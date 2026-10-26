/**
 * emc.setup: an openEMS FDTD model of a region of a KiCad board, decided here in full and written as one
 * self-contained Python script (python/emc/rf.py + python/emc/openems_model.py + the MODEL it builds). The same
 * inputs always give the same script.
 *
 * What goes in:
 *   copper     the tracks, pads, vias and zone fills of the chosen nets and the reference nets (ground by default)
 *              inside the region, clipped to it. Tracks become polygons (a rectangle plus octagonal end caps), pads
 *              their bounding rectangles, zones their filled polygons (Sutherland-Hodgman clipped), all as
 *              conducting sheets with the copper's thickness and conductivity (5.8e7 S/m); via barrels are PEC
 *              cylinders of the drill diameter with octagonal rings on their end layers.
 *   stackup    each dielectric of the board's stackup (thickness, epsilon_r, loss tangent) as a box over the
 *              region. A missing permittivity or loss tangent is assumed (4.5, 0.02) and reported.
 *   ports      lumped ports (resistor + source between a pad or point and the reference plane under it, box from
 *              the plane to the copper) or MSL ports (a straight feed section of the given length and direction).
 *   boundary   PML (8 cells, openEMS's PML_8) on all six faces, or MUR first-order absorbing (cheaper, more
 *              reflection). The structure is kept `margin` away from the PML: for S-parameters
 *              max(5 mm, 8 x board thickness); with radiated output at least lambda/4 at the lowest far-field
 *              frequency (capped at 1 m, and reported when capped). The PML cells are added beyond the margin.
 *   mesh       rectilinear: inside the region uniform cells no larger than min(lambda_min / (N sqrt(er_max)), w_min
 *              / 2) (N = cells_per_wavelength, w_min the narrowest track), with the edges of pads, axis-aligned
 *              tracks, vias and ports as mesh lines; outside it, cells grow by `grading` per cell up to lambda_min / N
 *              in air. In z, copper planes are mesh lines and each dielectric gets `cells_per_dielectric` cells.
 *              (No 1/3-2/3 edge rule: expect impedances within a few per cent, finer meshes for more.)
 *   excitation a Gaussian pulse covering 0 to fstop (openEMS SetGaussExcite(fstop/2, fstop/2)); results on the
 *              uniform grid df, 2df, ... fstop (df = fstop / points), which TDR needs.
 *
 * Estimates (reported, not promised): cells = Nx Ny Nz; the time step from the Courant limit of the smallest cells;
 * timesteps for the pulse (openEMS's Gaussian lasts 2 x 9 / (2 pi fc)) plus 5 transits of the domain's diagonal at
 * the slowest wave speed, capped at nr_ts (a resonant structure rings much longer; openEMS stops at the energy end
 * criterion, and emc.run reports the real count); memory at 72 bytes per cell for the fields and update coefficients
 * (6 field and 12 coefficient float32 values) times 1.5 for set-up overhead; run time at an assumed throughput
 * (TRACE_OPENEMS_MCPS, default 50 million cell-updates per second; openEMS prints the real figure, which emc.run
 * reports).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { stackupKnown, type Board } from '../../kicad/pcb.js'
import { clipSegment, clipToBox, isGround, readGeometry, type BoardGeometry, type Poly, type Pt } from './board.js'
import { C0, harmonics, type Trapezoid } from './spectrum.js'

export class SetupError extends Error {
  override name = 'SetupError'
}

export interface PortSpec {
  name?: string | undefined
  /** a pad, "R3.2", or a point [x, y] in board mm */
  at: string | [number, number]
  layer?: string | undefined
  ref_layer?: string | undefined
  type?: 'lumped' | 'msl' | undefined
  z0?: number | undefined
  /** MSL: the direction the line runs into the structure, and the feed section's length */
  direction?: 'x+' | 'x-' | 'y+' | 'y-' | undefined
  length_mm?: number | undefined
  width_mm?: number | undefined
}

