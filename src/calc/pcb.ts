/**
 * Printed-circuit copper: trace width for a current (IPC-2221), via current, resistance, thermal resistance,
 * inductance and capacitance, and controlled impedance (closed forms, or the 2D field solver in fieldsolve.ts).
 *
 * Lengths are in metres throughout; copper weight is in ounces per square foot (1 oz = 34.79 um, IPC-2221B
 * table 6-1 rounds it to 35 um / 1.37 mil, which is used here). Results carry both SI values and the mil/mm
 * figures PCB people read.
 */
import { eng, opt, rhoCu, K_CU, ToolError, val, type Result, type Val, type Out } from './common.js'
import * as FS from './fieldsolve.js'

const MIL = 25.4e-6
const OZ_M = 35e-6           // 1 oz/ft^2 copper, IPC-2221B table 6-1 (1.37 mil)
const ETA0 = FS.ETA0

// ---------------------------------------------------------------------------------------------- trace width
/**
 * IPC-2221B section 6.2 (the chart of IPC-2221 figure 6-4, as its curve fit): I = k dT^0.44 A^0.725, I in A, dT in
 * C, A in mil^2; k = 0.048 for external layers and 0.024 for internal layers. Valid within the chart (up to 35 A,
 * 400 mil wide, 10 to 100 C rise, 0.5 to 3 oz).
 */
export const ipc2221Current = (areaMil2: number, rise: number, internal: boolean): number =>
  (internal ? 0.024 : 0.048) * rise ** 0.44 * areaMil2 ** 0.725
export const ipc2221Area = (current: number, rise: number, internal: boolean): number =>
  (current / ((internal ? 0.024 : 0.048) * rise ** 0.44)) ** (1 / 0.725)

export interface TraceWidthArgs {
  current?: Val | undefined
  width?: Val | undefined
  temp_rise: Val
  copper_oz?: Val | undefined
  layer: 'external' | 'internal'
  ambient?: Val | undefined
  length?: Val | undefined
}

/**
 * Width for a current (or the current a width carries) at a temperature rise, from IPC-2221B 6.2. With `length`,
 * also the trace's resistance at ambient + rise (copper resistivity 1.724e-8 ohm m at 20 C, +0.393 %/C, IEC 60028),
 * its voltage drop and dissipation at that current.
 */
export function traceWidth(a: TraceWidthArgs): Result {
  const internal = a.layer === 'internal'
  const rise = val('temp_rise', a.temp_rise)
  const oz = val('copper_oz', a.copper_oz ?? 1)
  const t = oz * OZ_M
  const tMil = t / MIL
  const amb = val('ambient', a.ambient ?? 25, { positive: false })
  const iIn = opt('current', a.current)
  const wIn = opt('width', a.width)
  if ((iIn === undefined) === (wIn === undefined)) throw new ToolError('trace_width: give exactly one of current, width')
  let i: number
  let w: number
  if (iIn !== undefined) {
    i = iIn
    w = (ipc2221Area(i, rise, internal) / tMil) * MIL
  } else {
    w = wIn as number
    i = ipc2221Current((w / MIL) * tMil, rise, internal)
  }
  const temp = amb + rise
  const rPerM = rhoCu(temp) / (w * t)
  const out: Out = {
    layer: a.layer, current_a: i, width_m: w, width_mm: w * 1e3, width_mil: w / MIL, thickness_m: t, copper_oz: oz,
    temp_rise_c: rise, copper_temp_c: temp, area_mil2: (w / MIL) * tMil, resistance_per_m_ohm: rPerM,
    in_chart_range: i <= 35 && w / MIL <= 400 && rise >= 10 && rise <= 100 && oz >= 0.5 && oz <= 3,
  }
  let tail = ''
  const len = opt('length', a.length)
  if (len !== undefined) {
    const r = rPerM * len
    out.length_m = len
    out.resistance_ohm = r
    out.voltage_drop_v = r * i
    out.power_w = i * i * r
    tail = `; over ${eng(len, 'm')}: ${eng(r, 'Ω')}, drop ${eng(r * i, 'V')}, ${eng(i * i * r, 'W')}`
  }
  return {
    ...out,
    summary: `${(w / MIL).toFixed(1)} mil (${(w * 1e3).toFixed(3)} mm) ${a.layer} ${oz} oz carries ${eng(i, 'A')} at ${rise} °C rise${tail}`,
  }
}

