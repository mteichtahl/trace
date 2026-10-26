/**
 * Temperature measurement on the bench (thermal.measure, hardware: true) through the existing HIL plumbing
 * (src/tools/hil: the SCPI transports and the instrument and serial-port settings), and the comparison of measured
 * against predicted temperatures, with a calibration fit.
 *
 *   dmm_temp   the DMM's own temperature function: SCPI-99 CONF:TEMP <TC|RTD|FRTD|THER>,<type>; READ? (Keysight
 *              Truevolt 34465A/34470A and Keithley DMM6500 accept this form; the reading is in the instrument's
 *              unit, set to C with UNIT:TEMP C)
 *   dmm_rtd    a platinum RTD read as resistance (2- or 4-wire, the hil.dmm dialects' CONF:RES / CONF:FRES) and
 *              converted with Callendar-Van Dusen, IEC 60751:2008: R = R0 (1 + A T + B T^2 [+ C (T - 100) T^3, T < 0]),
 *              A = 3.9083e-3, B = -5.775e-7, C = -4.183e-12
 *   scpi       any instrument: commands, then a query whose reply is a temperature (scale and offset applied)
 *   serial     firmware telemetry: capture the port and take the last match of a regex's first group
 *   manual     a reading typed in (a hand-held thermocouple meter, an IR camera spot), with a note of how it was taken
 *
 * Calibration (Antmicro validated their models the same way, with heater elements at known power and K-type
 * thermocouples): with a heater at a stated power and the board model's run, the model is re-run with a multiplier
 * on its convective h until its mean predicted rise matches the measured mean rise; the multiplier is stored per
 * envelope (thermal_corrections) with both run ids. It folds every model error (h, emissivity, laminate) into one
 * number: it is a calibration of this board in this setup, not a measurement of h.
 */
import { z } from 'zod'
import { ToolError } from '../../core/registry.js'
import { instrument } from '../hil/resources.js'
import { withTransport, num as scpiNum } from '../hil/scpi.js'
import { capture, SerialSession } from '../hil/serial.js'
import { serialPort } from '../hil/resources.js'

export const IEC60751 = { A: 3.9083e-3, B: -5.775e-7, C: -4.183e-12 }

/** Temperature (deg C) of a platinum RTD from its resistance (IEC 60751 Callendar-Van Dusen). */
export function rtdTemperature(r: number, r0 = 100): number {
  const { A, B, C } = IEC60751
  const ratio = r / r0
  if (ratio >= 1) return (-A + Math.sqrt(A * A - 4 * B * (1 - ratio))) / (2 * B)
  let t = (ratio - 1) / A
  for (let i = 0; i < 50; i++) {
    const f = 1 + A * t + B * t * t + C * (t - 100) * t ** 3 - ratio
    const d = A + 2 * B * t + C * (4 * t ** 3 - 300 * t * t)
    const step = f / d
    t -= step
    if (Math.abs(step) < 1e-10) break
  }
  return t
}

const inst = { instrument: z.string().optional(), address: z.string().optional() }

export const PointSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual'), value_c: z.number(), note: z.string().optional().describe('how it was measured') }).strict(),
  z.object({ kind: z.literal('dmm_temp'), ...inst, sensor: z.enum(['TC', 'RTD', 'FRTD', 'THER']).default('TC'), type: z.string().default('K').describe('thermocouple type (K, J, T, …), RTD alpha (85), thermistor (5000)'), samples: z.number().int().min(1).max(100).default(3) }).strict(),
  z.object({ kind: z.literal('dmm_rtd'), ...inst, r0: z.number().positive().default(100), wires: z.union([z.literal(2), z.literal(4)]).default(4), samples: z.number().int().min(1).max(100).default(3) }).strict(),
  z.object({ kind: z.literal('scpi'), ...inst, commands: z.array(z.string()).default([]), query: z.string(), scale: z.number().default(1), offset: z.number().default(0) }).strict(),
  z.object({ kind: z.literal('serial'), serial: z.string().optional(), port: z.string().optional(), baud: z.number().int().positive().optional(), seconds: z.number().positive().max(600).default(5), regex: z.string().describe('a regex whose first group is the temperature in deg C, e.g. "T_U3=([-0-9.]+)"'), send: z.string().optional() }).strict(),
])
export type PointSource = z.output<typeof PointSource>

export interface Reading { value_c: number; samples: number[]; log: string[]; how: string }

export interface Readers {
  dmmTemp(s: Extract<PointSource, { kind: 'dmm_temp' }>): Promise<Reading>
  dmmRtd(s: Extract<PointSource, { kind: 'dmm_rtd' }>): Promise<Reading>
  scpi(s: Extract<PointSource, { kind: 'scpi' }>): Promise<Reading>
  serial(s: Extract<PointSource, { kind: 'serial' }>): Promise<Reading>
}

const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

