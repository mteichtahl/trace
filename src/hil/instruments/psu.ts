/**
 * Bench power supplies: set voltage and current limit, switch the output, measure, per channel.
 *
 * Dialects: Rigol DP800, Keysight/Agilent E36xx, Siglent SPD, R&S HMC and NGx, and a generic SCPI fallback.
 *
 * Safety, because a wrong set-point destroys a board:
 *   - a PSU's limits (max_voltage_v, max_current_a, tighter per channel) come from the project settings; a set-point
 *     above them is refused before anything is sent;
 *   - without both limits (an unconfigured PSU, or one reached by an ad-hoc address) set-points are refused and the
 *     output is never enabled; switching it off and measuring are always allowed;
 *   - before the output is enabled, the set-points the instrument actually holds are read back and checked, so a
 *     higher value left on the front panel is caught;
 *   - every result reports what the instrument says it is set to, read back, not what was asked for.
 */
import { ToolError } from '../../core/registry.js'
import { channelLimits, type Instrument } from '../resources.js'
import { num, type Transport } from '../scpi.js'
import { round, session, type DialectMatch } from './base.js'

export interface PsuDialect extends DialectMatch {
  /** commands sent before a per-channel command (e.g. INST:NSEL 2) */
  select(ch: number): string[]
  setVoltage(ch: number, v: number): string
  setCurrent(ch: number, a: number): string
  output(ch: number, on: boolean): string[]
  voltageSet(ch: number): string
  currentSet(ch: number): string
  /** null: the instrument cannot report its output state in plain SCPI */
  outputState(ch: number): string | null
  measureVoltage(ch: number): string
  measureCurrent(ch: number): string
}

const f = (v: number): string => String(round(v, 6))
const nsel = (ch: number): string[] => [`INST:NSEL ${ch}`]