// ---------------------------------------------------------------------------------------------- via
export interface ViaArgs {
  drill: Val
  plating?: Val | undefined
  length: Val
  temp_rise?: Val | undefined
  layer?: 'external' | 'internal' | undefined
  temperature?: Val | undefined
  pad?: Val | undefined
  antipad?: Val | undefined
  er?: Val | undefined
  current?: Val | undefined
}

/**
 * One plated via: finished hole `drill`, barrel plating thickness `plating` (IPC-6012 class 2 minimum average is
 * 20 um, the default), barrel length `length` (usually the board thickness).
 *
 *   barrel cross-section A = pi/4 ((d + 2t)^2 - d^2), current from IPC-2221B 6.2 treating the barrel as a conductor
 *   of that area (internal k by default, the conservative choice for a barrel enclosed in laminate);
 *   resistance R = rho L / A; thermal resistance theta = L / (k_Cu A);
 *   inductance, Howard Johnson & Graham, High-Speed Digital Design (1993), section 7.2: L = 5.08 h (ln(4h/d) + 1) nH,
 *   h, d in inches; and Goldfarb & Pucel, "Modeling via hole grounds in microstrip", IEEE MGWL 1991:
 *   L = mu0/(2 pi) (h ln((h + sqrt(r^2 + h^2))/r) + 1.5 (r - sqrt(r^2 + h^2)));
 *   capacitance (with pad and antipad), Johnson & Graham section 7.2: C = 1.41 er T D1/(D2 - D1) pF, inches.
 */
export function via(a: ViaArgs): Result {
  const d = val('drill', a.drill)
  const t = val('plating', a.plating ?? 20e-6)
  const h = val('length', a.length)
  const rise = val('temp_rise', a.temp_rise ?? 10)
  const internal = (a.layer ?? 'internal') === 'internal'
  const temp = val('temperature', a.temperature ?? 25 + rise, { positive: false })
  const area = (Math.PI / 4) * ((d + 2 * t) ** 2 - d * d)
  const areaMil2 = area / (MIL * MIL)
  const imax = ipc2221Current(areaMil2, rise, internal)
  const r = (rhoCu(temp) * h) / area
  const theta = h / (K_CU * area)
  const hi = h / 0.0254
  const di = d / 0.0254
  const lJohnson = 5.08e-9 * hi * (Math.log((4 * hi) / di) + 1)
  const rr = d / 2
  const sq = Math.sqrt(rr * rr + h * h)
  const lGP = (FS.MU0 / (2 * Math.PI)) * (h * Math.log((h + sq) / rr) + 1.5 * (rr - sq))
  const out: Out = {
    drill_m: d, plating_m: t, length_m: h, barrel_area_m2: area, barrel_area_mil2: areaMil2, temp_rise_c: rise,
    max_current_a: imax, resistance_ohm: r, thermal_resistance_c_per_w: theta, inductance_johnson_h: lJohnson,
    inductance_goldfarb_pucel_h: lGP,
  }
  const pad = opt('pad', a.pad)
  const anti = opt('antipad', a.antipad)
  if (pad !== undefined && anti !== undefined) {
    if (anti <= pad) throw new ToolError('antipad: must be larger than pad')
    const er = val('er', a.er ?? 4.4)
    out.capacitance_f = 1.41e-12 * er * hi * (pad / 0.0254) / (anti / 0.0254 - pad / 0.0254)
  }
  const i = opt('current', a.current)
  if (i !== undefined) {
    out.vias_needed = Math.ceil(i / imax)
    out.voltage_drop_v = i * r
    out.power_w = i * i * r
  }
  return {
    ...out,
    summary: `via ${eng(d, 'm')} drill, ${eng(t, 'm')} plating: ${eng(imax, 'A')} at ${rise} °C rise, ${eng(r, 'Ω')}, ${theta.toFixed(0)} °C/W, ${eng(lJohnson, 'H')}`
      + (out.vias_needed !== undefined ? `; ${out.vias_needed as number} needed for ${eng(i as number, 'A')}` : ''),
  }
}

// ---------------------------------------------------------------------------------------------- impedance
/** Hammerstad-Jensen zero-thickness microstrip impedance of air line, Z01(u) (Hammerstad & Jensen, "Accurate models
 * for microstrip computer-aided design", IEEE MTT-S Digest 1980, eq. 1-2). */
