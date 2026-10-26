/**
 * Reading a routed KiCad 6–10 board: its copper, its parts, its outline, and what the copper does to a signal.
 *
 * Checks and agents need facts the schematic does not hold: how long a net is and on which layers, how it runs
 * between two pins, which vias it passes, what impedance a trace has on the board's own stackup, where each part
 * sits, how big the board is, what the design rules are. This module reads a .kicad_pcb once into a `Board` (plain,
 * serialisable data) and answers questions about it:
 *
 *   board.layers                 copper layers top-down, each with its copper thickness and the dielectric above/below
 *   board.footprints             ref, value, side, position, rotation, pads, attributes
 *   board.outline                Edge.Cuts bounding box (mm)
 *   new Net(board, name)         one net's segments, arcs, vias and pads joined into a graph
 *   net.length_m / byLayer()     total routed length, and per layer
 *   net.path('R4.2', 'U1.7')     the shortest routed path between two pads: length, layers, vias
 *   net.tree('U1.7')             the net cut into branches between pads and forks (a transmission-line model's input)
 *   z0(layer, w), delay(layer, w), capPerM(layer, w)   a copper layer's electrical properties at trace width w
 *
 * Impedance uses closed forms parameterised by the board's stackup: Hammerstad-Jensen microstrip (with the thickness
 * correction) on the outer layers, the IPC-2141A asymmetric stripline on inner layers. They are within a few percent
 * of a field solver for ordinary geometries; results computed from them say "model: analytic". When the board has no
 * stackup, or a dielectric has no permittivity, the figures are null: never guessed.
 *
 * Connectivity follows tracks, arcs and vias only. Copper pours (zones) are not filled here, so a pad that is reached
 * only through a pour shows as unreached; outputs say so.
 *
 * KiCad 6–9 refer to nets by number with a table at the top of the file; KiCad 10 writes the name in place. Both are
 * read. Arcs are measured as true circular arcs through their three points.
 *
 * Parsing a large board takes a couple of seconds, so the parsed Board is kept in the cache database (store.Cache)
 * keyed by the file's sha256 and reused while the file is unchanged.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ToolError } from '../../core/registry.js'
import { Cache } from '../../core/store.js'
import { fileVersion, type FileVersion } from './project.js'
import * as sx from './sexpr.js'
import type { SList } from './sexpr.js'

export const C0 = 299_792_458
export const ETA0 = 376.730313668
const CACHE_NS = 'kicad.pcb'
const CACHE_VERSION = 4

// ------------------------------------------------------------------ closed forms

/** Hammerstad-Jensen microstrip with the thickness correction: [Z0 (ohm), er_eff]. Lengths in any one unit. */
export function microstrip(w: number, h: number, t: number, er: number): [number, number] {
  if (!(w > 0) || !(h > 0) || !(er >= 1)) throw new RangeError('microstrip needs w > 0, h > 0, er >= 1')
  if (t > 0) {
    const dw = (t / Math.PI) * (1 + Math.log((4 * Math.E) / Math.sqrt((t / h) ** 2 + (1 / Math.PI / (w / t + 1.1)) ** 2)))
    w = w + (dw * (1 + 1 / Math.cosh(Math.sqrt(er - 1)))) / 2
  }
  const u = w / h
  const a = 1 + Math.log((u ** 4 + (u / 52) ** 2) / (u ** 4 + 0.432)) / 49 + Math.log(1 + (u / 18.1) ** 3) / 18.7
  const b = 0.564 * ((er - 0.9) / (er + 3)) ** 0.053
  const ee = (er + 1) / 2 + ((er - 1) / 2) * (1 + 10 / u) ** (-a * b)
  const f = 6 + (2 * Math.PI - 6) * Math.exp(-((30.666 / u) ** 0.7528))
  const z01 = (ETA0 / (2 * Math.PI)) * Math.log(f / u + Math.sqrt(1 + (2 / u) ** 2))
  return [z01 / Math.sqrt(ee), ee]
}

/** Centred stripline between planes b apart (IPC-2141A; valid for w/b < 0.35 and t/b < 0.25). */
export function striplineSymmetric(w: number, b: number, t: number, er: number): number {
  return (60 / Math.sqrt(er)) * Math.log((4 * b) / (0.67 * Math.PI * (0.8 * w + t)))
}

/** Off-centre stripline with dielectric h1 above and h2 below: IPC-2141A's combination of two symmetric striplines
 * of plate spacing 2h + t. */
export function stripline(w: number, h1: number, h2: number, t: number, er: number): number {
  const za = striplineSymmetric(w, 2 * h1 + t, t, er)
  const zb = striplineSymmetric(w, 2 * h2 + t, t, er)
  return (2 * za * zb) / (za + zb)
}

// ------------------------------------------------------------------ stackup

/** [thickness (m), er] of the dielectric between two copper layers; er null when the stackup does not give it. */
export type Dielectric = [number, number | null]

export interface Layer {
  name: string
  /** 0 = F.Cu, top down */
  index: number
  /** copper thickness (m) */
  t: number | null
  below: Dielectric | null
  above: Dielectric | null
  outer: boolean
  /** [thickness m, er] of the solder mask over an outer layer */
  mask: [number, number] | null
}

function ready(L: Layer): { h: number; er: number; h2?: number; er2?: number } | null {
  if (L.t === null) return null
  if (L.outer) {
    const d = L.index === 0 ? L.below : L.above
    if (!d || !d[0] || !d[1]) return null
    return { h: d[0], er: d[1] }
  }
  const a = L.above
  const b = L.below
  if (!a || !b || !a[0] || !a[1] || !b[0] || !b[1]) return null
  return { h: a[0], er: a[1], h2: b[0], er2: b[1] }
}

/** Single-ended characteristic impedance (ohm) of a trace of width w (m) on this layer; null without stackup data. */
export function z0(L: Layer, w: number): number | null {
  const r = ready(L)
  if (!r || L.t === null) return null
  if (L.outer) return microstrip(w, r.h, L.t, r.er)[0]
  const h2 = r.h2 as number
  const er2 = r.er2 as number
  return stripline(w, r.h, h2, L.t, (r.er * r.h + er2 * h2) / (r.h + h2))
}

