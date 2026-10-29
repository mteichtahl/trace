/**
 * Reading a KiCad 6–10 schematic, hierarchical sheets included: what is placed, and (through kicad-cli) how it is
 * connected.
 *
 * A .kicad_sch file is one sheet. A hierarchical design is a root sheet whose `(sheet …)` blocks point at other
 * files, and the same file can be placed several times (two channels drawn once), so one symbol in a file can stand
 * for several parts on the board. Which reference each placement gets lives in the symbol's
 * `(instances (project … (path "/<root uuid>/<sheet uuid>…" (reference "R12") (unit 1))))` block (KiCad 7+), or in the
 * root file's `(symbol_instances …)` table (KiCad 6). This reader walks the hierarchy from the root, keeps the instance
 * path of every placement and resolves each symbol's reference for that path; a symbol with no instance data falls
 * back to its Reference field.
 *
 * Per placement it returns reference, value, footprint, lib_id, unit, every field (so MPN, Manufacturer, LCSC,
 * Digikey… come through under whatever name the design uses), the DNP / in_bom / on_board / exclude_from_sim flags,
 * its sheet and whether it is a power symbol. Also the sheets, labels (local, global, hierarchical) and no-connects.
 *
 * Connectivity is deliberately not computed here. Nets come from wire geometry, junctions, label scoping, bus
 * unfolding and power-symbol globals, which is exactly what eeschema does, and a half-right re-implementation would
 * give confident wrong answers. `netlist()` asks kicad-cli for the kicadxml netlist and parses it; without kicad-cli
 * it throws a ToolError saying so.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ToolError } from '../../core/registry.js'
import { Cache, scratchDir } from '../../core/store.js'
import { kicadCliVersion, requireKicad, runCli } from './project.js'
import * as sx from './sexpr.js'
import type { SList } from './sexpr.js'
import { child, childText, descendants, parseXml, XmlError } from './xml.js'

/** Field names people use for the manufacturer part number, the manufacturer and the LCSC code (case-insensitive). */
export const MPN_FIELDS = ['mpn', 'manufacturer_part_number', 'manufacturer part number', 'mfr part', 'mfr_pn', 'mfrpn', 'mfr. part #',
  'part number', 'partnumber', 'pn']
export const MFR_FIELDS = ['manufacturer', 'mfr', 'mfg', 'manufacturer_name']
export const LCSC_FIELDS = ['lcsc', 'lcsc part', 'lcsc part #', 'lcsc_part', 'lcscpart', 'lcsc#', 'jlcpcb', 'jlc', 'jlcpcb part', 'jlcpcb part #']
const STANDARD_FIELDS = new Set(['Reference', 'Value', 'Footprint', 'Datasheet', 'Description'])

/** The first non-empty field whose name matches one of `names`, case-insensitively. */
export function pick(fields: Readonly<Record<string, string>>, names: readonly string[]): string | null {
  const low = new Map<string, string>()
  for (const [k, v] of Object.entries(fields)) low.set(k.toLowerCase().trim(), v)
  for (const n of names) {
    const v = low.get(n)?.trim()
    if (v && v !== '~' && v !== '-') return v
  }
  return null
}

export interface Symbol {
  ref: string
  value: string
  footprint: string
  lib_id: string
  unit: number
  uuid: string
  /** human sheet path: "/" for the root, "/Power/" for a sub-sheet */
  sheet: string
  /** uuid path of the sheet instance: "/<root>/<sheet>" */
  instance_path: string
  file: string
  fields: Record<string, string>
  dnp: boolean
  in_bom: boolean
  on_board: boolean
  exclude_from_sim: boolean
  power: boolean
  at: [number, number, number] | null
}

export const mpnOf = (s: Symbol): string | null => pick(s.fields, MPN_FIELDS)
export const manufacturerOf = (s: Symbol): string | null => pick(s.fields, MFR_FIELDS)
export const lcscOf = (s: Symbol): string | null => pick(s.fields, LCSC_FIELDS)
/** Power symbols, flags and other '#'-referenced symbols that are not parts. */
export const isVirtual = (s: Symbol): boolean => s.power || s.ref.startsWith('#')

export interface SymbolSummary {
  ref: string
  value: string
  footprint: string
  lib_id: string
  unit: number
  sheet: string
  dnp: boolean
  in_bom: boolean
  on_board: boolean
  exclude_from_sim?: boolean
  mpn?: string
  manufacturer?: string
  lcsc?: string
  fields?: Record<string, string>
}

