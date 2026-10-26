/**
 * OrthoRoute's solution file (.ORS: gzip-compressed JSON, format 1.0) read back into a KiCad board, without KiCad.
 *
 * The geometry is in the board's own coordinates (mm, KiCad's Y-down frame, as the .ORP gave them). Each net's tracks
 * and vias are vetted before anything is written:
 *
 *   - vias at one point of one net are merged into one span; when blind/buried vias are not allowed (fewer than four
 *     copper layers, or the setting is off) every via becomes a through via
 *   - the net's copper must keep the board's clearance to every other net's copper: the board's pads, tracks and vias,
 *     and the OrthoRoute copper already accepted (a through via made from a blind one is checked on every layer)
 *   - the net must be complete: every pad reached (tracks, vias and the net's existing copper; pours are not counted)
 *
 * A net that fails either check is left out entirely and falls through to the next stage (Freerouting). What is
 * written is locked, so the next router treats it as fixed: `(locked yes)` in KiCad 8–10 boards (checked against
 * KiCad 10.0.7's own output), the bare `locked` flag in older ones.
 */
import { gunzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ToolError } from '../../core/registry.js'
import { Net, type Board, type Segment, type Via } from '../kicad/pcb.js'
import { boardShapes, ShapeIndex, viaSpan, type Shape } from './geometry.js'

const XY = z.object({ x: z.number(), y: z.number() })
const Layer = z.union([z.string(), z.number().int()])
const Track = z.object({ layer: Layer, start: XY, end: XY, width: z.number().positive(), net_id: z.union([z.string(), z.number()]).optional() }).loose()
const ViaRow = z.object({ position: XY, from_layer: Layer, to_layer: Layer, diameter: z.number().positive(), drill: z.number().positive(), net_id: z.union([z.string(), z.number()]).optional() }).loose()
const OrsSchema = z.object({
  format_version: z.literal('1.0'),
  geometry: z.object({
    by_net: z.record(z.string(), z.object({ tracks: z.array(Track).default([]), vias: z.array(ViaRow).default([]) }).loose()).default({}),
  }).loose(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  statistics: z.record(z.string(), z.unknown()).default({}),
  iteration_metrics: z.array(z.unknown()).default([]),
}).loose()

export interface OrsTrack { layer: string; x1: number; y1: number; x2: number; y2: number; width: number }
export interface OrsVia { x: number; y: number; from: string; to: string; diameter: number; drill: number }
export interface OrsSolution {
  nets: Record<string, { tracks: OrsTrack[]; vias: OrsVia[] }>
  metadata: Record<string, unknown>
  statistics: Record<string, unknown>
  iterations: number
}

/** Parse a .ORS (gzip or plain JSON). Numeric layers are indices into `layers` (the copper stack, top first). */
export function readOrs(data: Uint8Array, layers: readonly string[]): OrsSolution {
  let raw: unknown
  try {
    const bytes = data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data) : Buffer.from(data)
    raw = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new ToolError('the OrthoRoute solution is not gzip-compressed JSON')
  }
  const r = OrsSchema.safeParse(raw)
  if (!r.success) throw new ToolError(`the OrthoRoute solution is not a format 1.0 .ORS: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  const name = (l: string | number): string => {
    if (typeof l === 'string') return l
    const n = layers[l]
    if (n === undefined) throw new ToolError(`the OrthoRoute solution names copper layer ${l}; the board has ${layers.length}`)
    return n
  }
  const nets: OrsSolution['nets'] = {}
  for (const [net, g] of Object.entries(r.data.geometry.by_net)) {
    nets[net] = {
      tracks: g.tracks.map((t) => ({ layer: name(t.layer), x1: t.start.x, y1: t.start.y, x2: t.end.x, y2: t.end.y, width: t.width })),
      vias: g.vias.map((v) => ({ x: v.position.x, y: v.position.y, from: name(v.from_layer), to: name(v.to_layer), diameter: v.diameter, drill: v.drill })),
    }
  }
  return { nets, metadata: r.data.metadata, statistics: r.data.statistics, iterations: r.data.iteration_metrics.length }
}

export interface ApplyOptions {
  /** the nets OrthoRoute was asked to route: anything else in the solution is ignored */
  nets: readonly string[]
  blindBuried: boolean
  /** mm, the board's default clearance */
  clearance: number
}

export interface ApplyResult {
  /** the new board text, with the accepted copper appended and locked */
  text: string
  routed: string[]
  failed: { net: string; reason: string }[]
  tracks: number
  vias: number
  /** blind/buried vias written as through vias */
  through_from_blind: number
}

const round = (v: number): number => Math.round(v * 1e6) / 1e6
const atom = (v: number): string => String(round(v))
const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** Merge one net's vias that share a point into one via spanning their layers. */
export function mergeVias(vias: readonly OrsVia[], order: readonly string[]): OrsVia[] {
  const at = new Map<string, OrsVia>()
  for (const v of vias) {
    const k = `${round(v.x)},${round(v.y)}`
    const cur = at.get(k)
    if (!cur) { at.set(k, { ...v }); continue }
    const idx = [cur.from, cur.to, v.from, v.to].map((l) => order.indexOf(l)).filter((i) => i >= 0)
    cur.from = order[Math.min(...idx)] as string
    cur.to = order[Math.max(...idx)] as string
    cur.diameter = Math.max(cur.diameter, v.diameter)
    cur.drill = Math.max(cur.drill, v.drill)
  }
  return [...at.values()]
}

/** How this board's file names a net in a track: by number (KiCad 6–9's net table) or by name (KiCad 10). */
export function netRef(text: string): (net: string) => string {
  const codes = new Map<string, string>()
  const cut = text.search(/\n\s*\((footprint|module|segment|via|zone|gr_)\b/) // the net table comes before these
  const head = cut > 0 ? text.slice(0, cut) : text
  for (const m of head.matchAll(/^\s*\(net\s+(\d+)\s+"((?:[^"\\]|\\.)*)"\s*\)/gm)) codes.set((m[2] as string).replace(/\\(.)/g, '$1'), m[1] as string)
  if (!codes.size) return (n) => `(net ${q(n)})`
  return (n) => {
    const c = codes.get(n)
    if (c === undefined) throw new ToolError(`net ${n} is not in the board's net table`)
    return `(net ${c})`
  }
}