export function erEff(L: Layer, w: number): number | null {
  const r = ready(L)
  if (!r || L.t === null) return null
  if (L.outer) {
    let e = microstrip(w, r.h, L.t, r.er)[1]
    if (L.mask) e += (L.mask[1] - 1) * (1 - Math.exp((-1.0 * L.mask[0]) / r.h)) * 0.5 // thin mask (Wadell's approximation)
    return e
  }
  const h2 = r.h2 as number
  return (r.er * r.h + (r.er2 as number) * h2) / (r.h + h2)
}

/** Propagation delay per metre (s/m). */
export function delay(L: Layer, w: number): number | null {
  const e = erEff(L, w)
  return e ? Math.sqrt(e) / C0 : null
}

/** Capacitance per metre (F/m): delay / Z0. */
export function capPerM(L: Layer, w: number): number | null {
  const d = delay(L, w)
  const z = z0(L, w)
  return d && z ? d / z : null
}

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4
const r2 = (x: number): number => Math.round(x * 100) / 100

export interface LayerDescription {
  name: string
  index: number
  outer: boolean
  copper_um: number | null
  dielectric_above_mm: number | null
  er_above: number | null
  dielectric_below_mm: number | null
  er_below: number | null
  width_mm?: number
  z0_ohm?: number | null
  er_eff?: number | null
  delay_ps_per_mm?: number | null
  cap_pf_per_mm?: number | null
  model?: string
}

export function describeLayer(L: Layer, w?: number): LayerDescription {
  const out: LayerDescription = {
    name: L.name, index: L.index, outer: L.outer, copper_um: L.t !== null ? r2(L.t * 1e6) : null,
    dielectric_above_mm: L.above ? r4(L.above[0] * 1e3) : null, er_above: L.above ? L.above[1] : null,
    dielectric_below_mm: L.below ? r4(L.below[0] * 1e3) : null, er_below: L.below ? L.below[1] : null,
  }
  if (w) {
    const z = z0(L, w)
    const d = delay(L, w)
    const c = capPerM(L, w)
    const e = erEff(L, w)
    out.width_mm = r4(w * 1e3)
    out.z0_ohm = z !== null ? r2(z) : null
    out.er_eff = e !== null ? Math.round(e * 1000) / 1000 : null
    out.delay_ps_per_mm = d !== null ? Math.round(d * 1e9 * 1000) / 1000 : null
    out.cap_pf_per_mm = c !== null ? r4(c * 1e9) : null
    out.model = z !== null ? (L.outer ? 'analytic: Hammerstad-Jensen microstrip' : 'analytic: IPC-2141A stripline')
      : 'unavailable: the stackup lacks thickness or permittivity for this layer'
  }
  return out
}

function copperOrder(names: string[]): string[] {
  const key = (n: string): number => (n === 'F.Cu' ? 0 : n === 'B.Cu' ? 10_000 : Number(/^In(\d+)\.Cu$/.exec(n)?.[1] ?? 5000))
  return [...names].sort((a, b) => key(a) - key(b))
}

interface StackRow { name: string; type: string; t: number | null; er: number | null }

function stackup(tree: SList, copperNames: string[]): Layer[] {
  const st = sx.find(sx.find(tree, 'setup'), 'stackup')
  const rows: StackRow[] = []
  for (const ly of sx.findAll(st, 'layer')) {
    const th = sx.numValue(ly, 'thickness')
    rows.push({ name: sx.atomAt(ly, 1) ?? '', type: sx.value(ly, 'type') ?? '', t: th !== undefined ? th * 1e-3 : null, er: sx.numValue(ly, 'epsilon_r') ?? null })
  }
  const cuRows = rows.filter((r) => r.type === 'copper')
  const order = cuRows.length ? cuRows.map((r) => r.name) : copperOrder(copperNames)
  const n = order.length
  const gap = (seq: StackRow[]): Dielectric | null => {
    let th = 0
    const parts: [number, number | null][] = []
    for (const r of seq) {
      if (r.type === 'copper') break
      if (r.name.startsWith('dielectric') || r.type === 'core' || r.type === 'prepreg') {
        if (r.t === null) return null
        th += r.t
        parts.push([r.t, r.er])
      }
    }
    if (!parts.length) return null
    const er = parts.some(([, e]) => e === null) ? null : parts.reduce((s, [h, e]) => s + h * (e as number), 0) / th
    return [th, er]
  }
  return order.map((name, k) => {
    let t: number | null = null
    let below: Dielectric | null = null
    let above: Dielectric | null = null
    let mask: [number, number] | null = null
    if (cuRows.length) {
      const pos = rows.findIndex((r) => r.name === name)
      t = rows[pos]?.t ?? null
      if (k < n - 1) below = gap(rows.slice(pos + 1))
      if (k > 0) above = gap(rows.slice(0, pos).reverse())
      if (k === 0 || k === n - 1) {
        const m = rows.find((r) => r.type === (k === 0 ? 'Top Solder Mask' : 'Bottom Solder Mask'))
        if (m?.t) mask = [m.t, m.er ?? 3.8] // 3.8: KiCad's own default for a mask without one
      }
    }
    return { name, index: k, t, below, above, outer: k === 0 || k === n - 1, mask }
  })
}

// ------------------------------------------------------------------ the board

/** [x1, y1, x2, y2, width, layer, length] in mm; for an arc, length is the true arc length. */
export type Segment = [number, number, number, number, number, string, number]
/** [x, y, size, drill, top layer, bottom layer] in mm */
export type Via = [number, number, number, number | null, string, string]

export interface Pad {
  ref: string
  num: string
  x: number
  y: number
  /** axis-aligned bounding size after rotation (mm) */
  w: number
  h: number
  layers: string[]
  net: string
  kind: string
}

export const padId = (p: Pad): string => `${p.ref}.${p.num}`

export interface FootprintPad { num: string; net: string | null; x_mm: number; y_mm: number; type: string }

export interface Footprint {
  ref: string
  value: string
  footprint: string
  layer: string
  side: 'top' | 'bottom'
  x_mm: number
  y_mm: number
  rotation_deg: number
  mount: 'smd' | 'through_hole' | 'unspecified'
  dnp: boolean
  exclude_from_bom: boolean
  exclude_from_pos_files: boolean
  pads: FootprintPad[]
  fields: Record<string, string>
}