export interface SetupInput {
  board: string
  nets: string[]
  reference_nets?: string[] | undefined
  region?: { x0: number; y0: number; x1: number; y1: number } | undefined
  region_margin_mm?: number | undefined
  include_other_copper?: boolean | undefined
  ports: PortSpec[]
  fstart?: number | undefined
  fstop: number
  points?: number | undefined
  cells_per_wavelength?: number | undefined
  max_cell_mm?: number | undefined
  fine_cell_mm?: number | undefined
  cells_per_dielectric?: number | undefined
  grading?: number | undefined
  boundary?: 'pml' | 'mur' | undefined
  margin_mm?: number | undefined
  excite?: 'all' | 'first' | undefined
  radiated?: { frequencies?: number[] | undefined; drive?: { amplitude_v: number; freq_hz: number; rise_s: number; duty?: number | undefined } | undefined; distance_m?: number | undefined; max_frequencies?: number | undefined } | undefined
  nr_ts?: number | undefined
  end_criteria_db?: number | undefined
  threads?: number | undefined
  keep_fields?: boolean | undefined
}

interface LayerOut { name: string; z: number; t_m: number; polygons: [number[], number[]][] }

export interface Model {
  title: string
  board_box: [number, number, number, number]
  mesh: { x: number[]; y: number[]; z: number[] }
  dielectrics: { z0: number; z1: number; er: number; tand: number }[]
  layers: LayerOut[]
  vias: [number, number, number, number, number][]
  ports: { type: 'lumped' | 'msl'; z0: number; start: number[]; stop: number[]; dir?: string; feed_shift?: number; meas_shift?: number; name: string }[]
  boundary: string[]
  f0: number
  fc: number
  f_loss: number
  sigma: number
  freqs: number[]
  excite: 'all' | 'first'
  nr_ts: number
  end_criteria: number
  threads: number
  er_eff: number | null
  nf2ff: boolean
  ff_freqs: number[]
  ff_radius_m: number
  ff_center_m: number[]
  keep: boolean
}

export interface Summary {
  region_mm: [number, number, number, number]
  nets: string[]
  reference_nets: string[]
  boundary: { kind: string; margin_mm: number; margin_reason: string; pml_cells: number }
  mesh: { nx: number; ny: number; nz: number; cells: number; min_cell_mm: [number, number, number]; max_cell_mm: [number, number, number]; fine_cell_mm: number; air_cell_mm: number; reason: string }
  timestep_s: number
  timesteps_est: number
  memory_mb_est: number
  time_s_est: number
  time_assumption: string
  excitations: number
  ports: { name: string; type: string; z0: number; at_mm: [number, number]; layer: string; ref_layer: string }[]
  stackup: { layer: string; z_mm: number }[]
  dielectrics: { z0_mm: number; z1_mm: number; er: number; tand: number; assumed: string[] }[]
  copper: { layer: string; polygons: number }[]
  vias: number
  frequencies: { start: number; stop: number; points: number; df: number }
  far_field?: { frequencies: number[]; radius_m: number; note: string }
  warnings: string[]
  choices: string[]
}

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4

function octagon(x: number, y: number, r: number): Pt[] {
  const R = r / Math.cos(Math.PI / 8) // circumscribed: the octagon covers the circle
  return Array.from({ length: 8 }, (_, k) => [x + R * Math.cos(Math.PI / 8 + (k * Math.PI) / 4), y + R * Math.sin(Math.PI / 8 + (k * Math.PI) / 4)] as Pt)
}

