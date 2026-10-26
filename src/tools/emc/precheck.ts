/**
 * Rule-based EMI precheck of a KiCad board: no field solver, only the board's geometry (tracks, vias, pads, zone
 * fills, outline, stackup) and a few closed forms. Each finding gives its rule, a severity, the net and layer, a
 * location (board mm, KiCad's frame) and the evidence it was decided on. The rules are design guidelines, not
 * requirements of any standard, and every threshold is an input with a stated default.
 *
 *   return_path      a signal track whose nearest adjacent copper layer carries a reference plane (a ground or
 *                    power zone) is sampled every sample_mm along its length: a stretch of at least min_gap_mm with
 *                    no plane under it is a gap in the return path; passing from one plane net to another is a
 *                    split crossing. Points within antipad_mm of the net's own through-hole pads and vias are
 *                    skipped (the plane's clearance holes there are expected). A track with no plane on either
 *                    adjacent layer is reported once per net and layer (info).
 *   switching_loop   for switching nodes (names like SW, LX, PHASE, HG/LG, GATE, BST; or switch_nets): the node's
 *                    copper area (track length x width plus pads), the dV/dt antenna; and the area of the convex hull
 *                    of the node's pads together with the ground pads of every part on the node, a proxy (an upper
 *                    bound for a compact layout) for the hot-loop area.
 *   edge_proximity   fast nets (clock-like names, or fast_nets) with track closer than edge_mm to the outline.
 *   stitching        a signal via whose two ends are referenced to different planes: to another layer of the same
 *                    net it needs a via of that net within stitch_mm; to a different net it needs a capacitor
 *                    between the two nets nearby (reported with the nearest one found).
 *   decoupling       for each IC (reference prefix U or IC) power pin: the nearest capacitor with one pad on that
 *                    power net and the other on ground; none, or farther than decap_mm, is a finding.
 *   edge_spectrum    for each net given in `edges` (frequency, 10-90 % rise time, amplitude): the trapezoid
 *                    harmonic amplitudes (spectrum.ts), the current V_n / Z0 (Z0 of the net's main layer and width,
 *                    Hammerstad-Jensen / IPC-2141A from src/kicad/pcb.ts), the loop area (track length x height to
 *                    its plane), and the differential-mode field at distance_m (Ott, with ground reflection) against
 *                    CISPR 32 class A/B. A PRE-COMPLIANCE ESTIMATE: it ignores common-mode (cable) radiation, which
 *                    usually dominates real failures, and the matched-line current assumption can be off either way.
 */
import { segSeg } from '../../pcb/geometry.js'
import { z0 as layerZ0, type Board, type Layer } from '../../kicad/pcb.js'
import { CLOCKISH, convexHull, isGround, isPower, polyArea, SWITCHING, type BoardGeometry, type Poly, type Pt, type ZoneFill } from './board.js'
import { cisprLimit, CISPR_SOURCE, type CisprClass } from './limits.js'
import { dBuV, dmField, harmonics, peakToRms } from './spectrum.js'

export type Severity = 'error' | 'warn' | 'info'
export type Rule = 'return_path' | 'switching_loop' | 'edge_proximity' | 'stitching' | 'decoupling' | 'edge_spectrum'
export const RULES: readonly Rule[] = ['return_path', 'switching_loop', 'edge_proximity', 'stitching', 'decoupling', 'edge_spectrum']

export interface Finding {
  rule: Rule
  severity: Severity
  net: string | null
  layer: string | null
  at: { x_mm: number; y_mm: number } | null
  message: string
  evidence: Record<string, unknown>
}

export interface EdgeSpec { net: string; freq_hz: number; rise_s: number; amplitude_v: number; duty?: number | undefined }

export interface PrecheckOptions {
  rules: readonly Rule[]
  fastNets: readonly string[]
  fastPattern: RegExp
  switchNets: readonly string[]
  switchPattern: RegExp
  referenceNets: readonly string[]
  edgeMm: number
  stitchMm: number
  decapMm: number
  minGapMm: number
  antipadMm: number
  sampleMm: number
  swCopperMm2: number
  swLoopMm2: number
  edges: readonly EdgeSpec[]
  cisprClass: CisprClass
  distanceM: number
  warnMarginDb: number
  icPrefixes: readonly string[]
}

