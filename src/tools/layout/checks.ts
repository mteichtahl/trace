/**
 * Placement and length checks on a KiCad board, read from the file (no kicad-cli): pure functions over a Layout.
 *
 *   placementCheck  courtyard overlaps (same side), parts outside the board edge or closer to it than a margin,
 *                   parts in keep-out areas that forbid footprints (or pads in ones that forbid pads), decoupling
 *                   capacitors too far from the power pins they serve, IC power pins with no capacitor near, and
 *                   connectors away from the board edge
 *   lengthMatch     differential pair skew (pairs named …+/…- or …P/…N, as KiCad pairs them, or given) and
 *                   length-group spread, against tolerances given here or set in the board's .kicad_dru
 *                   (skew / length constraints on a net class, net name or diff pair)
 *   floorplan       placement summarised by functional block: footprints grouped by schematic sheet (or by ref
 *                   prefix, or by given blocks), each block's bounding box, area, density and centroid, blocks whose
 *                   boxes overlap, and how many nets join each pair of blocks. A report: nothing is moved.
 */
import { existsSync, readFileSync } from 'node:fs'
import * as sx from '../kicad/sexpr.js'
import { signalLength, type Board, type Pad } from '../kicad/pcb.js'
import { onSide, type Layout, type PlacedFootprint } from './board.js'
import { area, bbox, gapToSegments, inside, overlapArea, overlaps, rectPoly, type Poly, type Pt } from './geom.js'
import type { DruItem, DruRule } from './dru.js'

const r3 = (x: number): number => Math.round(x * 1000) / 1000

export function glob(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
}

const GROUND = /^\/?(.*\/)?(GND|AGND|DGND|PGND|SGND|GNDA|GNDD|GNDPWR|VSS|VSSA|0V|EARTH|CHASSIS)\w*$/i
/** Power rails: KiCad power symbols (+3V3, +5V, …), and VCC / VDD / VBAT / VIN … style names, 3V3, 1V8, 12V. */
const POWER = /^\/?(.*\/)?(\+\w+|\d+V\d*|V(CC|DD|IO|BAT|IN|SYS|BUS|USB|REF|CORE|AUX|MOT|PP|SS_?IO)\w*|AVDD\w*|DVDD\w*|VDDA\w*|PVDD\w*)$/i

// ------------------------------------------------------------------ placement

export interface PlacementOptions {
  edge_clearance_mm: number
  decap_max_mm: number
  decap_refs: RegExp
  decap_max_uf: number
  ic_refs: RegExp
  connector_refs: RegExp
  connector_edge_max_mm: number
  interior_connectors: string[]
  ground: RegExp
  /** nets a decoupling capacitor can serve */
  power: RegExp
  /** courtyard overlaps smaller than this (mm²) are ignored (touching outlines) */
  min_overlap_mm2: number
  ignore: string[]
}

export interface Finding {
  check: 'courtyard_overlap' | 'outside_edge' | 'edge_clearance' | 'keepout' | 'decoupling_distance' | 'power_pin_without_decoupling' | 'connector_not_at_edge' | 'no_courtyard' | 'courtyard_open'
  severity: 'error' | 'warning' | 'info'
  refs: string[]
  message: string
  value_mm?: number
  limit_mm?: number
  at?: [number, number]
}

/** A capacitor value in µF, from "100n", "0.1u", "4.7uF", "10µF", "1 nF", "100p", "2u2". */
export function capacitanceUf(value: string): number | null {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*([pnuµm]?)(\d*)\s*F?\b/i.exec(value)
  if (!m) return null
  let v = Number(`${(m[1] as string).replace(',', '.')}${m[3] ? `.${m[3]}` : ''}`)
  if (m[3] && /\./.test(m[1] as string)) return null
  const s = (m[2] ?? '').toLowerCase()
  v *= s === 'p' ? 1e-6 : s === 'n' ? 1e-3 : s === 'u' || s === 'µ' ? 1 : s === 'm' ? 1e3 : 1e6
  return v
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y)

/** The area two footprints' courtyards share (their actual polygons: an edge crossing or containment first, then the
 * exact shared area), 0 when they only touch or are apart. */
export function courtyardOverlap(a: { courtyards: Poly[] }, b: { courtyards: Poly[] }): number {
  let s = 0
  for (const p of a.courtyards) for (const q of b.courtyards) if (overlaps(p, q)) s += overlapArea(p, q)
  return s
}

const hullNote = (f: PlacedFootprint): string => (f.courtyard_from === 'hull' ? `; ${f.ref}'s courtyard is its convex hull (the outline does not close), so this may overstate` : '')