export function symbolSummary(s: Symbol, allFields = true): SymbolSummary {
  const d: SymbolSummary = {
    ref: s.ref, value: s.value, footprint: s.footprint, lib_id: s.lib_id, unit: s.unit, sheet: s.sheet,
    dnp: s.dnp, in_bom: s.in_bom, on_board: s.on_board,
  }
  if (s.exclude_from_sim) d.exclude_from_sim = true
  const mpn = mpnOf(s)
  const mfr = manufacturerOf(s)
  const lcsc = lcscOf(s)
  if (mpn) d.mpn = mpn
  if (mfr) d.manufacturer = mfr
  if (lcsc) d.lcsc = lcsc
  if (allFields) {
    const extra: Record<string, string> = {}
    for (const [k, v] of Object.entries(s.fields)) if (!STANDARD_FIELDS.has(k) && v !== '' && v !== '~') extra[k] = v
    if (Object.keys(extra).length) d.fields = extra
  }
  return d
}

export interface Sheet {
  name: string
  file: string
  path: string
  instance_path: string
  uuid: string
  page: string | null
}

export type LabelKind = 'label' | 'global_label' | 'hierarchical_label'

export interface Label {
  kind: LabelKind
  text: string
  sheet: string
  at: [number, number, number] | null
  shape: string | null
}

export interface Schematic {
  root: string
  version: string | null
  project: string
  symbols: Symbol[]
  sheets: Sheet[]
  labels: Label[]
  no_connects: { sheet: string; at: [number, number] | null }[]
  problems: string[]
  title: Record<string, string>
}

/** Natural order: R2 before R10, U1 before U1A. */
export function naturalCompare(a: string, b: string): number {
  const ta = a.split(/(\d+)/)
  const tb = b.split(/(\d+)/)
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i]
    const y = tb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d
      continue
    }
    const c = x.toLowerCase().localeCompare(y.toLowerCase())
    if (c !== 0) return c
  }
  return 0
}

/** One entry per reference (multi-unit parts merged to their lowest unit); power symbols left out unless asked. */
export function parts(sch: Schematic, includeVirtual = false): Symbol[] {
  const seen = new Map<string, Symbol>()
  const sorted = [...sch.symbols].sort((a, b) => naturalCompare(a.ref, b.ref) || a.unit - b.unit)
  for (const s of sorted) {
    if (isVirtual(s) && !includeVirtual) continue
    if (!seen.has(s.ref)) seen.set(s.ref, s)
  }
  return [...seen.values()]
}

export function powerNets(sch: Schematic): string[] {
  return [...new Set(sch.symbols.filter((s) => s.power && s.value).map((s) => s.value))].sort()
}

function props(node: SList): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of sx.findAll(node, 'property')) {
    const k = sx.atomAt(p, 1)
    const v = sx.atomAt(p, 2)
    if (k !== undefined && v !== undefined) out[k] = v
  }
  return out
}

function powerLibIds(tree: SList): Set<string> {
  const out = new Set<string>()
  const libs = sx.find(tree, 'lib_symbols')
  for (const s of sx.findAll(libs, 'symbol')) {
    const name = sx.atomAt(s, 1)
    if (name && (sx.find(s, 'power') !== undefined || sx.atoms(s).slice(1).includes('power'))) out.add(name)
  }
  return out
}

type RefUnit = [string | null, number | null]

function legacyInstances(tree: SList): Map<string, RefUnit> {
  const out = new Map<string, RefUnit>()
  for (const p of sx.findAll(sx.find(tree, 'symbol_instances'), 'path')) {
    const key = sx.atomAt(p, 1)
    if (key) out.set(key, [sx.value(p, 'reference') ?? null, sx.numValue(p, 'unit') ?? null])
  }
  return out
}

function legacySheetPages(tree: SList): Map<string, string> {
  const out = new Map<string, string>()
  for (const p of sx.findAll(sx.find(tree, 'sheet_instances'), 'path')) {
    const key = sx.atomAt(p, 1)
    const page = sx.value(p, 'page')
    if (key && page) out.set(key, page)
  }
  return out
}

const trimSlash = (s: string): string => s.replace(/\/+$/, '')

function instanceRef(sym: SList, inst: string, project: string, legacy: Map<string, RefUnit>): RefUnit {
  const insts = sx.find(sym, 'instances')
  if (insts) {
    let best: RefUnit | null = null
    for (const proj of sx.findAll(insts, 'project')) {
      for (const p of sx.findAll(proj, 'path')) {
        if (trimSlash(sx.atomAt(p, 1) ?? '') === trimSlash(inst)) {
          const cand: RefUnit = [sx.value(p, 'reference') ?? null, sx.numValue(p, 'unit') ?? null]
          if (sx.atomAt(proj, 1) === project) return cand
          best ??= cand
        }
      }
    }
    if (best) return best
  }
  const uuid = sx.value(sym, 'uuid')
  if (legacy.size && uuid) {
    // KiCad 6 paths leave out the root sheet's uuid
    const segs = inst.replace(/^\/+|\/+$/g, '').split('/')
    const key = '/' + [...segs.slice(1), uuid].join('/')
    const hit = legacy.get(key)
    if (hit) return hit
  }
  return [null, null]
}

