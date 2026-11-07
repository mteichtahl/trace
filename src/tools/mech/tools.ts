/**
 * The mechanical tools (docs/enclosure-build.md, "TypeScript"): a case for the board, built by the enclosure engine
 * (./engine.ts, build123d through a `cad` job, after a `cad-script` job for a custom case.py), its fit check as the layout gate's evidence (criterion layout.fit), and
 * the files and order sheet for JLCPCB's 3D printing and CNC service. Every call is a recorded run; each answer has
 * `run_id` and a one-line `summary`.
 *
 *   mech.board               the board facts the engine reads: outline, cutouts, holes, parts with boxes and heights
 *   mech.init                mechanical/case.json (the recommendation) and mechanical/case.py (the template)
 *   mech.settings            the settings with each value's recommendation; changes, each away from it with a reason
 *   mech.build               runs the engine: mechanical/out/, the fit check and the process's design rules
 *   mech.fit                 the latest build's fit, and whether the board or the case changed since
 *   mech.hand_in             a STEP or case.py from the repository becomes the case, then builds
 *   mech.capabilities        JLC3DP's and JLCCNC's rules as stored, their sources and whether they are stale
 *   mech.capabilities_check  re-reads the source pages: each stored figure same, changed or unreadable
 *   mech.order               mechanical/out/order.json and order.md for a person to upload and pay; never orders
 *   mech.options             the case designs that could work for the board (python/tracebridge/case_options.py):
 *                            every combination of template, mounting, closure and process tried against
 *                            feasibility rules on regions and relations, the feasible ones ranked with why and what
 *                            each gives up, the pruned ones with the rule; with ask, the feasible ones asked of a
 *                            person as a question (journey.ask's record), recommended first
 *
 * Paths are the repository's (relative to its root); the files written are in the working tree, for the person or the
 * worker to commit.
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { z } from 'zod'
import { defineTool, ToolError, type AnyTool } from '../../core/registry.js'
import { Work } from '../../core/store.js'
import { candidates, needPcb, resolveProject } from '../kicad/project.js'
import { cap, recorded } from '../kicad/record.js'
import { type BoardFacts, boardFacts, repoPath } from './board.js'
import {
  CAPABILITIES, FIGURES, type FigureStatus, RECOMMENDED, RECOMMENDED_WHY, SOURCES, UPLOAD, capabilitiesStamp, figureStatus, isCnc, pageText, processRow, staleness,
} from './capabilities.js'
import { sameApartFromStamps } from './stable-output.js'
import { ALL_ENGINE_FILES, type EngineResult, FORMATS, PY_DIR, partsFor, runCase } from './engine.js'
import { copyRepoFile, readRepoFile, removeRepoFile, repoDir, repoFile, writeRepoFile } from './paths.js'
import { type BuildInputs, engineStamp, sha256, staleReasons } from './stale.js'
import { CASE_VIEW, caseFactHashes, caseViewHashOf } from './case-facts.js'
import { normalisedHash } from '../../core/normalise.js'
import {
  CASE_JSON, CASE_PY, type CaseSettings, type CaseTemplate, MECH_DIR, OUT_DIR, SETTABLE, TEMPLATE_IDS, defaults, describe, missingReasons,
  needSettings, readSettings, withClearance, withValue, writeSettings,
} from './settings.js'

/** The case script mech.init writes for each template (the engine's python/tracebridge/mech/templates/<id>.py). */
export const CASE_TEMPLATES: Readonly<Record<CaseTemplate, string>> = {
  'printed-shell': `from tracebridge.mech import shell

def build(board, settings):
    case = shell.two_part(board, settings)
    # Your changes go here: case.parts["lid"] = case.parts["lid"] - ...  (build123d)
    return case
`,
  'extruded-box': `from tracebridge.mech import boxes

def build(board, settings):
    case = boxes.extruded_box(board, settings)
    # Your changes go here: case.parts["tube"] = case.parts["tube"] - ...  (build123d)
    return case
`,
  'din-rail': `from tracebridge.mech import boxes

def build(board, settings):
    case = boxes.din_rail(board, settings)
    # Your changes go here: case.parts["lid"] = case.parts["lid"] - ...  (build123d)
    return case
`,
}
/** The printed shell's script, the recommendation. */
export const CASE_TEMPLATE = CASE_TEMPLATES['printed-shell']

/** What each template is, for a person choosing one. */
export const TEMPLATE_WORDS: Readonly<Record<CaseTemplate, string>> = {
  'printed-shell': 'a printed two-part shell: a base the board screws into and a lid that drops onto it',
  'extruded-box': 'an extruded box: a tube the board slides into along guides, closed by two end plates',
  'din-rail': 'a DIN rail enclosure: the two-part shell with a foot that clips onto a 35 mm top-hat rail',
}

/** A repository file's sha256, null when it is not there (checked: no symbolic link, nothing outside the repository). */
const sha = (r: string, p: string): string | null => (existsSync(join(r, p)) ? sha256(readRepoFile(r, p)) : null)
const fmt = (n: number): string => String(Math.round(n * 100) / 100)
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

async function root(): Promise<string> {
  return (await candidates()).root
}

/** A path a person gave, inside the repository (./paths.ts: by realpath, not a symbolic link, not under .git/). */
const inRepo = (r: string, p: string, what?: string): { abs: string; rel: string } => repoFile(r, p, what)

/** The board to use: the given path, else the project's one .kicad_pcb. */
async function boardPath(r: string, board?: string): Promise<string> {
  if (board) {
    const { abs } = inRepo(r, board)
    if (!existsSync(abs)) throw new ToolError(`there is no board ${board}`)
    return needPcb(await resolveProject(abs))
  }
  return needPcb(await resolveProject())
}