export const PSU_DIALECTS: readonly PsuDialect[] = [
  {
    id: 'rigol-dp800', idn: /RIGOL.*,\s*DP8\d\d|^DP8\d\d/i,
    select: () => [],
    setVoltage: (ch, v) => `:SOUR${ch}:VOLT ${f(v)}`,
    setCurrent: (ch, a) => `:SOUR${ch}:CURR ${f(a)}`,
    output: (ch, on) => [`:OUTP CH${ch},${on ? 'ON' : 'OFF'}`],
    voltageSet: (ch) => `:SOUR${ch}:VOLT?`,
    currentSet: (ch) => `:SOUR${ch}:CURR?`,
    outputState: (ch) => `:OUTP? CH${ch}`,
    measureVoltage: (ch) => `:MEAS:VOLT? CH${ch}`,
    measureCurrent: (ch) => `:MEAS:CURR? CH${ch}`,
  },
  {
    // E3631A/E3646A/E36312A and the E36100/E36200/E36300 families all accept INST:NSEL
    id: 'keysight-e36', idn: /(AGILENT|KEYSIGHT|HEWLETT).*,\s*E36\d+|^E36\d+/i,
    select: nsel,
    setVoltage: (_ch, v) => `VOLT ${f(v)}`,
    setCurrent: (_ch, a) => `CURR ${f(a)}`,
    output: (ch, on) => [...nsel(ch), `OUTP ${on ? 'ON' : 'OFF'}`],
    voltageSet: () => 'VOLT?',
    currentSet: () => 'CURR?',
    outputState: () => 'OUTP?',
    measureVoltage: () => 'MEAS:VOLT?',
    measureCurrent: () => 'MEAS:CURR?',
  },
  {
    id: 'siglent-spd', idn: /SIGLENT.*,\s*SPD\d+|^SPD\d+/i,
    select: () => [],
    setVoltage: (ch, v) => `CH${ch}:VOLT ${f(v)}`,
    setCurrent: (ch, a) => `CH${ch}:CURR ${f(a)}`,
    output: (ch, on) => [`OUTP CH${ch},${on ? 'ON' : 'OFF'}`],
    voltageSet: (ch) => `CH${ch}:VOLT?`,
    currentSet: (ch) => `CH${ch}:CURR?`,
    outputState: () => null, // SYST:STAT? is a hex bit field that differs by model
    measureVoltage: (ch) => `MEAS:VOLT? CH${ch}`,
    measureCurrent: (ch) => `MEAS:CURR? CH${ch}`,
  },
  {
    // HMC804x/HMP: a channel's output and the master output are separate switches
    id: 'rs-hmc', idn: /(ROHDE|HAMEG|R&S).*,\s*(HMC|HMP)\d+|^(HMC|HMP)\d+/i,
    select: nsel,
    setVoltage: (_ch, v) => `VOLT ${f(v)}`,
    setCurrent: (_ch, a) => `CURR ${f(a)}`,
    output: (ch, on) => (on ? [...nsel(ch), 'OUTP:CHAN ON', 'OUTP:MAST ON'] : [...nsel(ch), 'OUTP:CHAN OFF']),
    voltageSet: () => 'VOLT?',
    currentSet: () => 'CURR?',
    outputState: () => 'OUTP:CHAN?',
    measureVoltage: () => 'MEAS:VOLT?',
    measureCurrent: () => 'MEAS:CURR?',
  },
  {
    id: 'rs-ngx', idn: /(ROHDE|R&S).*,\s*NG[A-Z]\d*|^NG[A-Z]\d+/i,
    select: nsel,
    setVoltage: (_ch, v) => `VOLT ${f(v)}`,
    setCurrent: (_ch, a) => `CURR ${f(a)}`,
    output: (ch, on) => (on ? [...nsel(ch), 'OUTP:SEL ON', 'OUTP:GEN ON'] : [...nsel(ch), 'OUTP:SEL OFF']),
    voltageSet: () => 'VOLT?',
    currentSet: () => 'CURR?',
    outputState: () => 'OUTP:SEL?',
    measureVoltage: () => 'MEAS:VOLT?',
    measureCurrent: () => 'MEAS:CURR?',
  },
  {
    id: 'generic', idn: /$^/,
    select: (ch) => (ch > 1 ? nsel(ch) : []),
    setVoltage: (_ch, v) => `VOLT ${f(v)}`,
    setCurrent: (_ch, a) => `CURR ${f(a)}`,
    output: (ch, on) => [...(ch > 1 ? nsel(ch) : []), `OUTP ${on ? 'ON' : 'OFF'}`],
    voltageSet: () => 'VOLT?',
    currentSet: () => 'CURR?',
    outputState: () => 'OUTP?',
    measureVoltage: () => 'MEAS:VOLT?',
    measureCurrent: () => 'MEAS:CURR?',
  },
]

export interface PsuRequest {
  channel: number
  voltage?: number | undefined
  current?: number | undefined
  output?: 'on' | 'off' | undefined
  /** read back the measured output (default true) */
  measure?: boolean | undefined
}

export interface PsuState {
  instrument: string
  dialect: string
  idn: string
  channel: number
  limits: { max_voltage_v: number | null; max_current_a: number | null }
  set: { voltage_v: number; current_a: number }
  output: 'on' | 'off' | 'unknown'
  measured?: { voltage_v: number; current_a: number }
  actions: string[]
  errors: string[]
  commands: string[]
}

/** Refuse what the limits do not allow, before any instrument is touched. */
export function checkRequest(inst: Instrument, req: PsuRequest): void {
  if (!inst.channels.includes(req.channel)) throw new ToolError(`${inst.name} has no channel ${req.channel} (channels: ${inst.channels.join(', ')})`)
  const lim = channelLimits(inst, req.channel)
  const wantsChange = req.voltage !== undefined || req.current !== undefined || req.output === 'on'
  if (wantsChange && (lim.max_voltage_v === undefined || lim.max_current_a === undefined)) {
    throw new ToolError(`${inst.name}: refused — no limits are configured${inst.adhoc ? ' (an address given directly has none)' : ''}; ` +
      'add limits {max_voltage_v, max_current_a} to its hil.instruments entry. Without them set-points are refused and the output is never enabled; output off and measuring still work.')
  }
  if (req.voltage !== undefined) {
    if (!(req.voltage >= 0)) throw new ToolError(`voltage must be 0 V or more`)
    if (lim.max_voltage_v !== undefined && req.voltage > lim.max_voltage_v) throw new ToolError(`${inst.name} CH${req.channel}: refused — ${req.voltage} V is above the limit ${lim.max_voltage_v} V`)
  }
  if (req.current !== undefined) {
    if (!(req.current >= 0)) throw new ToolError(`current must be 0 A or more`)
    if (lim.max_current_a !== undefined && req.current > lim.max_current_a) throw new ToolError(`${inst.name} CH${req.channel}: refused — ${req.current} A is above the limit ${lim.max_current_a} A`)
  }
}