export const DEFAULTS: PrecheckOptions = {
  rules: RULES, fastNets: [], fastPattern: CLOCKISH, switchNets: [], switchPattern: SWITCHING, referenceNets: [],
  edgeMm: 3, stitchMm: 2, decapMm: 3, minGapMm: 0.5, antipadMm: 0.6, sampleMm: 0.2, swCopperMm2: 25, swLoopMm2: 50,
  edges: [], cisprClass: 'B', distanceM: 3, warnMarginDb: 6, icPrefixes: ['U', 'IC'],
}

const rd = (v: number, d = 3): number => Number(v.toFixed(d))
const at = (x: number, y: number): { x_mm: number; y_mm: number } => ({ x_mm: rd(x), y_mm: rd(y) })

/** Polygons with a y-bucketed edge index, for fast point-in-polygon on large plane fills. */
class PlaneIndex {
  private readonly items: { net: string; zone: ZoneFill; poly: Poly; bb: [number, number, number, number]; buckets: Map<number, [number, number, number, number][]> }[] = []
  private static readonly H = 1

  add(net: string, zone: ZoneFill, poly: Poly): void {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    const buckets = new Map<number, [number, number, number, number][]>()
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i] as Pt
      const [xj, yj] = poly[j] as Pt
      x0 = Math.min(x0, xi)
      x1 = Math.max(x1, xi)
      y0 = Math.min(y0, yi)
      y1 = Math.max(y1, yi)
      for (let b = Math.floor(Math.min(yi, yj) / PlaneIndex.H); b <= Math.floor(Math.max(yi, yj) / PlaneIndex.H); b++) {
        const list = buckets.get(b) ?? []
        list.push([xi, yi, xj, yj])
        buckets.set(b, list)
      }
    }
    this.items.push({ net, zone, poly, bb: [x0, y0, x1, y1], buckets })
  }

  /** The plane net covering (x, y), or null. */
  netAt(x: number, y: number): string | null {
    for (const it of this.items) {
      if (x < it.bb[0] || x > it.bb[2] || y < it.bb[1] || y > it.bb[3]) continue
      const edges = it.buckets.get(Math.floor(y / PlaneIndex.H))
      if (!edges) continue
      let inside = false
      for (const [xi, yi, xj, yj] of edges) if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
      if (inside) return it.net
    }
    return null
  }

  get size(): number {
    return this.items.length
  }

  get filled(): boolean {
    return this.items.every((i) => i.zone.filled)
  }
}

function referenceNet(n: string, o: PrecheckOptions): boolean {
  return o.referenceNets.includes(n) || isGround(n) || isPower(n)
}

/** The planes on each copper layer. */
function planes(g: BoardGeometry, o: PrecheckOptions): Map<string, PlaneIndex> {
  const out = new Map<string, PlaneIndex>()
  for (const z of g.zones) {
    if (z.keepout || !z.net || !referenceNet(z.net, o)) continue
    const idx = out.get(z.layer) ?? new PlaneIndex()
    for (const p of z.polygons) idx.add(z.net, z, p)
    out.set(z.layer, idx)
  }
  return out
}

/** The nearest adjacent copper layer with planes, and the dielectric height to it (mm). */
function refLayer(b: Board, layer: string, pl: Map<string, PlaneIndex>): { layer: Layer; h_mm: number } | null {
  const L = b.layers.find((l) => l.name === layer)
  if (!L) return null
  const cands: { layer: Layer; h_mm: number }[] = []
  const up = b.layers[L.index - 1]
  const down = b.layers[L.index + 1]
  if (up && pl.get(up.name)?.size) cands.push({ layer: up, h_mm: (L.above?.[0] ?? 1e-3) * 1e3 })
  if (down && pl.get(down.name)?.size) cands.push({ layer: down, h_mm: (L.below?.[0] ?? 1e-3) * 1e3 })
  cands.sort((a, c) => a.h_mm - c.h_mm)
  return cands[0] ?? null
}