const processOk = (p: CaseSettings['process']): boolean => isCnc(p) || processRow(p) !== null

/** The process as the capabilities spell it (a material or process given in another case: "pa12-hp" → "PA12-HP"). */
function canonicalProcess(p: CaseSettings['process']): CaseSettings['process'] {
  const row = processRow(p)
  if (!row) return isCnc(p) ? { ...p, service: p.service.toLowerCase() } : p
  const material = row.materials.find((m) => m.toLowerCase() === p.material.toLowerCase()) ?? p.material
  return { service: row.service, process: row.process, material }
}
const processList = (): string => CAPABILITIES.processes.map((r) => `${r.process} ${r.materials.join('/')}`).join('; ')

// ------------------------------------------------------------------ mech.board

const boardArg = z.string().optional().describe("the .kicad_pcb (a repository path); default: the case's board, else the project's one board")

export const boardTool = defineTool({
  name: 'mech.board',
  description: 'The board facts the enclosure engine reads, from the .kicad_pcb alone: thickness, the Edge.Cuts outline (largest closed loop, arcs sampled every 0.5 mm) and cutouts, holes (mounting, npth, pth of 1 mm and more), and each part with its courtyard box, side, mount, height above its face (Height field, else the package table, else 5 mm assumed with a warning), leads below the far face for through-hole parts, whether it is a connector and the outline side it sits at (within 1.5 mm). Use it to see what the case will be built around and which heights are guesses. Recorded; returns run_id.',
  input: z.object({ board: boardArg, parts_limit: z.number().int().min(1).max(2000).default(200) }),
  run: async (a) => {
    const r = await root()
    const pcb = await boardPath(r, a.board ?? readSettings(r)?.board)
    return recorded('mech.board', repoPath(pcb, r), a, async (run) => {
      const f = boardFacts(pcb, r)
      run.artifact('facts.json', JSON.stringify(f, null, 1), 'application/json')
      const assumed = f.parts.filter((p) => p.height_source === 'default')
      run.measure('parts', f.parts.length)
      run.measure('assumed_heights', assumed.length)
      const xs = f.outline.map((p) => p[0])
      const ys = f.outline.map((p) => p[1])
      const size = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
      const tallest = [...f.parts].sort((x, y) => y.height_mm - x.height_mm)[0]
      const c = cap(f.parts, a.parts_limit)
      return {
        status: 'pass' as const,
        summary: `${f.board}: ${fmt(size[0] as number)} × ${fmt(size[1] as number)} × ${f.thickness_mm} mm, ${plural(f.parts.length, 'part')}, ${plural(f.holes.length, 'hole')}, ${plural(f.parts.filter((p) => p.connector && p.edge).length, 'connector')} at an edge${tallest ? `, tallest ${tallest.ref} ${tallest.height_mm} mm` : ''}${assumed.length ? `; ${plural(assumed.length, 'height')} assumed` : ''}`,
        result: { ...f, parts: c.items, parts_omitted: c.omitted, size_mm: size.map(fmt).map(Number) },
      }
    })
  },
})

// ------------------------------------------------------------------ mech.init

const ProcessIn = z.object({ service: z.string().min(1), process: z.string().min(1), material: z.string().min(1) }).strict()

export const initTool = defineTool({
  name: 'mech.init',
  description: `Start the project's case: writes ${CASE_JSON} (the recommended settings: walls, clearances 0.5 mm board edge to wall and 1.0 mm above the tallest part, openings for edge connectors; the board path; the process, default the recommendation ${RECOMMENDED.process} ${RECOMMENDED.material} at JLC3DP) and ${CASE_PY} (the template's build123d script, which a person or the worker edits). template: ${TEMPLATE_IDS.map((t) => `${t} (${TEMPLATE_WORDS[t]})`).join('; ')}; default printed-shell. A process or template other than the recommendation needs a reason. Refuses to overwrite either file without replace: true. Then run mech.build. Recorded; returns run_id.`,
  input: z.object({
    board: boardArg,
    process: ProcessIn.optional().describe(`{service, process, material}; default ${JSON.stringify(RECOMMENDED)}`),
    template: z.enum(TEMPLATE_IDS).optional().describe('the case design; default printed-shell'),
    reason: z.string().optional().describe('why, when the process is not the recommendation'),
    quantity: z.number().int().min(1).max(100_000).optional(),
    replace: z.boolean().default(false),
  }),
  run: async (a) => {
    const r = await root()
    const pcb = await boardPath(r, a.board)
    const board = repoPath(pcb, r)
    return recorded('mech.init', board, a, async () => {
      const existing = [CASE_JSON, CASE_PY].filter((p) => existsSync(join(r, p)))
      if (existing.length && !a.replace) throw new ToolError(`${existing.join(' and ')} already ${existing.length === 1 ? 'exists' : 'exist'}: pass replace: true to start the case again (the old settings and script are overwritten)`)
      let s = defaults(board)
      if (a.process) {
        if (!processOk(a.process)) throw new ToolError(`mech.init: ${a.process.service} ${a.process.process} ${a.process.material} is not in the capabilities (${processList()}; or service jlccnc for CNC)`)
        const given = canonicalProcess(a.process)
        for (const k of ['service', 'process', 'material'] as const) if (given[k] !== s.process[k]) s = withValue(s, `process.${k}`, given[k], a.reason)
      }
      if (a.quantity !== undefined && a.quantity !== s.quantity) s = withValue(s, 'quantity', a.quantity, a.reason ?? 'the build quantity')
      if (a.template && a.template !== s.template) {
        if (!a.reason || a.reason.trim().length < 3) throw new ToolError(`mech.init: template ${a.template} is not the recommendation (printed-shell): give the reason`)
        s = { ...s, template: a.template, reasons: { ...s.reasons, template: a.reason.trim() } }
      }
      // both checked before either is written: a symbolic link at either refuses the whole call
      repoFile(r, CASE_JSON)
      repoFile(r, CASE_PY)
      writeSettings(r, s)
      writeRepoFile(r, CASE_PY, CASE_TEMPLATES[s.template])
      const p = s.process
      return {
        status: 'pass' as const,
        summary: `wrote ${CASE_JSON} and ${CASE_PY} for ${board}: ${s.template}, ${p.process} ${p.material} at ${p.service}, wall ${s.params.wall_mm} mm`,
        result: {
          written: [CASE_JSON, CASE_PY], settings: s,
          recommendation: { ...RECOMMENDED, why: RECOMMENDED_WHY },
          next: 'mech.build to build the case and check its fit.',
        },
      }
    })
  },
})

