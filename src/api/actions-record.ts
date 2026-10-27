/**
 * The project tabs that read the record (docs/ui-design.md "Project page"): what the screens draw, from what the
 * record holds today, with everything it does not hold yet said plainly (`notes`) rather than made up.
 *
 *   requirements.trace  read    each requirement with its evidence status (verified | failing | untested | waived:
 *                               test items and results, and the journey's waivers), its tests and the intent lines it
 *                               is derived from; the intent statements (src/tools/design: agents propose, people
 *                               accept, edit or reject; rejected ones are left out) with their state, flags, source
 *                               and whether a requirement covers them; `links` (requirement → intent). `intent_note`
 *                               only while no statement is recorded
 *   design.get          read    the KiCad files of the default branch: one sheet per schematic file with the findings
 *                               of the latest electrical rule check (by sheet, each placed on the sheet's drawing when
 *                               the drawing's page size is known), the requirements it serves (design.sheets) and its
 *                               drawing (the newest kicad.export that kept them: runs/<id>/sheets/<file>.svg); the
 *                               board with the latest design rule check's findings, its size and layers, and its
 *                               picture; the architecture (every option with blocks, connections and scores; the
 *                               criteria; the chosen option, else trace's recommendation, drawn); the pin plan, each
 *                               pin with its status from the pin plan check against the newest netlist in the record,
 *                               and which parts' plans a person agreed (stale when the plan changed since). `notes`
 *                               says what is still not recorded
 *
 * build.get, order.record and the rest of the Build tab's record are in actions-build.ts; cost.get in actions-cost.ts.
 */
import { loadJourney } from '../core/journey.js'
import { type Context, Repo, def, withRecordDb } from './action-kit.js'
import { standing } from '../tools/design/decisions.js'
import { TOPIC_NAMES } from '../tools/design/db.js'
import { type ArchitectureView, architectureView, intentView, linksView, pinCheck, pinPlanPrint } from '../tools/design/record.js'
import { type Finding, checkFindings, designOf, latestDrawings, latestNetlist, latestRun, placeOn, requirementEvidence, runImages, runResult, sheetFileOf } from './record-read.js'

const iso = (t: number | null): string | null => (t === null ? null : new Date(t * 1000).toISOString())

/** A finding as the app's pictures draw it (PictureFinding), with KiCad's position in millimetres. */
const pictureFinding = (f: Finding, drawing?: Parameters<typeof placeOn>[1]) => {
  const at = placeOn(f, drawing)
  return {
    id: f.id, severity: f.severity, text: f.text, where: f.ref ?? f.where, sheet: f.where, ...(f.x_mm !== null ? { x_mm: f.x_mm, y_mm: f.y_mm } : {}), ...(at ? { at } : {}),
    source: { kind: 'run' as const, id: f.run, label: `run ${f.run.slice(0, 8)}` },
  }
}

/** A block as the diagram draws it: its key part (the first marked key, else the first), what it serves, where. */
const blockOut = (b: ArchitectureView['options'][number]['blocks'][number]) => {
  const key = b.parts.find((p) => p.key) ?? b.parts[0]
  return { id: b.id, name: b.name, ...(b.role ? { role: b.role } : {}), ...(key ? { part: key.mpn } : {}), parts: b.parts, serves: b.serves, x: b.x, y: b.y }
}

/** The KiCad files of the default branch (schematics and boards), sorted. */
export async function kicadFiles(ctx: Context, repo: string): Promise<{ sch: string[]; pcb: string[]; ref: string }> {
  const gh = await ctx.deps.github()
  const { branch } = await gh.defaultBranch(repo)
  const t = await gh.tree(repo, branch)
  const skip = /(^|\/)(\.git|node_modules)(\/|$)|-backups\/|(^|\/)~?_autosave-/
  const paths = t.files.map((f) => f.path).filter((p) => !skip.test(p)).sort()
  return { sch: paths.filter((p) => p.endsWith('.kicad_sch')), pcb: paths.filter((p) => p.endsWith('.kicad_pcb')), ref: branch }
}

