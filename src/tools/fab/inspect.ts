/**
 * Reading a design from its fabrication files (docs/fab-import.md): the Gerbers (one zip), the bill of materials and
 * the pick and place (CSV) and the person's overview, inspected before a project is started from them. Pure: the API's
 * projects.import_check and the agents' fab.import both answer this.
 *
 *   gerbers    every file's job from its Gerber X2 file function (TF.FileFunction), else its name; the outline's size
 *              from the profile layer's coordinates; the job file's layers, thickness, finish and impedance control;
 *              the drill files' holes and smallest drill
 *   bom        a line per part: designators, value, footprint, LCSC part, MPN, manufacturer, quantity, and JLCPCB's
 *              library and stock when the file carries them
 *   cpl        a row per placed part: designator, centre, side and rotation
 *   overview   the six topics the Intent builder asks about, each found or not, with the question that answers it
 *
 * Each finding is blocking (the import cannot go ahead), a warning (it can, and the finding goes with the project) or
 * a note, in plain words with what to do about it.
 */
import { parseCsv } from '../kicad/bom.js'
import { unzip } from '../mech/stable-output.js'
import { BASE_BOARD_CAPABILITIES } from '../pcb/capabilities.js'

export const MB = 1024 * 1024
/** The run kinds that record a release package: built by kicad.fab, or imported by fab.import. */
export const PACKAGE_KINDS = ['kicad.fab', 'import.fab'] as const
export const MAX_GERBER_ZIP = 25 * MB
/** what the zip may unpack to: Gerbers compress about five times (the sample: 3.3 MB to 16.8 MB) */
export const MAX_GERBER_UNPACKED = 200 * MB
export const MAX_CSV = 2 * MB
export const MIN_OVERVIEW = 300
export const MAX_OVERVIEW = 40_000
/** the overview topics an import needs at the least (docs/fab-import.md "The overview's quality bar") */
export const MIN_TOPICS = 4

export type Severity = 'blocking' | 'warning' | 'note'
export type FileKey = 'gerbers' | 'bom' | 'cpl' | 'overview'
/**
 * A Gerber's GenerationSoftware attribute in words: "KiCad,Pcbnew,10.0.8-10.0.8~ubuntu24.04.1" is "KiCad Pcbnew 10.0.8"
 * (the version without its build and packaging suffix, which a person does not need). Pure.
 */
export function toolWords(gen: string): string {
  const [vendor = '', app = '', version = ''] = gen.split(',').map((x) => x.trim())
  const v = version.replace(/^(\d+(?:\.\d+)*)[-~+].*$/, '$1')
  return [vendor, app, v].filter(Boolean).join(' ').replace(/\s+/g, ' ')
}

export interface Finding {
  id: string
  severity: Severity
  file: FileKey
  /** what is wrong, in plain words */
  text: string
  /** what to do about it */
  fix: string
  /** the designators or file names it is about, when there are some */
  refs?: string[]
}

// ------------------------------------------------------------------ Gerbers

export type LayerKind = 'copper' | 'mask' | 'silkscreen' | 'paste' | 'outline' | 'drill' | 'drill-map' | 'job' | 'other'
export type Side = 'top' | 'bottom' | 'inner'
export interface GerberFile {
  name: string
  bytes: number
  kind: LayerKind
  side: Side | null
  /** the copper layer's number from the top (1), when the file says it */
  layer: number | null
  /** plated or not, for a drill file */
  plated: boolean | null
  /** how the kind was known: its X2 attribute or its name */
  from: 'attribute' | 'name' | 'content'
}
export interface Outline { x0: number; y0: number; x1: number; y1: number; width_mm: number; height_mm: number }
export interface Job { layers: number | null; thickness_mm: number | null; finish: string | null; impedance: boolean | null; width_mm: number | null; height_mm: number | null }
export interface Drills { holes: number; smallest_mm: number | null; plated_files: number; unplated_files: number }
export interface Gerbers {
  files: GerberFile[]
  copper: number
  outline: Outline | null
  job: Job | null
  drills: Drills
  /** the design tool, from the X2 attributes ("KiCad Pcbnew 10.0.8") */
  tool: string | null
  /** the project's name and revision, from the X2 attributes */
  project: { name: string | null; revision: string | null }
}

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const attr = (text: string, name: string): string | null => {
  const m = new RegExp(`(?:%TF\\.${name},([^*%]*)\\*%|#@! TF\\.${name},([^*\\r\\n]*))`).exec(text)
  const v = m?.[1] ?? m?.[2]
  return v === undefined ? null : v.trim()
}

/** A file's kind from its X2 file function ("Copper,L1,Top", "Soldermask,Bot", "Profile,NP", "Plated,1,10,PTH"). Pure. */
export function fromFunction(fn: string): Pick<GerberFile, 'kind' | 'side' | 'layer' | 'plated'> | null {
  const [what = '', ...rest] = fn.split(',').map((x) => x.trim())
  const sideOf = (s: string | undefined): Side | null => (s === 'Top' ? 'top' : s === 'Bot' ? 'bottom' : s === 'Inr' ? 'inner' : null)
  switch (what) {
    case 'Copper': {
      const n = /^L(\d+)$/.exec(rest[0] ?? '')
      return { kind: 'copper', side: sideOf(rest[1]), layer: n ? Number(n[1]) : null, plated: null }
    }
    case 'Soldermask': return { kind: 'mask', side: sideOf(rest[0]), layer: null, plated: null }
    case 'Legend': return { kind: 'silkscreen', side: sideOf(rest[0]), layer: null, plated: null }
    case 'Paste': return { kind: 'paste', side: sideOf(rest[0]), layer: null, plated: null }
    case 'Profile': return { kind: 'outline', side: null, layer: null, plated: null }
    case 'Plated': return { kind: 'drill', side: null, layer: null, plated: true }
    case 'NonPlated': return { kind: 'drill', side: null, layer: null, plated: false }
    case 'Drillmap': case 'FabricationDrawing': case 'AssemblyDrawing': return { kind: 'drill-map', side: null, layer: null, plated: null }
    default: return null
  }
}