// ------------------------------------------------------------------ mech.settings

const Value = z.union([z.number(), z.string(), z.boolean(), z.array(z.string())])

export const settingsTool = defineTool({
  name: 'mech.settings',
  description: `The case's settings (${CASE_JSON}) with each value's recommendation and reason. set: [{path, value, reason}] changes values (paths: ${SETTABLE.join(', ')}); clearance: [{ref, mm, reason}] gives one part the gap it needs (a mating face, a heatsink; mm null removes it). A value away from its recommendation is refused without a reason; set back to the recommendation, its reason goes. Changes are written to ${CASE_JSON}; run mech.build after. Recorded; returns run_id.`,
  input: z.object({
    set: z.array(z.object({ path: z.string(), value: Value, reason: z.string().optional() }).strict()).default([]),
    clearance: z.array(z.object({ ref: z.string(), mm: z.number().min(0).nullable(), reason: z.string().optional() }).strict()).default([]),
  }),
  run: async (a) => {
    const r = await root()
    const before = needSettings(r)
    return recorded('mech.settings', before.board, a, async () => {
      let s = before
      for (const c of a.set) {
        // a process value as the capabilities spell it, so case.json and the recommendation compare as equal
        let v = c.value
        if (typeof v === 'string' && c.path.startsWith('process.')) {
          const k = c.path.slice('process.'.length) as keyof CaseSettings['process']
          v = canonicalProcess({ ...s.process, [k]: v })[k]
        }
        s = withValue(s, c.path, v, c.reason)
      }
      for (const c of a.clearance) s = withClearance(s, c.ref, c.mm, c.reason)
      if (!processOk(s.process)) throw new ToolError(`mech.settings: ${s.process.service} ${s.process.process} ${s.process.material} is not in the capabilities (${processList()}; or service jlccnc for CNC)`)
      s = { ...s, process: canonicalProcess(s.process) }
      const changed = a.set.length + a.clearance.length > 0
      if (changed) writeSettings(r, s)
      const warnings = unknownRefs(r, s, a)
      const rows = describe(s)
      const away = rows.filter((x) => x.changed)
      const unexplained = missingReasons(s)
      return {
        status: unexplained.length ? 'fail' as const : 'pass' as const,
        summary: `${changed ? `${plural(a.set.length + a.clearance.length, 'change')} written; ` : ''}${plural(away.length, 'value')} away from the recommendation${unexplained.length ? `, ${unexplained.length} without a reason: ${unexplained.join(', ')}` : ''}${warnings.length ? `; ${plural(warnings.length, 'warning')}` : ''}`,
        result: { settings: s, values: rows, without_reason: unexplained, warnings, ...(changed ? { written: CASE_JSON, next: 'mech.build to rebuild the case and check its fit.' } : {}) },
      }
    })
  },
})

/**
 * References this call names (a per-part clearance, openings.skip) that are not parts of the board: a warning each, not
 * a refusal (the part may be about to be placed). Nothing when the board cannot be read.
 */
function unknownRefs(r: string, s: CaseSettings, a: { set: { path: string; value: unknown }[]; clearance: { ref: string; mm: number | null }[] }): string[] {
  const named = [
    ...a.clearance.filter((c) => c.mm !== null).map((c) => ({ ref: c.ref, what: `clearance for ${c.ref}` })),
    ...a.set.filter((c) => c.path === 'openings.skip' && Array.isArray(c.value)).flatMap((c) => (c.value as string[]).map((ref) => ({ ref, what: `openings.skip names ${ref}` }))),
  ]
  if (!named.length) return []
  let refs: Set<string>
  try {
    refs = new Set(boardFacts(join(r, s.board), r).parts.map((p) => p.ref))
  } catch {
    return []
  }
  return named.filter((n) => !refs.has(n.ref)).map((n) => `${n.what}: ${n.ref} is not a part on ${s.board} (it is kept; check the reference)`)
}

// ------------------------------------------------------------------ mech.build

/** What the stale check (./stale.ts) compares: the board, the case's own files, the facts, the capabilities' date and
 * the engine, as they are now (`facts`: the facts as built, else read from the board now). */