function rectPoly(x0: number, y0: number, x1: number, y1: number): Pt[] {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

function segPoly(x1: number, y1: number, x2: number, y2: number, w: number): Pt[] {
  const L = Math.hypot(x2 - x1, y2 - y1)
  if (L === 0) return octagon(x1, y1, w / 2)
  const nx = (-(y2 - y1) / L) * (w / 2)
  const ny = ((x2 - x1) / L) * (w / 2)
  return [[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]]
}

const toArrays = (p: Poly): [number[], number[]] => [p.map((q) => r4(q[0])), p.map((q) => r4(q[1]))]

/** Mesh lines on one axis: uniform `fine` cells over [c0, c1] through the fixed lines, then graded out to the margin. */
export function axisLines(fixed: readonly number[], c0: number, c1: number, lo: number, hi: number, fine: number, maxCell: number, grading: number, pmlCells: number): number[] {
  const core = [...new Set([c0, c1, ...fixed.filter((v) => v >= c0 && v <= c1)].map(r4))].sort((a, b) => a - b)
  const merged: number[] = []
  for (const v of core) if (!merged.length || v - (merged[merged.length - 1] as number) >= fine / 3 || v === c1) merged.push(v)
  if (merged.length >= 2 && (merged[merged.length - 1] as number) - (merged[merged.length - 2] as number) < fine / 3) merged.splice(merged.length - 2, 1)
  const lines: number[] = []
  for (let i = 0; i < merged.length; i++) {
    const v = merged[i] as number
    if (i > 0) {
      const prev = merged[i - 1] as number
      const n = Math.ceil((v - prev) / fine - 1e-9)
      for (let k = 1; k < n; k++) lines.push(r4(prev + ((v - prev) * k) / n))
    }
    lines.push(v)
  }
  // graded cells from the core's edge cell out to the margin: s_k = min(s0 g^k, maxCell), scaled to end exactly at
  // the margin (which keeps every ratio), then the PML cells at the last size
  const grow = (start: number, end: number, dir: 1 | -1, s0: number): number[] => {
    const D = Math.abs(end - start)
    const out: number[] = []
    if (D > 1e-9) {
      const st: number[] = []
      let sum = 0
      let s = s0
      while (sum < D - 1e-9) {
        s = Math.min(s * grading, maxCell)
        st.push(s)
        sum += s
      }
      const k = D / sum
      let x = start
      for (const v of st) {
        x += dir * v * k
        out.push(r4(x))
      }
      out[out.length - 1] = r4(end)
    }
    const last = out.length >= 2 ? Math.abs((out[out.length - 1] as number) - (out[out.length - 2] as number)) : s0
    let x = out.length ? (out[out.length - 1] as number) : start
    for (let j = 0; j < pmlCells; j++) {
      x += dir * last
      out.push(r4(x))
    }
    return out
  }
  const firstCell = lines.length >= 2 ? (lines[1] as number) - (lines[0] as number) : fine
  const lastCell = lines.length >= 2 ? (lines[lines.length - 1] as number) - (lines[lines.length - 2] as number) : fine
  return [...grow(c0, lo, -1, firstCell).reverse(), ...lines, ...grow(c1, hi, 1, lastCell)]
}

export function pythonDir(): string {
  if (process.env.TRACE_EMC_SCRIPTS) return process.env.TRACE_EMC_SCRIPTS.replace(/\/?$/, '/')
  return fileURLToPath(new URL('../../../python/emc/', import.meta.url))
}

export function modelScript(m: Model): string {
  const dir = pythonDir()
  const rf = readFileSync(`${dir}rf.py`, 'utf8')
  const runner = readFileSync(`${dir}openems_model.py`, 'utf8')
  return [
    '# Generated by trace emc.setup: an openEMS model of a KiCad board region. Run: python3 model.py run OUT_DIR',
    '# (python/emc/rf.py and python/emc/openems_model.py, then the MODEL; deterministic for the same inputs)',
    rf, runner,
    `MODEL = json.loads(${JSON.stringify(JSON.stringify(m))})`,
    '',
    "if __name__ == '__main__':",
    '    sys.exit(main(MODEL, sys.argv))',
    '',
  ].join('\n\n')
}

function padAt(b: Board, ref: string): { x: number; y: number; w: number; h: number; layers: string[]; net: string } {
  const [r, n] = ref.split('.')
  for (const [net, pads] of Object.entries(b.pads)) for (const p of pads) if (p.ref === r && p.num === n) return { x: p.x, y: p.y, w: p.w, h: p.h, layers: p.layers, net }
  throw new SetupError(`no pad ${ref} with a net on the board`)
}

export function buildModel(input: SetupInput, geometry?: BoardGeometry): { model: Model; summary: Summary } {
  const g = geometry ?? readGeometry(input.board)
  const b = g.board
  const warnings: string[] = []
  const choices: string[] = []
  if (!input.nets.length) throw new SetupError('give the nets to simulate')
  for (const n of input.nets) if (!b.segments[n] && !b.pads[n]) throw new SetupError(`no net ${n} on the board`)
  if (!input.ports.length) throw new SetupError('give at least one port')
  if (!stackupKnown(b)) throw new SetupError('the board\'s stackup lacks layer thicknesses (KiCad Board Setup > Physical Stackup): the model needs them')
  if (!(input.fstop > 0)) throw new SetupError('fstop must be positive')
  const allNets = [...new Set([...Object.keys({ ...b.pads, ...b.segments, ...b.vias }), ...g.zones.map((z) => z.net).filter((x): x is string => x !== null)])]
  const refs = input.reference_nets ?? allNets.filter(isGround).sort()
  if (!input.reference_nets) choices.push(`reference nets: ${refs.join(', ') || 'none found'} (ground nets by name)`)
  const include = new Set(input.include_other_copper ? allNets : [...input.nets, ...refs])

  // region
  let region = input.region
  if (!region) {
    const m = input.region_margin_mm ?? 3
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    const add = (x: number, y: number, r: number): void => {
      x0 = Math.min(x0, x - r)
      y0 = Math.min(y0, y - r)
      x1 = Math.max(x1, x + r)
      y1 = Math.max(y1, y + r)
    }
    for (const n of input.nets) {
      for (const s of b.segments[n] ?? []) {
        add(s[0], s[1], s[4] / 2)
        add(s[2], s[3], s[4] / 2)
      }
      for (const p of b.pads[n] ?? []) add(p.x, p.y, Math.max(p.w, p.h) / 2)
      for (const v of b.vias[n] ?? []) add(v[0], v[1], v[2] / 2)
    }
    region = { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m }
    if (b.outline) {
      region = { x0: Math.max(region.x0, b.outline.min_x_mm), y0: Math.max(region.y0, b.outline.min_y_mm), x1: Math.min(region.x1, b.outline.max_x_mm), y1: Math.min(region.y1, b.outline.max_y_mm) }
    }
    choices.push(`region: the nets' copper + ${m} mm, inside the board outline`)
  }
  const { x0, y0, x1, y1 } = region
  if (!(x1 > x0 && y1 > y0)) throw new SetupError('the region is empty')

  // stackup: z of each copper layer, bottom copper at z = 0
  const n = b.layers.length
  const zOf: number[] = new Array<number>(n).fill(0)
  for (let k = n - 2; k >= 0; k--) zOf[k] = (zOf[k + 1] as number) + ((b.layers[k]?.below?.[0] ?? 0) * 1e3)
  const dielectrics: Model['dielectrics'] = []
  const dSummary: Summary['dielectrics'] = []
  let erMax = 1
  for (let k = 0; k < n - 1; k++) {
    const L = b.layers[k] as Board['layers'][number]
    const assumed: string[] = []
    let er = L.below?.[1] ?? null
    if (er === null) {
      er = 4.5
      assumed.push('epsilon_r 4.5')
    }
    let tand = g.lossTangent[k] ?? null
    if (tand === null) {
      tand = 0.02
      assumed.push('loss tangent 0.02')
    }
    if (assumed.length) warnings.push(`dielectric below ${L.name}: assumed ${assumed.join(', ')}`)
    erMax = Math.max(erMax, er)
    const z0 = zOf[k + 1] as number
    const z1 = zOf[k] as number
    dielectrics.push({ z0: r4(z0), z1: r4(z1), er, tand })
    dSummary.push({ z0_mm: r4(z0), z1_mm: r4(z1), er, tand, assumed })
  }
  const zTop = zOf[0] as number
  const layerZ = (name: string): number => {
    const L = b.layers.find((l) => l.name === name)
    if (!L) throw new SetupError(`${name} is not a copper layer`)
    return zOf[L.index] as number
  }

  // copper
  const polys = new Map<string, Poly[]>(b.layers.map((l) => [l.name, []]))
  const fixedX: number[] = []
  const fixedY: number[] = []
  let wMin = Infinity
  const cut: string[] = []
  for (const [net, segs] of Object.entries(b.segments)) {
    if (!include.has(net)) continue
    for (const [sx1, sy1, sx2, sy2, w, layer] of segs) {
      const c = clipSegment(sx1, sy1, sx2, sy2, x0, y0, x1, y1)
      if (!c) continue
      const [a1, b1, a2, b2] = c
      if (!isGround(net) && !refs.includes(net) && (Math.hypot(a1 - sx1, b1 - sy1) > 1e-6 || Math.hypot(a2 - sx2, b2 - sy2) > 1e-6)) cut.push(`${net} at (${r4(Math.hypot(a1 - sx1, b1 - sy1) > 1e-6 ? a1 : a2)}, ${r4(Math.hypot(a1 - sx1, b1 - sy1) > 1e-6 ? b1 : b2)})`)
      const list = polys.get(layer)
      if (!list) continue
      list.push(segPoly(a1, b1, a2, b2, w))
      if (Math.hypot(a1 - sx1, b1 - sy1) < 1e-6) list.push(octagon(a1, b1, w / 2))
      if (Math.hypot(a2 - sx2, b2 - sy2) < 1e-6) list.push(octagon(a2, b2, w / 2))
      if (input.nets.includes(net)) wMin = Math.min(wMin, w)
      if (Math.abs(a1 - a2) < 1e-6) fixedX.push(a1 - w / 2, a1 + w / 2)
      if (Math.abs(b1 - b2) < 1e-6) fixedY.push(b1 - w / 2, b1 + w / 2)
    }
  }
  for (const [net, pads] of Object.entries(b.pads)) {
    if (!include.has(net)) continue
    for (const p of pads) {
      const px0 = Math.max(p.x - p.w / 2, x0)
      const py0 = Math.max(p.y - p.h / 2, y0)
      const px1 = Math.min(p.x + p.w / 2, x1)
      const py1 = Math.min(p.y + p.h / 2, y1)
      if (px1 <= px0 || py1 <= py0) continue
      for (const ly of p.layers) polys.get(ly)?.push(rectPoly(px0, py0, px1, py1))
      fixedX.push(px0, px1)
      fixedY.push(py0, py1)
    }
  }
  for (const z of g.zones) {
    if (z.keepout || !z.net || !include.has(z.net)) continue
    for (const p of z.polygons) {
      const c = clipToBox(p, x0, y0, x1, y1)
      if (c.length >= 3) polys.get(z.layer)?.push(c)
    }
    if (!z.filled) warnings.push(`zone ${z.name ?? z.net} on ${z.layer} is not filled: its outline was used (refill zones in KiCad)`)
  }
  const vias: Model['vias'] = []
  for (const [net, vs] of Object.entries(b.vias)) {
    if (!include.has(net)) continue
    for (const [vx, vy, size, drill, top, bot] of vs) {
      if (vx < x0 || vx > x1 || vy < y0 || vy > y1) continue
      vias.push([r4(vx), r4(vy), r4(layerZ(top)), r4(layerZ(bot)), r4((drill ?? size * 0.5) / 2)])
      polys.get(top)?.push(octagon(vx, vy, size / 2))
      polys.get(bot)?.push(octagon(vx, vy, size / 2))
      fixedX.push(vx)
      fixedY.push(vy)
    }
  }
  if (cut.length) warnings.push(`tracks cut by the region boundary end open there (no port): ${cut.slice(0, 8).join('; ')}${cut.length > 8 ? ` … ${cut.length} in all` : ''}`)

  // ports
  const ports: Model['ports'] = []
  const pSummary: Summary['ports'] = []
  const portZ0 = input.ports[0]?.z0 ?? 50
  input.ports.forEach((p, k) => {
    const z0 = p.z0 ?? 50
    if (z0 !== portZ0) warnings.push('ports have different impedances: the Touchstone file uses port 1\'s')
    let x: number
    let y: number
    let w = p.width_mm ?? 0.5
    let h = p.width_mm ?? 0.5
    let layer = p.layer
    if (typeof p.at === 'string') {
      const pad = padAt(b, p.at)
      x = pad.x
      y = pad.y
      w = pad.w
      h = pad.h
      layer ??= pad.layers[0]
    } else [x, y] = p.at
    if (!layer) throw new SetupError(`port ${k + 1}: give layer`)
    if (x < x0 || x > x1 || y < y0 || y > y1) throw new SetupError(`port ${k + 1} at (${x}, ${y}) is outside the region`)
    const L = b.layers.find((l) => l.name === layer)
    if (!L) throw new SetupError(`port ${k + 1}: ${layer} is not a copper layer`)
    let refLayer = p.ref_layer
    if (!refLayer) {
      // the nearest copper layer with a reference zone (or reference copper) under the port
      const cands = b.layers.filter((l) => l.name !== layer && g.zones.some((z) => z.layer === l.name && z.net !== null && refs.includes(z.net)))
      cands.sort((a, c) => Math.abs(a.index - L.index) - Math.abs(c.index - L.index))
      refLayer = cands[0]?.name
      if (!refLayer) throw new SetupError(`port ${k + 1}: no reference plane found (give ref_layer)`)
      choices.push(`port ${k + 1}: reference layer ${refLayer} (nearest layer with a reference zone)`)
    }
    if (typeof p.at === 'string' && padAt(b, p.at).layers.includes(refLayer)) {
      throw new SetupError(`port ${k + 1} at ${p.at}: a through-hole pad has its own copper on ${refLayer}, which would short a lumped port to itself; give a point on the track beside the pad ("at": [x, y]) or an MSL port`)
    }
    const zs = layerZ(layer)
    const zr = layerZ(refLayer)
    const name = p.name ?? (typeof p.at === 'string' ? p.at : `P${k + 1}`)
    if ((p.type ?? 'lumped') === 'lumped') {
      ports.push({ type: 'lumped', z0, name, start: [r4(x - w / 2), r4(y - h / 2), r4(zr)], stop: [r4(x + w / 2), r4(y + h / 2), r4(zs)] })
      fixedX.push(x - w / 2, x + w / 2)
      fixedY.push(y - h / 2, y + h / 2)
    } else {
      const dir = p.direction
      if (!dir) throw new SetupError(`port ${k + 1}: an MSL port needs direction (x+, x-, y+ or y-: the way the line runs into the structure)`)
      const len = p.length_mm ?? 5
      const ww = p.width_mm ?? (b.segments[input.nets[0] as string]?.[0]?.[4] ?? 0.5)
      const ax = dir[0] as 'x' | 'y'
      const sgn = dir[1] === '+' ? 1 : -1
      // start is the outer end, stop is toward the structure (openEMS examples' convention), z from strip to plane
      const start = ax === 'x' ? [x - sgn * len, y - ww / 2, zs] : [x - ww / 2, y - sgn * len, zs]
      const stop = ax === 'x' ? [x, y + ww / 2, zr] : [x + ww / 2, y, zr]
      ports.push({ type: 'msl', z0, name, start: start.map(r4), stop: stop.map(r4), dir: ax, feed_shift: r4(len / 4), meas_shift: r4(len / 2) })
      polys.get(layer)?.push(rectPoly(Math.min(start[0] as number, stop[0] as number), Math.min(start[1] as number, stop[1] as number), Math.max(start[0] as number, stop[0] as number), Math.max(start[1] as number, stop[1] as number)))
      fixedX.push(start[0] as number, stop[0] as number)
      fixedY.push(start[1] as number, stop[1] as number)
    }
    pSummary.push({ name, type: p.type ?? 'lumped', z0, at_mm: [r4(x), r4(y)], layer, ref_layer: refLayer })
  })

  // margins, mesh
  const cpw = input.cells_per_wavelength ?? 20
  const lambdaMin = (C0 / input.fstop) * 1e3 // mm
  const air = input.max_cell_mm ?? lambdaMin / cpw
  let fine = Math.min(lambdaMin / (cpw * Math.sqrt(erMax)), Number.isFinite(wMin) ? wMin / 2 : Infinity, air)
  if (input.max_cell_mm) fine = Math.min(fine, input.max_cell_mm)
  if (input.fine_cell_mm) {
    fine = input.fine_cell_mm
    if (Number.isFinite(wMin) && fine > wMin / 2) warnings.push(`fine_cell_mm ${fine} is more than half the narrowest track (${r4(wMin)} mm): its impedance is less accurate${fine > wMin ? ', and a track narrower than a cell may be lost on the grid' : ''}`)
  }
  const thick = zTop
  let margin = input.margin_mm ?? Math.max(5, 8 * thick)
  let marginReason = input.margin_mm !== undefined ? 'given' : `S-parameters: max(5 mm, 8 x board thickness ${r4(thick)} mm)`
  const ffFreqs = farFieldFrequencies(input, warnings)
  if (ffFreqs.length && input.margin_mm === undefined) {
    const want = (C0 / Math.min(...ffFreqs)) * 1e3 / 4
    if (want > margin) {
      margin = Math.min(want, 1000)
      marginReason = `radiated: lambda/4 at ${(Math.min(...ffFreqs) / 1e6).toPrecision(4)} MHz${want > 1000 ? ` (capped at 1 m: below ${(C0 / 4 / 1e6).toPrecision(3)} MHz the PML is nearer than lambda/4)` : ''}`
      if (want > 1000) warnings.push(`the far-field box is nearer than lambda/4 below ${(C0 / 4 / 1e6).toPrecision(3)} MHz: low-frequency far-field results are less accurate`)
    }
  }
  const boundaryKind = input.boundary ?? 'pml'
  const pml = boundaryKind === 'pml' ? 8 : 0
  const grading = input.grading ?? 1.4
  const xs = axisLines(fixedX, x0, x1, x0 - margin, x1 + margin, fine, air, grading, pml)
  const ys = axisLines(fixedY, y0, y1, y0 - margin, y1 + margin, fine, air, grading, pml)
  const cpd = input.cells_per_dielectric ?? 4
  const zCore: number[] = []
  for (let k = n - 1; k >= 0; k--) {
    const z = zOf[k] as number
    if (k < n - 1) {
      const zb = zOf[k + 1] as number
      const nz = Math.max(cpd, Math.ceil((z - zb) / fine))
      for (let j = 1; j < nz; j++) zCore.push(r4(zb + ((z - zb) * j) / nz))
    }
    zCore.push(r4(z))
  }
  const dz = Math.min(fine, ...dielectrics.map((d) => (d.z1 - d.z0) / cpd))
  const zs = axisLines(zCore, 0, zTop, -margin, zTop + margin, dz, air, grading, pml).filter((v, i, a) => i === 0 || v - (a[i - 1] as number) > 1e-6)
  const steps = (v: number[]): number[] => v.slice(1).map((x, i) => x - (v[i] as number))
  const sx = steps(xs)
  const sy = steps(ys)
  const sz = steps(zs)
  const cells = sx.length * sy.length * sz.length
  const dmin = [Math.min(...sx), Math.min(...sy), Math.min(...sz)].map((v) => v * 1e-3)
  const dt = 1 / (C0 * Math.sqrt(dmin.reduce((s, v) => s + 1 / (v * v), 0)))
  const fc = input.fstop / 2
  const pulse = (2 * 9) / (2 * Math.PI * fc)
  const diag = Math.hypot((xs[xs.length - 1] as number) - (xs[0] as number), (ys[ys.length - 1] as number) - (ys[0] as number), (zs[zs.length - 1] as number) - (zs[0] as number)) * 1e-3
  const nrTs = input.nr_ts ?? 1_000_000
  const tsEst = Math.min(nrTs, Math.ceil((pulse + (5 * diag * Math.sqrt(erMax)) / C0) / dt))
  const excite = input.excite ?? 'all'
  const excitations = excite === 'all' ? ports.length : 1
  const mcps = Number(process.env.TRACE_OPENEMS_MCPS ?? 50)
  const timeEst = (cells * tsEst * excitations) / (mcps * 1e6)
  const points = input.points ?? 500
  const df = input.fstop / points
  const freqs = Array.from({ length: points }, (_, k) => Number(((k + 1) * df).toPrecision(12)))
  const radius = input.radiated?.distance_m ?? 3
  const centre = [((x0 + x1) / 2) * 1e-3, ((y0 + y1) / 2) * 1e-3, (zTop / 2) * 1e-3]

  const layers: LayerOut[] = b.layers.map((l, k) => ({ name: l.name, z: r4(zOf[k] as number), t_m: l.t ?? 35e-6, polygons: (polys.get(l.name) ?? []).map(toArrays) }))
  // the trace's effective permittivity for TDR distance: microstrip-ish average when the port is on an outer layer
  const p0 = pSummary[0]
  const L0 = p0 ? b.layers.find((l) => l.name === p0.layer) : undefined
  const erEff = L0 ? (L0.outer ? ((L0.index === 0 ? (L0.below?.[1] ?? 4.5) : (L0.above?.[1] ?? 4.5)) + 1) / 2 : (L0.below?.[1] ?? L0.above?.[1] ?? 4.5)) : null

  const model: Model = {
    title: `${b.path} nets ${input.nets.join(',')}`,
    board_box: [r4(x0), r4(y0), r4(x1), r4(y1)],
    mesh: { x: xs, y: ys, z: zs },
    dielectrics, layers, vias, ports,
    boundary: new Array<string>(6).fill(boundaryKind === 'pml' ? 'PML_8' : 'MUR'),
    f0: fc, fc, f_loss: input.fstop / 2, sigma: 5.8e7, freqs, excite, nr_ts: nrTs,
    end_criteria: 10 ** ((input.end_criteria_db ?? -40) / 10), threads: input.threads ?? 0, er_eff: erEff,
    nf2ff: ffFreqs.length > 0, ff_freqs: ffFreqs, ff_radius_m: radius, ff_center_m: centre.map((v) => Number(v.toPrecision(8))), keep: input.keep_fields ?? false,
  }
  choices.push(`excitation: Gaussian pulse f0 = fc = ${fc.toExponential(3)} Hz (0 to fstop)`)
  choices.push(`end criterion: energy ${input.end_criteria_db ?? -40} dB below its peak, at most ${nrTs} timesteps`)
  choices.push(`copper: conducting sheets, sigma 5.8e7 S/m, each layer's thickness; dielectric loss tangent exact at ${(input.fstop / 2).toExponential(3)} Hz`)
  const summary: Summary = {
    region_mm: [r4(x0), r4(y0), r4(x1), r4(y1)],
    nets: input.nets, reference_nets: refs,
    boundary: { kind: boundaryKind === 'pml' ? 'PML_8 on all faces' : 'MUR (first-order absorbing) on all faces', margin_mm: r4(margin), margin_reason: marginReason, pml_cells: pml },
    mesh: {
      nx: xs.length, ny: ys.length, nz: zs.length, cells,
      min_cell_mm: [r4(Math.min(...sx)), r4(Math.min(...sy)), r4(Math.min(...sz))], max_cell_mm: [r4(Math.max(...sx)), r4(Math.max(...sy)), r4(Math.max(...sz))],
      fine_cell_mm: r4(fine), air_cell_mm: r4(air),
      reason: `fine = min(lambda_min/(${cpw} sqrt(er ${erMax})) = ${r4(lambdaMin / (cpw * Math.sqrt(erMax)))} mm, narrowest track/2 = ${Number.isFinite(wMin) ? r4(wMin / 2) : '-'} mm); air = lambda_min/${cpw}; grading ${grading}; ${cpd} cells per dielectric`,
    },
    timestep_s: Number(dt.toPrecision(4)), timesteps_est: tsEst,
    memory_mb_est: Math.round((cells * 72 * 1.5) / 1e6),
    time_s_est: Math.round(timeEst),
    time_assumption: `${mcps} million cell-updates per second (TRACE_OPENEMS_MCPS), ${excitations} excitation(s); pulse + 5 domain transits (a resonant structure rings far longer)`,
    excitations,
    ports: pSummary,
    stackup: b.layers.map((l, k) => ({ layer: l.name, z_mm: r4(zOf[k] as number) })),
    dielectrics: dSummary,
    copper: layers.map((l) => ({ layer: l.name, polygons: l.polygons.length })),
    vias: vias.length,
    frequencies: { start: input.fstart ?? df, stop: input.fstop, points, df },
    ...(ffFreqs.length ? { far_field: { frequencies: ffFreqs, radius_m: radius, note: 'NF2FF box inside the PML; far field at radius_m, maximum over theta/phi in 5 degree steps' } } : {}),
    warnings, choices,
  }
  return { model, summary }
}

function farFieldFrequencies(input: SetupInput, warnings: string[]): number[] {
  const r = input.radiated
  if (!r) return []
  const maxN = r.max_frequencies ?? 12
  if (r.frequencies?.length) return [...r.frequencies].sort((a, b) => a - b).filter((f) => f <= input.fstop)
  if (!r.drive) return []
  const p: Trapezoid = { amplitude: r.drive.amplitude_v, freq: r.drive.freq_hz, duty: r.drive.duty, rise: r.drive.rise_s }
  const hs = harmonics(p, 30e6, input.fstop).filter((h) => h.amplitude > 0)
  if (!hs.length) {
    warnings.push('no harmonic of the drive between 30 MHz and fstop: no far-field frequencies')
    return []
  }
  // the strongest harmonics by envelope, spread over the band: keep the `maxN` largest amplitudes
  return hs.sort((a, b) => b.amplitude - a.amplitude).slice(0, maxN).map((h) => h.f).sort((a, b) => a - b)
}