/** The board's file format version (YYYYMMDD). */
export const formatVersion = (text: string): number => Number(/\(version\s+(\d+)\)/.exec(text.slice(0, 400))?.[1] ?? 0)

export function trackText(t: OrsTrack, net: string, ref: (n: string) => string, version: number): string {
  const lock = version >= 20240000 ? '\t\t(locked yes)\n' : ''
  return `\t(segment${version >= 20240000 ? '' : ' locked'}\n\t\t(start ${atom(t.x1)} ${atom(t.y1)})\n\t\t(end ${atom(t.x2)} ${atom(t.y2)})\n`
    + `\t\t(width ${atom(t.width)})\n${lock}\t\t(layer ${q(t.layer)})\n\t\t${ref(net)}\n\t\t(uuid ${q(randomUUID())})\n\t)\n`
}

export function viaText(v: OrsVia, net: string, ref: (n: string) => string, version: number, order: readonly string[]): string {
  const [a, b] = [order.indexOf(v.from), order.indexOf(v.to)].sort((x, y) => x - y) as [number, number]
  const last = order.length - 1
  const kind = a === 0 && b === last ? '' : a === 0 || b === last ? ' blind' : version >= 20250000 ? ' buried' : ' blind'
  const lock = version >= 20240000 ? '\t\t(locked yes)\n' : ''
  return `\t(via${kind}${version >= 20240000 ? '' : ' locked'}\n\t\t(at ${atom(v.x)} ${atom(v.y)})\n\t\t(size ${atom(v.diameter)})\n`
    + `\t\t(drill ${atom(v.drill)})\n\t\t(layers ${q(order[a] as string)} ${q(order[b] as string)})\n${lock}\t\t${ref(net)}\n\t\t(uuid ${q(randomUUID())})\n\t)\n`
}