function currentInputs(r: string, s: CaseSettings, facts?: BoardFacts): BuildInputs {
  let f = facts
  if (!f) {
    try {
      f = boardFacts(join(r, s.board), r)
    } catch { /* an unreadable board shows as a changed board */ }
  }
  return {
    board: s.board, board_sha256: sha(r, s.board) ?? '',
    ...(f ? { case_facts: caseFactHashes(f) } : {}),
    case_json_sha256: sha(r, CASE_JSON), case_py_sha256: s.source === 'script' ? sha(r, CASE_PY) : null,
    case_file: s.source === 'file' ? s.file ?? null : null, case_file_sha256: s.source === 'file' && s.file ? sha(r, s.file) : null,
    facts_sha256: f ? sha256(JSON.stringify(f)) : '',
    capabilities_checked: CAPABILITIES.checked,
    capabilities_sha256: capabilitiesStamp(),
    engine: engineStamp(process.env.TRACE_MECH_PYTHONPATH || PY_DIR),
  }
}

const Formats = z.array(z.enum(FORMATS)).min(1).default([...FORMATS])

/** The words for a fit: clashes and gaps by part, with numbers. */
function fitLines(f: EngineResult['fit']): string[] {
  return [
    ...f.clashes.map((c) => `${c.ref} clashes with the ${c.case_part} (${fmt(c.volume_mm3)} mm³)`),
    ...f.gaps.filter((g) => !g.ok).map((g) => `${g.ref} ${g.where}: ${g.measured_mm === null ? 'not measured' : `${fmt(g.measured_mm)} mm`}, needs ${fmt(g.required_mm)} mm`),
    ...f.openings.filter((o) => !o.made).map((o) => `no opening made for ${o.ref} (${o.side})`),
  ]
}

async function build(r: string, s: CaseSettings, args: unknown, formats: readonly (typeof FORMATS)[number][]) {
  return recorded('mech.build', s.board, args, async (run) => {
    const facts: BoardFacts = boardFacts(inRepo(r, s.board, 'the case\'s board').abs, r)
    const inputs = currentInputs(r, s, facts)
    // the script and the handed-in file: regular files in the repository (no symbolic link to something outside)
    const script = s.source === 'script' && existsSync(join(r, CASE_PY)) ? inRepo(r, CASE_PY).abs : null
    const caseFile = s.source === 'file' && s.file ? inRepo(r, s.file, 'the handed-in case').abs : null
    if (caseFile && !existsSync(caseFile)) throw new ToolError(`the handed-in case ${s.file} is missing (${CASE_JSON} names it): hand it in again with mech.hand_in, or set source back to script`)
    // where the files go, checked before the engine runs: a linked mechanical/out is refused, not written through
    repoFile(r, OUT_DIR)
    const c = await runCase({ facts, settings: s, script, caseFile, formats })
    const res = c.result
    // mechanical/out/: this build's files only. A file the same as the one there but for its export time stamp or
    // random ids is left as it is, so a build that changed nothing changes no file (test-esp32 log #222)
    repoDir(r, OUT_DIR)
    const unchanged = new Set(Object.entries(c.outputs).filter(([name, p]) => name !== 'result.json' && existsSync(join(r, OUT_DIR, name))
      && sameApartFromStamps(name, readRepoFile(r, `${OUT_DIR}/${name}`), readFileSync(p))).map(([name]) => name))
    for (const f of ALL_ENGINE_FILES) if (f !== 'result.json' && !unchanged.has(f)) removeRepoFile(r, `${OUT_DIR}/${f}`)
    const written: string[] = []
    for (const [name, p] of Object.entries(c.outputs)) {
      if (name === 'result.json') continue
      if (!unchanged.has(name)) writeRepoFile(r, `${OUT_DIR}/${name}`, readFileSync(p))
      written.push(`${OUT_DIR}/${name}`)
    }
    written.sort()
    run.artifact('result.json', JSON.stringify(res, null, 1), 'application/json')
    run.artifact('facts.json', JSON.stringify(facts, null, 1), 'application/json')
    run.artifact('case.json', JSON.stringify(s, null, 1), 'application/json')
    // lineage (src/ontology/lineage.ts): the part of the board the case depends on, and the case's own files, so the
    // build's freshness everywhere (the graph, artifact.stale, the layout.fit shape) agrees with mech.fit
    run.reads(`${s.board}#${CASE_VIEW}`, caseViewHashOf(facts))
    for (const p of [CASE_JSON, ...(script ? [CASE_PY] : []), ...(s.source === 'file' && s.file ? [s.file] : [])]) {
      run.reads(p, existsSync(join(r, p)) ? normalisedHash(p, readRepoFile(r, p)) : null)
    }
    for (const [name, p] of Object.entries(c.outputs)) {
      if (name === 'fit.json') run.artifact(name, readFileSync(p, 'utf8'), 'application/json')
      else if (name.endsWith('.step')) run.artifact(name, readFileSync(p), 'model/step')
    }
    const f = res.fit
    const gapViolations = f.gaps.filter((g) => !g.ok).length
    const assumed = f.assumptions?.length ?? facts.parts.filter((p) => p.height_source === 'default').length
    const failingRules = res.rules.filter((x) => x.ok === false)
    const unchecked = res.rules.filter((x) => x.ok === null)
    run.measure('clashes', f.clashes.length)
    run.measure('gap_violations', gapViolations)
    run.measure('assumed_heights', assumed)
    run.measure('rule_failures', failingRules.length)
    run.measure('seconds', res.seconds, 's')
    const passed = f.status === 'pass' && failingRules.length === 0
    const bbox = res.case.bbox_mm.map(fmt).join(' × ')
    const p = s.process
    const unexplained = missingReasons(s)
    const lines = fitLines(f)
    return {
      status: passed ? 'pass' as const : 'fail' as const,
      summary: `fit ${f.status}: ${plural(f.clashes.length, 'clash', 'clashes')}, ${plural(gapViolations, 'gap')} under its clearance, ${plural(assumed, 'height')} assumed; rules ${failingRules.length ? `${failingRules.length} failing (${failingRules.map((x) => x.rule).join(', ')})` : 'within limits'}; case ${bbox} mm, ${p.process} ${p.material}`,
      result: {
        passed, fit_status: f.status, fit_summary: f.summary, problems: lines,
        clashes: f.clashes, gaps: f.gaps, openings: f.openings, assumptions: f.assumptions,
        rules_failing: failingRules, rules_not_checked: unchecked, rules: res.rules,
        case: res.case, fasteners: res.fasteners ?? [], source: res.source, process: p,
        files: written, where: c.where, stages: c.stages, engine_seconds: res.seconds, notes: res.notes ?? [],
        warnings: [...facts.warnings, ...unexplained.map((x) => `${x} differs from the recommendation without a reason in ${CASE_JSON} (set it with mech.settings)`)],
        inputs,
        next: passed
          ? 'The case fits and is within the process\'s rules: run shape.check with criterion "layout.fit", which reads this build and records the criterion.'
          : 'Read the clashes and gaps: a clearance or wall change is mech.settings; a shape change is an edit to mechanical/case.py (delegate it); a clash that needs the board outline or a part moved is for a person, who may waive that one problem in the journey. shape.check layout.fit records the criterion from the newest build and its waivers.',
      },
    }
  })
}