/** A file's kind from its name: Protel extensions, KiCad and EasyEDA layer names. Pure. */
export function fromName(name: string): Pick<GerberFile, 'kind' | 'side' | 'layer' | 'plated'> {
  const n = baseName(name).toLowerCase()
  const ext = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : ''
  const none = { layer: null, plated: null }
  if (ext === 'gbrjob') return { kind: 'job', side: null, ...none }
  if (/drl_map|drill_map|-drl\.gbr$/.test(n)) return { kind: 'drill-map', side: null, ...none }
  if (['drl', 'xln', 'exc', 'drd'].includes(ext) || /drill/.test(n)) return { kind: 'drill', side: null, layer: null, plated: /npth|non.?plated/.test(n) ? false : /pth|plated/.test(n) ? true : null }
  if (ext === 'gtl' || /f[._]cu|top.?copper|toplayer/.test(n)) return { kind: 'copper', side: 'top', layer: 1, plated: null }
  if (ext === 'gbl' || /b[._]cu|bottom.?copper|bottomlayer/.test(n)) return { kind: 'copper', side: 'bottom', layer: null, plated: null }
  const inner = /^g(\d+)$/.exec(ext) ?? /^gp(\d+)$/.exec(ext) ?? /in(\d+)[._]cu/.exec(n) ?? /inner.?(\d+)/.exec(n)
  if (inner || /^g\d+l$/.test(ext)) return { kind: 'copper', side: 'inner', layer: inner ? Number(inner[1]) + 1 : null, plated: null }
  if (ext === 'gts' || /f[._]mask|top.?solder.?mask|topsoldermask/.test(n)) return { kind: 'mask', side: 'top', ...none }
  if (ext === 'gbs' || /b[._]mask|bottom.?solder.?mask|bottomsoldermask/.test(n)) return { kind: 'mask', side: 'bottom', ...none }
  if (ext === 'gto' || /f[._]silk|top.?silk/.test(n)) return { kind: 'silkscreen', side: 'top', ...none }
  if (ext === 'gbo' || /b[._]silk|bottom.?silk/.test(n)) return { kind: 'silkscreen', side: 'bottom', ...none }
  if (ext === 'gtp' || /f[._]paste|top.?paste/.test(n)) return { kind: 'paste', side: 'top', ...none }
  if (ext === 'gbp' || /b[._]paste|bottom.?paste/.test(n)) return { kind: 'paste', side: 'bottom', ...none }
  if (['gko', 'gm1', 'gml', 'gm', 'gbr'].includes(ext) && /edge|outline|profile|board|gko|gm1|gml/.test(n)) return { kind: 'outline', side: null, ...none }
  if (['gko', 'gm1', 'gml'].includes(ext)) return { kind: 'outline', side: null, ...none }
  return { kind: 'other', side: null, ...none }
}

/** The extents of a Gerber's drawn coordinates (mm), from its format (FS) and units (MO). Arcs by their end points. Pure. */
export function gerberExtents(text: string): Outline | null {
  const fs = /%FS[LT]?A?X(\d)(\d)Y(\d)(\d)\*%/.exec(text)
  const dx = fs ? Number(fs[2]) : 6
  const dy = fs ? Number(fs[4]) : 6
  const inch = /%MOIN\*%/.test(text)
  const scale = inch ? 25.4 : 1
  let x = 0
  let y = 0
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity
  const re = /(?:^|\*|\n)\s*(?:G0?[123])?(?:X(-?\d+))?(?:Y(-?\d+))?(?:I-?\d+)?(?:J-?\d+)?D0?([123])\*/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[1] === undefined && m[2] === undefined) continue
    if (m[1] !== undefined) x = (Number(m[1]) / 10 ** dx) * scale
    if (m[2] !== undefined) y = (Number(m[2]) / 10 ** dy) * scale
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  if (!Number.isFinite(x0)) return null
  const r = (v: number): number => Math.round(v * 1000) / 1000
  return { x0: r(x0), y0: r(y0), x1: r(x1), y1: r(y1), width_mm: r(x1 - x0), height_mm: r(y1 - y0) }
}

/** An Excellon file's holes and its smallest tool (mm). Pure. */
export function drillFile(text: string): { holes: number; smallest_mm: number | null } {
  const inch = /^\s*INCH/m.test(text) && !/^\s*METRIC/m.test(text)
  const sizes: number[] = []
  for (const m of text.matchAll(/^T(\d+)(?:F\d+)?(?:S\d+)?C([\d.]+)/gm)) sizes.push(Number(m[2]) * (inch ? 25.4 : 1))
  const holes = (text.match(/^(?:G\d\d)?X-?[\d.]+(?:Y-?[\d.]+)?|^Y-?[\d.]+/gm) ?? []).length
  const real = sizes.filter((s) => s > 0)
  return { holes, smallest_mm: real.length ? Math.round(Math.min(...real) * 1000) / 1000 : null }
}

/** A Gerber job file's general specs, or null when it is not one. Pure. */
export function jobFile(text: string): Job | null {
  try {
    const j = JSON.parse(text) as { GeneralSpecs?: Record<string, unknown> }
    const g = j.GeneralSpecs
    if (!g || typeof g !== 'object') return null
    const size = g.Size && typeof g.Size === 'object' ? g.Size as Record<string, unknown> : {}
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    return {
      layers: num(g.LayerNumber), thickness_mm: num(g.BoardThickness), finish: typeof g.Finish === 'string' ? g.Finish : null,
      impedance: typeof g.ImpedanceControlled === 'boolean' ? g.ImpedanceControlled : null, width_mm: num(size.X), height_mm: num(size.Y),
    }
  } catch {
    return null
  }
}