const isFast = (n: string, o: PrecheckOptions): boolean => o.fastNets.includes(n) || (!o.fastNets.length && o.fastPattern.test(n) && !isGround(n) && !isPower(n))
const isSwitch = (n: string, o: PrecheckOptions): boolean => o.switchNets.includes(n) || (!o.switchNets.length && o.switchPattern.test(n) && !isGround(n))

// ------------------------------------------------------------------------------------------- the rules

function returnPath(g: BoardGeometry, o: PrecheckOptions, pl: Map<string, PlaneIndex>, out: Finding[]): void {
  const b = g.board
  const noRef = new Map<string, number>()
  for (const [net, segs] of Object.entries(b.segments)) {
    if (referenceNet(net, o)) continue
    const holes: [number, number, number][] = []
    for (const p of b.pads[net] ?? []) if (p.kind === 'thru_hole' || p.kind === 'np_thru_hole') holes.push([p.x, p.y, Math.max(p.w, p.h) / 2 + o.antipadMm])
    for (const v of b.vias[net] ?? []) holes.push([v[0], v[1], v[2] / 2 + o.antipadMm])
    const seen = new Set<string>()
    for (const [x1, y1, x2, y2, , layer, len] of segs) {
      const ref = refLayer(b, layer, pl)
      if (!ref) {
        noRef.set(`${net}|${layer}`, (noRef.get(`${net}|${layer}`) ?? 0) + len)
        continue
      }
      const idx = pl.get(ref.layer.name) as PlaneIndex
      const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / o.sampleMm))
      let gapStart: number | null = null
      let lastNet: string | null = null
      const flush = (k: number): void => {
        if (gapStart === null) return
        const lenMm = ((k - gapStart) / n) * Math.hypot(x2 - x1, y2 - y1)
        if (lenMm >= o.minGapMm) {
          const m = (gapStart + k - 1) / 2 / n
          const x = x1 + (x2 - x1) * m
          const y = y1 + (y2 - y1) * m
          const key = `gap|${Math.round(x)}|${Math.round(y)}`
          if (!seen.has(key)) {
            seen.add(key)
            out.push({
              rule: 'return_path', severity: isFast(net, o) ? 'error' : 'warn', net, layer, at: at(x, y),
              message: `${net} on ${layer} runs ${rd(lenMm, 2)} mm over a gap in the ${ref.layer.name} plane: its return current must detour`,
              evidence: { reference_layer: ref.layer.name, gap_mm: rd(lenMm, 2), segment: [rd(x1), rd(y1), rd(x2), rd(y2)], plane_filled: idx.filled, height_mm: rd(ref.h_mm) },
            })
          }
        }
        gapStart = null
      }
      for (let k = 0; k <= n; k++) {
        const x = x1 + ((x2 - x1) * k) / n
        const y = y1 + ((y2 - y1) * k) / n
        if (holes.some(([hx, hy, r]) => Math.hypot(x - hx, y - hy) <= r)) {
          flush(k)
          continue
        }
        const pn = idx.netAt(x, y)
        if (pn === null) {
          if (gapStart === null) gapStart = k
          continue
        }
        flush(k)
        if (lastNet !== null && pn !== lastNet) {
          const key = `split|${Math.round(x)}|${Math.round(y)}`
          if (!seen.has(key)) {
            seen.add(key)
            out.push({
              rule: 'return_path', severity: 'error', net, layer, at: at(x, y),
              message: `${net} on ${layer} crosses from the ${lastNet} plane to the ${pn} plane on ${ref.layer.name}: a split crossing`,
              evidence: { reference_layer: ref.layer.name, from: lastNet, to: pn, segment: [rd(x1), rd(y1), rd(x2), rd(y2)] },
            })
          }
        }
        lastNet = pn
      }
      flush(n + 1)
    }
  }
  for (const [key, len] of noRef) {
    const [net, layer] = key.split('|') as [string, string]
    out.push({
      rule: 'return_path', severity: isFast(net, o) ? 'warn' : 'info', net, layer, at: null,
      message: `${net} has ${rd(len, 1)} mm of track on ${layer} with no plane on an adjacent layer (its return is coplanar or on a far layer)`,
      evidence: { length_mm: rd(len, 2) },
    })
  }
}