export const buildTool = defineTool({
  name: 'mech.build',
  description: `Build the case with the enclosure engine (build123d) from the board facts, ${CASE_JSON} and ${CASE_PY} (or the handed-in STEP), then check it. A ${CASE_PY} that differs from the template runs first as its own cad-script job (on the project's cad function, or locally; the cloud without one builds only the template or a handed-in STEP), then a cad job (the tools function, or locally) checks what it built; the answer's stages say where each ran. The check: clashes (part envelopes or the board against case parts, mm³), gaps (board edge to wall, each part to the lid or floor, against its clearance), openings for edge connectors, and the process's design rules (wall, size, hole, lip gap; JLC3DP or JLCCNC). Writes ${OUT_DIR}/ (case.step, case-<part>.step/.stl/.3mf, fit.json, case.jsonld). Measures clashes, gap_violations, assumed_heights; status pass only when the fit passes and no rule fails. Then shape.check layout.fit records the layout gate's fit criterion from the newest build (its shape: met when the build still stands and every clash, gap and failing rule is fixed or waived on its own). Recorded; returns run_id.`,
  input: z.object({ formats: Formats.describe('files to write (default step, stl and 3mf)') }),
  run: async (a) => {
    const r = await root()
    return build(r, needSettings(r), a, a.formats)
  },
})

// ------------------------------------------------------------------ mech.fit

interface BuildRecord { id: string; started: number; status: string; result: Record<string, unknown> }

/** The newest mech.build run that produced a fit. */
export function latestBuild(): BuildRecord | null {
  const w = new Work()
  try {
    for (const s of w.runs('mech.build', 20)) {
      if (s.kind !== 'mech.build' || s.status === 'running' || s.status === 'error') continue
      const rec = w.run(s.id)
      const res = rec?.result
      if (res && typeof res === 'object' && !Array.isArray(res) && 'fit_status' in res) return { id: s.id, started: s.started, status: s.status, result: res as Record<string, unknown> }
    }
    return null
  } finally {
    w.close()
  }
}

export const fitTool = defineTool({
  name: 'mech.fit',
  description: 'The latest mech.build run\'s fit check (clashes, gaps, openings, failing rules) and whether it is stale: the board file, the case settings, the case script or the handed-in file changed since that build (each by sha256), or the board facts, the capabilities\' date or the enclosure engine did. A stale fit is no evidence for layout.fit: run mech.build again. Recorded; returns run_id.',
  input: z.object({}),
  run: async (a) => {
    const r = await root()
    const s = needSettings(r)
    return recorded('mech.fit', s.board, a, async (run) => {
      const b = latestBuild()
      if (!b) throw new ToolError('no mech.build run is recorded yet: run mech.build')
      const res = b.result
      const reasons = staleReasons(res.inputs as BuildInputs, currentInputs(r, s))
      run.measure('stale', reasons.length ? 1 : 0)
      const passed = b.status === 'pass' && !reasons.length
      return {
        status: passed ? 'pass' as const : 'fail' as const,
        summary: `build ${b.id} (${new Date(b.started * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC): ${b.status}${reasons.length ? `, stale: ${reasons.join('; ')}` : ', current'}`,
        result: {
          build_run: b.id, build_status: b.status, stale: reasons.length > 0, stale_reasons: reasons,
          fit_status: res.fit_status, fit_summary: res.fit_summary, problems: res.problems, clashes: res.clashes, gaps: res.gaps, openings: res.openings,
          assumptions: res.assumptions, rules_failing: res.rules_failing, rules_not_checked: res.rules_not_checked, case: res.case, files: res.files,
          next: reasons.length ? 'mech.build: the fit is stale.' : b.status === 'pass' ? 'shape.check layout.fit, if not checked since this build.' : 'Fix the clashes and gaps (mech.settings, or a delegated change to the case script), then mech.build.',
        },
      }
    })
  },
})

// ------------------------------------------------------------------ mech.hand_in