export function placementCheck(L: Layout, o: PlacementOptions): { findings: Finding[]; counts: Record<string, number>; decoupling: unknown[]; connectors: unknown[] } {
  const findings: Finding[] = []
  const ignore = o.ignore.map(glob)
  const fps = L.footprints.filter((f) => !ignore.some((re) => re.test(f.ref)))
  const b = L.board

  // courtyards: same side, pairwise via a coarse grid
  const cell = 5
  const grid = new Map<string, number[]>()
  const boxes = fps.map((f) => bbox(f.courtyard))
  boxes.forEach(([x0, y0, x1, y1], i) => {
    for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) {
      for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) (grid.get(`${gx},${gy}`) ?? grid.set(`${gx},${gy}`, []).get(`${gx},${gy}`) as number[]).push(i)
    }
  })
  const seen = new Set<string>()
  for (const list of grid.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let c = a + 1; c < list.length; c++) {
        const i = list[a] as number
        const j = list[c] as number
        const k = i < j ? `${i},${j}` : `${j},${i}`
        if (seen.has(k)) continue
        seen.add(k)
        const fa = fps[i] as PlacedFootprint
        const fb = fps[j] as PlacedFootprint
        if (fa.side !== fb.side) continue
        const [ax0, ay0, ax1, ay1] = boxes[i] as number[] as [number, number, number, number]
        const [bx0, by0, bx1, by1] = boxes[j] as number[] as [number, number, number, number]
        if (ax1 <= bx0 || bx1 <= ax0 || ay1 <= by0 || by1 <= ay0) continue
        const ov = courtyardOverlap(fa, fb)
        if (ov > o.min_overlap_mm2) {
          findings.push({ check: 'courtyard_overlap', severity: 'error', refs: [fa.ref, fb.ref].sort(), message: `${fa.ref} and ${fb.ref} courtyards overlap by ${r3(ov)} mm² (${fa.side})${hullNote(fa)}${hullNote(fb)}`, value_mm: r3(ov) })
        }
      }
    }
  }

  // the board edge
  if (L.outline) {
    for (const f of fps) {
      const out = f.courtyard.filter((p) => !inside(p, L.outline as Pt[]) || L.cutouts.some((c) => inside(p, c)))
      if (out.length) {
        findings.push({ check: 'outside_edge', severity: 'error', refs: [f.ref], message: `${f.ref}'s courtyard extends outside the board edge (${out.length} of ${f.courtyard.length} corners)`, at: [r3(f.x), r3(f.y)] })
        continue
      }
      const g = gapToSegments(f.courtyard, L.edges)
      if (o.edge_clearance_mm > 0 && g < o.edge_clearance_mm && !o.connector_refs.test(f.ref)) {
        findings.push({ check: 'edge_clearance', severity: 'warning', refs: [f.ref], message: `${f.ref} is ${r3(g)} mm from the board edge (want ${o.edge_clearance_mm} mm)`, value_mm: r3(g), limit_mm: o.edge_clearance_mm })
      }
    }
  }

  // keep-outs
  for (const k of L.keepouts) {
    for (const f of fps) {
      if (!onSide(k.layers, f.side)) continue
      if (k.not_allowed.includes('footprints') && courtyardOverlap(f, { courtyards: [k.polygon] }) > 1e-6) {
        findings.push({ check: 'keepout', severity: 'error', refs: [f.ref], message: `${f.ref} is inside keep-out ${k.name ?? '(unnamed)'}, which does not allow footprints${hullNote(f)}` })
      } else if (k.not_allowed.includes('pads')) {
        const inPads = f.pads.filter((p) => inside([p.x_mm, p.y_mm], k.polygon))
        if (inPads.length) findings.push({ check: 'keepout', severity: 'error', refs: [f.ref], message: `${f.ref} has ${inPads.length} pad(s) inside keep-out ${k.name ?? '(unnamed)'}, which does not allow pads` })
      }
    }
  }

  // decoupling: a small capacitor between a power net and ground, near the IC power pins on that net
  const byRef = new Map(fps.map((f) => [f.ref, f]))
  const padsOf = (ref: string): Pad[] => Object.values(b.pads).flat().filter((p) => p.ref === ref)
  const decoupling: { cap: string; value: string; net: string; nearest_pin: string | null; distance_mm: number | null; ok: boolean | null }[] = []
  const covered = new Set<string>()
  for (const f of fps) {
    if (!o.decap_refs.test(f.ref) || f.dnp) continue
    const uf = capacitanceUf(f.value)
    if (uf === null || uf > o.decap_max_uf) continue
    const pads = padsOf(f.ref)
    const nets = [...new Set(pads.map((p) => p.net))]
    const gnd = nets.find((n) => o.ground.test(n))
    const pwr = nets.find((n) => n !== gnd && !o.ground.test(n))
    if (!gnd || !pwr || nets.length !== 2 || !o.power.test(pwr)) continue // a filter capacitor on a signal is not decoupling
    const capPad = pads.find((p) => p.net === pwr) as Pad
    const pins = (b.pads[pwr] ?? []).filter((p) => o.ic_refs.test(p.ref) && byRef.has(p.ref) && byRef.get(p.ref)?.side === f.side)
    let best: { pin: string; d: number } | null = null
    for (const p of pins) {
      const d = dist(capPad, p)
      if (!best || d < best.d) best = { pin: `${p.ref}.${p.num}`, d }
    }
    for (const p of pins) if (dist(capPad, p) <= o.decap_max_mm) covered.add(`${p.ref}.${p.num}`)
    // no IC pin on its net on this side (the load is off the board, or on the other side): nothing to judge
    const ok = best === null ? null : best.d <= o.decap_max_mm
    decoupling.push({ cap: f.ref, value: f.value, net: pwr, nearest_pin: best?.pin ?? null, distance_mm: best ? r3(best.d) : null, ok })
    if (best && ok === false) findings.push({ check: 'decoupling_distance', severity: 'warning', refs: [f.ref, best.pin.split('.')[0] as string], message: `${f.ref} (${f.value} on ${pwr}) is ${r3(best.d)} mm from the nearest ${pwr} pin, ${best.pin} (want ≤ ${o.decap_max_mm} mm)`, value_mm: r3(best.d), limit_mm: o.decap_max_mm })
  }
  // IC power pins on a net that has decoupling somewhere, but none near this pin
  const decapNets = new Set(decoupling.map((d) => d.net))
  for (const net of decapNets) {
    for (const p of b.pads[net] ?? []) {
      if (!o.ic_refs.test(p.ref) || !byRef.has(p.ref) || covered.has(`${p.ref}.${p.num}`)) continue
      findings.push({ check: 'power_pin_without_decoupling', severity: 'info', refs: [p.ref], message: `${p.ref}.${p.num} (${net}) has no decoupling capacitor within ${o.decap_max_mm} mm`, at: [r3(p.x), r3(p.y)] })
    }
  }

  // connectors at the edge
  const connectors: { ref: string; edge_distance_mm: number | null; ok: boolean }[] = []
  for (const f of fps) {
    if (!o.connector_refs.test(f.ref) && !/connector|header|usb|jack|terminal/i.test(f.footprint)) continue
    if (o.interior_connectors.some((p) => glob(p).test(f.ref))) continue
    const g = L.edges.length ? gapToSegments(f.courtyard, L.edges) : null
    const ok = g !== null && g <= o.connector_edge_max_mm
    connectors.push({ ref: f.ref, edge_distance_mm: g === null ? null : r3(g), ok })
    if (g !== null && !ok) findings.push({ check: 'connector_not_at_edge', severity: 'warning', refs: [f.ref], message: `connector ${f.ref} is ${r3(g)} mm from the board edge (want ≤ ${o.connector_edge_max_mm} mm; list it in interior_connectors if it belongs inside)`, value_mm: r3(g), limit_mm: o.connector_edge_max_mm })
  }

  for (const f of fps) if (f.courtyard_from === 'pads') findings.push({ check: 'no_courtyard', severity: 'info', refs: [f.ref], message: `${f.ref} (${f.footprint}) has no courtyard: its pads' box grown by a margin was used` })
  for (const f of fps) if (f.courtyard_from === 'hull') findings.push({ check: 'courtyard_open', severity: 'info', refs: [f.ref], message: `${f.ref} (${f.footprint}): ${f.courtyard_note ?? 'the courtyard outline does not close: its convex hull was used'}` })
  const counts: Record<string, number> = {}
  for (const x of findings) counts[x.check] = (counts[x.check] ?? 0) + 1
  return { findings, counts, decoupling, connectors }
}