function switchingLoop(g: BoardGeometry, o: PrecheckOptions, out: Finding[]): void {
  const b = g.board
  for (const net of Object.keys(b.pads)) {
    if (!isSwitch(net, o)) continue
    const pads = b.pads[net] ?? []
    let copper = 0
    for (const s of b.segments[net] ?? []) copper += s[6] * s[4]
    for (const p of pads) copper += p.w * p.h
    for (const z of g.zones) if (z.net === net) for (const poly of z.polygons) copper += polyArea(poly)
    const refs = [...new Set(pads.map((p) => p.ref))]
    const hullPts: Pt[] = pads.map((p) => [p.x, p.y])
    const gnd: string[] = []
    for (const [n2, ps] of Object.entries(b.pads)) {
      if (!isGround(n2)) continue
      for (const p of ps) if (refs.includes(p.ref)) {
        hullPts.push([p.x, p.y])
        gnd.push(`${p.ref}.${p.num}`)
      }
    }
    const hull = convexHull(hullPts)
    const loop = hull.length >= 3 ? polyArea(hull) : 0
    const cx = pads.reduce((s, p) => s + p.x, 0) / Math.max(1, pads.length)
    const cy = pads.reduce((s, p) => s + p.y, 0) / Math.max(1, pads.length)
    const big = copper > o.swCopperMm2 || loop > o.swLoopMm2
    out.push({
      rule: 'switching_loop', severity: big ? 'warn' : 'info', net, layer: null, at: at(cx, cy),
      message: `switching node ${net}: ${rd(copper, 1)} mm² of copper, hot-loop hull ${rd(loop, 1)} mm²${big ? ' (above the guideline)' : ''}`,
      evidence: { copper_mm2: rd(copper, 2), loop_hull_mm2: rd(loop, 2), parts: refs, ground_pads: gnd, limits: { copper_mm2: o.swCopperMm2, loop_mm2: o.swLoopMm2 }, note: 'hull of the node pads and the ground pads of the parts on it: a proxy for the loop, not its measured area' },
    })
  }
}

function edgeProximity(g: BoardGeometry, o: PrecheckOptions, out: Finding[]): void {
  if (!g.edges.length) return
  for (const [net, segs] of Object.entries(g.board.segments)) {
    if (!isFast(net, o)) continue
    let best = Infinity
    let where: [number, number, string] | null = null
    for (const [x1, y1, x2, y2, w, layer] of segs) {
      for (const [ex1, ey1, ex2, ey2] of g.edges) {
        const d = segSeg(x1, y1, x2, y2, ex1, ey1, ex2, ey2) - w / 2
        if (d < best) {
          best = d
          where = [(x1 + x2) / 2, (y1 + y2) / 2, layer]
        }
      }
    }
    if (where && best < o.edgeMm) {
      out.push({
        rule: 'edge_proximity', severity: best < o.edgeMm / 2 ? 'warn' : 'info', net, layer: where[2], at: at(where[0], where[1]),
        message: `fast net ${net} comes within ${rd(best, 2)} mm of the board edge (guideline ${o.edgeMm} mm): fringing fields at the edge radiate`,
        evidence: { distance_mm: rd(best, 3), guideline_mm: o.edgeMm },
      })
    }
  }
}

function refAt(g: BoardGeometry, pl: Map<string, PlaneIndex>, layer: string, x: number, y: number, ring: number): { layer: string; net: string } | null {
  const b = g.board
  const probe = (name: string): string | null => {
    const idx = pl.get(name)
    if (!idx) return null
    for (let k = 0; k < 8; k++) {
      const n = idx.netAt(x + ring * Math.cos((k * Math.PI) / 4), y + ring * Math.sin((k * Math.PI) / 4))
      if (n) return n
    }
    return null
  }
  const ref = refLayer(b, layer, pl)
  if (ref) {
    const n = probe(ref.layer.name)
    if (n) return { layer: ref.layer.name, net: n }
  }
  const same = probe(layer)
  return same ? { layer, net: same } : null
}