export const handInTool = defineTool({
  name: 'mech.hand_in',
  description: `Use a file a person put in the repository as the case: a STEP (.step/.stp) is copied into ${MECH_DIR}/ and becomes the case body (settings source "file": it no longer follows the board, and its wall thickness is not measured), or a case script (.py) replaces ${CASE_PY} (source "script"). Then runs mech.build and answers as it does, with what was handed in. Recorded; returns run_id.`,
  input: z.object({
    path: z.string().describe('the file, as a path in the repository'),
    formats: Formats,
  }),
  run: async (a) => {
    const r = await root()
    let s = needSettings(r)
    const { abs, rel } = inRepo(r, a.path, 'the handed-in file')
    if (!existsSync(abs)) throw new ToolError(`there is no file ${a.path} in the repository`)
    const ext = extname(abs).toLowerCase()
    let kept: string
    if (ext === '.step' || ext === '.stp') {
      kept = `${MECH_DIR}/${basename(abs)}`
      copyRepoFile(r, rel, kept, { from: 'the handed-in file', to: 'the case file it is kept as' })
      s = { ...s, source: 'file', file: kept }
    } else if (ext === '.py') {
      kept = CASE_PY
      copyRepoFile(r, rel, CASE_PY, { from: 'the handed-in file', to: CASE_PY })
      const { file: _drop, ...rest } = s
      s = { ...rest, source: 'script' } as CaseSettings
    } else throw new ToolError(`mech.hand_in takes a STEP (.step, .stp) or a case script (.py), not ${ext || 'a file without an extension'}`)
    writeSettings(r, s)
    const out = await build(r, s, a, a.formats)
    return { ...out, handed_in: { from: rel, kept, source: s.source }, written: [kept, CASE_JSON, ...out.files] }
  },
})

// ------------------------------------------------------------------ mech.capabilities

export const capabilitiesTool = defineTool({
  name: 'mech.capabilities',
  description: 'What JLCPCB\'s mechanical services can make, as trace stores it: per JLC3DP print process and material group the largest and smallest part, the minimum wall by part size, assembly and moving clearances, model and hole tolerances and the smallest hole; JLCCNC\'s wall, internal-radius, tolerance and thread rules; the general rules (escape holes, snap and fastener walls, smallest printed thread); each with its source page, the date read, and whether the table is stale (older than 90 days: run mech.capabilities_check). Also the recommended process and why. Recorded; returns run_id.',
  input: z.object({ process: z.string().optional().describe('only this process (SLA, MJF, SLS, FDM, SLM)') }),
  run: async (a) => recorded('mech.capabilities', null, a, async () => {
    const st = staleness()
    const rows = CAPABILITIES.processes.filter((p) => !a.process || p.process.toLowerCase() === a.process.toLowerCase())
    if (a.process && !rows.length) throw new ToolError(`no process ${a.process}; one of ${[...new Set(CAPABILITIES.processes.map((p) => p.process))].join(', ')}`)
    return {
      status: st.stale ? 'fail' as const : 'pass' as const,
      summary: `${plural(rows.length, 'process group')}, read ${st.checked} (${st.age_days} days ago${st.stale ? ', stale: re-check it' : ''})`,
      result: { ...st, sources: SOURCES, processes: rows, general: CAPABILITIES.general, cnc: CAPABILITIES.cnc, recommendation: { ...RECOMMENDED, why: RECOMMENDED_WHY } },
    }
  }),
})

export const capabilitiesCheckTool = defineTool({
  name: 'mech.capabilities_check',
  description: 'Fetch each source page of the stored capabilities (JLC3DP\'s design guideline and service page, JLCCNC\'s machining guideline) and report, for each stored figure, whether the page still states it next to its label: same, changed (the label is there, the figure is not) or unreadable (the page or the label could not be read). Changes nothing: trace\'s scheduled capabilities workflow re-reads the pages daily, proposes changed figures on a pull request and reports the rest for a person (src/tools/mech/capsync.ts). Plain fetch (set NODE_USE_ENV_PROXY=1 for a proxy). Recorded; returns run_id.',
  input: z.object({ timeout_s: z.number().int().min(5).max(120).default(30) }),
  run: async (a) => recorded('mech.capabilities_check', null, a, async (run) => {
    const pages = new Map<string, { text: string | null; error: string | null }>()
    await Promise.all(SOURCES.map(async (u) => {
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(a.timeout_s * 1000), headers: { 'user-agent': 'trace mech.capabilities_check' } })
        pages.set(u, res.ok ? { text: pageText(await res.text()), error: null } : { text: null, error: `HTTP ${res.status}` })
      } catch (e) {
        pages.set(u, { text: null, error: e instanceof Error ? (e.cause instanceof Error ? `${e.message}: ${e.cause.message}` : e.message) : String(e) })
      }
    }))
    const figures = FIGURES.map((f) => ({ id: f.id, page: f.page, label: f.label, stored: f.text, status: figureStatus(f, pages.get(f.page)?.text ?? null) as FigureStatus }))
    const count = (k: FigureStatus): number => figures.filter((f) => f.status === k).length
    run.measure('same', count('same'))
    run.measure('changed', count('changed'))
    run.measure('unreadable', count('unreadable'))
    run.artifact('figures.json', JSON.stringify(figures, null, 1), 'application/json')
    const ok = count('changed') === 0 && count('unreadable') === 0
    return {
      status: ok ? 'pass' as const : 'fail' as const,
      summary: `${figures.length} figures: ${count('same')} same, ${count('changed')} changed, ${count('unreadable')} unreadable (stored ${CAPABILITIES.checked})`,
      result: {
        checked: CAPABILITIES.checked, pages: [...pages].map(([url, p]) => ({ url, read: p.text !== null, error: p.error })),
        changed: figures.filter((f) => f.status === 'changed'), unreadable: figures.filter((f) => f.status === 'unreadable'), same: count('same'),
        note: 'Nothing was changed. trace\'s scheduled capabilities workflow re-reads these pages daily: a figure stated with other numbers comes as a pull request to src/tools/mech/capabilities.updates.ts, anything else as an issue for a person.',
      },
    }
  }),
})