// ------------------------------------------------------------------ lengths

export { druRules, type DruArea, type DruItem, type DruRule } from './dru.js'

/** A net's items as .kicad_dru conditions see them: its tracks, vias and pads. (The board reader does not keep a
 * via's micro flag: a via that is not through is Blind/buried here.) */
export function netItems(b: Board, net: string, cls: string | null, pair: boolean): DruItem[] {
  const order = b.layers.map((l) => l.name)
  const out: DruItem[] = []
  for (const [x1, y1, x2, y2, , ly] of b.segments[net] ?? []) out.push({ type: 'track', net, netclass: cls, diffPair: pair, layers: [ly], points: [[x1, y1], [x2, y2]] })
  for (const [x, y, , , top, bot] of b.vias[net] ?? []) {
    const through = top === order[0] && bot === order[order.length - 1]
    const ia = order.indexOf(top)
    const ib = order.indexOf(bot)
    const span = ia >= 0 && ib >= 0 ? order.slice(Math.min(ia, ib), Math.max(ia, ib) + 1) : [top, bot]
    out.push({ type: 'via', net, netclass: cls, diffPair: pair, layers: span, viaKind: through ? 'through' : 'blind', points: [[x, y]] })
  }
  for (const p of b.pads[net] ?? []) out.push({ type: 'pad', net, netclass: cls, diffPair: pair, layers: p.layers, padKind: p.kind, reference: p.ref, points: [[p.x, p.y]] })
  return out
}

