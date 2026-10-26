/**
 * The kicad tools: what a Claude Code agent can ask about a KiCad 6–10 project, through the CLI or MCP.
 *
 * Every tool takes an optional `project`: a path to a .kicad_pro, .kicad_sch or .kicad_pcb (or a folder holding one
 * project), or nothing for the single project configured in `electronics.projects` or found in the repository (more
 * than one → an error listing them). Answers are compact dicts with units in the key names (length_mm, z0_ohm), long
 * lists are capped with a count of what was left out, and every run is recorded in the project's run record
 * (`run_id` in the answer) with its full outputs stored there as artifacts.
 *
 * Reading files (components, board, net lengths) is done here; anything that needs KiCad's own understanding
 * (connectivity, ERC, DRC, plots, placement files) runs kicad-cli and fails with a clear ToolError without it.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { defineTool, ToolError, type AnyTool } from '../../core/registry.js'
import { buildBom, bomCsv, jlcBomCsv, jlcCplCsv, placements } from './bom.js'
import { drc, erc, type CheckReport } from './checks.js'
import { EXPORT_KINDS, exportOne, listFiles, outDirFor, zipDir, type ExportKind } from './export.js'
import { describeLayer, designRules, layerOf, loadBoard, Net, netNames, stackupKnown, type Board } from './pcb.js'
import { candidates, fileVersion, findKicadCli, fromPath, kicadCliVersion, needPcb, needSch, relTo, resolveProject, summary, type Project } from './project.js'
import { netlist, parts, powerNets, readSchematic, symbolSummary, type Symbol } from './schematic.js'
import { cap, recorded } from './record.js'

const project = z.string().optional().describe('path to a .kicad_pro, .kicad_sch or .kicad_pcb (or a folder with one project); omit for the configured/only project')
const limit = (d: number) => z.number().int().min(1).max(5000).default(d).describe(`maximum items listed (default ${d}); totals are always given`)

/** The run record's subject: the project file, relative to the working directory when it is inside it. */
const subject = (p: Project): string => {
  const f = p.pro ?? p.sch ?? p.pcb ?? p.name
  const r = relative(process.cwd(), f)
  return r && !r.startsWith('..') && !isAbsolute(r) ? r : f
}
const round = (x: number, d = 4): number => Math.round(x * 10 ** d) / 10 ** d
const POUR_NOTE = 'connectivity follows tracks and vias; copper pours (zones) are not filled, so pads joined only by a pour show as unreached'

// ------------------------------------------------------------------ kicad.projects

const projects = defineTool({
  name: 'kicad.projects',
  description: 'KiCad projects in this repository (configured in electronics.projects, else discovered *.kicad_pro): schematic/board files, the KiCad version that wrote them, and the kicad-cli available.',
  input: z.object({}),
  run: async () => recorded('kicad.projects', null, {}, async () => {
    const { root, files } = await candidates()
    const list = files.filter((f) => existsSync(f)).map((f) => summary(fromPath(f), root))
    const missing = files.filter((f) => !existsSync(f)).map((f) => relTo(root, f))
    const cli = findKicadCli()
    return {
      status: 'pass' as const,
      summary: `${list.length} project(s)`,
      result: { root, projects: list, missing, kicad_cli: cli, kicad_cli_version: cli ? await kicadCliVersion() : null },
    }
  }),
})

// ------------------------------------------------------------------ kicad.components