export interface Outline { min_x_mm: number; min_y_mm: number; max_x_mm: number; max_y_mm: number; width_mm: number; height_mm: number }

export interface Zone { net: string | null; layers: string[]; copper: boolean; keepout: boolean; name: string | null }

export interface LayerTableRow { id: string; name: string; type: string; user_name?: string }

export type SetupValue = number | string | string[]

export interface Board {
  v: number
  path: string
  sha256: string
  kicad: FileVersion
  /** copper, top down */
  layers: Layer[]
  layer_table: LayerTableRow[]
  segments: Record<string, Segment[]>
  vias: Record<string, Via[]>
  pads: Record<string, Pad[]>
  footprints: Footprint[]
  outline: Outline | null
  zones: Zone[]
  setup: Record<string, SetupValue>
  thickness_mm: number | null
  title: Record<string, string>
}

export class PcbError extends ToolError {
  override name = 'PcbError'
}

export function layerOf(b: Board, name: string): Layer {
  const L = b.layers.find((l) => l.name === name)
  if (!L) throw new PcbError(`${JSON.stringify(name)} is not a copper layer (layers: ${b.layers.map((l) => l.name).join(', ')})`)
  return L
}

export function netNames(b: Board): string[] {
  return [...new Set([...Object.keys(b.segments), ...Object.keys(b.pads), ...Object.keys(b.vias)])].sort()
}

export function stackupKnown(b: Board): boolean {
  return b.layers.every((L) => L.t !== null) && b.layers.every((L) => L.index === b.layers.length - 1 || (L.below !== null && L.below[0] > 0))
}

/** Barrel length (m) between two copper layers (centre of one copper to centre of the other); null without a stackup. */
export function viaLength(b: Board, top: string, bottom: string): number | null {
  const ia = b.layers.find((l) => l.name === top)?.index
  const ib = b.layers.find((l) => l.name === bottom)?.index
  if (ia === undefined || ib === undefined) return null
  const lo = Math.min(ia, ib)
  const hi = Math.max(ia, ib)
  let z = 0
  for (let k = lo; k <= hi; k++) {
    const L = b.layers[k]
    if (!L || L.t === null) return null
    z += k === lo || k === hi ? L.t / 2 : L.t
    if (k < hi) {
      if (!L.below) return null
      z += L.below[0]
    }
  }
  return lo === hi ? 0 : z
}

/** The circle through three points: [cx, cy, r], or null when they are collinear. */
function circle(x1: number, y1: number, xm: number, ym: number, x2: number, y2: number): [number, number, number] | null {
  const ax = x1 - xm
  const ay = y1 - ym
  const bx = x2 - xm
  const by = y2 - ym
  const d = 2 * (ax * by - ay * bx)
  if (Math.abs(d) < 1e-12) return null
  const a2 = ax * ax + ay * ay
  const b2 = bx * bx + by * by
  const cx = xm + (by * a2 - ay * b2) / d
  const cy = ym + (ax * b2 - bx * a2) / d
  return [cx, cy, Math.hypot(x1 - cx, y1 - cy)]
}

const TAU = 2 * Math.PI
const mod = (a: number, m: number): number => ((a % m) + m) % m

/** Length of the circular arc from (x1,y1) through (xm,ym) to (x2,y2); the chord for collinear points. */
export function arcLength(x1: number, y1: number, xm: number, ym: number, x2: number, y2: number): number {
  const c = circle(x1, y1, xm, ym, x2, y2)
  if (!c) return Math.hypot(x2 - x1, y2 - y1)
  const [cx, cy, r] = c
  const t1 = Math.atan2(y1 - cy, x1 - cx)
  const tm = Math.atan2(ym - cy, xm - cx)
  const t2 = Math.atan2(y2 - cy, x2 - cx)
  let sweep = mod(t2 - t1, TAU)
  if (mod(tm - t1, TAU) > sweep) sweep = TAU - sweep
  return r * sweep
}

/** The arc's ends plus the axis extremes it passes (for bounding boxes). */
function arcExtent(x1: number, y1: number, xm: number, ym: number, x2: number, y2: number): [number, number][] {
  const pts: [number, number][] = [[x1, y1], [xm, ym], [x2, y2]]
  const c = circle(x1, y1, xm, ym, x2, y2)
  if (!c) return pts
  const [cx, cy, r] = c
  const t1 = Math.atan2(y1 - cy, x1 - cx)
  const tm = Math.atan2(ym - cy, xm - cx)
  const t2 = Math.atan2(y2 - cy, x2 - cx)
  let sweep = mod(t2 - t1, TAU)
  let sign = 1
  if (mod(tm - t1, TAU) > sweep) {
    sweep = TAU - sweep
    sign = -1
  }
  for (let k = 0; k < 4; k++) {
    const ang = (k * Math.PI) / 2
    if (mod(sign * (ang - t1), TAU) <= sweep) pts.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)])
  }
  return pts
}

/** A footprint-local point to board coordinates (KiCad's y-down frame, angle counter-clockwise on screen). */
function rot(px: number, py: number, fx: number, fy: number, deg: number): [number, number] {
  const th = (deg * Math.PI) / 180
  return [fx + px * Math.cos(th) + py * Math.sin(th), fy - px * Math.sin(th) + py * Math.cos(th)]
}

function layersOf(node: SList): string[] {
  const one = sx.value(node, 'layer')
  if (one !== undefined) return [one]
  const many = sx.find(node, 'layers')
  return many ? sx.atoms(many) : []
}

function point(node: SList, name: string): [number, number] | null {
  const c = sx.find(node, name)
  const x = sx.num(c?.[1])
  const y = sx.num(c?.[2])
  return x !== undefined && y !== undefined ? [x, y] : null
}

