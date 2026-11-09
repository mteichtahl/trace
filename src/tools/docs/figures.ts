/**
 * The figures and values the project's documents carry (docs/scribe.md "What goes in them"), made from trace's own
 * tools and records so nothing in a document is drawn or typed by hand.
 *
 *   docs.values   the power, thermal and load values as rows and as ready tables (src/docs/values.ts)
 *   docs.figures  the photographic renders (render.showcase: the board from above, below and three-quarter, and in its
 *                 case and exploded when mech.build made one, coloured from the project's logo), the case's
 *                 drawings (python -m tracebridge.mech drawing on the case mech.build made: three dimensioned views and
 *                 an exploded view, a cad job on the tools function) and a timing diagram per protocol (protocol.diagram
 *                 of the newest protocol.model run of each), written to docs/design/figures with stable names, each
 *                 with the run that made it
 *
 * docs/design/figures/figures.json keeps, per figure, its file, kind, the run that made it (its `source` for the
 * figure marker), a hash of what it was made from and its quality. A figure whose inputs have not changed is not made
 * again; a draft is replaced by a release render, never the other way round.
 *
 * quality: draft (a quick look while the board is still changing) or release (for the printed copies), as
 * render.showcase takes it. The tools function has no display, so Blender renders with Cycles there.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import { type AnyTool, defineTool, ToolError, type ToolContext } from '../../core/registry.js'
import { openProject, Work } from '../../core/store.js'
import { readOutput } from '../../core/artifact-store.js'
import { VALUE_KINDS } from '../../docs/catalog.js'
import { recordedValues, valuesTable } from '../../docs/values.js'
import { FUNCTION_MAX_SECONDS, backendFor, runJob } from '../../gpu/jobs.js'
import { pyDir } from '../mech/engine.js'
import { tools as protocolTools } from '../protocol/tools.js'
import { logoPaths } from '../../docs/logo.js'
import { showcase } from '../render/showcase.js'

export const FIGURES_DIR = 'docs/design/figures'
export const MANIFEST = `${FIGURES_DIR}/figures.json`
type Quality = 'draft' | 'release'
/** render.showcase's shots and the figure each becomes (src/docs/diagrams.ts). */
export const SHOT_FIGURE = { 'board-top': 'render-top', 'board-bottom': 'render-bottom', board: 'render-iso', 'board-in-case': 'render-in-case', exploded: 'render-exploded' } as const
const CASE_FILES = ['mechanical/out/case-base.stl', 'mechanical/out/case-lid.stl']

export interface FigureEntry { file: string; kind: string; source: string; inputs: string; quality?: Quality; made: string }
export type Manifest = Record<string, FigureEntry>

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/)