async function readOutput(t: Transport, d: PsuDialect, ch: number): Promise<'on' | 'off' | 'unknown'> {
  const q = d.outputState(ch)
  if (!q) return 'unknown'
  for (const c of d.select(ch)) await t.write(c)
  const r = (await t.query(q)).trim().toUpperCase()
  return r === '1' || r === 'ON' ? 'on' : r === '0' || r === 'OFF' ? 'off' : 'unknown'
}

async function readSet(t: Transport, d: PsuDialect, ch: number): Promise<{ voltage_v: number; current_a: number }> {
  for (const c of d.select(ch)) await t.write(c)
  const voltage_v = num(await t.query(d.voltageSet(ch)))
  const current_a = num(await t.query(d.currentSet(ch)))
  return { voltage_v, current_a }
}

export async function psu(inst: Instrument, req: PsuRequest): Promise<PsuState> {
  checkRequest(inst, req)
  const lim = channelLimits(inst, req.channel)
  const ch = req.channel
  const { value, s } = await session(inst, PSU_DIALECTS, 'psu', async ({ t, dialect: d }) => {
    const actions: string[] = []
    // off first, so a new set-point is never applied to a live output that was meant to go off
    if (req.output === 'off') {
      for (const c of d.output(ch, false)) await t.write(c)
      actions.push('output off')
    }
    for (const c of d.select(ch)) await t.write(c)
    // current before voltage: the limit is in place before the voltage rises
    if (req.current !== undefined) { await t.write(d.setCurrent(ch, req.current)); actions.push(`current limit ${req.current} A`) }
    if (req.voltage !== undefined) { await t.write(d.setVoltage(ch, req.voltage)); actions.push(`voltage ${req.voltage} V`) }
    const set = await readSet(t, d, ch)
    if (req.output === 'on') {
      const vMax = lim.max_voltage_v ?? 0
      const iMax = lim.max_current_a ?? 0
      // the instrument may hold set-points from its front panel or an earlier session
      if (set.voltage_v > vMax * 1.0005 + 1e-6 || set.current_a > iMax * 1.0005 + 1e-6) {
        throw new ToolError(`${inst.name} CH${ch}: refused to enable the output — it is set to ${set.voltage_v} V / ${set.current_a} A, above the limits ` +
          `${vMax} V / ${iMax} A; give voltage and current within the limits`)
      }
      for (const c of d.output(ch, true)) await t.write(c)
      actions.push('output on')
    }
    const output = await readOutput(t, d, ch)
    let measured: PsuState['measured']
    if (req.measure !== false) {
      for (const c of d.select(ch)) await t.write(c)
      measured = { voltage_v: num(await t.query(d.measureVoltage(ch))), current_a: num(await t.query(d.measureCurrent(ch))) }
    }
    return { set, output, measured, actions }
  })
  return {
    instrument: inst.name,
    dialect: s.dialect.id,
    idn: s.identity.raw,
    channel: ch,
    limits: { max_voltage_v: lim.max_voltage_v ?? null, max_current_a: lim.max_current_a ?? null },
    set: value.set,
    output: value.output,
    ...(value.measured ? { measured: value.measured } : {}),
    actions: value.actions,
    errors: s.errors,
    commands: s.log,
  }
}