function edgePoints(node: SList): [number, number][] {
  const kind = sx.head(node) ?? ''
  let pts: [number, number][] = []
  if (kind.endsWith('_line') || kind.endsWith('_rect')) {
    const a = point(node, 'start')
    const b = point(node, 'end')
    if (a && b) pts = kind.endsWith('_line') ? [a, b] : [a, b, [a[0], b[1]], [b[0], a[1]]]
  } else if (kind.endsWith('_arc')) {
    const a = point(node, 'start')
    const m = point(node, 'mid')
    const b = point(node, 'end')
    if (a && m && b) pts = arcExtent(a[0], a[1], m[0], m[1], b[0], b[1])
    else if (a && b) {
      // KiCad 6 footprint arcs: (start centre) (end point) (angle)
      const r = Math.hypot(b[0] - a[0], b[1] - a[1])
      pts = [[a[0] - r, a[1] - r], [a[0] + r, a[1] + r]]
    }
  } else if (kind.endsWith('_circle')) {
    const c = point(node, 'center')
    const e = point(node, 'end')
    if (c && e) {
      const r = Math.hypot(e[0] - c[0], e[1] - c[1])
      pts = [[c[0] - r, c[1] - r], [c[0] + r, c[1] + r]]
    }
  } else if (kind.endsWith('_poly') || kind.endsWith('_curve')) {
    const p = sx.find(node, 'pts')
    for (const q of sx.findAll(p, 'xy')) {
      const x = sx.num(q[1])
      const y = sx.num(q[2])
      if (x !== undefined && y !== undefined) pts.push([x, y])
    }
    for (const arc of sx.findAll(p, 'arc')) {
      const a = point(arc, 'start')
      const m = point(arc, 'mid')
      const b = point(arc, 'end')
      if (a && m && b) pts.push(...arcExtent(a[0], a[1], m[0], m[1], b[0], b[1]))
    }
  }
  return pts
}

function setupRules(tree: SList): Record<string, SetupValue> {
  const out: Record<string, SetupValue> = {}
  const setup = sx.find(tree, 'setup')
  if (!setup) return out
  for (const c of sx.children(setup)) {
    const k = sx.head(c)
    if (!k || k === 'stackup' || k === 'pcbplotparams') continue
    const a = sx.atoms(c)
    if (a.length === 1) out[k] = sx.num(a[0]) ?? (a[0] as string)
    else if (a.length) out[k] = a
  }
  return out
}

function fpRefValue(fp: SList): { ref: string; value: string; props: Record<string, string> } {
  const props: Record<string, string> = {}
  for (const p of sx.findAll(fp, 'property')) {
    const k = sx.atomAt(p, 1)
    const v = sx.atomAt(p, 2)
    if (k !== undefined && v !== undefined) props[k] = v
  }
  let ref = props.Reference
  let value = props.Value
  for (const t of sx.findAll(fp, 'fp_text')) {
    if (t[1] === 'reference' && ref === undefined) ref = sx.atomAt(t, 2)
    if (t[1] === 'value' && value === undefined) value = sx.atomAt(t, 2)
  }
  return { ref: ref ?? '?', value: value ?? '', props }
}