/** Read the Gerber zip. Throws a plain-words Error when it is not a zip this reader can open. Pure. */
export function readGerbers(zip: Uint8Array): Gerbers {
  if (zip.length > MAX_GERBER_ZIP) throw new Error(`The Gerber zip is ${(zip.length / MB).toFixed(1)} MB; at most ${MAX_GERBER_ZIP / MB} MB is taken.`)
  const entries = unzip(Buffer.from(zip), MAX_GERBER_UNPACKED)
  if (!entries) throw new Error('The Gerbers could not be opened as a zip (it may be damaged, encrypted, or larger than 200 MB unpacked). Zip the Gerber and drill files together and give it again.')
  const files: GerberFile[] = []
  let outline: Outline | null = null
  let job: Job | null = null
  const drills: Drills = { holes: 0, smallest_mm: null, plated_files: 0, unplated_files: 0 }
  let tool: string | null = null
  const project = { name: null as string | null, revision: null as string | null }
  for (const [path, buf] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    if (path.endsWith('/') || /(^|\/)(__MACOSX|\.)/.test(path)) continue
    const text = buf.subarray(0, Math.min(buf.length, 64 * MB)).toString('latin1')
    const fn = attr(text, 'FileFunction')
    let k = (fn ? fromFunction(fn) : null)
    let from: GerberFile['from'] = k ? 'attribute' : 'name'
    if (!k) k = fromName(path)
    // an Excellon file named oddly (".txt") is still a drill file
    if (k.kind === 'other' && /^M48\s*$/m.test(text.slice(0, 200))) { k = { kind: 'drill', side: null, layer: null, plated: /NPTH/i.test(path) ? false : null }; from = 'content' }
    files.push({ name: baseName(path), bytes: buf.length, ...k, from })
    const gen = attr(text, 'GenerationSoftware')
    if (gen && !tool) tool = toolWords(gen)
    const pid = attr(text, 'ProjectId')
    if (pid && !project.name) {
      const [name, , rev] = pid.split(',')
      project.name = name?.trim() || null
      project.revision = rev?.trim() || null
    }
    if (k.kind === 'outline') {
      const e = gerberExtents(text)
      if (e && (!outline || e.width_mm * e.height_mm > outline.width_mm * outline.height_mm)) outline = e
    } else if (k.kind === 'job') {
      job = jobFile(text) ?? job
    } else if (k.kind === 'drill') {
      const d = drillFile(text)
      drills.holes += d.holes
      if (d.smallest_mm !== null) drills.smallest_mm = drills.smallest_mm === null ? d.smallest_mm : Math.min(drills.smallest_mm, d.smallest_mm)
      if (k.plated === false) drills.unplated_files++
      else drills.plated_files++
    }
  }
  // a copper layer named by its place only (Protel's .gbl): number it after the inner layers
  const copperFiles = files.filter((f) => f.kind === 'copper')
  return { files, copper: copperFiles.length, outline, job, drills, tool, project }
}

// ------------------------------------------------------------------ CSV columns

/** Lower-cased, without spaces, dots, underscores or a trailing "#". */
const key = (h: string): string => h.replace(/^﻿/, '').trim().toLowerCase().replace(/[\s._\-()/]+/g, '').replace(/#$/, '')

const COLUMNS = {
  designator: ['designator', 'designators', 'reference', 'references', 'ref', 'refs', 'refdes', 'part', 'name'],
  value: ['comment', 'value', 'val', 'description'],
  footprint: ['footprint', 'package', 'pattern'],
  lcsc: ['lcscpart', 'lcsc', 'lcscpartnumber', 'jlcpcbpart', 'jlcpcbpartnumber', 'lcscpartno', 'supplierpart', 'jlcpart'],
  mpn: ['mpn', 'manufacturerpartnumber', 'manufacturerpart', 'mfrpart', 'mfrpartnumber', 'partnumber'],
  manufacturer: ['manufacturer', 'mfr', 'manufacturername'],
  qty: ['qty', 'quantity', 'count'],
  library: ['jlclibrary', 'library', 'librarytype', 'jlcpcbtype', 'type', 'basicextended'],
  stock: ['jlcstock', 'stock', 'lcscstock', 'jlcpcbstock'],
  x: ['midx', 'posx', 'centerx', 'centrex', 'centerxmm', 'x', 'xmm', 'refx'],
  y: ['midy', 'posy', 'centery', 'centrey', 'centerymm', 'y', 'ymm', 'refy'],
  side: ['layer', 'side', 'tb'],
  rotation: ['rotation', 'rot', 'angle'],
} as const
type Column = keyof typeof COLUMNS

/** Where each column is, by its loosely matched header; a header row is the first row naming a designator. Pure. */
function columns(rows: string[][], want: readonly Column[]): { head: number; at: Partial<Record<Column, number>> } | null {
  for (let h = 0; h < Math.min(rows.length, 10); h++) {
    const keys = rows[h]!.map(key)
    const at: Partial<Record<Column, number>> = {}
    for (const c of want) {
      const i = keys.findIndex((k) => (COLUMNS[c] as readonly string[]).includes(k))
      if (i >= 0) at[c] = i
    }
    if (at.designator !== undefined) return { head: h, at }
  }
  return null
}

/** Designators in a cell: "C41,C92 C103" → [C41, C92, C103]; "R1-R4" expanded. Pure. */
export function designators(cell: string): string[] {
  const out: string[] = []
  for (const t of cell.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)) {
    const range = /^([A-Za-z_]+)(\d+)-(?:\1)?(\d+)$/.exec(t)
    if (range && Number(range[3]) >= Number(range[2]) && Number(range[3]) - Number(range[2]) < 1000) {
      for (let n = Number(range[2]); n <= Number(range[3]); n++) out.push(`${range[1]}${n}`)
    } else out.push(t)
  }
  return out
}