function hjZ01(u: number): number {
  const f = 6 + (2 * Math.PI - 6) * Math.exp(-((30.666 / u) ** 0.7528))
  return (ETA0 / (2 * Math.PI)) * Math.log(f / u + Math.sqrt(1 + (2 / u) ** 2))
}
/** Hammerstad-Jensen effective permittivity (1980, eq. 3-5). */
function hjEe(u: number, er: number): number {
  const a = 1 + Math.log((u ** 4 + (u / 52) ** 2) / (u ** 4 + 0.432)) / 49 + Math.log(1 + (u / 18.1) ** 3) / 18.7
  const b = 0.564 * ((er - 0.9) / (er + 3)) ** 0.053
  return (er + 1) / 2 + ((er - 1) / 2) * (1 + 10 / u) ** (-a * b)
}

/** Hammerstad-Jensen microstrip with their strip-thickness correction (1980, eq. 6-8). Returns [Z0, er_eff]. */
export function microstripHJ(w: number, h: number, t: number, er: number): [number, number] {
  const u = w / h
  let u1 = u
  let ur = u
  if (t > 0) {
    const t1 = t / h
    const coth = 1 / Math.tanh(Math.sqrt(6.517 * u))
    const du1 = (t1 / Math.PI) * Math.log(1 + (4 * Math.E) / (t1 * coth * coth))
    const dur = 0.5 * (1 + 1 / Math.cosh(Math.sqrt(er - 1))) * du1
    u1 = u + du1
    ur = u + dur
  }
  const ee = hjEe(ur, er) * (hjZ01(u1) / hjZ01(ur)) ** 2
  // ee = ee(ur) (Z01(u1)/Z01(ur))^2 and Z0 = Z01(u1)/sqrt(ee) = Z01(ur)/sqrt(ee(ur)) (1980, eq. 7-8)
  return [hjZ01(ur) / Math.sqrt(hjEe(ur, er)), ee]
}

/** IPC-2141A surface microstrip: Z0 = 87/sqrt(er + 1.41) ln(5.98 h / (0.8 w + t)), 0.1 < w/h < 2.0. */
export const microstripIPC = (w: number, h: number, t: number, er: number): number =>
  (87 / Math.sqrt(er + 1.41)) * Math.log((5.98 * h) / (0.8 * w + t))

/**
 * IPC-2141A embedded microstrip: the surface form with er' = er (1 - exp(-1.55 H1/h)), H1 the dielectric height from
 * the plane to the top of the covering dielectric; Z0 = 60/sqrt(er') ln(5.98 h / (0.8 w + t)).
 */
export function embeddedIPC(w: number, h: number, t: number, er: number, cover: number): [number, number] {
  const ere = er * (1 - Math.exp((-1.55 * cover) / h))
  return [(60 / Math.sqrt(ere)) * Math.log((5.98 * h) / (0.8 * w + t)), ere]
}

/** IPC-2141A symmetric stripline: Z0 = 60/sqrt(er) ln(4 b / (0.67 pi (0.8 w + t))), b the plane spacing. */
export const striplineIPC = (w: number, b: number, t: number, er: number): number =>
  (60 / Math.sqrt(er)) * Math.log((4 * b) / (0.67 * Math.PI * (0.8 * w + t)))

/**
 * IPC-2141A asymmetric (offset) stripline: Z0 = 80/sqrt(er) ln(1.9 (2 h1 + t)/(0.8 w + t)) (1 - h1/(4 h2)), h1 the
 * dielectric between the trace and the nearer plane, h2 between the trace and the farther plane.
 */
export function asymStriplineIPC(w: number, h1: number, h2: number, t: number, er: number): number {
  const near = Math.min(h1, h2)
  const far = Math.max(h1, h2)
  return (80 / Math.sqrt(er)) * Math.log((1.9 * (2 * near + t)) / (0.8 * w + t)) * (1 - near / (4 * far))
}

/**
 * Edge-coupled differential impedance, the IPC-2141A / National Semiconductor AN-905 approximations (they treat
 * coupling as an exponential correction to 2 Z0, good to a few percent for s/h above ~0.3):
 *   microstrip Zdiff = 2 Z0 (1 - 0.48 exp(-0.96 s/h)); stripline Zdiff = 2 Z0 (1 - 0.347 exp(-2.9 s/b)).
 */
export const diffMicrostrip = (z0: number, s: number, h: number): number => 2 * z0 * (1 - 0.48 * Math.exp((-0.96 * s) / h))
export const diffStripline = (z0: number, s: number, b: number): number => 2 * z0 * (1 - 0.347 * Math.exp((-2.9 * s) / b))

export type Structure = 'microstrip' | 'embedded_microstrip' | 'stripline' | 'asymmetric_stripline'