/** Read a .kicad_pcb (uncached: see loadBoard). */
export function parseBoard(path: string): Board {
  const p = resolve(path)
  const raw = readFileSync(p)
  const sha256 = createHash('sha256').update(raw).digest('hex')
  let tree: SList
  try {
    tree = sx.parse(raw.toString('utf8'))
  } catch (e) {
    if (e instanceof sx.SexprError) throw new PcbError(`${p} is not a readable KiCad board: ${e.message}`)
    throw e
  }
  if (sx.head(tree) !== 'kicad_pcb') throw new PcbError(`${p} is not a KiCad board (it starts with ${JSON.stringify(sx.head(tree) ?? '')})`)

  const layerTable: LayerTableRow[] = []
  const copperNames: string[] = []
  for (const row of sx.children(sx.find(tree, 'layers') ?? ['layers'])) {
    const [id, name, type, user] = [sx.atomAt(row, 0), sx.atomAt(row, 1), sx.atomAt(row, 2), sx.atomAt(row, 3)]
    if (id === undefined || name === undefined || type === undefined) continue
    layerTable.push(user !== undefined ? { id, name, type, user_name: user } : { id, name, type })
    if (name.endsWith('.Cu')) copperNames.push(name)
  }
  const layers = stackup(tree, copperNames)
  const cuNames = layers.map((l) => l.name)
  const cuSet = new Set(cuNames)

  // the net table (KiCad 6–9 number nets; KiCad 10 names them in place)
  const netTable = new Map<string, string>()
  for (const n of sx.findAll(tree, 'net')) {
    const code = sx.atomAt(n, 1)
    const name = sx.atomAt(n, 2)
    if (code !== undefined && name !== undefined) netTable.set(code, name)
  }
  const netOf = (node: SList): string | null => {
    const c = sx.find(node, 'net')
    if (!c) return null
    const a = sx.atomAt(c, 1)
    const b = sx.atomAt(c, 2)
    if (b !== undefined) return b || null
    if (a === undefined) return null
    const named = netTable.get(a)
    if (named !== undefined) return named || null
    return /^\d+$/.test(a) ? null : a || null
  }

  const segments: Record<string, Segment[]> = {}
  const vias: Record<string, Via[]> = {}
  const segSeen = new Set<string>()
  const viaSeen = new Set<string>()
  for (const node of sx.children(tree)) {
    const kind = node[0]
    if (kind === 'segment' || kind === 'arc') {
      const net = netOf(node)
      const a = point(node, 'start')
      const e = point(node, 'end')
      const w = sx.numValue(node, 'width')
      const ly = sx.value(node, 'layer')
      if (!net || !a || !e || w === undefined || !ly) continue
      let L = Math.hypot(e[0] - a[0], e[1] - a[1])
      if (kind === 'arc') {
        const m = point(node, 'mid')
        if (m) L = arcLength(a[0], a[1], m[0], m[1], e[0], e[1])
      }
      const s: Segment = [a[0], a[1], e[0], e[1], w, ly, L]
      const key = `${net}|${s.join(',')}`
      if (segSeen.has(key)) continue // a board can carry the same track twice
      segSeen.add(key)
      ;(segments[net] ??= []).push(s)
    } else if (kind === 'via') {
      const net = netOf(node)
      const at = sx.xy(node)
      const size = sx.numValue(node, 'size')
      const ls = layersOf(node)
      if (!net || !at || size === undefined || ls.length < 2) continue
      const v: Via = [at[0], at[1], size, sx.numValue(node, 'drill') ?? null, ls[0] as string, ls[ls.length - 1] as string]
      const key = `${net}|${v.join(',')}`
      if (viaSeen.has(key)) continue
      viaSeen.add(key)
      ;(vias[net] ??= []).push(v)
    }
  }

  const pads: Record<string, Pad[]> = {}
  const footprints: Footprint[] = []
  const edge: [number, number][] = []
  for (const fp of [...sx.findAll(tree, 'footprint'), ...sx.findAll(tree, 'module')]) {
    const at = sx.xy(fp)
    if (!at) continue
    const [fx, fy, fr] = at
    const { ref, value, props } = fpRefValue(fp)
    const side = sx.value(fp, 'layer') ?? 'F.Cu'
    const attr = sx.find(fp, 'attr')
    const attrs = attr ? sx.atoms(attr) : []
    const fpPads: FootprintPad[] = []
    for (const pd of sx.findAll(fp, 'pad')) {
      const num = sx.atomAt(pd, 1)
      const pkind = sx.atomAt(pd, 2)
      const pa = sx.find(pd, 'at')
      const sz = sx.find(pd, 'size')
      const px = sx.num(pa?.[1])
      const py = sx.num(pa?.[2])
      const sw = sx.num(sz?.[1])
      if (num === undefined || pkind === undefined || px === undefined || py === undefined || sw === undefined) continue
      const sh = sx.num(sz?.[2]) ?? sw
      const pr = sx.num(pa?.[3]) ?? 0
      const [x, y] = rot(px, py, fx, fy, fr)
      const a = (pr * Math.PI) / 180 // a pad's angle in the file is absolute (it includes the footprint's)
      const w = Math.abs(sw * Math.cos(a)) + Math.abs(sh * Math.sin(a))
      const h = Math.abs(sw * Math.sin(a)) + Math.abs(sh * Math.cos(a))
      const names = layersOf(pd)
      const cu = pkind === 'thru_hole' || pkind === 'np_thru_hole' || names.includes('*.Cu') ? cuNames : names.filter((n) => cuSet.has(n))
      const net = netOf(pd)
      fpPads.push({ num, net, x_mm: r4(x), y_mm: r4(y), type: pkind })
      if (net) (pads[net] ??= []).push({ ref, num, x, y, w, h, layers: cu, net, kind: pkind })
    }
    for (const g of sx.children(fp)) {
      if ((sx.head(g) ?? '').startsWith('fp_') && layersOf(g).includes('Edge.Cuts')) {
        for (const [qx, qy] of edgePoints(g)) edge.push(rot(qx, qy, fx, fy, fr))
      }
    }
    const kinds = new Set(fpPads.map((q) => q.type))
    const mount: Footprint['mount'] = attrs.includes('smd') ? 'smd' : attrs.includes('through_hole') ? 'through_hole'
      : kinds.has('thru_hole') ? 'through_hole' : kinds.has('smd') ? 'smd' : 'unspecified'
    const fields: Record<string, string> = {}
    for (const [k, v] of Object.entries(props)) if (!['Reference', 'Value', 'Footprint', 'Datasheet'].includes(k) && v !== '' && v !== '~') fields[k] = v
    footprints.push({
      ref, value, footprint: sx.atomAt(fp, 1) ?? '', layer: side, side: side.startsWith('B.') ? 'bottom' : 'top',
      x_mm: r4(fx), y_mm: r4(fy), rotation_deg: Math.round(fr * 1000) / 1000, mount,
      dnp: attrs.includes('dnp'), exclude_from_bom: attrs.includes('exclude_from_bom'),
      exclude_from_pos_files: attrs.includes('exclude_from_pos_files'), pads: fpPads, fields,
    })
  }
  for (const g of sx.children(tree)) {
    if ((sx.head(g) ?? '').startsWith('gr_') && layersOf(g).includes('Edge.Cuts')) edge.push(...edgePoints(g))
  }
  let outline: Outline | null = null
  if (edge.length) {
    const xs = edge.map((q) => q[0])
    const ys = edge.map((q) => q[1])
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    outline = { min_x_mm: r4(x0), min_y_mm: r4(y0), max_x_mm: r4(x1), max_y_mm: r4(y1), width_mm: r4(x1 - x0), height_mm: r4(y1 - y0) }
  }
  const zones: Zone[] = sx.findAll(tree, 'zone').map((z) => {
    const zl = layersOf(z)
    return { net: netOf(z) ?? sx.value(z, 'net_name') ?? null, layers: zl, copper: zl.some((l) => l.endsWith('.Cu')),
      keepout: sx.find(z, 'keepout') !== undefined, name: sx.value(z, 'name') ?? null }
  })
  const title: Record<string, string> = {}
  const tb = sx.find(tree, 'title_block')
  for (const k of ['title', 'date', 'rev', 'company']) {
    const v = sx.value(tb, k)
    if (v) title[k] = v
  }
  return {
    v: CACHE_VERSION, path: p, sha256, kicad: fileVersion(p), layers, layer_table: layerTable, segments, vias, pads, footprints,
    outline, zones, setup: setupRules(tree), thickness_mm: sx.numValue(sx.find(tree, 'general'), 'thickness') ?? null, title,
  }
}

const memo = new Map<string, Board>()

/** The board, parsed once per content: kept in memory and in the cache database, keyed by sha256. */
export function loadBoard(path: string): Board {
  const p = resolve(path)
  if (!existsSync(p)) throw new PcbError(`${p} does not exist`)
  const sha = createHash('sha256').update(readFileSync(p)).digest('hex')
  const hit = memo.get(sha)
  if (hit) return { ...hit, path: p }
  let cache: Cache | null = null
  try {
    cache = new Cache()
  } catch {
    cache = null // an unusable cache only costs time
  }
  try {
    const c = cache?.get<Board>(CACHE_NS, sha)
    if (c && typeof c === 'object' && c.v === CACHE_VERSION && c.sha256 === sha) {
      const b = { ...c, path: p }
      memo.set(sha, b)
      return b
    }
    const b = parseBoard(p)
    memo.set(sha, b)
    try {
      cache?.put(CACHE_NS, sha, b)
    } catch {
      // ignore: caching is best effort
    }
    return b
  } finally {
    cache?.close()
  }
}