/** Whether a rule governs a net: one of the net's items (or, with no items, the net itself) meets its condition,
 * with the other net's items as B (a diff pair) when given. */
export function ruleGoverns(rule: DruRule, items: readonly DruItem[], others: readonly DruItem[] = []): boolean {
  if (!items.length) return false
  return items.some((a) => (others.length ? others.some((b) => rule.test(a, b)) : rule.test(a, null)))
}

/** A net's class from the project file: netclass_assignments, then netclass_patterns (globs), else Default. */
export function netClasses(proPath: string | null): (net: string) => string | null {
  if (!proPath || !existsSync(proPath)) return () => null
  try {
    const pro = JSON.parse(readFileSync(proPath, 'utf8')) as { net_settings?: { netclass_assignments?: Record<string, string | string[]> | null; netclass_patterns?: { netclass: string; pattern: string }[] } }
    const ns = pro.net_settings ?? {}
    const assigned = ns.netclass_assignments ?? {}
    const pats = (ns.netclass_patterns ?? []).map((p) => ({ cls: p.netclass, re: glob(p.pattern) }))
    return (net) => {
      const a = assigned[net]
      if (a) return Array.isArray(a) ? (a[0] ?? null) : a
      const hit = pats.find((p) => p.re.test(net) || p.re.test(net.replace(/^\//, '')))
      return hit ? hit.cls : 'Default'
    }
  } catch {
    return () => null
  }
}

/** KiCad's own pairing: the same name ending in + and -, or in P and N; and USB's DP and DM (D minus). */
export function diffPairs(nets: readonly string[]): { p: string; n: string }[] {
  const set = new Set(nets)
  const out: { p: string; n: string }[] = []
  for (const net of nets) {
    const m = /^(.*)(\+|P)$/.exec(net)
    if (!m || !m[1]) continue
    const others = m[2] === '+' ? [`${m[1]}-`] : [`${m[1]}N`, ...(/D_?$/.test(m[1]) ? [`${m[1]}M`] : [])]
    const other = others.find((o) => set.has(o))
    if (other) out.push({ p: net, n: other })
  }
  return out.sort((a, b) => a.p.localeCompare(b.p))
}

// ------------------------------------------------------------------ signal classes

/** The signal classes a pair gets a skew tolerance from when nothing else gives one. */
export const PAIR_CLASSES = ['usb2_ls', 'usb2_fs', 'usb2_hs'] as const
export type PairClass = (typeof PAIR_CLASSES)[number]
export type UsbSpeed = 'low' | 'full' | 'high'

/**
 * The default skew tolerance of each class, with its basis. FR-4 carries a signal about 6.7 ps per mm. Full and Low
 * Speed edges are nanoseconds long, so a few mm of skew is harmless there; High Speed is the tight one.
 */
export const CLASS_TOLERANCE: Readonly<Record<PairClass, { name: string; tolerance_mm: number; skew_ps: number; basis: string }>> = {
  usb2_ls: {
    name: 'USB 2.0 Low Speed', tolerance_mm: 15, skew_ps: 100,
    basis: 'USB 2.0 Low Speed, 1.5 Mbit/s (667 ns bit): the USB 2.0 specification has low-speed edges rise and fall in 75 to 300 ns, so 100 ps of D+/D- skew (about 15 mm of FR-4 at 6.7 ps/mm) is negligible.',
  },
  usb2_fs: {
    name: 'USB 2.0 Full Speed', tolerance_mm: 15, skew_ps: 100,
    basis: 'USB 2.0 Full Speed, 12 Mbit/s (83 ns bit): the USB 2.0 specification has full-speed edges rise and fall in 4 to 20 ns, so 100 ps of D+/D- skew (about 15 mm of FR-4 at 6.7 ps/mm) is under 3 % of the fastest edge and does not move the crossover.',
  },
  usb2_hs: {
    name: 'USB 2.0 High Speed', tolerance_mm: 1.27, skew_ps: 8.5,
    basis: 'USB 2.0 High Speed, 480 Mbit/s (2.08 ns bit, edges from 500 ps): the USB 2.0 specification allows a cable pair 100 ps of skew, and common layout guidance matches D+ and D- on the board within 50 mil (1.27 mm, about 8.5 ps).',
  },
}

const USB_CLASS: Readonly<Record<UsbSpeed, PairClass>> = { low: 'usb2_ls', full: 'usb2_fs', high: 'usb2_hs' }

/** Whether a pair's names say USB: USB in either name, or D+/D-, DP/DN, DP/DM on their own. */
export function usbPair(p: string, n: string): boolean {
  const base = (x: string): string => x.replace(/^.*\//, '')
  return [p, n].some((x) => /USB/i.test(base(x))) || (/^D_?[+P]$/i.test(base(p)) && /^D_?[-NM]$/i.test(base(n)))
}

/**
 * The USB speed the project states, from its requirements and intent (each { id, text }): High Speed or 480 Mbit/s,
 * Full Speed or 12 Mbit/s, Low Speed or 1.5 Mbit/s, in a text that names USB. The fastest one stated wins.
 */
export function usbSpeedFrom(texts: readonly { id: string; text: string }[]): { speed: UsbSpeed; from: string } | null {
  const order: [UsbSpeed, RegExp][] = [
    ['high', /\bhigh[- ]?speed\b|\b480\s*Mb(it)?(\/s|ps)\b/i],
    ['full', /\bfull[- ]?speed\b|\b12\s*Mb(it)?(\/s|ps)\b/i],
    ['low', /\blow[- ]?speed\b|\b1\.5\s*Mb(it)?(\/s|ps)\b/i],
  ]
  const usb = texts.filter((t) => /\bUSB\b/i.test(t.text))
  for (const [speed, re] of order) {
    const hit = usb.find((t) => re.test(t.text))
    if (hit) return { speed, from: hit.id }
  }
  return null
}

export interface NetLength { net: string; length_mm: number; delay_ps: number | null; from: string | null; to: string | null; trace_mm: number; via_barrel_mm: number | null; vias: number; unreached: string[]; routed: boolean }

/**
 * A net's length for matching: signalLength's, the same figure kicad.net_length and emc.precheck report (pad to pad
 * along the net's longest run, both layers, via barrels from the stackup). Summing every track of a multi-pad net, as
 * this did before, counted stubs and let a via-less net's detour match another net's barrels (test-esp32 #159).
 * include_vias false leaves the barrels out.
 */
export function netLength(b: Board, name: string, includeVias: boolean): NetLength {
  const s = signalLength(b, name)
  return {
    net: name, length_mm: r3(includeVias ? s.length_mm : s.trace_mm), delay_ps: s.delay_ps, from: s.from, to: s.to,
    trace_mm: r3(s.trace_mm), via_barrel_mm: s.via_barrel_mm === null ? null : r3(s.via_barrel_mm), vias: s.vias, unreached: s.unreached, routed: s.routed,
  }
}

/** Where a measured length runs, "U2.5 to J1.B6", for the reader to check against the board. */
const ends = (l: NetLength): string | null => (l.from && l.to ? `${l.from} to ${l.to}` : null)

export interface LengthOptions {
  pairs?: { p: string; n: string; max_skew_mm?: number | undefined }[] | undefined
  auto_pairs: boolean
  max_skew_mm?: number | undefined
  groups?: { name: string; nets: string[]; tolerance_mm?: number | undefined; target_mm?: number | undefined }[] | undefined
  include_vias: boolean
  rules: DruRule[]
  netClass: (net: string) => string | null
  /** each pair's class, given; else USB pairs are USB 2.0 at usb_speed */
  classes?: Readonly<Record<string, PairClass>> | undefined
  usb_speed?: { speed: UsbSpeed; from: string } | null | undefined
  /** nets (or globs) that are not pairs to match, though their names pair */
  ignore?: readonly string[] | undefined
}

/** A pair's signal class and why: given for it, or a USB pair at the stated speed; null when not known. */
function pairClass(pr: { p: string; n: string }, o: LengthOptions): { cls: PairClass; from: string } | { cls: null; why: string } | null {
  const given = o.classes?.[pr.p]
  if (given) return { cls: given, from: 'given for the pair' }
  if (!usbPair(pr.p, pr.n)) return null
  if (o.usb_speed) return { cls: USB_CLASS[o.usb_speed.speed], from: o.usb_speed.from }
  return { cls: null, why: `a USB pair, but no requirement states its speed: Full Speed allows ${CLASS_TOLERANCE.usb2_fs.tolerance_mm} mm, High Speed ${CLASS_TOLERANCE.usb2_hs.tolerance_mm} mm (give usb_speed or a tolerance)` }
}

export interface LengthVerdict {
  pairs: unknown[]; groups: unknown[]; lengths: unknown[]; failures: number; unknown: number
  /** pairs on the board by name that nothing checked and ignore does not name */
  unchecked: { p: string; n: string }[]
  ignored: { p: string; n: string }[]
  /** why the check is not met, in plain words; empty when it is */
  reasons: string[]
  /** no pair or group on the board, so there is nothing to match */
  nothing_to_match: boolean
}

export function lengthMatch(b: Board, nets: readonly string[], o: LengthOptions): LengthVerdict {
  const lens = new Map<string, NetLength>()
  const len = (n: string): NetLength => lens.get(n) ?? lens.set(n, netLength(b, n, o.include_vias)).get(n) as NetLength
  const ignoreRes = (o.ignore ?? []).map(glob)
  const ignoredNet = (n: string): boolean => ignoreRes.some((re) => re.test(n) || re.test(n.replace(/^\//, '')))
  const onBoard = diffPairs(nets)
  const ignored = onBoard.filter((d) => ignoredNet(d.p) || ignoredNet(d.n))
  const candidates = onBoard.filter((d) => !ignored.includes(d))
  const pairList: { p: string; n: string; max_skew_mm?: number | undefined }[] = [...(o.pairs ?? []), ...(o.auto_pairs ? candidates.filter((d) => !(o.pairs ?? []).some((q) => q.p === d.p)) : [])]
  let failures = 0
  let unknown = 0
  const pairs = pairList.map((pr) => {
    for (const n of [pr.p, pr.n]) if (!nets.includes(n)) throw new Error(`${n} is not a net on the board`)
    const a = len(pr.p)
    const c = len(pr.n)
    const skew = r3(Math.abs(a.length_mm - c.length_mm))
    const cls = o.netClass(pr.p)
    const ip = netItems(b, pr.p, cls, true)
    const iN = netItems(b, pr.n, o.netClass(pr.n), true)
    const rule = o.rules.find((r) => r.skew_max_mm !== undefined && ruleGoverns(r, ip, iN) && ruleGoverns(r, iN, ip))
    const given = pr.max_skew_mm
    // the signal class gives a default with its basis (test-esp32 #163, #187): a USB Full Speed pair is not held to
    // a High Speed figure, and a pair nothing gives a tolerance to is not met, not passed
    const sc = pairClass(pr, o)
    const byClass = sc?.cls ? { v: CLASS_TOLERANCE[sc.cls].tolerance_mm, from: `${CLASS_TOLERANCE[sc.cls].name} default (speed from ${sc.from})` } : null
    const tol: { v: number; from: string } | null = given !== undefined ? { v: given, from: 'given for the pair' }
      : o.max_skew_mm !== undefined ? { v: o.max_skew_mm, from: 'max_skew_mm' } : rule ? { v: rule.skew_max_mm as number, from: `rule ${rule.name}` } : byClass
    const routed = a.routed && c.routed && !a.unreached.length && !c.unreached.length
    const status = !routed ? 'unrouted' : tol === null ? 'no_tolerance' : skew <= tol.v + 1e-9 ? 'pass' : 'fail'
    if (status === 'fail' || status === 'unrouted') failures++
    if (status === 'no_tolerance') unknown++
    return {
      p: pr.p, n: pr.n, net_class: cls, p_mm: a.length_mm, n_mm: c.length_mm, skew_mm: skew, p_path: ends(a), n_path: ends(c),
      ...(a.delay_ps !== null && c.delay_ps !== null ? { skew_ps: r3(Math.abs(a.delay_ps - c.delay_ps)) } : {}),
      tolerance_mm: tol?.v ?? null, tolerance_from: tol?.from ?? null, status,
      ...(sc?.cls ? { signal_class: sc.cls, class_tolerance_mm: CLASS_TOLERANCE[sc.cls].tolerance_mm, basis: CLASS_TOLERANCE[sc.cls].basis } : {}),
      ...(sc && !sc.cls ? { why: sc.why } : {}),
    }
  })
  const groups = (o.groups ?? []).map((g) => {
    const members = [...new Set(g.nets.flatMap((p) => (/[*?]/.test(p) ? nets.filter((n) => glob(p).test(n) || glob(p).test(n.replace(/^\//, ''))) : [p])))]
    for (const n of members) if (!nets.includes(n)) throw new Error(`${n} is not a net on the board`)
    const rows = members.map(len)
    const vals = rows.map((r) => r.length_mm)
    const longest = vals.length ? Math.max(...vals) : 0
    const ref = g.target_mm ?? longest
    const pairNets = new Set(diffPairs(nets).flatMap((d) => [d.p, d.n]))
    const rule = rows.length ? o.rules.find((r) => r.length?.max !== undefined && rows.every((x) => ruleGoverns(r, netItems(b, x.net, o.netClass(x.net), pairNets.has(x.net))))) : undefined
    const tol = g.tolerance_mm ?? null
    const bad = rows.filter((r) => (tol !== null && Math.abs(ref - r.length_mm) > tol + 1e-9) || (rule?.length?.max !== undefined && r.length_mm > rule.length.max) || (rule?.length?.min !== undefined && r.length_mm < rule.length.min))
    const unrouted = rows.filter((r) => !r.routed || r.unreached.length)
    const status = !rows.length ? 'empty' : unrouted.length ? 'unrouted' : tol === null && !rule ? 'no_tolerance' : bad.length ? 'fail' : 'pass'
    if (status === 'fail' || status === 'unrouted') failures++
    if (status === 'no_tolerance') unknown++
    return {
      name: g.name, nets: rows.map((r) => ({ net: r.net, length_mm: r.length_mm, delta_mm: r3(r.length_mm - ref), path: ends(r) })),
      longest_mm: longest, shortest_mm: vals.length ? Math.min(...vals) : 0, spread_mm: vals.length ? r3(longest - Math.min(...vals)) : 0,
      reference_mm: ref, reference: g.target_mm !== undefined ? 'target' : 'longest', tolerance_mm: tol,
      ...(rule ? { rule: rule.name, rule_length_mm: rule.length } : {}), status, out_of_tolerance: bad.map((r) => r.net),
    }
  })
  const checked = new Set(pairList.flatMap((x) => [x.p, x.n]).concat(groups.flatMap((g) => g.nets.map((x) => x.net))))
  const unchecked = candidates.filter((d) => !checked.has(d.p) || !checked.has(d.n))
  const both = (x: { p: string; n: string }): string => `${x.p}/${x.n}`
  const reasons: string[] = []
  for (const pr of pairs) {
    if (pr.status === 'fail') reasons.push(`${both(pr)} is ${pr.skew_mm} mm apart, over its ${pr.tolerance_mm} mm (${pr.tolerance_from})`)
    if (pr.status === 'unrouted') reasons.push(`${both(pr)} is not fully routed`)
    if (pr.status === 'no_tolerance') reasons.push(`${both(pr)} has no matched-length rule${pr.why ? `: ${pr.why}` : ''}`)
  }
  for (const g of groups) {
    if (g.status === 'fail') reasons.push(`group ${g.name}: ${g.out_of_tolerance.join(', ')} out of tolerance`)
    if (g.status === 'unrouted') reasons.push(`group ${g.name} is not fully routed`)
    if (g.status === 'no_tolerance') reasons.push(`group ${g.name} has no tolerance`)
  }
  for (const d of unchecked) reasons.push(`${both(d)} is a differential pair by name and was not checked (check it, or name it in ignore)`)
  return { pairs, groups, lengths: [...lens.values()], failures, unknown, unchecked, ignored, reasons, nothing_to_match: !pairs.length && !groups.length && !unchecked.length }
}

// ------------------------------------------------------------------ floorplan

export interface Block { name: string; refs: string[]; side: { top: number; bottom: number }; bbox: [number, number, number, number]; area_mm2: number; courtyard_mm2: number; density: number; centroid: [number, number] }

export function floorplan(L: Layout, o: { group_by: 'sheet' | 'ref_prefix'; blocks?: { name: string; refs: string[] }[] | undefined; limitRefs: number }): {
  board: { area_mm2: number | null; courtyard_mm2: { top: number; bottom: number }; utilisation: { top: number | null; bottom: number | null } }
  blocks: (Omit<Block, 'refs'> & { count: number; refs: string[]; refs_omitted: number })[]
  overlaps: { a: string; b: string; overlap_mm2: number; fraction_of_smaller: number }[]
  connections: { a: string; b: string; nets: number }[]
  unassigned: string[]
} {
  const assign = new Map<string, string>()
  if (o.blocks?.length) {
    for (const blk of o.blocks) {
      const res = blk.refs.map(glob)
      for (const f of L.footprints) if (!assign.has(f.ref) && res.some((re) => re.test(f.ref))) assign.set(f.ref, blk.name)
    }
  } else {
    for (const f of L.footprints) assign.set(f.ref, o.group_by === 'sheet' ? f.sheet : (/^[A-Za-z#]+/.exec(f.ref)?.[0] ?? '?'))
  }
  const groups = new Map<string, PlacedFootprint[]>()
  for (const f of L.footprints) {
    const g = assign.get(f.ref)
    if (g !== undefined) (groups.get(g) ?? groups.set(g, []).get(g) as PlacedFootprint[]).push(f)
  }
  const blocks: Block[] = [...groups].map(([name, fs]): Block => {
    const pts = fs.flatMap((f) => f.courtyard)
    const bb = bbox(pts) as [number, number, number, number]
    const a = (bb[2] - bb[0]) * (bb[3] - bb[1])
    const cy = fs.reduce((s, f) => s + area(f.courtyard), 0)
    return {
      name, refs: fs.map((f) => f.ref).sort((x, y) => x.localeCompare(y, undefined, { numeric: true })),
      side: { top: fs.filter((f) => f.side === 'top').length, bottom: fs.filter((f) => f.side === 'bottom').length },
      bbox: bb.map(r3) as [number, number, number, number], area_mm2: r3(a), courtyard_mm2: r3(cy), density: a > 0 ? r3(cy / a) : 0,
      centroid: [r3(fs.reduce((t, f) => t + f.x, 0) / fs.length), r3(fs.reduce((t, f) => t + f.y, 0) / fs.length)],
    }
  }).sort((x, y) => x.name.localeCompare(y.name))
  const overlaps: { a: string; b: string; overlap_mm2: number; fraction_of_smaller: number }[] = []
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const A = blocks[i] as Block
      const B = blocks[j] as Block
      const ov = overlapArea(rectPoly(...A.bbox), rectPoly(...B.bbox))
      if (ov > 0.01) overlaps.push({ a: A.name, b: B.name, overlap_mm2: r3(ov), fraction_of_smaller: r3(ov / Math.max(1e-9, Math.min(A.area_mm2, B.area_mm2))) })
    }
  }
  const conn = new Map<string, number>()
  for (const [net, pads] of Object.entries(L.board.pads)) {
    if (GROUND.test(net)) continue
    const gs = [...new Set(pads.map((p) => assign.get(p.ref)).filter((g): g is string => g !== undefined))].sort()
    for (let i = 0; i < gs.length; i++) for (let j = i + 1; j < gs.length; j++) conn.set(`${gs[i]}\u0000${gs[j]}`, (conn.get(`${gs[i]}\u0000${gs[j]}`) ?? 0) + 1)
  }
  const sideArea = (s: 'top' | 'bottom'): number => r3(L.footprints.filter((f) => f.side === s).reduce((t, f) => t + area(f.courtyard), 0))
  const boardArea = L.outline ? area(L.outline) - L.cutouts.reduce((s, c) => s + area(c), 0) : L.board.outline ? L.board.outline.width_mm * L.board.outline.height_mm : null
  return {
    board: {
      area_mm2: boardArea === null ? null : r3(boardArea), courtyard_mm2: { top: sideArea('top'), bottom: sideArea('bottom') },
      utilisation: { top: boardArea ? r3(sideArea('top') / boardArea) : null, bottom: boardArea ? r3(sideArea('bottom') / boardArea) : null },
    },
    blocks: blocks.map((b) => ({ ...b, count: b.refs.length, refs: b.refs.slice(0, o.limitRefs), refs_omitted: Math.max(0, b.refs.length - o.limitRefs) })),
    overlaps: overlaps.sort((x, y) => y.overlap_mm2 - x.overlap_mm2),
    connections: [...conn].map(([k, n]) => {
      const [a, b] = k.split('\u0000') as [string, string]
      return { a, b, nets: n }
    }).sort((x, y) => y.nets - x.nets),
    unassigned: L.footprints.filter((f) => !assign.has(f.ref)).map((f) => f.ref),
  }
}

export { GROUND, POWER }