export interface ImpedanceArgs {
  structure: Structure
  differential?: boolean | undefined
  width?: Val | undefined
  target_z0?: Val | undefined
  gap?: Val | undefined
  height: Val
  height2?: Val | undefined
  thickness?: Val | undefined
  er: Val
  er2?: Val | undefined
  cover?: Val | undefined
  mask_thickness?: Val | undefined
  mask_er?: Val | undefined
  mode?: 'closed_form' | 'fieldsolve' | undefined
  grid?: Val | undefined
}

interface Geo {
  structure: Structure
  diff: boolean
  s: number | undefined
  h: number
  h2: number | undefined
  t: number
  er: number
  er2: number | undefined
  cover: number | undefined
  mask: readonly [number, number] | undefined
}

interface ZResult { z: number; z0: number; er_eff: number | null; delay_s_per_m: number | null; zodd?: number; zeven?: number; zcomm?: number; method: string }

/** Closed-form impedance of one geometry at width w. */
function closedForm(g: Geo, w: number): ZResult {
  let z0: number
  let ee: number | null = null
  let method: string
  let b = g.h
  switch (g.structure) {
    case 'microstrip': {
      ;[z0, ee] = microstripHJ(w, g.h, g.t, g.er)
      method = 'Hammerstad-Jensen 1980 with thickness correction'
      break
    }
    case 'embedded_microstrip': {
      if (g.cover === undefined) throw new ToolError('cover: required for embedded_microstrip (dielectric height from the plane to the top of the covering layer)')
      if (g.cover <= g.h + g.t) throw new ToolError('cover: must exceed height + thickness')
      ;[z0, ee] = embeddedIPC(w, g.h, g.t, g.er, g.cover)
      method = 'IPC-2141A embedded microstrip'
      break
    }
    case 'stripline': {
      // symmetric: height = plane-to-plane spacing b
      b = g.h
      z0 = striplineIPC(w, b, g.t, g.er)
      ee = g.er
      method = 'IPC-2141A symmetric stripline'
      break
    }
    case 'asymmetric_stripline': {
      if (g.h2 === undefined) throw new ToolError('height2: required for asymmetric_stripline (trace to the farther plane)')
      b = g.h + g.h2 + g.t
      z0 = asymStriplineIPC(w, g.h, g.h2, g.t, g.er)
      ee = g.er
      method = 'IPC-2141A asymmetric stripline'
      break
    }
  }
  const delay = ee === null ? null : Math.sqrt(ee) / FS.C0
  if (!g.diff) return { z: z0, z0, er_eff: ee, delay_s_per_m: delay, method }
  if (g.s === undefined) throw new ToolError('gap: required for a differential pair (edge-to-edge spacing)')
  const zd = g.structure === 'microstrip' || g.structure === 'embedded_microstrip' ? diffMicrostrip(z0, g.s, g.h) : diffStripline(z0, g.s, b)
  return { z: zd, z0, er_eff: ee, delay_s_per_m: delay, zodd: zd / 2, method: `${method}; edge-coupled pair per IPC-2141A/AN-905 exponential approximation` }
}

function section(g: Geo, w: number): FS.Section {
  const s = g.diff ? g.s : undefined
  if (g.diff && s === undefined) throw new ToolError('gap: required for a differential pair (edge-to-edge spacing)')
  switch (g.structure) {
    case 'microstrip':
      return FS.microstrip(w, g.t, g.h, g.er, s, g.mask)
    case 'embedded_microstrip':
      if (g.cover === undefined) throw new ToolError('cover: required for embedded_microstrip')
      return FS.embeddedMicrostrip(w, g.t, g.h, g.er, g.cover, g.er2, s)
    case 'stripline':
      // symmetric: the trace centred, height = plane spacing b
      return FS.stripline(w, g.t, (g.h - g.t) / 2, g.er, (g.h + g.t) / 2, g.er2, s)
    case 'asymmetric_stripline':
      if (g.h2 === undefined) throw new ToolError('height2: required for asymmetric_stripline')
      return FS.stripline(w, g.t, g.h, g.er, g.h2 + g.t, g.er2, s)
  }
}

function fieldSolved(g: Geo, w: number, dx: number): ZResult {
  const l = FS.solve(section(g, w), { dx })
  if (!g.diff) return { z: l.z0, z0: l.z0, er_eff: l.erEff, delay_s_per_m: l.delay, method: `2D finite-difference field solver, grid ${eng(dx, 'm')}` }
  return {
    z: l.zdiff, z0: l.z0, zodd: l.zodd, zeven: l.zeven, zcomm: l.zcomm, er_eff: l.erEff, delay_s_per_m: l.delay,
    method: `2D finite-difference field solver, grid ${eng(dx, 'm')}`,
  }
}