export function clearMemo(): void {
  memo.clear()
}

// ------------------------------------------------------------------ one net

type NodeKey = string
type EdgeKind = 'seg' | 'via' | 'land' | 'pad'
interface Edge { to: NodeKey; len: number | null; layer: string; width: number; kind: EdgeKind }

const Q = 1000 // node keys in micrometres
const key = (x: number, y: number, layer: string): NodeKey => `${Math.round(x * Q)},${Math.round(y * Q)},${layer}`
const keyXY = (k: NodeKey): string => k.split(',').slice(0, 2).join(',')

/** A run of copper between two pads or junctions. */
export class Branch {
  length_m = 0
  readonly byLayer = new Map<string, number>()
  readonly width = new Map<string, number>()
  viaLen_m = 0
  viaLenKnown = true
  private readonly viaAt = new Set<string>()

  constructor(public a: string, public b: string) {}

  get vias(): number {
    return this.viaAt.size
  }

  add(from: NodeKey, e: Edge): void {
    if (e.kind === 'via') {
      if (e.len === null) this.viaLenKnown = false
      else this.viaLen_m += e.len
      this.viaAt.add(keyXY(from))
    } else if (e.len) {
      this.byLayer.set(e.layer, (this.byLayer.get(e.layer) ?? 0) + e.len)
      this.width.set(e.layer, Math.max(this.width.get(e.layer) ?? 0, e.width))
    }
    this.length_m += e.len ?? 0
  }

  /** Trace delay layer by layer, plus barrels at an inner layer's delay; null without a stackup. */
  delay(board: Board): number | null {
    let tot = 0
    for (const [ly, L] of this.byLayer) {
      const d = delay(layerOf(board, ly), this.width.get(ly) ?? 1e-4)
      if (d === null) return null
      tot += L * d
    }
    if (this.viaLen_m) {
      const inner = board.layers.find((l) => !l.outer) ?? board.layers[0]
      const d = inner ? delay(inner, 1e-4) : null
      if (d === null) return null
      tot += this.viaLen_m * d
    }
    return tot
  }

  /** Length-weighted characteristic impedance; null without a stackup or trace. */
  z0(board: Board): number | null {
    let tot = 0
    let acc = 0
    for (const [ly, L] of this.byLayer) {
      const z = z0(layerOf(board, ly), this.width.get(ly) ?? 1e-4)
      if (z === null) return null
      tot += L
      acc += L * z
    }
    return tot ? acc / tot : null
  }

  toJSON(board: Board): BranchSummary {
    const d = this.delay(board)
    const z = this.z0(board)
    const order = (ly: string): number => board.layers.find((l) => l.name === ly)?.index ?? 99
    const trace = [...this.byLayer.values()].reduce((s, v) => s + v, 0)
    return {
      from: this.a, to: this.b, length_mm: r4(this.length_m * 1e3), trace_mm: r4(trace * 1e3),
      by_layer_mm: Object.fromEntries([...this.byLayer].sort((x, y) => order(x[0]) - order(y[0])).map(([k, v]) => [k, r4(v * 1e3)])),
      width_mm: Object.fromEntries([...this.width].map(([k, v]) => [k, r4(v * 1e3)])),
      vias: this.vias, via_barrel_mm: this.viaLenKnown ? r4(this.viaLen_m * 1e3) : null,
      delay_ps: d !== null ? r2(d * 1e12) : null, z0_ohm: z !== null ? Math.round(z * 10) / 10 : null,
      model: z !== null ? 'analytic' : 'unavailable (no stackup)',
    }
  }
}

export interface BranchSummary {
  from: string
  to: string
  length_mm: number
  trace_mm: number
  by_layer_mm: Record<string, number>
  width_mm: Record<string, number>
  vias: number
  via_barrel_mm: number | null
  delay_ps: number | null
  z0_ohm: number | null
  model: string
}

function onSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number, tol: number): boolean {
  const dx = x2 - x1
  const dy = y2 - y1
  const L2 = dx * dx + dy * dy
  if (L2 === 0) return false
  const t = ((px - x1) * dx + (py - y1) * dy) / L2
  if (t <= 1e-6 || t >= 1 - 1e-6) return false
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)) <= Math.max(tol * 0.5, 1e-3)
}

function span(a: string, b: string, order: Map<string, number>): string[] {
  const ia = order.get(a)
  const ib = order.get(b)
  if (ia === undefined || ib === undefined) return [a, b].filter((n) => order.has(n))
  const lo = Math.min(ia, ib)
  const hi = Math.max(ia, ib)
  return [...order].filter(([, i]) => i >= lo && i <= hi).sort((x, y) => x[1] - y[1]).map(([n]) => n)
}

/** A binary heap of [distance, node] for Dijkstra. */
class Heap {
  private readonly d: [number, NodeKey][] = []
  get size(): number {
    return this.d.length
  }
  push(item: [number, NodeKey]): void {
    const d = this.d
    d.push(item)
    let i = d.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if ((d[p] as [number, NodeKey])[0] <= item[0]) break
      d[i] = d[p] as [number, NodeKey]
      i = p
    }
    d[i] = item
  }
  pop(): [number, NodeKey] | undefined {
    const d = this.d
    const top = d[0]
    const last = d.pop()
    if (!d.length || !last) return top
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      let mv = last[0]
      if (l < d.length && (d[l] as [number, NodeKey])[0] < mv) {
        m = l
        mv = (d[l] as [number, NodeKey])[0]
      }
      if (r < d.length && (d[r] as [number, NodeKey])[0] < mv) m = r
      if (m === i) break
      d[i] = d[m] as [number, NodeKey]
      i = m
    }
    d[i] = last
    return top
  }
}

/** One net's copper as a graph: nodes are track ends, via barrels and pads; edges are tracks and barrels. */
export class Net {
  readonly segs: Segment[]
  readonly vias: Via[]
  readonly pads: Pad[]
  readonly padNodes = new Map<string, NodeKey>()
  private readonly adj = new Map<NodeKey, Edge[]>()