/** A length in mm from a cell: "279.05mm", "-220.2", "350mil", "0.5in". Pure. */
export function mmOf(cell: string | undefined): number | null {
  const m = /^\s*(-?[\d.]+)\s*(mm|mil|in|inch)?\s*$/i.exec(cell ?? '')
  if (!m) return null
  const v = Number(m[1])
  if (!Number.isFinite(v)) return null
  const unit = (m[2] ?? 'mm').toLowerCase()
  return unit === 'mil' ? v * 0.0254 : unit.startsWith('in') ? v * 25.4 : v
}

// ------------------------------------------------------------------ the bill of materials

export interface BomLine {
  row: number
  refs: string[]
  value: string | null
  footprint: string | null
  lcsc: string | null
  mpn: string | null
  manufacturer: string | null
  qty: number | null
  library: 'basic' | 'extended' | 'preferred' | null
  stock: number | null
}
export interface Bom { lines: BomLine[]; parts: number; has: { lcsc: boolean; stock: boolean; library: boolean; mpn: boolean } }

const cellOf = (row: string[], i: number | undefined): string | null => {
  if (i === undefined) return null
  const v = (row[i] ?? '').trim()
  return v && v !== '--' ? v : null
}

/** Read a BOM CSV. Throws a plain-words Error when no designator column is found. Pure. */
export function readBom(text: string): Bom {
  const rows = parseCsv(text.replace(/^﻿/, '')).filter((r) => r.some((c) => c.trim()))
  const c = columns(rows, ['designator', 'value', 'footprint', 'lcsc', 'mpn', 'manufacturer', 'qty', 'library', 'stock'])
  if (!c) throw new Error('The bill of materials has no designator column (Designator, Reference or Ref) in its first rows.')
  const lines: BomLine[] = []
  rows.slice(c.head + 1).forEach((row, n) => {
    const refs = designators(cellOf(row, c.at.designator) ?? '')
    if (!refs.length) return
    const lib = (cellOf(row, c.at.library) ?? '').toLowerCase()
    const q = cellOf(row, c.at.qty)
    const s = cellOf(row, c.at.stock)
    lines.push({
      row: c.head + 2 + n, refs, value: cellOf(row, c.at.value), footprint: cellOf(row, c.at.footprint),
      lcsc: cellOf(row, c.at.lcsc)?.toUpperCase() ?? null, mpn: cellOf(row, c.at.mpn), manufacturer: cellOf(row, c.at.manufacturer),
      qty: q !== null && /^\d+$/.test(q) ? Number(q) : null,
      library: lib.startsWith('bas') ? 'basic' : /^(ext|expand)/.test(lib) ? 'extended' : lib.startsWith('pref') ? 'preferred' : null,
      stock: s !== null && /^\d+$/.test(s.replace(/,/g, '')) ? Number(s.replace(/,/g, '')) : null,
    })
  })
  return {
    lines, parts: lines.reduce((n, l) => n + l.refs.length, 0),
    has: { lcsc: c.at.lcsc !== undefined, stock: c.at.stock !== undefined, library: c.at.library !== undefined, mpn: c.at.mpn !== undefined },
  }
}

// ------------------------------------------------------------------ the pick and place

export interface Placement { row: number; ref: string; x: number; y: number; side: 'top' | 'bottom'; rotation: number | null }

/** Read a pick and place CSV. Throws a plain-words Error when its columns are not found. Pure. */
export function readCpl(text: string): Placement[] {
  const rows = parseCsv(text.replace(/^﻿/, '')).filter((r) => r.some((c) => c.trim()))
  const c = columns(rows, ['designator', 'x', 'y', 'side', 'rotation'])
  if (!c) throw new Error('The pick and place file has no designator column (Designator, Ref or Reference) in its first rows.')
  if (c.at.x === undefined || c.at.y === undefined) throw new Error('The pick and place file has no centre columns (Mid X and Mid Y, or PosX and PosY).')
  const out: Placement[] = []
  rows.slice(c.head + 1).forEach((row, n) => {
    const ref = cellOf(row, c.at.designator)
    const x = mmOf(row[c.at.x!])
    const y = mmOf(row[c.at.y!])
    if (!ref || x === null || y === null) return
    const side = (cellOf(row, c.at.side) ?? 'top').toLowerCase()
    const rot = Number.parseFloat(cellOf(row, c.at.rotation) ?? '')
    out.push({ row: c.head + 2 + n, ref, x, y, side: side.startsWith('b') ? 'bottom' : 'top', rotation: Number.isFinite(rot) ? rot : null })
  })
  return out
}

// ------------------------------------------------------------------ the overview

export interface Topic { id: string; title: string; found: boolean; ask: string }

const TOPICS: { id: string; title: string; ask: string; words: RegExp }[] = [
  { id: 'purpose', title: 'What it does', ask: 'What does the board do, in a sentence or two?', words: /\b(it|this board|the board|this)\b[^.]{0,60}\b(does|controls?|monitors?|measures?|drives?|provides?|carries|hosts?|connects?|reads?|switch(es)?|supervis\w*|manages?|converts?)\b|\b(purpose|designed to|used to|is a|is an)\b/i },
  { id: 'use', title: 'Where it is used', ask: 'Where will it be used: the setting, enclosure and environment (indoors, a vehicle, a rack, temperature)?', words: /\b(enclosure|case|chassis|rack|panel|indoors?|outdoors?|vehicle|temperature|environment|mounted in|installed|lab|bench|desk|cockpit|simulator|cabinet|housing)\b/i },
  { id: 'power', title: 'Power', ask: 'What powers it: the input voltage and current, and the rails it makes?', words: /\b(\d+(\.\d+)?\s?(v|vdc|vac|a|ma|w)\b|volts?|power(ed)?|supply|battery|rail|psu|poe|usb[- ]?c? power)/i },
  { id: 'interfaces', title: 'Interfaces', ask: 'What does it connect to: connectors, buses and the devices on them?', words: /\b(connector|header|interface|i2c|i²c|spi|uart|usb|can(bus)?|ethernet|rj45|hdmi|gpio|rs-?485|rs-?232|jtag|swd|pcie|m\.2|bus|port)\b/i },
  { id: 'size', title: 'Size and mounting', ask: 'How big is it, and how is it mounted (holes, standoffs, a case)?', words: /\b(\d+(\.\d+)?\s?(mm|cm|in)\b|\d+\s?[x×]\s?\d+|size|dimensions?|outline|mounting|standoffs?|holes?|footprint of the board)/i },
  { id: 'quantity', title: 'Quantity and cost', ask: 'How many will be built, and is there a target cost or budget?', words: /\b(quantity|qty|units|boards? (per|a) (build|run|batch)|\d+\s?(pcs|pieces|boards|units)|cost|budget|price|\$|usd|aud|eur|prototype run|production run)\b/i },
]