function stitching(g: BoardGeometry, o: PrecheckOptions, pl: Map<string, PlaneIndex>, out: Finding[]): void {
  const b = g.board
  const order = b.layers.map((l) => l.name)
  for (const [net, vias] of Object.entries(b.vias)) {
    if (referenceNet(net, o)) continue
    for (const [x, y, size, , top, bot] of vias) {
      const touching = new Set<string>()
      for (const s of b.segments[net] ?? []) {
        if (Math.hypot(s[0] - x, s[1] - y) <= size / 2 + 0.01 || Math.hypot(s[2] - x, s[3] - y) <= size / 2 + 0.01) touching.add(s[5])
      }
      const ls = touching.size >= 2 ? [...touching].sort((a, c) => order.indexOf(a) - order.indexOf(c)) : [top, bot]
      const a = ls[0] as string
      const c = ls[ls.length - 1] as string
      const ring = size / 2 + o.antipadMm + 0.3
      const ra = refAt(g, pl, a, x, y, ring)
      const rc = refAt(g, pl, c, x, y, ring)
      if (!ra || !rc || (ra.layer === rc.layer && ra.net === rc.net)) continue
      if (ra.net === rc.net) {
        let near = Infinity
        for (const [vx, vy] of b.vias[ra.net] ?? []) near = Math.min(near, Math.hypot(vx - x, vy - y))
        for (const p of b.pads[ra.net] ?? []) if (p.kind === 'thru_hole') near = Math.min(near, Math.hypot(p.x - x, p.y - y))
        if (near > o.stitchMm) {
          out.push({
            rule: 'stitching', severity: isFast(net, o) ? 'error' : 'warn', net, layer: `${a}->${c}`, at: at(x, y),
            message: `${net} changes layer here (${a} to ${c}), its reference moves from ${ra.layer} to ${rc.layer} (${ra.net}), and the nearest ${ra.net} via is ${Number.isFinite(near) ? `${rd(near, 2)} mm` : 'nowhere'} away (guideline ${o.stitchMm} mm)`,
            evidence: { from: ra, to: rc, nearest_stitch_mm: Number.isFinite(near) ? rd(near, 3) : null, guideline_mm: o.stitchMm },
          })
        }
      } else {
        let near = Infinity
        let cap: string | null = null
        for (const f of b.footprints) {
          if (!/^C\d/i.test(f.ref)) continue
          const nets = new Set(f.pads.map((p) => p.net))
          if (nets.has(ra.net) && nets.has(rc.net)) {
            const d = Math.hypot(f.x_mm - x, f.y_mm - y)
            if (d < near) {
              near = d
              cap = f.ref
            }
          }
        }
        out.push({
          rule: 'stitching', severity: near > 5 * o.stitchMm ? 'warn' : 'info', net, layer: `${a}->${c}`, at: at(x, y),
          message: `${net} changes reference net here (${ra.net} on ${ra.layer} to ${rc.net} on ${rc.layer}); the return crosses through ${cap ? `${cap}, ${rd(near, 2)} mm away` : 'no capacitor between those nets'}`,
          evidence: { from: ra, to: rc, nearest_capacitor: cap, distance_mm: Number.isFinite(near) ? rd(near, 3) : null },
        })
      }
    }
  }
}