// ------------------------------------------------------------------ mech.order

export const orderTool = defineTool({
  name: 'mech.order',
  description: `Prepare the case order for a person to submit and pay at JLC3DP (or JLCCNC): writes ${OUT_DIR}/order.json and order.md with the service, process, material, finish, quantity, the files to upload (one per case part), the fit run and the upload page. Needs a current, passing mech.build (a failing fit only with waiver: the reason it is accepted, quoted on the sheet). Never places an order. Recorded; returns run_id.`,
  input: z.object({
    finish: z.string().min(1).default('standard').describe('surface finish as JLC3DP names it (standard, dyed, painted …)'),
    color: z.string().optional(),
    quantity: z.number().int().min(1).max(100_000).optional().describe('default: the case settings\' quantity'),
    format: z.enum(['step', 'stl', '3mf']).default('step').describe('the file per part to upload'),
    waiver: z.string().min(10).optional().describe('when the latest build fails: why the case is ordered anyway'),
  }),
  run: async (a) => {
    const r = await root()
    const s = needSettings(r)
    return recorded('mech.order', s.board, a, async (run) => {
      const b = latestBuild()
      if (!b) throw new ToolError('no mech.build run is recorded yet: run mech.build first')
      const stale = staleReasons(b.result.inputs as BuildInputs, currentInputs(r, s))
      if (stale.length) throw new ToolError(`the latest build (${b.id}) is stale: ${stale.join('; ')}. Run mech.build again`)
      if (b.status !== 'pass' && !a.waiver) throw new ToolError(`the latest build (${b.id}) does not pass: ${String(b.result.fit_summary ?? '')}. Fix it, or give the waiver`)
      const files = partsFor(s.source, s.template).map((p) => `${OUT_DIR}/case-${p}.${a.format}`)
      const missing = files.filter((f) => !existsSync(join(r, f)))
      if (missing.length) throw new ToolError(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the working tree: run mech.build with formats including ${a.format}`)
      const service = isCnc(s.process) ? 'jlccnc' : 'jlc3dp'
      const qty = a.quantity ?? s.quantity
      const order = {
        version: 1, service, process: s.process.process, material: s.process.material, finish: a.finish, ...(a.color ? { color: a.color } : {}),
        quantity: qty, files, fit_run: b.id, fit_status: b.result.fit_status, ...(a.waiver ? { waiver: a.waiver } : {}),
        upload: UPLOAD[service], prepared: new Date().toISOString(), board: s.board,
        note: 'Prepared by trace; a person uploads the files, checks the quote and pays. trace places no order.',
      }
      const md = [
        `# Case order: ${s.board}`, '',
        `Upload at ${UPLOAD[service]} and pay there; trace places no order.`, '',
        '| Option | Value |', '| --- | --- |',
        `| Service | ${service === 'jlc3dp' ? 'JLC3DP 3D printing' : 'JLCCNC machining'} |`,
        `| Process | ${s.process.process} |`, `| Material | ${s.process.material} |`, `| Finish | ${a.finish}${a.color ? `, ${a.color}` : ''} |`,
        `| Quantity | ${qty} of each part |`, `| Fit check | run ${b.id}: ${String(b.result.fit_status)} |`,
        ...(a.waiver ? [`| Waiver | ${a.waiver} |`] : []), '',
        '## Files to upload', '', ...files.map((f) => `- \`${f}\``), '',
        '## After paying', '', 'Record the order number, what was paid and the ship date with the project\'s order (Order submit).', '',
      ].join('\n')
      writeRepoFile(r, `${OUT_DIR}/order.json`, `${JSON.stringify(order, null, 2)}\n`)
      writeRepoFile(r, `${OUT_DIR}/order.md`, md)
      run.artifact('order.json', JSON.stringify(order, null, 1), 'application/json')
      run.artifact('order.md', md, 'text/markdown')
      return {
        status: 'pass' as const,
        summary: `order sheet for ${qty} × ${files.length} part(s), ${s.process.process} ${s.process.material} ${a.finish}, at ${service}: ${OUT_DIR}/order.md`,
        result: { order, written: [`${OUT_DIR}/order.json`, `${OUT_DIR}/order.md`], next: `A person uploads ${files.join(', ')} at ${UPLOAD[service]} and pays.` },
      }
    })
  },
})

// ------------------------------------------------------------------ mech.options

/** The processes the options are offered in: the recommendation, the first resin, and machined aluminium. */
export function optionProcesses(): { id: string; label: string; service: string; process: string; material: string; max_mm?: readonly number[]; recommended?: boolean; why?: string }[] {
  const mjf = processRow(RECOMMENDED)
  const sla = CAPABILITIES.processes.find((r) => r.process === 'SLA')
  return [
    { id: 'mjf', label: `${RECOMMENDED.process} ${RECOMMENDED.material} at JLC3DP`, ...RECOMMENDED, ...(mjf ? { max_mm: mjf.max_mm } : {}), recommended: true, why: (RECOMMENDED_WHY.replace(/^[^:]*: /, '').split(/[;,]/)[0] ?? '').trim() },
    ...(sla ? [{ id: 'sla', label: `SLA ${sla.materials[0]} at JLC3DP`, service: 'jlc3dp', process: 'SLA', material: sla.materials[0] as string, max_mm: sla.max_mm }] : []),
    { id: 'cnc', label: 'CNC aluminium 6061 at JLCCNC', service: 'jlccnc', process: 'CNC', material: 'Aluminum 6061' },
  ]
}