  constructor(readonly board: Board, readonly name: string) {
    if (!board.segments[name] && !board.pads[name] && !board.vias[name]) {
      const close = netNames(board).filter((n) => n.toLowerCase().includes(name.toLowerCase())).slice(0, 10)
      throw new PcbError(`${JSON.stringify(name)} is not a net on the board${close.length ? ` (similar: ${close.join(', ')})` : ''}`)
    }
    this.segs = board.segments[name] ?? []
    this.vias = board.vias[name] ?? []
    this.pads = board.pads[name] ?? []
    const order = new Map(board.layers.map((l) => [l.name, l.index] as const))
    const edge = (u: NodeKey, v: NodeKey, len: number | null, layer: string, width: number, kind: EdgeKind): void => {
      ;(this.adj.get(u) ?? this.adj.set(u, []).get(u) as Edge[]).push({ to: v, len, layer, width, kind })
      ;(this.adj.get(v) ?? this.adj.set(v, []).get(v) as Edge[]).push({ to: u, len, layer, width, kind })
    }
    const ends = new Map<string, [number, number][]>()
    const hw = new Map<string, number>()
    for (const [x1, y1, x2, y2, w, ly] of this.segs) {
      const list = ends.get(ly) ?? ends.set(ly, []).get(ly) as [number, number][]
      list.push([x1, y1], [x2, y2])
      for (const k of [key(x1, y1, ly), key(x2, y2, ly)]) hw.set(k, Math.max(hw.get(k) ?? 0, w / 2))
    }
    // A straight track is split wherever another track ends on its middle (a T-junction), so the graph has one
    // edge per piece and never a parallel full-length edge that would hide the junction. Arcs join only at their ends.
    for (const [x1, y1, x2, y2, w, ly, L] of this.segs) {
      const straight = Math.abs(L - Math.hypot(x2 - x1, y2 - y1)) <= 1e-6
      const stops: [number, number, number][] = [[0, x1, y1], [1, x2, y2]]
      if (straight) {
        const L2 = (x2 - x1) ** 2 + (y2 - y1) ** 2
        for (const [px, py] of ends.get(ly) ?? []) {
          if ((px === x1 && py === y1) || (px === x2 && py === y2)) continue
          if (onSegment(px, py, x1, y1, x2, y2, w / 2)) stops.push([((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / L2, px, py])
        }
      }
      if (stops.length === 2) {
        edge(key(x1, y1, ly), key(x2, y2, ly), L * 1e-3, ly, w * 1e-3, 'seg')
        continue
      }
      stops.sort((a, b) => a[0] - b[0])
      for (let k = 0; k + 1 < stops.length; k++) {
        const [, ax, ay] = stops[k] as [number, number, number]
        const [, bx, by] = stops[k + 1] as [number, number, number]
        const ka = key(ax, ay, ly)
        const kb = key(bx, by, ly)
        if (ka !== kb) edge(ka, kb, Math.hypot(bx - ax, by - ay) * 1e-3, ly, w * 1e-3, 'seg')
      }
    }
    for (const [x, y, s, d, top, bot] of this.vias) {
      const sp = span(top, bot, order)
      for (let k = 0; k + 1 < sp.length; k++) {
        const la = sp[k] as string
        const lb = sp[k + 1] as string
        edge(key(x, y, la), key(x, y, lb), viaLength(board, la, lb), 'via', (d ?? 0) * 1e-3, 'via')
      }
      for (const ly of sp) {
        // a track ending inside the via's land rather than exactly at its centre
        for (const [px, py] of ends.get(ly) ?? []) {
          const r = Math.hypot(px - x, py - y)
          if (r > 0 && r <= s / 2 + (hw.get(key(px, py, ly)) ?? 0) + 1e-6) edge(key(px, py, ly), key(x, y, ly), 0, ly, s * 1e-3, 'land')
        }
      }
    }
    for (const p of this.pads) {
      const pk = `pad:${padId(p)}`
      this.padNodes.set(padId(p), pk)
      if (!this.adj.has(pk)) this.adj.set(pk, [])
      for (const ly of p.layers) {
        const pts: [number, number][] = [...(ends.get(ly) ?? []),
          ...this.vias.filter((v) => span(v[4], v[5], order).includes(ly)).map((v): [number, number] => [v[0], v[1]])]
        for (const [px, py] of pts) {
          const tol = (hw.get(key(px, py, ly)) ?? 0) + 0.01
          if (Math.abs(px - p.x) <= p.w / 2 + tol && Math.abs(py - p.y) <= p.h / 2 + tol) edge(pk, key(px, py, ly), 0, ly, Math.max(p.w, p.h) * 1e-3, 'pad')
        }
      }
    }
  }

  /** Total routed trace length (m), every segment and arc once. */
  get length_m(): number {
    return this.segs.reduce((s, g) => s + g[6], 0) * 1e-3
  }

  byLayer(): Map<string, number> {
    const out = new Map<string, number>()
    for (const g of this.segs) out.set(g[5], (out.get(g[5]) ?? 0) + g[6] * 1e-3)
    return out
  }

  /** Routed copper's capacitance to its planes (F), each segment at its own layer and width; vias excluded. */
  capacitance(): number | null {
    let c = 0
    for (const g of this.segs) {
      const L = this.board.layers.find((l) => l.name === g[5])
      const per = L ? capPerM(L, g[4] * 1e-3) : null
      if (per === null) return null
      c += g[6] * 1e-3 * per
    }
    return c
  }

  private reach(start: NodeKey): Set<NodeKey> {
    const seen = new Set([start])
    const stack = [start]
    while (stack.length) {
      const u = stack.pop() as NodeKey
      for (const e of this.adj.get(u) ?? []) {
        if (!seen.has(e.to)) {
          seen.add(e.to)
          stack.push(e.to)
        }
      }
    }
    return seen
  }

  /** Pads not reached by tracks/vias from the first pad. A pad fed by a copper pour shows here: zones are not filled. */
  unreached(): string[] {
    const first = this.pads[0]
    if (!first) return []
    const seen = this.reach(this.padNodes.get(padId(first)) as NodeKey)
    return this.pads.map(padId).filter((id) => !seen.has(this.padNodes.get(id) as NodeKey))
  }

  pad(id: string): Pad {
    const p = this.pads.find((q) => padId(q) === id)
    if (!p) throw new PcbError(`${id} has no pad on ${this.name} (pads: ${this.pads.slice(0, 40).map(padId).join(', ')})`)
    return p
  }

  private dijkstra(src: NodeKey): { dist: Map<NodeKey, number>; prev: Map<NodeKey, [NodeKey, Edge]> } {
    const dist = new Map<NodeKey, number>([[src, 0]])
    const prev = new Map<NodeKey, [NodeKey, Edge]>()
    const pq = new Heap()
    pq.push([0, src])
    while (pq.size) {
      const [d, u] = pq.pop() as [number, NodeKey]
      if (d > (dist.get(u) ?? Infinity)) continue
      for (const e of this.adj.get(u) ?? []) {
        const nd = d + (e.len ?? 0)
        if (nd < (dist.get(e.to) ?? Infinity) - 1e-15) {
          dist.set(e.to, nd)
          prev.set(e.to, [u, e])
          pq.push([nd, e.to])
        }
      }
    }
    return { dist, prev }
  }

  /** The shortest routed path between two pads ("R4.2", "U1.7"). */
  path(a: string, b: string): Branch {
    const src = this.padNodes.get(padId(this.pad(a))) as NodeKey
    const dst = this.padNodes.get(padId(this.pad(b))) as NodeKey
    const { dist, prev } = this.dijkstra(src)
    if (!dist.has(dst)) throw new PcbError(`${a} and ${b} are not connected by tracks on ${this.name} (copper pours are not followed)`)
    const br = new Branch(a, b)
    for (let u = dst; u !== src;) {
      const [p, e] = prev.get(u) as [NodeKey, Edge]
      br.add(p, e)
      u = p
    }
    return br
  }

  /** The shortest-path tree from one pad to every pad, cut into branches at pads and forks. */
  tree(root: string): Branch[] {
    const src = this.padNodes.get(padId(this.pad(root))) as NodeKey
    const { dist, prev } = this.dijkstra(src)
    const used = new Map<NodeKey, [NodeKey, Edge]>()
    const kids = new Map<NodeKey, Set<NodeKey>>()
    for (const p of this.pads) {
      let u = this.padNodes.get(padId(p)) as NodeKey
      if (!dist.has(u)) throw new PcbError(`${padId(p)} is not connected to ${root} by tracks on ${this.name}`)
      while (u !== src && !used.has(u)) {
        const st = prev.get(u) as [NodeKey, Edge]
        used.set(u, st)
        ;(kids.get(st[0]) ?? kids.set(st[0], new Set()).get(st[0]) as Set<NodeKey>).add(u)
        u = st[0]
      }
    }
    const padOf = new Map([...this.padNodes].map(([id, k]) => [k, id] as const))
    const names = new Map<NodeKey, string>()
    const stop = (u: NodeKey): boolean => u === src || padOf.has(u) || (kids.get(u)?.size ?? 0) !== 1
    const name = (u: NodeKey): string => padOf.get(u) ?? names.get(u) ?? (names.set(u, `j${names.size + 1}`).get(u) as string)
    const out: Branch[] = []
    const stack = [src]
    while (stack.length) {
      const start = stack.pop() as NodeKey
      for (const c of [...(kids.get(start) ?? [])].sort()) {
        const br = new Branch(name(start), '')
        let u = c
        for (;;) {
          const [p, e] = used.get(u) as [NodeKey, Edge]
          br.add(p, e)
          if (stop(u)) break
          u = [...(kids.get(u) as Set<NodeKey>)][0] as NodeKey
        }
        br.b = name(u)
        out.push(br)
        stack.push(u)
      }
    }
    return out
  }
}

// ------------------------------------------------------------------ design rules

export interface DesignRules {
  setup: Record<string, SetupValue>
  rules?: Record<string, unknown>
  track_widths?: unknown[]
  via_dimensions?: unknown[]
  diff_pair_dimensions?: unknown[]
  net_classes?: Record<string, unknown>[]
  custom_rules?: string[]
  project_error?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The board's design rules: the board setup block, the project file's rules and net classes (KiCad's own
 * .kicad_pro), and the names of custom rules in a .kicad_dru beside it. Values are mm, as KiCad stores them. */
export function designRules(board: Board, proPath: string | null): DesignRules {
  const out: DesignRules = { setup: board.setup }
  if (!proPath || !existsSync(proPath)) return out
  let pro: unknown
  try {
    pro = JSON.parse(readFileSync(proPath, 'utf8'))
  } catch (e) {
    out.project_error = `unreadable .kicad_pro: ${e instanceof Error ? e.message : String(e)}`
    return out
  }
  const ds = isRecord(pro) && isRecord(pro.board) && isRecord(pro.board.design_settings) ? pro.board.design_settings : {}
  if (isRecord(ds.rules) && Object.keys(ds.rules).length) out.rules = ds.rules
  for (const k of ['track_widths', 'via_dimensions', 'diff_pair_dimensions'] as const) {
    const v = ds[k]
    if (Array.isArray(v) && v.length) out[k] = v
  }
  const classes = isRecord(pro) && isRecord(pro.net_settings) && Array.isArray(pro.net_settings.classes) ? pro.net_settings.classes : []
  const keep = ['name', 'clearance', 'track_width', 'via_diameter', 'via_drill', 'diff_pair_width', 'diff_pair_gap', 'microvia_diameter', 'microvia_drill']
  const nc = classes.filter(isRecord).map((c) => Object.fromEntries(keep.filter((k) => k in c).map((k) => [k, c[k]])))
  if (nc.length) out.net_classes = nc
  const dru = proPath.replace(/\.kicad_pro$/, '.kicad_dru')
  if (existsSync(dru)) out.custom_rules = [...readFileSync(dru, 'utf8').matchAll(/\(rule\s+"?([^"\n)]+)"?/g)].map((m) => (m[1] as string).trim())
  return out
}