export interface OverviewCheck { chars: number; topics: Topic[]; found: number; ok: boolean }

/** The overview against its bar: length and the six topics. Pure. */
export function checkOverview(text: string): OverviewCheck {
  const t = text.trim()
  const topics = TOPICS.map((x) => ({ id: x.id, title: x.title, ask: x.ask, found: x.words.test(t) }))
  const found = topics.filter((x) => x.found).length
  return { chars: t.length, topics, found, ok: t.length >= MIN_OVERVIEW && found >= MIN_TOPICS }
}

// ------------------------------------------------------------------ the inspection

export type Entry = 'fabricate' | 'bringup'
export interface Inspection {
  summary: {
    board: { layers: number; width_mm: number | null; height_mm: number | null; thickness_mm: number | null; finish: string | null; impedance: boolean | null; smallest_hole_mm: number | null; holes: number }
    tool: string | null
    project: { name: string | null; revision: string | null }
    files: number
    bom: { lines: number; parts: number; with_lcsc: number; basic: number; extended: number; out_of_stock: number }
    placements: { total: number; top: number; bottom: number; hand_placed: number }
    overview: { chars: number; topics: number; of: number }
  }
  gerbers: Gerbers | null
  bom: Bom | null
  placements: Placement[]
  overview: OverviewCheck
  findings: Finding[]
  /** no blocking finding */
  ok: boolean
  /** the BOM designators no placement covers: placed by hand, or not at all by the assembler */
  hand_placed: string[]
  /** the board options to enter on JLCPCB's order form, as kicad.fab records them (src/tools/kicad/order-options.ts) */
  order_options: { group: 'pcb' | 'pcba'; option: string; value: string; source: string; decided: boolean }[]
  recommended: { entry: Entry; why: string }
}

export interface InspectInput {
  gerbers: Uint8Array | null
  bom: string | null
  cpl: string | null
  overview: string
  /** boards per build: what the stock must cover */
  quantity?: number
  /** the person says the boards are built already */
  built?: boolean
}