export const hilReaders: Readers = {
  async dmmTemp(s) {
    const i = instrument(s.instrument, s.address, 'dmm')
    const log: string[] = []
    const samples = await withTransport(i.address, i.timeout_s * 1000, async (t) => {
      for (const c of ['UNIT:TEMP C', `CONF:TEMP ${s.sensor},${s.type}`]) { log.push(`> ${c}`); await t.write(c) }
      const out: number[] = []
      for (let k = 0; k < s.samples; k++) { const r = await t.query('READ?', Math.max(5000, i.timeout_s * 1000)); log.push(`< ${r}`); out.push(scpiNum(r)) }
      return out
    })
    return { value_c: avg(samples), samples, log, how: `${i.name}: CONF:TEMP ${s.sensor},${s.type}` }
  },
  async dmmRtd(s) {
    const i = instrument(s.instrument, s.address, 'dmm')
    const log: string[] = []
    const fn = s.wires === 4 ? 'FRES' : 'RES'
    const ohms = await withTransport(i.address, i.timeout_s * 1000, async (t) => {
      log.push(`> CONF:${fn} AUTO`)
      await t.write(`CONF:${fn} AUTO`)
      const out: number[] = []
      for (let k = 0; k < s.samples; k++) { const r = await t.query('READ?', Math.max(5000, i.timeout_s * 1000)); log.push(`< ${r}`); out.push(scpiNum(r)) }
      return out
    })
    const temps = ohms.map((r) => rtdTemperature(r, s.r0))
    return { value_c: avg(temps), samples: temps, log, how: `${i.name}: ${s.wires}-wire Pt${s.r0} (IEC 60751)` }
  },
  async scpi(s) {
    const i = instrument(s.instrument, s.address)
    const log: string[] = []
    const v = await withTransport(i.address, i.timeout_s * 1000, async (t) => {
      for (const c of s.commands) { log.push(`> ${c}`); await t.write(c) }
      const r = await t.query(s.query, Math.max(5000, i.timeout_s * 1000))
      log.push(`< ${r}`)
      return scpiNum(r) * s.scale + s.offset
    })
    return { value_c: v, samples: [v], log, how: `${i.name}: ${s.query}` }
  },
  async serial(s) {
    const cfg = serialPort(s.serial, s.port, s.baud)
    let re: RegExp
    try { re = new RegExp(s.regex, 'g') } catch (e) { throw new ToolError(`regex: ${e instanceof Error ? e.message : String(e)}`) }
    const ss = await SerialSession.open(cfg)
    try {
      const c = await capture(ss, s.seconds, undefined, s.send ? Buffer.from(s.send, 'utf8') : undefined)
      const text = c.data.toString('utf8')
      const values = [...text.matchAll(re)].map((m) => Number(m[1])).filter(Number.isFinite)
      if (!values.length) throw new ToolError(`serial: no match of ${s.regex} in ${c.data.length} bytes from ${ss.path}`)
      return { value_c: values[values.length - 1]!, samples: values, log: text.split('\n').slice(-20), how: `${ss.path}: /${s.regex}/` }
    } finally {
      await ss.close()
    }
  },
}

export async function read(s: PointSource, r: Readers = hilReaders): Promise<Reading> {
  switch (s.kind) {
    case 'manual': return { value_c: s.value_c, samples: [s.value_c], log: [], how: `manual${s.note ? `: ${s.note}` : ''}` }
    case 'dmm_temp': return r.dmmTemp(s)
    case 'dmm_rtd': return r.dmmRtd(s)
    case 'scpi': return r.scpi(s)
    case 'serial': return r.serial(s)
  }
}

export interface PointResult { name: string; ref?: string | undefined; measured_c: number; predicted_c: number | null; error_c: number | null; error_pct_of_rise: number | null; how: string }

/** Error statistics over the points that have a prediction (error = predicted - measured). */
export function errorStats(points: readonly PointResult[]): { n: number; mean_c: number | null; max_abs_c: number | null; rms_c: number | null } {
  const e = points.map((p) => p.error_c).filter((x): x is number => x !== null)
  if (!e.length) return { n: 0, mean_c: null, max_abs_c: null, rms_c: null }
  return { n: e.length, mean_c: avg(e), max_abs_c: Math.max(...e.map(Math.abs)), rms_c: Math.sqrt(avg(e.map((x) => x * x))) }
}

/**
 * The h multiplier that makes the model's mean rise match the measured mean rise, by bisection on log(multiplier)
 * in [0.1, 10]. `predict(mult)` re-runs the model and returns its predicted temperatures at the points.
 */
export async function fitMultiplier(measured: readonly number[], ambient: number, predict: (mult: number) => Promise<number[]>, o: { tolC?: number } = {}): Promise<{ multiplier: number; iterations: { multiplier: number; mean_predicted_rise_c: number }[]; mean_measured_rise_c: number; converged: boolean }> {
  const target = avg(measured.map((m) => m - ambient))
  if (!(target > 0)) throw new ToolError('calibration: the measured temperatures are not above the ambient')
  const iterations: { multiplier: number; mean_predicted_rise_c: number }[] = []
  const rise = async (m: number): Promise<number> => {
    const p = avg((await predict(m)).map((x) => x - ambient))
    iterations.push({ multiplier: m, mean_predicted_rise_c: p })
    return p
  }
  let lo = Math.log(0.1)
  let hi = Math.log(10)
  // rise falls as h grows
  if ((await rise(Math.exp(lo))) < target || (await rise(Math.exp(hi))) > target) {
    return { multiplier: NaN, iterations, mean_measured_rise_c: target, converged: false }
  }
  let mid = 0
  for (let k = 0; k < 40; k++) {
    mid = 0.5 * (lo + hi)
    const r = await rise(Math.exp(mid))
    if (Math.abs(r - target) < (o.tolC ?? 0.01)) break
    if (r > target) lo = mid
    else hi = mid
  }
  return { multiplier: Math.exp(mid), iterations, mean_measured_rise_c: target, converged: true }
}