/** Vet the solution net by net and write what passes into `text` (the file `board` was read from), locked. */
export function applyOrs(text: string, board: Board, sol: OrsSolution, opts: ApplyOptions): ApplyResult {
  const order = board.layers.map((l) => l.name)
  const blindOk = opts.blindBuried && order.length >= 4
  const index = new ShapeIndex()
  for (const s of boardShapes(board)) index.add(s)
  const ref = netRef(text)
  const version = formatVersion(text)
  const routed: string[] = []
  const failed: ApplyResult['failed'] = []
  let out = ''
  let tracks = 0
  let vias = 0
  let converted = 0
  for (const net of opts.nets) {
    const g = sol.nets[net]
    if (!g || (!g.tracks.length && !g.vias.length)) { failed.push({ net, reason: 'not routed by OrthoRoute' }); continue }
    const bad = [...g.tracks.map((t) => t.layer), ...g.vias.flatMap((v) => [v.from, v.to])].find((l) => !order.includes(l))
    if (bad) { failed.push({ net, reason: `uses ${bad}, which is not a copper layer of this board` }); continue }
    let vs = mergeVias(g.vias, order)
    let conv = 0
    if (!blindOk) {
      vs = vs.map((v) => {
        if (v.from === order[0] && v.to === order[order.length - 1]) return v
        conv++
        return { ...v, from: order[0] as string, to: order[order.length - 1] as string }
      })
    }
    const shapes: Shape[] = [
      ...g.tracks.map((t): Shape => ({ kind: 'cap', net, layers: [t.layer], x1: t.x1, y1: t.y1, x2: t.x2, y2: t.y2, r: t.width / 2 })),
      ...vs.map((v): Shape => ({ kind: 'cap', net, layers: viaSpan(order, v.from, v.to), x1: v.x, y1: v.y, x2: v.x, y2: v.y, r: v.diameter / 2 })),
    ]
    const hit = shapes.map((s) => [s, index.conflict(s, opts.clearance)] as const).find(([, o]) => o !== null)
    if (hit) {
      const [s, o] = hit as [Shape, Shape]
      failed.push({ net, reason: `too close to ${o.tag ?? 'copper'} of ${o.net} on ${s.layers.filter((l) => o.layers.includes(l)).join('/')}` })
      continue
    }
    const segs: Segment[] = g.tracks.map((t) => [t.x1, t.y1, t.x2, t.y2, t.width, t.layer, Math.hypot(t.x2 - t.x1, t.y2 - t.y1)])
    const vrows: Via[] = vs.map((v) => [v.x, v.y, v.diameter, v.drill, v.from, v.to])
    const trial: Board = { ...board, segments: { ...board.segments, [net]: [...(board.segments[net] ?? []), ...segs] }, vias: { ...board.vias, [net]: [...(board.vias[net] ?? []), ...vrows] } }
    const missing = (board.pads[net]?.length ?? 0) >= 2 ? new Net(trial, net).unreached() : []
    if (missing.length) { failed.push({ net, reason: `incomplete: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''} not reached` }); continue }
    for (const s of shapes) index.add(s)
    for (const t of g.tracks) out += trackText(t, net, ref, version)
    for (const v of vs) out += viaText(v, net, ref, version, order)
    tracks += g.tracks.length
    vias += vs.length
    converted += conv
    routed.push(net)
  }
  const end = text.lastIndexOf(')')
  if (end < 0) throw new ToolError('the board file has no closing parenthesis')
  return { text: out ? `${text.slice(0, end).replace(/\s*$/, '\n')}${out})\n` : text, routed, failed, tracks, vias, through_from_blind: converted }
}