function readManifest(root: string): Manifest {
  try { return JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')) as Manifest } catch { return {} }
}

/** Whether a figure needs making again: new inputs, or a release wanted over a draft. Pure. */
export function stale(prev: FigureEntry | undefined, inputs: string, quality?: Quality): boolean {
  if (!prev || prev.inputs !== inputs) return true
  return quality === 'release' && prev.quality !== 'release'
}

/** A hash of the repository's boards (every tracked .kicad_pcb and its 3D models' folder listing), for the renders. */
function boardInputs(root: string, colours: string): string {
  const files = execFileSync('git', ['ls-files', '*.kicad_pcb'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).sort()
  if (!files.length) return ''
  const h = createHash('sha256').update(colours)
  for (const f of files) h.update(f).update(readFileSync(join(root, f)))
  return h.digest('hex').slice(0, 16)
}

const call = async (list: readonly AnyTool[], name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> => {
  const t = list.find((x) => x.name === name)
  if (!t) throw new ToolError(`${name} is not available`)
  return (await t.run(t.input.parse(args), ctx)) as Record<string, unknown>
}

const values = defineTool({
  name: 'docs.values',
  description: 'The power, thermal and load values the project\'s documents state, read from what trace recorded (the newest power budget, thermal.check and thermal.measure runs): each with its value, limit, margin, basis (estimated, simulated, measured) and the record it came from, and as ready tables with their markers. Nothing recorded for a kind: no rows, so the document keeps it pending.',
  input: z.object({ kinds: z.array(z.enum(VALUE_KINDS)).min(1).optional() }),
  run: (a) => {
    const db = openProject()
    try {
      const all = recordedValues(db)
      const kinds = a.kinds ?? [...VALUE_KINDS]
      return {
        values: Object.fromEntries(kinds.map((k) => [k, all[k]])),
        tables: Object.fromEntries(kinds.map((k) => [k, valuesTable(k, all[k])])),
        missing: kinds.filter((k) => !all[k].length).map((k) => `${k}: nothing recorded yet${k === 'power' ? ' (run thermal.budget with a scenario)' : k === 'thermal' ? ' (run thermal.check)' : ''}`),
      }
    } finally {
      db.close()
    }
  },
})

const figures = defineTool({
  name: 'docs.figures',
  description: 'Make the figures the project\'s documents carry, into docs/design/figures with stable names: the photographic renders (render.showcase: the board from above, below and three-quarter, and in its case and exploded when mech.build made a case; coloured from the logo; quality draft or release), the case\'s dimensioned and exploded line drawings and a timing diagram for each protocol modelled (protocol.diagram). A figure whose inputs have not changed is kept. Returns each figure with the run that made it, for its marker\'s source.',
  input: z.object({
    revision: z.string().regex(/^[A-Z]{1,3}$/).default('A').describe('the revision the renders are of'),
    quality: z.enum(['draft', 'release']).default('draft').describe('draft: quick, while the board changes; release: for the printed copies'),
    renders: z.boolean().default(true),
    timing: z.boolean().default(true),
    drawings: z.boolean().default(true).describe('the case\'s dimensioned and exploded drawings, from mechanical/out/case.step'),
    mask_color: hex.default('#1f6b3a').describe('the solder mask colour the board is ordered in'),
    silk_color: hex.default('#f2f2ec').describe('the silkscreen colour'),
    project: z.string().optional().describe('the KiCad project, when the repository has more than one'),
  }),
  run: async (a, ctx) => {
    const root = process.cwd()
    const manifest = readManifest(root)
    const made: FigureEntry[] = []
    const kept: string[] = []
    const notes: string[] = []
    mkdirSync(join(root, FIGURES_DIR), { recursive: true })
    const now = new Date().toISOString()

    if (a.renders) {
      // render.showcase (docs/revision-renders.md): the board's shots, and the case's when mech.build made one;
      // coloured from the project's logo. Its inputs are the board, the case and the logo, so are these figures'.
      const hasCase = CASE_FILES.every((f) => existsSync(join(root, f)))
      const inputs = boardInputs(root, [`${a.mask_color}${a.silk_color}`, ...(hasCase ? CASE_FILES : []), ...logoPaths('light')].map((f) => existsSync(join(root, f)) ? `${f}:${createHash('sha256').update(readFileSync(join(root, f))).digest('hex')}` : f).join('|'))
      const shots = (Object.keys(SHOT_FIGURE) as (keyof typeof SHOT_FIGURE)[]).filter((s) => hasCase || !s.includes('case') && s !== 'exploded')
      if (!inputs) notes.push('No board yet: no renders.')
      else if (shots.every((s) => !stale(manifest[SHOT_FIGURE[s]], inputs, a.quality))) kept.push(...shots.map((s) => SHOT_FIGURE[s]))
      else {
        if (!hasCase) notes.push('No case built yet (mech.build): the board is rendered on its own.')
        const r = await call([showcase], 'render.showcase', { revision: a.revision, ...(a.project ? { project: a.project } : {}), shots, quality: a.quality, mask_color: a.mask_color, silk_color: a.silk_color }, ctx)
        const run = String(r.run_id)
        const byShot = new Map(Object.entries((r.shots ?? {}) as Record<string, string>).map(([name, shot]) => [shot, name]))
        const work = new Work()
        try {
          for (const s of shots) {
            const name = byShot.get(s)
            // release-quality pictures may be kept in the installation's storage (src/core/artifact-store.ts)
            const bytes = name ? await readOutput(work, run, name) : null
            if (!bytes) throw new ToolError(`render.showcase made no ${s} picture (run ${run})`)
            const key = SHOT_FIGURE[s]
            const file = `${FIGURES_DIR}/${key}.png`
            writeFileSync(join(root, file), bytes)
            manifest[key] = { file, kind: key, source: `run:${run}`, inputs, quality: a.quality, made: now }
            made.push(manifest[key]!)
          }
        } finally {
          work.db.close()
        }
      }
    }

    if (a.drawings) {
      const step = 'mechanical/out/case.step'
      if (!existsSync(join(root, step))) notes.push('No case built yet (mech.build): no mechanical drawings.')
      else {
        const inputs = createHash('sha256').update(readFileSync(join(root, step))).digest('hex').slice(0, 16)
        if (!stale(manifest['mech-drawing'], inputs) && !stale(manifest['mech-exploded'], inputs)) kept.push('mech-drawing', 'mech-exploded')
        else {
          const local = backendFor({ kind: 'cad' }) === 'local'
          const python = local ? process.env.TRACE_PYTHON || 'python3' : 'python3'
          const env: Record<string, string> = { PYTHONUNBUFFERED: '1', ...(local ? { PYTHONPATH: [pyDir(), process.env.PYTHONPATH].filter(Boolean).join(':') } : {}) }
          const work = new Work()
          const id = work.start('docs.drawing', { subject: step, args: { step } })
          try {
            const r = await runJob({
              // the cad function's whole allowance: 600 s killed a 270-face case twice on it (test-esp32-run3 S19), a
              // drawing that took 64 s on a laptop; four exact hidden-line projections are slow there
              kind: 'cad', timeoutSeconds: FUNCTION_MAX_SECONDS, env, inputs: { 'case.step': join(root, step) }, outputs: ['drawing.svg', 'exploded.svg', 'drawing.json'],
              argv: [python, '-m', 'tracebridge.mech', 'drawing', '--step', '{in:case.step}', '--out', '{dir}/out'],
            })
            const svg = r.outputs['drawing.svg']
            const exploded = r.outputs['exploded.svg']
            if (r.exitCode !== 0 || !svg || !exploded) {
              const why = (r.stdout || r.stderr).trim().slice(-500)
              work.finish(id, 'fail', `The case could not be drawn: ${why}`)
              throw new ToolError(`the case could not be drawn: ${why}`)
            }
            const facts = r.outputs['drawing.json'] ? JSON.parse(readFileSync(r.outputs['drawing.json'], 'utf8')) as Record<string, unknown> : {}
            for (const [key, path, kind] of [['mech-drawing', svg, 'mech-drawing'], ['mech-exploded', exploded, 'mech-drawing']] as const) {
              const bytes = readFileSync(path)
              work.artifact(id, `${key}.svg`, bytes, 'image/svg+xml')
              const file = `${FIGURES_DIR}/${key}.svg`
              writeFileSync(join(root, file), bytes)
              manifest[key] = { file, kind, source: `run:${id}`, inputs, made: now }
              made.push(manifest[key]!)
              rmSync(path, { force: true })
            }
            for (const k of ['width_mm', 'depth_mm', 'height_mm']) if (typeof facts[k] === 'number') work.measure(id, k, facts[k] as number, 'mm')
            work.finish(id, 'pass', `Case drawn: ${String(facts.width_mm)} × ${String(facts.depth_mm)} × ${String(facts.height_mm)} mm`, facts)
          } finally {
            work.db.close()
          }
        }
      }
    }

    if (a.timing) {
      const db = openProject()
      let models: { id: string; protocol: string }[] = []
      try {
        const rows = db.prepare("SELECT id, args FROM runs WHERE kind='protocol.model' AND status='pass' ORDER BY started DESC").all() as { id: string; args: string | null }[]
        const seen = new Set<string>()
        for (const r of rows) {
          let p = ''
          try { p = String((JSON.parse(r.args ?? '{}') as { protocol?: string }).protocol ?? '') } catch { /* no args */ }
          if (!p || !/^[a-z0-9]+$/.test(p) || seen.has(p)) continue
          seen.add(p)
          models.push({ id: r.id, protocol: p })
        }
      } finally {
        db.close()
      }
      if (!models.length) notes.push('No protocol modelled yet (protocol.model): no timing diagrams.')
      for (const m of models) {
        const key = `timing-${m.protocol}`
        if (!stale(manifest[key], m.id)) { kept.push(key); continue }
        const file = `${FIGURES_DIR}/${key}.svg`
        const r = await call(protocolTools, 'protocol.diagram', { run_id: m.id, transaction: 0, title: `${m.protocol.toUpperCase()} exchange`, png: false, out: file }, ctx)
        if (!existsSync(join(root, file))) throw new ToolError(`protocol.diagram wrote no diagram for ${m.protocol} (run ${String(r.run_id)})`)
        manifest[key] = { file, kind: 'timing-diagram', source: `run:${String(r.run_id)}`, inputs: m.id, made: now }
        made.push(manifest[key]!)
      }
      models = []
    }

    writeFileSync(join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
    return { made, kept, figures: Object.values(manifest), notes }
  },
})

export const figureTools: AnyTool[] = [values, figures]