function decoupling(g: BoardGeometry, o: PrecheckOptions, out: Finding[]): void {
  const b = g.board
  const caps = b.footprints.filter((f) => /^C\d/i.test(f.ref) && f.pads.length === 2)
  for (const ic of b.footprints) {
    if (!o.icPrefixes.some((p) => new RegExp(`^${p}\\d`, 'i').test(ic.ref))) continue
    const done = new Set<string>()
    for (const pin of ic.pads) {
      if (!pin.net || !isPower(pin.net) || done.has(pin.net)) continue
      done.add(pin.net)
      let near = Infinity
      let which: string | null = null
      let side: string | null = null
      for (const c of caps) {
        const pn = c.pads.find((p) => p.net === pin.net)
        const pg = c.pads.find((p) => p.net !== null && isGround(p.net))
        if (!pn || !pg) continue
        const d = Math.hypot(pn.x_mm - pin.x_mm, pn.y_mm - pin.y_mm)
        if (d < near) {
          near = d
          which = c.ref
          side = c.side
        }
      }
      if (which === null) {
        out.push({ rule: 'decoupling', severity: 'warn', net: pin.net, layer: null, at: at(pin.x_mm, pin.y_mm), message: `${ic.ref} pin ${pin.num} (${pin.net}) has no capacitor from ${pin.net} to ground on the board`, evidence: { ic: ic.ref, pin: pin.num } })
      } else if (near > o.decapMm) {
        out.push({ rule: 'decoupling', severity: 'warn', net: pin.net, layer: null, at: at(pin.x_mm, pin.y_mm), message: `${ic.ref} pin ${pin.num} (${pin.net}): nearest decoupling capacitor ${which} is ${rd(near, 2)} mm away (guideline ${o.decapMm} mm)`, evidence: { ic: ic.ref, pin: pin.num, capacitor: which, distance_mm: rd(near, 3), capacitor_side: side, ic_side: ic.side } })
      } else if (side !== ic.side) {
        out.push({ rule: 'decoupling', severity: 'info', net: pin.net, layer: null, at: at(pin.x_mm, pin.y_mm), message: `${ic.ref} pin ${pin.num}: decoupling capacitor ${which} is on the other side of the board (via inductance in the loop)`, evidence: { ic: ic.ref, capacitor: which, distance_mm: rd(near, 3) } })
      }
    }
  }
}

export interface SpectrumRow { f_hz: number; harmonic: number; current_ua: number; e_dbuv_m: number; limit_dbuv_m: number; margin_db: number }

function edgeSpectrum(g: BoardGeometry, o: PrecheckOptions, pl: Map<string, PlaneIndex>, out: Finding[]): Record<string, unknown>[] {
  const b = g.board
  const tables: Record<string, unknown>[] = []
  for (const e of o.edges) {
    const segs = b.segments[e.net]
    if (!segs?.length) {
      out.push({ rule: 'edge_spectrum', severity: 'info', net: e.net, layer: null, at: null, message: `${e.net}: no tracks on the board, no estimate`, evidence: {} })
      continue
    }
    const byLayer = new Map<string, { len: number; w: number }>()
    let length = 0
    for (const s of segs) {
      length += s[6]
      const cur = byLayer.get(s[5]) ?? { len: 0, w: s[4] }
      cur.len += s[6]
      byLayer.set(s[5], cur)
    }
    const main = [...byLayer].sort((a, c) => c[1].len - a[1].len)[0] as [string, { len: number; w: number }]
    const L = b.layers.find((l) => l.name === main[0]) as Layer
    const z = layerZ0(L, main[1].w * 1e-3)
    const ref = refLayer(b, main[0], pl)
    const h = ref ? ref.h_mm : ((L.below?.[0] ?? L.above?.[0] ?? 1.6e-3) * 1e3)
    const z0 = z ?? 50
    const area = (length * 1e-3) * (h * 1e-3)
    const rows: SpectrumRow[] = []
    for (const hm of harmonics({ amplitude: e.amplitude_v, freq: e.freq_hz, duty: e.duty, rise: e.rise_s }, 30e6, 6e9, 2000)) {
      const lim = cisprLimit(o.cisprClass, hm.f, o.distanceM)
      if (!lim || hm.amplitude <= 0) continue
      const i = hm.amplitude / z0
      const ev = dBuV(peakToRms(dmField(hm.f, area, i, o.distanceM, true)))
      rows.push({ f_hz: hm.f, harmonic: hm.n, current_ua: rd(i * 1e6, 3), e_dbuv_m: rd(ev, 2), limit_dbuv_m: rd(lim.db_uv_m, 2), margin_db: rd(lim.db_uv_m - ev, 2) })
    }
    const worst = [...rows].sort((a, c) => a.margin_db - c.margin_db)[0]
    tables.push({ net: e.net, loop_area_mm2: rd(length * h, 2), length_mm: rd(length, 2), height_mm: rd(h, 3), z0_ohm: rd(z0, 2), z0_from: z === null ? 'assumed 50 ohm (stackup incomplete)' : `${main[0]}, ${main[1].w} mm`, worst: worst ?? null, harmonics: rows.length })
    if (worst && worst.margin_db < o.warnMarginDb) {
      out.push({
        rule: 'edge_spectrum', severity: worst.margin_db < 0 ? 'error' : 'warn', net: e.net, layer: main[0], at: null,
        message: `${e.net}: estimated differential-mode emission ${worst.e_dbuv_m} dBuV/m at ${(worst.f_hz / 1e6).toPrecision(4)} MHz vs CISPR 32 class ${o.cisprClass} ${worst.limit_dbuv_m} dBuV/m at ${o.distanceM} m (margin ${worst.margin_db} dB) — pre-compliance estimate`,
        evidence: { ...worst, loop_area_mm2: rd(length * h, 2), z0_ohm: rd(z0, 2), assumption: 'I = V_n / Z0 (matched line), loop = length x height, Ott DM formula with ground reflection, no common-mode', limits: CISPR_SOURCE },
      })
    }
  }
  return tables
}