/**
 * Characteristic impedance of a trace or an edge-coupled pair; or, with target_z0 (the differential impedance for a
 * pair), the width that gives it, by bisection on log(width) (impedance falls monotonically with width).
 * Geometry: microstrip/embedded: height = dielectric from the plane to the trace's bottom face; stripline: height =
 * plane-to-plane spacing (trace centred); asymmetric: height = trace bottom to the nearer plane, height2 = trace top
 * to the farther plane.
 */
export function impedance(a: ImpedanceArgs): Result {
  const g: Geo = {
    structure: a.structure, diff: a.differential ?? false, s: opt('gap', a.gap), h: val('height', a.height), h2: opt('height2', a.height2),
    t: val('thickness', a.thickness ?? OZ_M, { allowZero: true }), er: val('er', a.er, { min: 1 }), er2: opt('er2', a.er2, { min: 1 }),
    cover: opt('cover', a.cover), mask: undefined,
  }
  if (a.mask_thickness !== undefined) {
    if (a.structure !== 'microstrip') throw new ToolError('mask_thickness: solder mask applies to surface microstrip only')
    g.mask = [val('mask_thickness', a.mask_thickness), val('mask_er', a.mask_er ?? 3.5, { min: 1 })]
  }
  const mode = a.mode ?? 'closed_form'
  if (mode === 'closed_form' && g.mask) throw new ToolError('mask_thickness: the closed forms do not model solder mask; use mode "fieldsolve"')
  if (mode === 'closed_form' && g.er2 !== undefined) throw new ToolError('er2: the closed forms take one dielectric; use mode "fieldsolve"')
  const dx = val('grid', a.grid ?? 2.5e-6)
  const calc = (w: number) => (mode === 'fieldsolve' ? fieldSolved(g, w, dx) : closedForm(g, w))
  const label = g.diff ? 'Zdiff' : 'Z0'
  const target = opt('target_z0', a.target_z0)
  let w: number
  let iterations = 0
  if (target === undefined) {
    w = val('width', a.width)
  } else {
    if (a.width !== undefined) throw new ToolError('impedance: give width or target_z0, not both')
    let lo = Math.log(Math.max(g.h * 0.01, 2 * dx))
    let hi = Math.log(g.h * 20)
    const zAt = (lw: number) => calc(Math.exp(lw)).z
    const zLo = zAt(lo)
    const zHi = zAt(hi)
    if (!(target <= zLo && target >= zHi)) {
      throw new ToolError(`target_z0: ${target} Ω is outside what this stackup reaches (${zHi.toFixed(1)} to ${zLo.toFixed(1)} Ω)`)
    }
    const tolW = mode === 'fieldsolve' ? 1e-3 : 1e-6
    while (hi - lo > tolW && iterations < 60) {
      const mid = (lo + hi) / 2
      if (zAt(mid) > target) lo = mid
      else hi = mid
      iterations++
    }
    w = Math.exp((lo + hi) / 2)
  }
  const r = calc(w)
  const out: Out = {
    structure: g.structure, differential: g.diff, mode, method: r.method, width_m: w, width_mil: w / MIL, gap_m: g.s ?? null,
    height_m: g.h, thickness_m: g.t, er: g.er, z0_ohm: r.z0, er_eff: r.er_eff, delay_s_per_m: r.delay_s_per_m,
    delay_ps_per_in: r.delay_s_per_m === null ? null : r.delay_s_per_m * 0.0254 * 1e12,
  }
  if (g.diff) {
    out.zdiff_ohm = r.z
    out.zodd_ohm = r.zodd ?? null
    if (r.zeven !== undefined) out.zeven_ohm = r.zeven
    if (r.zcomm !== undefined) out.zcomm_ohm = r.zcomm
  }
  if (target !== undefined) { out.target_ohm = target; out.bisection_steps = iterations }
  if (g.structure === 'stripline' && !g.diff && mode === 'closed_form') out.cohn_exact_zero_thickness_ohm = FS.striplineExact(w, g.h, g.er)
  return {
    ...out,
    summary: `${label} ${r.z.toFixed(2)} Ω at width ${(w / MIL).toFixed(2)} mil (${(w * 1e3).toFixed(4)} mm)${g.diff ? `, gap ${eng(g.s as number, 'm')}` : ''} [${mode}]`,
  }
}