const sheetName = (path: string): string => (path.split('/').pop() ?? path).replace(/\.kicad_sch$/, '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase())

export const RECORD_ACTIONS = {
  'requirements.trace': def('read', Repo, async ({ repo }, ctx) => withRecordDb(ctx, repo, (db) => {
    const r = loadJourney(db)
    const requirements = requirementEvidence(db, r)
    const count = (e: string): number => requirements.filter((x) => x.evidence === e).length
    const d = designOf(db)
    const view = intentView(d.rows, d.decisions)
    const live = new Set(requirements.map((q) => q.id))
    const links = linksView(d.rows).filter((l) => live.has(l.requirement))
    const intent = view.filter((s) => s.state !== 'rejected' && s.kind !== 'question').map((s) => ({
      id: s.id, topic: TOPIC_NAMES[s.topic], text: s.words, state: s.state, kind: s.kind, flags: s.flags,
      source: s.source, ...(s.decided ? { decided: s.decided } : {}), ...(s.uncovered !== null ? { uncovered: s.uncovered } : {}),
      covered: links.some((l) => l.intent === s.id),
    }))
    return {
      repo, intent, links,
      ...(intent.length ? {} : { intent_note: 'No intent statements are recorded yet: the Intent builder writes them (an agent proposes each line, a person accepts it), and each requirement then links back to the line it came from.' }),
      requirements: requirements.map((q) => ({ ...q, derived_from: links.filter((l) => l.requirement === q.id).map((l) => l.intent) })),
      summary: {
        requirements: requirements.length, verified: count('verified'), failing: count('failing'), untested: count('untested'), waived: count('waived'),
        intent: intent.length, accepted: intent.filter((s) => s.state === 'accepted' || s.state === 'edited').length, uncovered: intent.filter((s) => !s.covered && s.uncovered === undefined).length,
        unlinked: requirements.filter((q) => !links.some((l) => l.requirement === q.id)).length,
      },
    }
  })),

  'design.get': def('read', Repo, async ({ repo }, ctx) => {
    const files = await kicadFiles(ctx, repo)
    return withRecordDb(ctx, repo, (db) => {
      const r = loadJourney(db)
      const notes: string[] = []
      const erc = checkFindings(db, 'erc', r)
      const drc = checkFindings(db, 'drc', r)
      if (!erc.findings) notes.push(erc.unreadable)
      if (!drc.findings) notes.push(drc.unreadable)
      const design = designOf(db)
      const drawn = latestDrawings(db)
      const images = runImages(db, ['kicad.export', 'render.board'])
      const bySheet = new Map<string, Finding[]>()
      for (const f of erc.findings ?? []) {
        const file = sheetFileOf(f.where, files.sch) ?? '(no schematic file)'
        bySheet.set(file, [...(bySheet.get(file) ?? []), f])
      }
      const serves = new Map(design.rows.sheets.map((x) => [x.sheet, x]))
      const sheets = files.sch.map((path) => {
        // a drawing the latest export kept for this file; else an older run's SVG named like the sheet
        const d = drawn?.drawings.find((x) => x.kind === 'sheet' && x.file === path)
        const old = d ? undefined : images.find((i) => i.kind === 'kicad.export' && i.name.toLowerCase().includes(sheetName(path).toLowerCase().replace(/ /g, '-')))
        const named = serves.get(path)
        return {
          id: path, name: sheetName(path),
          ...(d ? { path: d.path } : old ? { path: old.path } : {}),
          ...(named ? { serves: named.requirements, ...(named.block ? { block: named.block } : {}), ...(named.reason ? { serves_none: named.reason } : {}) } : {}),
          findings: (bySheet.get(path) ?? []).map((f) => pictureFinding(f, d)),
        }
      })
      if (files.sch.length && !sheets.some((x) => x.path)) notes.push('No drawing of the sheets is in the record yet: kicad.export with sch_svg keeps one per sheet in its run.')
      const unnamed = files.sch.filter((f) => !serves.has(f))
      if (files.sch.length && unnamed.length) notes.push(`${unnamed.length} of ${files.sch.length} sheets do not name the requirements they serve yet (design.sheets).`)
      const boardRun = latestRun(db, 'kicad.board')
      const result = boardRun ? runResult(db, boardRun.id) : null
      const outline = result?.outline as { width_mm?: number; height_mm?: number } | null | undefined
      const boardSvg = drawn?.drawings.find((x) => x.kind === 'board')
      const top = images.find((i) => i.kind === 'render.board' && /^top\.png$/i.test(i.name)) ?? images.find((i) => i.kind === 'render.board')
      const render = drawn?.drawings.find((x) => x.kind === 'render')
      const pic = boardSvg ? { path: boardSvg.path, drawing: boardSvg } : top ? { path: top.path, drawing: undefined } : render ? { path: render.path, drawing: undefined } : null
      const board = files.pcb.length ? {
        file: files.pcb[0],
        ...(pic ? { path: pic.path } : {}),
        ...(render && pic?.path !== render.path ? { render: render.path } : {}),
        ...(Array.isArray(result?.layers) ? { layers: (result.layers as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
        ...(outline?.width_mm ? { size: `${outline.width_mm} × ${outline.height_mm} mm` } : {}),
        findings: (drc.findings ?? []).map((f) => pictureFinding(f, pic?.drawing)),
      } : undefined
      if (board && !pic) notes.push('No picture of the board is in the record yet: kicad.export with pcb_svg, or render.board, stores one.')
      // the architecture: the option a person chose, else trace's recommendation, drawn; every option listed
      const arch = architectureView(design.rows, design.decisions)
      const shown = arch.options.find((o) => o.id === arch.current)
      const architecture = shown ? {
        option: `Option ${shown.id}: ${shown.name}`, id: shown.id, state: arch.chosen?.option === shown.id ? 'chosen' as const : 'proposed' as const,
        blocks: shown.blocks.map(blockOut), connections: shown.connections.map((c) => ({ from: c.from, to: c.to, label: c.label, kind: c.kind })),
        options: arch.options.map((o) => ({ id: o.id, name: o.name, summary: o.summary, recommended: o.recommended, why: o.why, gives_up: o.gives_up, risks: o.risks, total: o.total, blocks: o.blocks.map(blockOut), connections: o.connections.map((c) => ({ from: c.from, to: c.to, label: c.label, kind: c.kind })) })),
        criteria: arch.criteria, fixed: arch.fixed, scores: arch.scores, recommended: arch.recommended, chosen: arch.chosen,
      } : undefined
      if (!shown) notes.push('No architecture is recorded yet: the agents propose options with design.architecture, and a person chooses one in Architecture choice.')
      else if (!arch.chosen) notes.push(`No architecture is chosen yet: the diagram shows trace's ${arch.recommended ? 'recommendation' : 'first option'}, until a person chooses in Architecture choice.`)
      if (shown) notes.push('Stock per key part is not in the record: the parts check (parts.search) answers it when asked, and the architecture gate\'s stock criterion records it.')
      // the pin plan, checked against the newest netlist in the record
      const net = latestNetlist(db)
      const pinFindings = pinCheck(design.rows.pins, net?.nets ?? null)
      const waived = new Set((r?.waivers ?? []).filter((w) => w.closedAt === null && w.targetKind === 'finding').map((w) => w.target))
      const agreed = standing(design.decisions, 'pins.agreed')
      const pins = design.rows.pins.filter((p) => p.status !== 'withdrawn').map((p) => {
        const mine = pinFindings.filter((f) => f.target === `pin:${p.part}.${p.pin}` || (p.peripheral && f.target === `peripheral:${p.part}.${p.peripheral}`) || (p.function && f.target === `peripheral:${p.part}.${p.function.toUpperCase()}`))
        const open = mine.filter((f) => !waived.has(f.id))
        const status = p.kind === 'spare' || p.kind === 'nc' ? (open.length ? 'conflict' as const : 'spare' as const) : open.some((f) => f.severity === 'blocks') ? 'conflict' as const : mine.length && !open.length ? 'waived' as const : 'ok' as const
        return {
          part: p.part, pin: p.pin, name: p.name, net: p.net ?? '', fn: p.function ?? (p.kind === 'spare' ? 'Spare' : p.kind), ...(p.peripheral ? { peripheral: p.peripheral } : {}), ...(p.use ? { use: p.use } : {}),
          ...(p.alternates.length ? { alt: p.alternates.join(', ') } : {}), ...(p.reserved ? { reserved: p.reserved } : {}), status,
          ...(open.length || p.note ? { note: [...open.map((f) => f.text), ...(p.note ? [p.note] : [])].join(' ') } : {}),
          findings: mine.map((f) => ({ id: f.id, severity: waived.has(f.id) ? 'waived' as const : f.severity, text: f.text })),
        }
      })
      const parts = [...new Set(pins.map((p) => p.part))]
      const pinPlan = pins.length ? {
        checked: net ? { run: net.run.id, at: iso(net.run.started) } : null,
        parts: parts.map((part) => {
          const a = agreed.get(part)
          const stale = a ? a.detail.print !== pinPlanPrint(design.rows.pins, part) : false
          return { part, pins: pins.filter((p) => p.part === part).length, agreed: a ? { by: a.by, at: iso(a.at) as string, stale } : null }
        }),
        findings: pinFindings.map((f) => ({ ...f, severity: waived.has(f.id) ? 'waived' as const : f.severity })),
      } : undefined
      if (!pins.length) notes.push('No pin plan is recorded yet: the firmware track proposes it with design.pins, and a person agrees it in Pin plan review.')
      else if (!net) notes.push('The pin plan has not been checked against the schematic yet: design.pins check (or kicad.netlist) stores the netlist it is compared with.')
      return {
        repo, ref: files.ref, sheets, ...(board ? { board } : {}), ...(architecture ? { architecture } : {}),
        ...(pins.length ? { pins, pin_plan: pinPlan } : {}),
        ...(drawn ? { drawings: { run: drawn.run.id, at: iso(drawn.run.started) } } : {}),
        checks: {
          erc: erc.run ? { run: erc.run.id, at: iso(erc.run.started), status: erc.run.status, summary: erc.run.summary } : null,
          drc: drc.run ? { run: drc.run.id, at: iso(drc.run.started), status: drc.run.status, summary: drc.run.summary } : null,
        },
        notes,
      }
    })
  }),

}