export interface PrecheckReport { findings: Finding[]; counts: Record<Severity, number>; spectrum: Record<string, unknown>[]; planes: { layer: string; nets: string[]; filled: boolean }[]; notes: string[] }

export function precheck(g: BoardGeometry, o: PrecheckOptions): PrecheckReport {
  const pl = planes(g, o)
  const findings: Finding[] = []
  const want = new Set(o.rules)
  const notes: string[] = []
  if (!pl.size) notes.push('no ground or power zones found: the plane rules (return_path, stitching) had nothing to check against')
  if (!g.edges.length) notes.push('no Edge.Cuts outline: edge_proximity skipped')
  if (want.has('return_path')) returnPath(g, o, pl, findings)
  if (want.has('switching_loop')) switchingLoop(g, o, findings)
  if (want.has('edge_proximity')) edgeProximity(g, o, findings)
  if (want.has('stitching')) stitching(g, o, pl, findings)
  if (want.has('decoupling')) decoupling(g, o, findings)
  const spectrum = want.has('edge_spectrum') ? edgeSpectrum(g, o, pl, findings) : []
  if (want.has('edge_spectrum') && !o.edges.length) notes.push('edge_spectrum needs `edges` (net, freq_hz, rise_s, amplitude_v): the board does not say how fast its nets switch')
  const rank: Record<Severity, number> = { error: 0, warn: 1, info: 2 }
  findings.sort((a, c) => rank[a.severity] - rank[c.severity] || a.rule.localeCompare(c.rule) || (a.net ?? '').localeCompare(c.net ?? ''))
  const counts: Record<Severity, number> = { error: 0, warn: 0, info: 0 }
  for (const f of findings) counts[f.severity]++
  const planesOut: PrecheckReport['planes'] = []
  for (const z of g.zones) {
    if (z.keepout || !z.net || !referenceNet(z.net, o)) continue
    const row = planesOut.find((p) => p.layer === z.layer)
    if (row) {
      if (!row.nets.includes(z.net)) row.nets.push(z.net)
      row.filled &&= z.filled
    } else planesOut.push({ layer: z.layer, nets: [z.net], filled: z.filled })
  }
  if (planesOut.some((p) => !p.filled)) notes.push('some zones are not filled (no filled_polygon): their outlines were used, which ignores clearances; refill zones in KiCad for an exact check')
  return { findings, counts, spectrum, planes: planesOut, notes }
}