function readTree(path: string): SList {
  try {
    return sx.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    if (e instanceof sx.SexprError) throw new ToolError(`${path} is not a readable KiCad file: ${e.message}`)
    throw e
  }
}

/** Read a schematic and all its sub-sheets. Missing or unreadable sub-sheets are listed in `problems`, not fatal. */
export function readSchematic(path: string, projectName?: string): Schematic {
  const root = resolve(path)
  if (!existsSync(root)) throw new ToolError(`${root} does not exist`)
  const project = projectName ?? root.replace(/^.*[\\/]/, '').replace(/\.kicad_sch$/, '')
  const tree = readTree(root)
  if (sx.head(tree) !== 'kicad_sch') throw new ToolError(`${root} is not a KiCad 6+ schematic (it starts with ${JSON.stringify(sx.head(tree) ?? '')})`)
  const legacy = legacyInstances(tree)
  const legacyPages = legacySheetPages(tree)
  const title: Record<string, string> = {}
  const tb = sx.find(tree, 'title_block')
  for (const k of ['title', 'date', 'rev', 'company']) {
    const v = sx.value(tb, k)
    if (v) title[k] = v
  }
  const out: Schematic = {
    root, version: sx.value(tree, 'version') ?? null, project, symbols: [], sheets: [], labels: [], no_connects: [], problems: [], title,
  }
  const cache = new Map<string, SList>([[root, tree]])

  const visit = (t: SList, file: string, human: string, inst: string, depth: number): void => {
    if (depth > 32) {
      out.problems.push(`${file}: hierarchy deeper than 32 sheets (does a sheet include itself?)`)
      return
    }
    const powerIds = powerLibIds(t)
    for (const sym of sx.findAll(t, 'symbol')) {
      const libId = sx.value(sym, 'lib_id') ?? ''
      const f = props(sym)
      const [r, u] = instanceRef(sym, inst, project, legacy)
      const ref = r ?? f.Reference ?? '?'
      const unit = u ?? sx.numValue(sym, 'unit') ?? 1
      const libName = sx.value(sym, 'lib_name') ?? libId
      const power = powerIds.has(libName) || powerIds.has(libId) || (libId.startsWith('power:') && ref.startsWith('#'))
      out.symbols.push({
        ref, value: f.Value ?? '', footprint: f.Footprint ?? '', lib_id: libId, unit, uuid: sx.value(sym, 'uuid') ?? '',
        sheet: human, instance_path: inst, file, fields: f,
        dnp: sx.flag(sym, 'dnp', false), in_bom: sx.flag(sym, 'in_bom', true), on_board: sx.flag(sym, 'on_board', true),
        exclude_from_sim: sx.flag(sym, 'exclude_from_sim', false), power, at: sx.xy(sym) ?? null,
      })
    }
    for (const kind of ['label', 'global_label', 'hierarchical_label'] as const) {
      for (const lb of sx.findAll(t, kind)) {
        const text = sx.atomAt(lb, 1)
        if (text !== undefined) out.labels.push({ kind, text, sheet: human, at: sx.xy(lb) ?? null, shape: sx.value(lb, 'shape') ?? null })
      }
    }
    for (const nc of sx.findAll(t, 'no_connect')) {
      const p = sx.xy(nc)
      out.no_connects.push({ sheet: human, at: p ? [p[0], p[1]] : null })
    }
    for (const sh of sx.findAll(t, 'sheet')) {
      const f = props(sh)
      const name = f.Sheetname ?? f['Sheet name'] ?? '?'
      const fname = f.Sheetfile ?? f['Sheet file'] ?? ''
      const suuid = sx.value(sh, 'uuid') ?? ''
      const childInst = `${trimSlash(inst)}/${suuid}`
      const childHuman = `${human}${name}/`
      let page: string | null = null
      for (const proj of sx.findAll(sx.find(sh, 'instances'), 'project')) {
        for (const p of sx.findAll(proj, 'path')) if (trimSlash(sx.atomAt(p, 1) ?? '') === trimSlash(inst)) page = sx.value(p, 'page') ?? page
      }
      page ??= legacyPages.get('/' + childInst.replace(/^\/+/, '').split('/').slice(1).join('/')) ?? null
      out.sheets.push({ name, file: fname, path: childHuman, instance_path: childInst, uuid: suuid, page })
      const childPath = resolve(dirname(file), fname)
      if (!fname || !existsSync(childPath)) {
        out.problems.push(`${childHuman}: sheet file ${JSON.stringify(fname)} not found`)
        continue
      }
      let ct = cache.get(childPath)
      if (!ct) {
        try {
          ct = readTree(childPath)
        } catch (e) {
          out.problems.push(`${childHuman}: ${fname} unreadable (${e instanceof Error ? e.message : String(e)})`)
          continue
        }
        cache.set(childPath, ct)
      }
      visit(ct, childPath, childHuman, childInst, depth + 1)
    }
  }
  visit(tree, root, '/', `/${sx.value(tree, 'uuid') ?? ''}`, 0)
  return out
}

