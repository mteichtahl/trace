/**
 * The project tabs that read the record (docs/ui-design.md "Project page"): what the screens draw, from what the
 * record holds today, with everything it does not hold yet said plainly (`notes`) rather than made up.
 *
 *   requirements.trace  read    each requirement with its evidence status (verified | failing | untested | waived:
 *                               test items and results, and the journey's waivers) and its tests; the intent lines
 *                               and each requirement's link to one (`intent`, `links`: empty, with `intent_note`, since
 *                               the record keeps no intent yet)
 *   design.get          read    the KiCad files of the default branch: one sheet per schematic file with the findings
 *                               of the latest electrical rule check (by sheet), the board with the latest design rule
 *                               check's findings, its size and layers from the latest kicad.board run, and a picture
 *                               where a run stored one (an SVG or PNG artifact, as runs/<id>/<name> for files.url).
 *                               The block diagram and the pin plan: none is recorded yet (`notes`)
 *
 * build.get, order.record and the rest of the Build tab's record are in actions-build.ts; cost.get in actions-cost.ts.
 */
import { loadJourney } from '../core/journey.js'
import { type Context, Repo, def, withRecordDb } from './action-kit.js'
import { type Finding, checkFindings, latestRun, requirementEvidence, runImages, runResult, sheetFileOf } from './record-read.js'

const iso = (t: number | null): string | null => (t === null ? null : new Date(t * 1000).toISOString())

/** A finding as the app's pictures draw it (PictureFinding), with KiCad's position in millimetres. */
const pictureFinding = (f: Finding) => ({
  id: f.id, severity: f.severity, text: f.text, where: f.ref ?? f.where, sheet: f.where, ...(f.x_mm !== null ? { x_mm: f.x_mm, y_mm: f.y_mm } : {}),
  source: { kind: 'run' as const, id: f.run, label: `run ${f.run.slice(0, 8)}` },
})

/** The KiCad files of the default branch (schematics and boards), sorted. */
async function kicadFiles(ctx: Context, repo: string): Promise<{ sch: string[]; pcb: string[]; ref: string }> {
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
    return {
      repo,
      intent: [] as { id: string; topic: string; text: string }[],
      links: [] as { requirement: string; intent: string }[],
      intent_note: 'The record keeps no intent statements yet, so there is nothing for a requirement to link back to. The Intent builder needs to store them (an intent table with each requirement\'s derived-from link) before this column can be drawn.',
      requirements,
      summary: { requirements: requirements.length, verified: count('verified'), failing: count('failing'), untested: count('untested'), waived: count('waived') },
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
      const images = runImages(db, ['kicad.export', 'render.board'])
      const bySheet = new Map<string, Finding[]>()
      for (const f of erc.findings ?? []) {
        const file = sheetFileOf(f.where, files.sch) ?? '(no schematic file)'
        bySheet.set(file, [...(bySheet.get(file) ?? []), f])
      }
      const sheets = files.sch.map((path) => ({
        id: path, name: sheetName(path),
        // a drawing only where a run stored one: kicad.export writes its SVGs to the clone, not the record
        ...((): { path?: string } => { const img = images.find((i) => i.kind === 'kicad.export' && i.name.toLowerCase().includes(sheetName(path).toLowerCase().replace(/ /g, '-'))); return img ? { path: img.path } : {} })(),
        findings: (bySheet.get(path) ?? []).map(pictureFinding),
      }))
      if (files.sch.length && !sheets.some((s) => s.path)) notes.push('No drawing of the sheets is in the record: kicad.export writes its SVGs into the working copy, not the run record, so they are not kept yet.')
      const boardRun = latestRun(db, 'kicad.board')
      const result = boardRun ? runResult(db, boardRun.id) : null
      const outline = result?.outline as { width_mm?: number; height_mm?: number } | null | undefined
      const top = images.find((i) => i.kind === 'render.board' && /^top\.png$/i.test(i.name)) ?? images.find((i) => i.kind === 'render.board')
      const board = files.pcb.length ? {
        file: files.pcb[0],
        ...(top ? { path: top.path } : {}),
        ...(Array.isArray(result?.layers) ? { layers: (result.layers as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
        ...(outline?.width_mm ? { size: `${outline.width_mm} × ${outline.height_mm} mm` } : {}),
        findings: (drc.findings ?? []).map(pictureFinding),
      } : undefined
      if (board && !top) notes.push('No picture of the board is in the record yet: render.board stores one when the board is rendered.')
      notes.push('No architecture record is kept yet, so there is no block diagram: Architecture choice needs to store its blocks and connections.')
      notes.push('No pin plan is kept yet: Pin plan review needs to store each pin with its net and function.')
      return {
        repo, ref: files.ref, sheets, ...(board ? { board } : {}),
        checks: {
          erc: erc.run ? { run: erc.run.id, at: iso(erc.run.started), status: erc.run.status, summary: erc.run.summary } : null,
          drc: drc.run ? { run: drc.run.id, at: iso(drc.run.started), status: drc.run.status, summary: drc.run.summary } : null,
        },
        notes,
      }
    })
  }),

}
