/**
 * fab.import (docs/fab-import.md): record a release package that was imported rather than built. It reads the files a
 * project started from fabrication files keeps in its repository (the Gerber zip, the JLCPCB BOM and CPL, and the
 * overview), inspects them as the import did, and records an `import.fab` run whose result has kicad.fab's shape
 * (files, order options, placements, parts placed by hand, problems), so the order sheet, Order submit, quotes and the
 * Build page read it as the release package. It changes no file: a problem is a question for a person.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { defineTool, ToolError, type AnyTool } from '../../core/registry.js'
import { findRoot } from '../../core/store.js'
import { recorded } from '../kicad/record.js'
import { inspect, inspectionView } from './inspect.js'

/** The package's files in `dir`: a Gerber zip, a BOM and a CPL by their names. Pure apart from reading the folder. */
export function packageFiles(dir: string): { gerbers: string | null; bom: string | null; cpl: string | null } {
  const names = existsSync(dir) ? readdirSync(dir) : []
  const find = (re: RegExp): string | null => names.find((n) => re.test(n)) ?? null
  return { gerbers: find(/-gerbers\.zip$/i) ?? find(/\.zip$/i), bom: find(/jlc-bom\.csv$/i) ?? find(/bom.*\.csv$/i), cpl: find(/jlc-cpl\.csv$/i) ?? find(/(cpl|pos|placement|pick).*\.csv$/i) }
}

const fabImport = defineTool({
  name: 'fab.import',
  description: 'Record an imported release package (a project started from fabrication files, docs/fab-import.md): reads the Gerber zip, the JLCPCB BOM and CPL in dir and the overview, inspects them (layers, outline, drills, BOM against placements, stock in the BOM), and records an import.fab run with the files, the board options for the order form (order_options), placements and the parts placed by hand, which the order sheet reads as the release package. Changes no file. Cite its run when recording fabricate.order.package.',
  input: z.object({
    dir: z.string().describe('the folder holding the imported files, relative to the repository: hardware/<board>/release/rev<revision>'),
    overview: z.string().default('docs/overview.md').describe('the project overview, relative to the repository'),
    boards: z.number().int().min(1).default(1).describe('boards per build: what the BOM\'s stock is checked against'),
  }),
  run: async (a) => {
    const root = findRoot() ?? process.cwd()
    const dir = isAbsolute(a.dir) ? a.dir : resolve(root, a.dir)
    const rel = relative(root, dir)
    if (rel.startsWith('..')) throw new ToolError(`${a.dir} is outside the repository`)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ToolError(`${a.dir}: no such folder; the imported files are in hardware/<board>/release/rev<revision>`)
    const f = packageFiles(dir)
    const read = (name: string | null): Buffer | null => (name ? readFileSync(join(dir, name)) : null)
    const overviewPath = resolve(root, a.overview)
    return recorded('import.fab', rel, a, async (run) => {
      const x = inspect({
        gerbers: read(f.gerbers), bom: read(f.bom)?.toString('utf8') ?? null, cpl: read(f.cpl)?.toString('utf8') ?? null,
        overview: existsSync(overviewPath) ? readFileSync(overviewPath, 'utf8') : '', quantity: a.boards,
      })
      const v = inspectionView(x)
      run.artifact('inspection.json', JSON.stringify(v, null, 2), 'application/json')
      run.artifact('order-options.json', JSON.stringify(x.order_options, null, 2), 'application/json')
      // the parts list in kicad.fab's bom.csv columns, which Order submit matches JLCPCB's page against
      if (x.bom) {
        const q = (s: string | null): string => (s === null ? '' : /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
        run.artifact('bom.csv', ['Quantity,References,Value,Footprint,MPN,Manufacturer,LCSC,Description', ...x.bom.lines.map((l) => [String(l.refs.length), l.refs.join(' '), l.value, l.footprint, l.mpn, l.manufacturer, l.lcsc, ''].map(q).join(','))].join('\n'), 'text/csv')
      }
      run.measure('placements', x.placements.length)
      run.measure('files', x.summary.files)
      const problems = x.findings.filter((y) => y.severity === 'blocking').map((y) => y.text)
      const warnings = x.findings.filter((y) => y.severity === 'warning').map((y) => y.text)
      const files = [f.gerbers, f.bom, f.cpl].filter((n): n is string => !!n).map((n) => ({ path: n, bytes: statSync(join(dir, n)).size }))
      const ok = problems.length === 0
      return {
        status: ok ? 'pass' as const : 'fail' as const,
        summary: ok ? `imported package: ${x.summary.board.layers}-layer ${x.summary.board.width_mm} × ${x.summary.board.height_mm} mm board, ${x.summary.bom.lines} BOM lines, ${x.placements.length} placements` : `imported package not ready (do not send it): ${problems.join('; ')}`,
        result: {
          project: x.summary.project.name, out_dir: rel, house: 'jlcpcb', imported: true, problems, notes: x.findings.filter((y) => y.severity === 'note').map((y) => y.text),
          placements: x.placements.length, hand_placed: x.hand_placed, warnings, files_total: files.length, files, order_options: x.order_options,
          board: x.summary.board, bom: x.summary.bom, tool: x.summary.tool,
        },
      }
    })
  },
})

export const tools: AnyTool[] = [fabImport]