// ------------------------------------------------------------------ connectivity (kicad-cli)

export interface NetNode {
  ref: string
  pin: string
  function: string | null
  type: string | null
}

export interface NetlistComponent {
  value: string
  footprint: string
  lib_id: string | null
  sheet: string | null
  fields: Record<string, string>
  dnp: boolean
  exclude_from_bom: boolean
}

export interface Netlist {
  nets: Map<string, NetNode[]>
  /** net name → its net class, when the netlist states one */
  classes: Map<string, string>
  components: Map<string, NetlistComponent>
}

/** Parse kicad-cli's kicadxml netlist. */
export function parseNetlistXml(text: string): Netlist {
  let doc
  try {
    doc = parseXml(text)
  } catch (e) {
    if (e instanceof XmlError) throw new ToolError(`kicad-cli wrote an unreadable netlist: ${e.message}`)
    throw e
  }
  if (doc.name !== 'export') throw new ToolError(`not a KiCad XML netlist (root element <${doc.name}>)`)
  const nets = new Map<string, NetNode[]>()
  const classes = new Map<string, string>()
  const netsEl = child(doc, 'nets')
  for (const n of netsEl ? netsEl.children.filter((c) => c.name === 'net') : []) {
    const name = n.attrs.name || `Net-${n.attrs.code ?? '?'}`
    nets.set(name, n.children.filter((c) => c.name === 'node').map((x) => ({
      ref: x.attrs.ref ?? '', pin: x.attrs.pin ?? '', function: x.attrs.pinfunction || null, type: x.attrs.pintype || null,
    })))
    if (n.attrs.class) classes.set(name, n.attrs.class)
  }
  const components = new Map<string, NetlistComponent>()
  for (const c of descendants(doc, 'comp')) {
    const fields: Record<string, string> = {}
    for (const f of descendants(c, 'field')) if (f.attrs.name) fields[f.attrs.name] = f.text
    const lib = child(c, 'libsource')
    const sp = child(c, 'sheetpath')
    const propNames = new Set(c.children.filter((p) => p.name === 'property').map((p) => p.attrs.name ?? ''))
    components.set(c.attrs.ref ?? '', {
      value: childText(c, 'value'), footprint: childText(c, 'footprint'),
      lib_id: lib ? `${lib.attrs.lib ?? ''}:${lib.attrs.part ?? ''}` : null, sheet: sp?.attrs.names ?? null, fields,
      dnp: propNames.has('dnp'), exclude_from_bom: propNames.has('exclude_from_bom'),
    })
  }
  return { nets, classes, components }
}

/** Every .kicad_sch reachable from the root (by sheet references), for content hashing. */
function sheetFiles(root: string): string[] {
  const dir = dirname(root)
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.kicad_sch')).sort().map((f) => join(dir, f))
  } catch {
    return [root]
  }
}

/** The schematic's nets, from kicad-cli, cached by the content of its sheet files and the kicad-cli version. */
export async function netlist(schPath: string): Promise<Netlist> {
  requireKicad() // a clear error before anything else
  const h = createHash('sha256').update((await kicadCliVersion()) ?? '')
  for (const f of sheetFiles(schPath)) h.update(f).update(readFileSync(f))
  const key = h.digest('hex')
  const cache = new Cache()
  try {
    let text = cache.get<string>('kicad.netlist', key)
    if (typeof text !== 'string') {
      const tmp = scratchDir('trace-netlist-')
      try {
        const outFile = join(tmp, 'netlist.xml')
        await runCli(['sch', 'export', 'netlist', '--format', 'kicadxml', '-o', outFile, schPath], { timeoutMs: 300_000 })
        if (!existsSync(outFile)) throw new ToolError('kicad-cli did not write a netlist')
        text = readFileSync(outFile, 'utf8')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
      cache.put('kicad.netlist', key, text)
    }
    return parseNetlistXml(text)
  } finally {
    cache.close()
  }
}