const few = (xs: readonly string[], n = 12): string => (xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} and ${xs.length - n} more`)
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const LCSC = /^C\d{1,9}$/

/** Inspect the four inputs together. Never throws: an unreadable file is a blocking finding. Pure. */
export function inspect(i: InspectInput): Inspection {
  const findings: Finding[] = []
  const add = (f: Finding): void => { findings.push(f) }
  const quantity = Math.max(1, i.quantity ?? 1)
  const caps = BASE_BOARD_CAPABILITIES

  // the Gerbers
  let g: Gerbers | null = null
  if (!i.gerbers) add({ id: 'gerbers.missing', severity: 'blocking', file: 'gerbers', text: 'No Gerber zip was given.', fix: 'Give the Gerber and drill files, zipped together.' })
  else {
    try { g = readGerbers(i.gerbers) } catch (e) { add({ id: 'gerbers.unreadable', severity: 'blocking', file: 'gerbers', text: e instanceof Error ? e.message : String(e), fix: 'Export the Gerbers again from the design tool and zip them.' }) }
  }
  if (g) {
    const of = (k: LayerKind): GerberFile[] => g!.files.filter((f) => f.kind === k)
    if (!of('outline').length) add({ id: 'gerbers.outline', severity: 'blocking', file: 'gerbers', text: 'There is no board outline (the Edge Cuts or profile layer).', fix: 'Include the outline layer in the Gerber export.' })
    else if (!g.outline) add({ id: 'gerbers.outline_empty', severity: 'blocking', file: 'gerbers', text: 'The outline layer draws nothing, so the board has no size.', fix: 'Check the outline is on the Edge Cuts layer and export again.' })
    if (!g.copper) add({ id: 'gerbers.copper', severity: 'blocking', file: 'gerbers', text: 'There is no copper layer in the zip.', fix: 'Include every copper layer in the Gerber export.' })
    if (!of('drill').length) add({ id: 'gerbers.drill', severity: 'blocking', file: 'gerbers', text: 'There is no drill file, so no holes or vias would be drilled.', fix: 'Export the drill files (Excellon) into the same zip.' })
    if (g.copper > caps.layers.max) add({ id: 'gerbers.layers_max', severity: 'blocking', file: 'gerbers', text: `The board has ${g.copper} copper layers; JLCPCB builds at most ${caps.layers.max}.`, fix: 'Reduce the layer count, or order from a fab that builds it.' })
    if (g.copper > 2 && g.copper % 2) add({ id: 'gerbers.layers_odd', severity: 'warning', file: 'gerbers', text: `The board has ${g.copper} copper layers, an odd number; multilayer boards are built in pairs.`, fix: 'Check a copper layer is not missing from the zip.' })
    if (g.job?.layers && g.job.layers !== g.copper) add({ id: 'gerbers.job_layers', severity: 'warning', file: 'gerbers', text: `The job file says ${g.job.layers} copper layers, but the zip holds ${g.copper}.`, fix: 'Export the Gerbers again so every copper layer is in the zip.' })
    if (g.outline && (g.outline.width_mm < caps.board_min_mm[0] || g.outline.height_mm < caps.board_min_mm[1])) add({ id: 'gerbers.too_small', severity: 'blocking', file: 'gerbers', text: `The board is ${g.outline.width_mm} × ${g.outline.height_mm} mm; JLCPCB makes boards from ${caps.board_min_mm[0]} × ${caps.board_min_mm[1]} mm.`, fix: 'Panelise it, or check the outline layer.' })
    for (const side of ['top', 'bottom'] as const) {
      if (g.copper >= (side === 'top' ? 1 : 2) && !of('mask').some((f) => f.side === side)) add({ id: `gerbers.mask_${side}`, severity: 'warning', file: 'gerbers', text: `There is no ${side} solder mask layer: the ${side} would be bare copper.`, fix: `Include the ${side} solder mask in the export, unless bare copper is meant.` })
    }
    if (!of('silkscreen').length) add({ id: 'gerbers.silkscreen', severity: 'note', file: 'gerbers', text: 'There is no silkscreen layer: the board will carry no labels.', fix: 'Include the silkscreen if the board should be labelled.' })
    if (g.drills.smallest_mm !== null && g.drills.smallest_mm < caps.via_mm.drill) add({ id: 'gerbers.small_hole', severity: 'warning', file: 'gerbers', text: `The smallest hole is ${g.drills.smallest_mm} mm; JLCPCB drills from ${caps.via_mm.drill} mm.`, fix: 'Enlarge the smallest holes, or check the fab can drill them as an option.' })
    const other = of('other').map((f) => f.name)
    if (other.length) add({ id: 'gerbers.other', severity: 'note', file: 'gerbers', text: `${plural(other.length, 'file')} in the zip ${other.length === 1 ? 'is' : 'are'} not a recognised layer: ${few(other, 6)}.`, fix: 'Nothing to do if they are meant to be there; the fab ignores files it does not need.', refs: other })
  }

  // the bill of materials
  let bom: Bom | null = null
  if (!i.bom) add({ id: 'bom.missing', severity: 'blocking', file: 'bom', text: 'No bill of materials was given.', fix: 'Give the BOM as a CSV, in JLCPCB\'s columns if you have them.' })
  else {
    if (i.bom.length > MAX_CSV) add({ id: 'bom.too_big', severity: 'blocking', file: 'bom', text: `The BOM is ${(i.bom.length / MB).toFixed(1)} MB; at most ${MAX_CSV / MB} MB is taken.`, fix: 'Check it is the BOM and not another file.' })
    else try { bom = readBom(i.bom) } catch (e) { add({ id: 'bom.unreadable', severity: 'blocking', file: 'bom', text: e instanceof Error ? e.message : String(e), fix: 'Export the BOM as a CSV with a Designator column.' }) }
  }
  if (bom) {
    if (!bom.lines.length) add({ id: 'bom.empty', severity: 'blocking', file: 'bom', text: 'The BOM has no lines with designators.', fix: 'Export the BOM again, one line per part value.' })
    const seen = new Map<string, number>()
    const twice = new Set<string>()
    for (const l of bom.lines) for (const r of l.refs) { if (seen.has(r)) twice.add(r); seen.set(r, l.row) }
    if (twice.size) add({ id: 'bom.duplicate', severity: 'blocking', file: 'bom', text: `${plural(twice.size, 'designator')} ${twice.size === 1 ? 'is' : 'are'} on more than one BOM line: ${few([...twice])}.`, fix: 'Keep each designator on one line only.', refs: [...twice] })
    const qtyOff = bom.lines.filter((l) => l.qty !== null && l.qty !== l.refs.length)
    if (qtyOff.length) add({ id: 'bom.qty', severity: 'warning', file: 'bom', text: `${plural(qtyOff.length, 'BOM line')} give${qtyOff.length === 1 ? 's' : ''} a quantity that differs from ${qtyOff.length === 1 ? 'its' : 'their'} designators (line ${few(qtyOff.map((l) => `${l.row}: ${l.qty} for ${l.refs.length}`), 5)}).`, fix: 'Correct the quantity; JLCPCB places by the designators.' })
    if (!bom.has.lcsc) add({ id: 'bom.no_lcsc_column', severity: 'warning', file: 'bom', text: 'The BOM has no LCSC part column, so JLCPCB cannot match its parts by number.', fix: 'Add an "LCSC Part #" column, or match each part on JLCPCB\'s order page.' })
    else {
      const none = bom.lines.filter((l) => !l.lcsc)
      if (none.length) add({ id: 'bom.no_lcsc', severity: 'warning', file: 'bom', text: `${plural(none.length, 'BOM line')} ${none.length === 1 ? 'has' : 'have'} no LCSC part, so JLCPCB will not place ${none.length === 1 ? 'it' : 'them'}: ${few(none.flatMap((l) => l.refs))}.`, fix: 'Give each an LCSC part, or plan to fit them by hand.', refs: none.flatMap((l) => l.refs) })
      const bad = bom.lines.filter((l) => l.lcsc && !LCSC.test(l.lcsc))
      if (bad.length) add({ id: 'bom.lcsc_form', severity: 'warning', file: 'bom', text: `${plural(bad.length, 'LCSC part')} ${bad.length === 1 ? 'is' : 'are'} not in LCSC's form (C and digits): ${few(bad.map((l) => l.lcsc!))}.`, fix: 'Correct the part numbers.', refs: bad.flatMap((l) => l.refs) })
    }
    if (bom.has.stock) {
      const out = bom.lines.filter((l) => l.stock === 0)
      const short = bom.lines.filter((l) => l.stock !== null && l.stock > 0 && l.stock < l.refs.length * quantity)
      if (out.length) add({ id: 'bom.out_of_stock', severity: 'warning', file: 'bom', text: `${plural(out.length, 'part')} had no stock at JLCPCB when the BOM was made: ${few(out.map((l) => `${l.value ?? l.mpn ?? l.lcsc} (${few(l.refs, 4)})`), 6)}.`, fix: 'trace checks stock again at Fabricate and suggests in-stock alternatives; you can also choose one now and give the BOM again.', refs: out.flatMap((l) => l.refs) })
      if (short.length) add({ id: 'bom.short', severity: 'warning', file: 'bom', text: `${plural(short.length, 'part')} had less stock than ${quantity} board${quantity === 1 ? '' : 's'} need: ${few(short.map((l) => `${l.value ?? l.lcsc} (${l.stock} for ${l.refs.length * quantity})`), 6)}.`, fix: 'trace checks stock again at Fabricate; lower the quantity or choose alternatives if it is still short.', refs: short.flatMap((l) => l.refs) })
    } else add({ id: 'bom.no_stock', severity: 'note', file: 'bom', text: 'The BOM carries no stock column.', fix: 'Nothing to do: trace checks stock and price at Fabricate.' })
  }

  // the pick and place
  let placements: Placement[] = []
  if (!i.cpl) add({ id: 'cpl.missing', severity: 'blocking', file: 'cpl', text: 'No pick and place file was given.', fix: 'Give the placement (CPL) file as a CSV.' })
  else if (i.cpl.length > MAX_CSV) add({ id: 'cpl.too_big', severity: 'blocking', file: 'cpl', text: `The pick and place file is ${(i.cpl.length / MB).toFixed(1)} MB; at most ${MAX_CSV / MB} MB is taken.`, fix: 'Check it is the placement file.' })
  else {
    try { placements = readCpl(i.cpl) } catch (e) { add({ id: 'cpl.unreadable', severity: 'blocking', file: 'cpl', text: e instanceof Error ? e.message : String(e), fix: 'Export the placement file as a CSV with Designator, Mid X, Mid Y, Layer and Rotation.' }) }
    if (i.cpl && !placements.length && !findings.some((f) => f.id === 'cpl.unreadable')) add({ id: 'cpl.empty', severity: 'blocking', file: 'cpl', text: 'The pick and place file has no rows.', fix: 'Export it again from the board.' })
  }
  const placedTwice = (() => { const s = new Set<string>(); const d = new Set<string>(); for (const p of placements) { if (s.has(p.ref)) d.add(p.ref); s.add(p.ref) } return [...d] })()
  if (placedTwice.length) add({ id: 'cpl.duplicate', severity: 'blocking', file: 'cpl', text: `${plural(placedTwice.length, 'designator')} ${placedTwice.length === 1 ? 'is' : 'are'} placed twice: ${few(placedTwice)}.`, fix: 'Keep one row per designator.', refs: placedTwice })
  if (g?.outline && placements.length) {
    const o = g.outline
    const m = 1
    const outside = placements.filter((p) => p.x < o.x0 - m || p.x > o.x1 + m || p.y < o.y0 - m || p.y > o.y1 + m)
    if (outside.length > placements.length / 2) add({ id: 'cpl.origin', severity: 'blocking', file: 'cpl', text: `${outside.length} of ${placements.length} placements are outside the board outline: the placement file and the Gerbers do not share an origin.`, fix: 'Export both from the same origin (KiCad: "Use drill/place file origin" the same in both), then give them again.', refs: outside.map((p) => p.ref) })
    else if (outside.length) add({ id: 'cpl.outside', severity: 'warning', file: 'cpl', text: `${plural(outside.length, 'placement')} ${outside.length === 1 ? 'is' : 'are'} outside the board outline: ${few(outside.map((p) => p.ref))}.`, fix: 'Check those parts\' positions; JLCPCB will ask about them.', refs: outside.map((p) => p.ref) })
  }

  // the BOM against the placements
  let handPlaced: string[] = []
  if (bom && placements.length) {
    const placed = new Set(placements.map((p) => p.ref))
    const listed = new Set(bom.lines.flatMap((l) => l.refs))
    handPlaced = [...listed].filter((r) => !placed.has(r))
    const unlisted = [...placed].filter((r) => !listed.has(r))
    if (handPlaced.length) add({ id: 'match.unplaced', severity: 'warning', file: 'cpl', text: `${plural(handPlaced.length, 'BOM part')} ${handPlaced.length === 1 ? 'has' : 'have'} no placement, so JLCPCB will not fit ${handPlaced.length === 1 ? 'it' : 'them'}: ${few(handPlaced)}.`, fix: 'Usually through-hole or hand-fitted parts; if not, export the placement file again with them.', refs: handPlaced })
    if (unlisted.length) add({ id: 'match.unlisted', severity: 'warning', file: 'bom', text: `${plural(unlisted.length, 'placement')} ${unlisted.length === 1 ? 'has' : 'have'} no BOM line, so JLCPCB will skip ${unlisted.length === 1 ? 'it' : 'them'}: ${few(unlisted)}.`, fix: 'Add them to the BOM, or leave them if they are fiducials or not fitted.', refs: unlisted })
  }

  // the overview
  const overview = checkOverview(i.overview)
  if (overview.chars > MAX_OVERVIEW) add({ id: 'overview.too_long', severity: 'blocking', file: 'overview', text: `The overview is ${overview.chars.toLocaleString('en')} characters; at most ${MAX_OVERVIEW.toLocaleString('en')} are taken.`, fix: 'Keep the overview to the project; attach long specifications to the project later.' })
  else if (!overview.ok) {
    const missing = overview.topics.filter((t) => !t.found)
    add({
      id: 'overview.thin', severity: 'blocking', file: 'overview',
      text: overview.chars < MIN_OVERVIEW ? `The overview is ${overview.chars} characters; trace needs at least ${MIN_OVERVIEW} to start the intent from it.` : `The overview covers ${overview.found} of ${overview.topics.length} topics; it needs at least ${MIN_TOPICS}.`,
      fix: `Add: ${missing.map((t) => t.ask).join(' ')}`,
    })
  } else if (overview.found < overview.topics.length) {
    const missing = overview.topics.filter((t) => !t.found)
    add({ id: 'overview.topics', severity: 'note', file: 'overview', text: `The overview does not say: ${missing.map((t) => t.title.toLowerCase()).join(', ')}.`, fix: missing.map((t) => t.ask).join(' ') })
  }

  // what JLCPCB's order form takes, from these files (the shape kicad.fab records)
  const options: Inspection['order_options'] = []
  const JOB = 'the Gerber job file'
  const DEFAULT = 'JLCPCB\'s default: not decided in the files'
  if (g) {
    options.push({ group: 'pcb', option: 'Base material', value: 'FR-4', source: DEFAULT, decided: false })
    options.push({ group: 'pcb', option: 'Layers', value: String(g.copper), source: 'the Gerbers', decided: true })
    if (g.outline) options.push({ group: 'pcb', option: 'Dimensions', value: `${round2(g.outline.width_mm)} x ${round2(g.outline.height_mm)} mm`, source: 'the outline layer', decided: true })
    options.push(g.job?.thickness_mm ? { group: 'pcb', option: 'PCB thickness', value: `${g.job.thickness_mm} mm`, source: JOB, decided: true } : { group: 'pcb', option: 'PCB thickness', value: '1.6 mm', source: DEFAULT, decided: false })
    if (g.drills.smallest_mm !== null) options.push({ group: 'pcb', option: 'Min hole size', value: `${g.drills.smallest_mm} mm`, source: 'the drill files', decided: true })
    options.push({ group: 'pcb', option: 'Solder mask colour', value: 'Green', source: DEFAULT, decided: false })
    options.push({ group: 'pcb', option: 'Silkscreen colour', value: 'White', source: DEFAULT, decided: false })
    options.push(g.job?.finish && g.job.finish !== 'None' ? { group: 'pcb', option: 'Surface finish', value: g.job.finish, source: JOB, decided: true } : { group: 'pcb', option: 'Surface finish', value: 'HASL', source: DEFAULT, decided: false })
    if (g.job?.impedance !== null && g.job?.impedance !== undefined) options.push({ group: 'pcb', option: 'Impedance control', value: g.job.impedance ? 'Yes' : 'No', source: JOB, decided: true })
  }
  const top = placements.filter((p) => p.side === 'top').length
  const bottom = placements.length - top
  if (placements.length) {
    options.push({ group: 'pcba', option: 'PCBA', value: 'Yes', source: 'the placement file', decided: true })
    options.push({ group: 'pcba', option: 'Assembly side', value: `${bottom === 0 ? 'Top side' : top === 0 ? 'Bottom side' : 'Both sides'} (${placements.length} placed parts${top && bottom ? `: ${top} top, ${bottom} bottom` : ''})`, source: 'the placement file', decided: true })
  }
  if (bom) options.push({ group: 'pcba', option: 'BOM', value: `${bom.lines.length} lines, ${bom.parts} parts`, source: 'the parts list', decided: true })

  const ok = !findings.some((f) => f.severity === 'blocking')
  const order: Record<Severity, number> = { blocking: 0, warning: 1, note: 2 }
  findings.sort((a, b) => order[a.severity] - order[b.severity])
  const recommended: Inspection['recommended'] = i.built
    ? { entry: 'bringup', why: 'You said the boards are built: their bench results become revision A\'s first evidence.' }
    : { entry: 'fabricate', why: 'The boards are not made yet: trace prepares the JLCPCB order from these files, checks stock again today, and you sign the order.' }
  return {
    summary: {
      board: {
        layers: g?.copper ?? 0, width_mm: g?.outline?.width_mm ?? g?.job?.width_mm ?? null, height_mm: g?.outline?.height_mm ?? g?.job?.height_mm ?? null,
        thickness_mm: g?.job?.thickness_mm ?? null, finish: g?.job?.finish ?? null, impedance: g?.job?.impedance ?? null,
        smallest_hole_mm: g?.drills.smallest_mm ?? null, holes: g?.drills.holes ?? 0,
      },
      tool: g?.tool ?? null, project: g?.project ?? { name: null, revision: null }, files: g?.files.length ?? 0,
      bom: {
        lines: bom?.lines.length ?? 0, parts: bom?.parts ?? 0, with_lcsc: bom?.lines.filter((l) => l.lcsc).length ?? 0,
        basic: bom?.lines.filter((l) => l.library === 'basic').length ?? 0, extended: bom?.lines.filter((l) => l.library === 'extended').length ?? 0,
        out_of_stock: bom?.lines.filter((l) => l.stock === 0).length ?? 0,
      },
      placements: { total: placements.length, top, bottom, hand_placed: handPlaced.length },
      overview: { chars: overview.chars, topics: overview.found, of: overview.topics.length },
    },
    gerbers: g, bom, placements, overview, findings, ok, hand_placed: handPlaced, order_options: options, recommended,
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/** The inspection without the bulky parts (each placement, each BOM line): what the app and the record keep. Pure. */
export function inspectionView(x: Inspection): Omit<Inspection, 'placements' | 'bom' | 'gerbers'> & { layers: Pick<GerberFile, 'name' | 'kind' | 'side' | 'layer' | 'bytes'>[] } {
  const { placements: _p, bom: _b, gerbers, ...rest } = x
  return { ...rest, layers: (gerbers?.files ?? []).map((f) => ({ name: f.name, kind: f.kind, side: f.side, layer: f.layer, bytes: f.bytes })) }
}

/** The repository paths the imported files are kept at, for a board named `board` at `revision`. Pure. */
export function importPaths(board: string, revision = 'A'): { dir: string; gerbers: string; bom: string; cpl: string; inspection: string; overview: string } {
  const b = board.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'board'
  const dir = `hardware/${b}/release/rev${revision}`
  return { dir, gerbers: `${dir}/${b}-gerbers.zip`, bom: `${dir}/${b}-jlc-bom.csv`, cpl: `${dir}/${b}-jlc-cpl.csv`, inspection: `${dir}/import.json`, overview: 'docs/overview.md' }
}