const OptionOut = z.object({
  key: z.string(), label: z.string(), choices: z.record(z.string(), z.string()), feasible: z.boolean(),
  pruned_by: z.object({ rule: z.string(), why: z.string() }).optional(),
  score: z.number().optional(), why: z.array(z.string()).optional(), gives_up: z.string().optional(), size_mm: z.array(z.number()).optional(),
  rank: z.number().optional(), recommended: z.boolean().optional(),
})
const OptionsOut = z.object({
  options: z.array(OptionOut), feasible: z.number(), pruned: z.number(), recommended: z.string().nullable(),
  not_offered: z.array(z.object({ label: z.string(), template: z.string(), process: z.string(), rule: z.string(), why: z.string() })),
})
export type CaseOptions = z.output<typeof OptionsOut>

/** The live requirements' words, from the design record (none when it has none). */
function requirementWords(): string[] {
  const w = new Work()
  try {
    const has = w.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='requirements'").get()
    return has ? (w.db.prepare("SELECT text FROM requirements WHERE status NOT IN ('rejected','obsolete')").all() as { text: string }[]).map((r) => r.text) : []
  } finally {
    w.close()
  }
}

export const optionsTool = defineTool({
  name: 'mech.options',
  description: `The case designs that could work for the board, before any is built: every combination of template (printed-shell, extruded-box, din-rail), how the board is held (screws, rests and lid posts, guides), how the case closes (lid, end plates) and process (MJF at JLC3DP, the recommendation; SLA; CNC aluminium) is tried against feasibility rules on the board's regions (its box, parts at its edges, parts sticking out, free corners, mounting holes, size against the process): pruned ones are kept with the rule and why; the feasible ones are ranked by the requirements, each with why and what it gives up. With ask: true, the feasible ones (up to six, recommended first) are asked of a person as a question in the journey (the Case design skill's process step shows it); their answer is the template and process for mech.init. Recorded; returns run_id.`,
  input: z.object({
    board: boardArg,
    ask: z.boolean().default(false).describe('ask a person which to build, as a journey question'),
  }),
  run: async (a) => {
    const r = await root()
    const s = readSettings(r)
    const pcb = a.board ? await boardPath(r, a.board) : s ? inRepo(r, s.board, 'the case\'s board').abs : await boardPath(r, undefined)
    const board = repoPath(pcb, r)
    const out = await recorded('mech.options', board, a, async (run) => {
      const facts = boardFacts(pcb, r)
      const { bridge } = await import('../../core/bridge.js')
      const res = await bridge().call('case.options', { facts, processes: optionProcesses(), requirements: requirementWords() }, OptionsOut)
      run.artifact('options.json', JSON.stringify(res, null, 1), 'application/json')
      run.measure('feasible', res.feasible)
      run.measure('pruned', res.pruned)
      const offered = res.options.filter((o) => o.feasible)
      return {
        status: offered.length ? 'pass' as const : 'fail' as const,
        summary: `${plural(offered.length, 'case design')} could work for ${board}${offered[0] ? `; trace recommends ${offered[0].label}` : ''}; ${res.pruned} combinations pruned`,
        result: {
          offered: offered.map((o) => ({ key: o.key, rank: o.rank, label: o.label, recommended: o.recommended, why: o.why, gives_up: o.gives_up, size_mm: o.size_mm, choices: o.choices })),
          not_offered: res.not_offered,
          pruned: res.options.filter((o) => !o.feasible).map((o) => ({ key: o.key, rule: o.pruned_by?.rule, why: o.pruned_by?.why })),
          recommended: res.recommended,
          next: offered.length ? (a.ask ? 'Asked: the answer names the template and process for mech.init.' : 'mech.options with ask: true to put them to a person, or mech.init with the recommended template and process.') : 'No case design fits: the board needs mounting holes, or its parts moved off its edges.',
        },
      }
    })
    if (!a.ask || !out.offered.length) return out
    // the question: the feasible options, recommended first, in the journey's questions record
    const { journeyScope } = await import('../journey/tools.js')
    const { addAgentQuestion } = await import('../../core/agent-facts.js')
    const { loadJourney } = await import('../../core/journey.js')
    let scope: ReturnType<typeof journeyScope>
    try { scope = journeyScope() } catch { return { ...out, asked: null, next: 'Not asked: no project in scope here. Put the options to a person in your report.' } }
    const rec = (await scope.journey.read((db) => loadJourney(db))).result
    const shown = out.offered.slice(0, 6)
    const dropped = out.not_offered.map((n) => `${n.label}: ${n.why}`)
    const { result: id } = await scope.facts.update((db) => ({
      result: addAgentQuestion(db, scope.asker, {
        text: `Which case should trace build for ${board}?${dropped.length ? ` Not offered: ${dropped.join('; ')}.` : ''}`.slice(0, 2000),
        blocks: 'building the case (mech.init, then mech.build)',
        options: shown.map((o, i) => ({ id: `case-${i + 1}`, label: o.label, recommended: Boolean(o.recommended), why: (o.why ?? []).join('; ') || 'it fits the board and the process', ...(o.gives_up ? { gives_up: o.gives_up } : {}) })),
        sources: [{ kind: 'run', ref: out.run_id, label: 'the case options and the rules that pruned the rest' }],
      }, rec),
    }))
    return { ...out, asked: { question_id: id }, next: `Asked (question ${id}). Read the answer with journey.status, then mech.init with that template and process.` }
  },
})

export const tools: AnyTool[] = [
  boardTool, initTool, settingsTool, buildTool, fitTool, handInTool, capabilitiesTool, capabilitiesCheckTool, orderTool, optionsTool,
] as unknown as AnyTool[]