const components = defineTool({
  name: 'kicad.components',
  description: 'Parts placed in the schematic (all hierarchical sheets): reference, value, footprint, lib_id, sheet, MPN/manufacturer/LCSC and other fields, DNP/in_bom/on_board flags. Filter by reference prefix or text.',
  input: z.object({
    project,
    refs: z.array(z.string()).optional().describe('only these references (exact)'),
    prefix: z.string().optional().describe('only references starting with this (e.g. "U", "C")'),
    match: z.string().optional().describe('case-insensitive text matched against value, footprint, lib_id and fields'),
    include_power: z.boolean().default(false).describe('include power symbols and flags (#PWR, #FLG)'),
    fields: z.boolean().default(true).describe('include non-standard fields'),
    limit: limit(200),
  }),
  run: async (a) => {
    const p = await resolveProject(a.project)
    return recorded('kicad.components', subject(p), a, async () => {
      const sch = readSchematic(needSch(p), p.name)
      let list: Symbol[] = parts(sch, a.include_power)
      if (a.refs?.length) {
        const want = new Set(a.refs)
        list = list.filter((s) => want.has(s.ref))
      }
      if (a.prefix) list = list.filter((s) => s.ref.startsWith(a.prefix as string))
      if (a.match) {
        const m = a.match.toLowerCase()
        list = list.filter((s) => [s.value, s.footprint, s.lib_id, ...Object.values(s.fields)].some((v) => v.toLowerCase().includes(m)))
      }
      const c = cap(list, a.limit)
      const byPrefix: Record<string, number> = {}
      for (const s of list) {
        const k = /^[A-Za-z#_]+/.exec(s.ref)?.[0] ?? '?'
        byPrefix[k] = (byPrefix[k] ?? 0) + 1
      }
      return {
        status: 'pass' as const,
        summary: `${list.length} parts`,
        result: {
          project: p.name, schematic_version: sch.version, title: sch.title, total: list.length, omitted: c.omitted,
          by_prefix: byPrefix, sheets: sch.sheets.length, dnp: list.filter((s) => s.dnp).length,
          problems: sch.problems, components: c.items.map((s) => symbolSummary(s, a.fields)),
        },
      }
    })
  },
})

// ------------------------------------------------------------------ kicad.netlist / kicad.net

const netlistTool = defineTool({
  name: 'kicad.netlist',
  description: 'The schematic\'s nets from kicad-cli (KiCad\'s own connectivity): each net with its pin count and (for small nets) its pins. Needs kicad-cli.',
  input: z.object({
    project,
    match: z.string().optional().describe('only nets whose name contains this (case-insensitive)'),
    pins: z.boolean().default(true).describe('list each net\'s pins (ref.pin) for nets up to max_pins'),
    max_pins: z.number().int().min(1).max(1000).default(12),
    limit: limit(300),
  }),
  run: async (a) => {
    const p = await resolveProject(a.project)
    return recorded('kicad.netlist', subject(p), a, async (run) => {
      const nl = await netlist(needSch(p))
      let names = [...nl.nets.keys()].sort()
      if (a.match) names = names.filter((n) => n.toLowerCase().includes((a.match as string).toLowerCase()))
      const single = [...nl.nets].filter(([, ns]) => ns.length === 1).map(([n]) => n)
      const c = cap(names, a.limit)
      run.measure('nets', nl.nets.size)
      run.measure('components', nl.components.size)
      run.artifact('nets.tsv', [...nl.nets].map(([n, ns]) => `${n}\t${ns.map((x) => `${x.ref}.${x.pin}`).join(' ')}`).join('\n'))
      return {
        status: 'pass' as const,
        summary: `${nl.nets.size} nets, ${nl.components.size} components`,
        result: {
          project: p.name, nets_total: nl.nets.size, components_total: nl.components.size, listed: names.length, omitted: c.omitted,
          single_pin_nets: single.length, single_pin_examples: single.slice(0, 20),
          nets: c.items.map((n) => {
            const ns = nl.nets.get(n) ?? []
            const row: { name: string; pins: number; class?: string; nodes?: string[] } = { name: n, pins: ns.length }
            const cls = nl.classes.get(n)
            if (cls && cls !== 'Default') row.class = cls
            if (a.pins && ns.length <= a.max_pins) row.nodes = ns.map((x) => `${x.ref}.${x.pin}${x.function ? `(${x.function})` : ''}`)
            return row
          }),
        },
      }
    })
  },
})

const net = defineTool({
  name: 'kicad.net',
  description: 'One net in full: every pin on it (ref, pin, pin function, pin type, the part\'s value) from kicad-cli\'s netlist, and, when the project has a routed board, its routed length per layer, vias and unreached pads.',
  input: z.object({ project, name: z.string().min(1).describe('net name, e.g. "GND", "/SPI_MOSI", "Net-(R4-Pad2)"'), limit: limit(200) }),
  run: async (a) => {
    const p = await resolveProject(a.project)
    return recorded('kicad.net', subject(p), a, async () => {
      const nl = await netlist(needSch(p))
      let nodes = nl.nets.get(a.name)
      let name = a.name
      if (!nodes) {
        const alt = [...nl.nets.keys()].find((n) => n === `/${a.name}` || n.replace(/^.*\//, '') === a.name)
        if (!alt) {
          const close = [...nl.nets.keys()].filter((n) => n.toLowerCase().includes(a.name.toLowerCase())).slice(0, 15)
          throw new ToolError(`no net ${JSON.stringify(a.name)} in the schematic${close.length ? `; similar: ${close.join(', ')}` : ''}`)
        }
        name = alt
        nodes = nl.nets.get(alt) ?? []
      }
      const c = cap(nodes, a.limit)
      let routed: Record<string, unknown> | null = null
      if (p.pcb) {
        const b = loadBoard(p.pcb)
        if (netNames(b).includes(name)) {
          const n = new Net(b, name)
          routed = {
            length_mm: round(n.length_m * 1e3), by_layer_mm: Object.fromEntries([...n.byLayer()].map(([k, v]) => [k, round(v * 1e3)])),
            segments: n.segs.length, vias: n.vias.length, pads: n.pads.length, unreached_pads: n.unreached().slice(0, 50), note: POUR_NOTE,
          }
        } else routed = { note: 'net not present on the board' }
      }
      return {
        status: 'pass' as const,
        summary: `${name}: ${nodes.length} pins`,
        result: {
          project: p.name, net: name, class: nl.classes.get(name) ?? null, pins: nodes.length, omitted: c.omitted,
          nodes: c.items.map((x) => ({ ref: x.ref, pin: x.pin, function: x.function, type: x.type, value: nl.components.get(x.ref)?.value ?? null })),
          routed,
        },
      }
    })
  },
})

// ------------------------------------------------------------------ kicad.erc / kicad.drc

function compactReport(r: CheckReport, max: number, severity: 'all' | 'error' | 'warning'): Record<string, unknown> {
  const vs = severity === 'all' ? r.violations : r.violations.filter((v) => v.severity === severity)
  const c = cap(vs, max)
  return {
    kicad_version: r.kicad_version, errors: r.errors, warnings: r.warnings, excluded: r.excluded, by_type: r.by_type,
    ...(r.unconnected !== undefined ? { unconnected: r.unconnected, parity_issues: r.parity } : {}),
    listed: vs.length, omitted: c.omitted,
    violations: c.items.map((v) => ({ type: v.type, severity: v.severity, description: v.description, where: v.where,
      items: v.items.slice(0, 6).map((i) => ({ ref: i.ref, uuid: i.uuid, description: i.description, pos: i.pos })) })),
  }
}

const severity = z.enum(['all', 'error', 'warning']).default('all').describe('which violations to list (counts always cover all)')

const ercTool = defineTool({
  name: 'kicad.erc',
  description: 'Electrical rules check by KiCad (kicad-cli sch erc --severity-all): error/warning/excluded counts, counts by type, and violations with the symbols they name. The full report is stored with the run. Needs kicad-cli.',
  input: z.object({ project, severity, limit: limit(50) }),
  run: async (a) => {
    const p = await resolveProject(a.project)
    return recorded('kicad.erc', subject(p), a, async (run) => {
      const [r, raw] = await erc(needSch(p))
      run.artifact('erc-report.json', raw, 'application/json')
      run.measure('errors', r.errors)
      run.measure('warnings', r.warnings)
      run.measure('excluded', r.excluded)
      return { status: r.errors ? 'fail' as const : 'pass' as const, summary: `ERC: ${r.errors} errors, ${r.warnings} warnings`,
        result: { project: p.name, ...compactReport(r, a.limit, a.severity) } }
    })
  },
})

const drcTool = defineTool({
  name: 'kicad.drc',
  description: 'Design rules check by KiCad (kicad-cli pcb drc --severity-all, with schematic parity by default): counts by severity and type, unconnected items, parity issues, and violations with the items they name. The full report is stored with the run. Needs kicad-cli; large boards take a minute.',
  input: z.object({
    project, severity, limit: limit(50),
    parity: z.boolean().default(true).describe('also check the board against the schematic'),
    refill_zones: z.boolean().default(false).describe('refill zones before checking (the board file is not saved)'),
  }),
  run: async (a) => {
    const p = await resolveProject(a.project)
    return recorded('kicad.drc', subject(p), a, async (run) => {
      const [r, raw] = await drc(needPcb(p), { parity: a.parity && p.sch !== null, refillZones: a.refill_zones })
      run.artifact('drc-report.json', raw, 'application/json')
      run.measure('errors', r.errors)
      run.measure('warnings', r.warnings)
      run.measure('unconnected', r.unconnected ?? null)
      run.measure('parity', r.parity ?? null)
      return { status: r.errors ? 'fail' as const : 'pass' as const,
        summary: `DRC: ${r.errors} errors, ${r.warnings} warnings, ${r.unconnected ?? 0} unconnected`,
        result: { project: p.name, ...compactReport(r, a.limit, a.severity) } }
    })
  },
})

// ------------------------------------------------------------------ kicad.bom / kicad.fab

const bom = defineTool({
  name: 'kicad.bom',
  description: 'Bill of materials from the schematic: lines grouped by value, footprint and part number (MPN/manufacturer/LCSC fields), quantities, references in natural order; DNP and BOM-excluded parts listed apart. Optionally writes the CSV (and the JLCPCB BOM) to out_dir.',
  input: z.object({
    project, limit: limit(150),
    out_dir: z.string().optional().describe('write <name>-bom.csv (and with jlc, <name>-jlc-bom.csv) here'),
    jlc: z.boolean().default(false).describe('also produce the JLCPCB BOM (Comment, Designator, Footprint, LCSC Part #)'),
  }),
  run: async (a) => {
    const p = await resolveProject(a.project)
    return recorded('kicad.bom', subject(p), a, async (run) => {
      const b = buildBom(readSchematic(needSch(p), p.name))
      const csv = bomCsv(b)
      run.artifact('bom.csv', csv, 'text/csv')
      run.measure('parts', b.total_parts)
      run.measure('lines', b.unique_lines)
      run.measure('missing_part_number', b.missing_part_number)
      const written: string[] = []
      if (a.jlc) run.artifact('jlc-bom.csv', jlcBomCsv(b), 'text/csv')
      if (a.out_dir) {
        const d = resolve(a.out_dir)
        mkdirSync(d, { recursive: true })
        writeFileSync(join(d, `${p.name}-bom.csv`), csv)
        written.push(join(d, `${p.name}-bom.csv`))
        if (a.jlc) {
          writeFileSync(join(d, `${p.name}-jlc-bom.csv`), jlcBomCsv(b))
          written.push(join(d, `${p.name}-jlc-bom.csv`))
        }
      }
      const c = cap(b.lines, a.limit)
      const noLcsc = b.lines.filter((l) => !l.lcsc).length
      return {
        status: 'pass' as const,
        summary: `${b.total_parts} parts in ${b.unique_lines} lines`,
        result: {
          project: p.name, total_parts: b.total_parts, unique_lines: b.unique_lines, missing_part_number: b.missing_part_number,
          ...(a.jlc ? { lines_without_lcsc: noLcsc } : {}),
          excluded: b.excluded.slice(0, 100), excluded_total: b.excluded.length, omitted: c.omitted, files: written,
          lines: c.items.map((l) => ({ qty: l.quantity, refs: l.refs.length > 30 ? [...l.refs.slice(0, 30), `…+${l.refs.length - 30}`] : l.refs,
            value: l.value, footprint: l.footprint, mpn: l.mpn, manufacturer: l.manufacturer, lcsc: l.lcsc })),
        },
      }
    })
  },
})

const fab = defineTool({
  name: 'kicad.fab',
  description: 'A fabrication + assembly package in out_dir: Gerbers and drill files (zipped), BOM CSV, placement file, and for JLCPCB the BOM and CPL in their columns. Lists the files and flags parts missing an LCSC code or a placement. Needs kicad-cli.',
  input: z.object({
    project,
    out_dir: z.string().optional().describe('default: <repo>/build/kicad/<project>/fab'),
    house: z.enum(['jlcpcb', 'generic']).default('jlcpcb'),
    zip: z.boolean().default(true).describe('zip gerbers + drill into <name>-gerbers.zip'),
  }),
  run: async (a) => {
    const p = await resolveProject(a.project)
    return recorded('kicad.fab', subject(p), a, async (run) => {
      const pcb = needPcb(p)
      const { root } = await candidates()
      const dir = outDirFor(a.out_dir, root, join(p.name, 'fab'))
      const files = { sch: p.sch, pcb, name: p.name }
      await exportOne('gerbers', files, dir)
      await exportOne('drill', files, dir)
      if (a.zip) zipDir(join(dir, 'gerbers'), join(dir, `${p.name}-gerbers.zip`))
      const warnings: string[] = []
      const pl = await placements(pcb)
      if (p.sch) {
        const b = buildBom(readSchematic(p.sch, p.name))
        writeFileSync(join(dir, `${p.name}-bom.csv`), bomCsv(b))
        run.artifact('bom.csv', bomCsv(b), 'text/csv')
        const placed = new Set(pl.map((x) => x.ref))
        const unplaced = b.lines.flatMap((l) => l.refs).filter((r) => !placed.has(r))
        if (unplaced.length) warnings.push(`${unplaced.length} BOM parts have no placement (not on the board, or through-hole excluded): ${unplaced.slice(0, 20).join(', ')}`)
        if (a.house === 'jlcpcb') {
          writeFileSync(join(dir, `${p.name}-jlc-bom.csv`), jlcBomCsv(b))
          const noL = b.lines.filter((l) => !l.lcsc)
          if (noL.length) warnings.push(`${noL.length} BOM lines have no LCSC code: ${noL.slice(0, 10).map((l) => `${l.refs[0] ?? ''} ${l.value}`).join('; ')}`)
        }
      } else warnings.push('no schematic: BOM files not produced')
      if (a.house === 'jlcpcb') {
        writeFileSync(join(dir, `${p.name}-jlc-cpl.csv`), jlcCplCsv(pl))
        run.artifact('jlc-cpl.csv', jlcCplCsv(pl), 'text/csv')
      }
      await exportOne('pos', files, dir)
      const out = listFiles(dir)
      run.artifact('files.txt', out.map((f) => `${f.path}\t${f.bytes}`).join('\n'))
      run.measure('files', out.length)
      run.measure('placements', pl.length)
      return { status: 'pass' as const, summary: `${out.length} fab files in ${dir}`,
        result: { project: p.name, out_dir: dir, house: a.house, placements: pl.length, warnings, files_total: out.length, files: out.slice(0, 80) } }
    })
  },
})

// ------------------------------------------------------------------ kicad.board / kicad.net_length

function boardSummary(b: Board, p: Project, widthMm: number | undefined): Record<string, unknown> {
  const fps = b.footprints
  const w = widthMm ? widthMm * 1e-3 : undefined
  return {
    kicad: b.kicad, title: b.title, thickness_mm: b.thickness_mm, outline: b.outline,
    copper_layers: b.layers.length, stackup_known: stackupKnown(b),
    stackup: b.layers.map((L) => describeLayer(L, w)),
    footprints: { total: fps.length, top: fps.filter((f) => f.side === 'top').length, bottom: fps.filter((f) => f.side === 'bottom').length,
      smd: fps.filter((f) => f.mount === 'smd').length, through_hole: fps.filter((f) => f.mount === 'through_hole').length, dnp: fps.filter((f) => f.dnp).length },
    nets: netNames(b).length,
    tracks: Object.values(b.segments).reduce((s, v) => s + v.length, 0),
    vias: Object.values(b.vias).reduce((s, v) => s + v.length, 0),
    zones: { total: b.zones.length, copper: b.zones.filter((z) => z.copper && !z.keepout).length, keepout: b.zones.filter((z) => z.keepout).length },
    layers: b.layer_table.map((l) => l.name),
    design_rules: designRules(b, p.pro),
  }
}

const board = defineTool({
  name: 'kicad.board',
  description: 'The routed board: outline size, copper stackup (per-layer impedance at a trace width when given), footprint/net/track/via/zone counts, layer list and design rules; optionally the footprints with position, side, rotation and pads.',
  input: z.object({
    project,
    trace_width_mm: z.number().positive().optional().describe('give each copper layer\'s Z0, delay and C per mm at this width'),
    footprints: z.boolean().default(false).describe('list footprints'),
    refs: z.array(z.string()).optional().describe('only these footprints (implies footprints)'),
    pads: z.boolean().default(false).describe('include each listed footprint\'s pads and nets'),
    limit: limit(100),
  }),
  run: async (a) => {
    const p = await resolveProject(a.project)
    return recorded('kicad.board', subject(p), a, async () => {
      const b = loadBoard(needPcb(p))
      const out: Record<string, unknown> = { project: p.name, ...boardSummary(b, p, a.trace_width_mm) }
      if (a.footprints || a.refs?.length) {
        const want = a.refs?.length ? new Set(a.refs) : null
        const list = b.footprints.filter((f) => !want || want.has(f.ref)).sort((x, y) => x.ref.localeCompare(y.ref, undefined, { numeric: true }))
        const c = cap(list, a.limit)
        out.footprint_list = c.items.map((f) => ({ ref: f.ref, value: f.value, footprint: f.footprint, side: f.side, x_mm: f.x_mm, y_mm: f.y_mm,
          rotation_deg: f.rotation_deg, mount: f.mount, dnp: f.dnp, pad_count: f.pads.length, ...(a.pads ? { pads: f.pads } : {}) }))
        out.footprints_omitted = c.omitted
      }
      return { status: 'pass' as const, summary: `${b.footprints.length} footprints, ${b.layers.length} copper layers`, result: out }
    })
  },
})

const netLength = defineTool({
  name: 'kicad.net_length',
  description: 'Routed copper of nets on the board: total length and per layer, vias, unreached pads; with from/to pads ("R4.2", "U1.7"), the shortest routed path between them with its layers, vias, delay and Z0 (analytic stackup model); with tree, the net as branches between pads and forks.',
  input: z.object({
    project,
    nets: z.array(z.string().min(1)).min(1).max(200).describe('net names as on the board'),
    from: z.string().optional().describe('pad "REF.PIN" (with to: path length on the first net)'),
    to: z.string().optional(),
    tree: z.string().optional().describe('root pad "REF.PIN": the first net as a tree of branches from it'),
  }),
  run: async (a) => {
    const p = await resolveProject(a.project)
    return recorded('kicad.net_length', subject(p), a, async (run) => {
      const b = loadBoard(needPcb(p))
      const rows = a.nets.map((name) => {
        const n = new Net(b, name)
        const cF = n.capacitance()
        run.measure(`${name}.length`, round(n.length_m * 1e3), 'mm')
        return {
          net: name, length_mm: round(n.length_m * 1e3),
          by_layer_mm: Object.fromEntries([...n.byLayer()].sort((x, y) => layerOf(b, x[0]).index - layerOf(b, y[0]).index).map(([k, v]) => [k, round(v * 1e3)])),
          segments: n.segs.length, vias: n.vias.length, pads: n.pads.length,
          capacitance_pf: cF !== null ? round(cF * 1e12, 3) : null, unreached_pads: n.unreached().slice(0, 50),
        }
      })
      const first = new Net(b, a.nets[0] as string)
      const out: Record<string, unknown> = { project: p.name, nets: rows, model: stackupKnown(b) ? 'analytic' : 'no stackup: delays and Z0 unavailable', note: POUR_NOTE }
      if (a.from || a.to) {
        if (!a.from || !a.to) throw new ToolError('from and to go together')
        out.path = first.path(a.from, a.to).toJSON(b)
      }
      if (a.tree) {
        const br = first.tree(a.tree)
        out.tree = cap(br, 200).items.map((x) => x.toJSON(b))
        out.tree_branches = br.length
      }
      return { status: 'pass' as const, summary: rows.map((r) => `${r.net} ${r.length_mm} mm`).join(', ').slice(0, 200), result: out }
    })
  },
})

// ------------------------------------------------------------------ kicad.export

const exportTool = defineTool({
  name: 'kicad.export',
  description: `KiCad outputs written by kicad-cli into out_dir: ${EXPORT_KINDS.join(', ')} (render = 3D PNG, slow; only when asked). Returns the files written. Needs kicad-cli.`,
  input: z.object({
    project,
    kinds: z.array(z.enum(EXPORT_KINDS)).min(1).describe('what to write'),
    out_dir: z.string().optional().describe('default: <repo>/build/kicad/<project>'),
    layers: z.string().optional().describe('board layers for pcb_pdf/pcb_svg, comma separated KiCad names'),
    side: z.enum(['top', 'bottom', 'left', 'right', 'front', 'back']).default('top').describe('render view'),
    zip_gerbers: z.boolean().default(false),
  }),
  run: async (a) => {
    const p = await resolveProject(a.project)
    return recorded('kicad.export', subject(p), a, async (run) => {
      const { root } = await candidates()
      const dir = outDirFor(a.out_dir, root, p.name)
      const done: { kind: ExportKind; args: string[] }[] = []
      for (const k of a.kinds) done.push({ kind: k, args: await exportOne(k, { sch: p.sch, pcb: p.pcb, name: p.name }, dir, { layers: a.layers, side: a.side }) })
      if (a.zip_gerbers && existsSync(join(dir, 'gerbers'))) zipDir(join(dir, 'gerbers'), join(dir, `${p.name}-gerbers.zip`))
      const out = listFiles(dir)
      run.artifact('files.txt', out.map((f) => `${f.path}\t${f.bytes}`).join('\n'))
      run.artifact('commands.txt', done.map((d) => `kicad-cli ${d.args.join(' ')}`).join('\n'))
      run.measure('files', out.length)
      return { status: 'pass' as const, summary: `${a.kinds.join(', ')} → ${dir}`,
        result: { project: p.name, out_dir: dir, kinds: a.kinds, files_total: out.length, files: out.slice(0, 100) } }
    })
  },
})

/** The kicad tools. */
export const tools: AnyTool[] = [projects, components, netlistTool, net, ercTool, drcTool, bom, fab, board, netLength, exportTool] as unknown as AnyTool[]

// re-exported for tests and other areas
export { fileVersion, powerNets }
