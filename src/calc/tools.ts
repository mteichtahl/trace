/**
 * The calc tools: one registry entry per calculator, each a thin zod schema over a pure function in this area's
 * modules (circuits.ts, filters.ts, pcb.ts, power.ts; fieldsolve.ts for `calc.impedance` mode "fieldsolve").
 *
 * Component values accept a number in SI units or a string such as "4k7", "100nF", "3.3V" (units.parseValue);
 * lengths are metres ("0.2m" is 0.2 m, "200u" is 200 um).
 */
import { z } from 'zod'
import { defineTool, type AnyTool } from '../core/registry.js'
import { divider, ledResistor, opampGain, regulatorFeedback } from './circuits.js'
import { zSeries, zTol, zVal } from './common.js'
import { activeFilter, lcFilter, rcFilter, rcTiming } from './filters.js'
import { impedance, traceWidth, via } from './pcb.js'
import { adc, boost, buck, crystalCaps, i2cPullup, ldoThermal, power } from './power.js'

const o = <T extends z.ZodType>(t: T) => t.optional()
const window = {
  r_min: o(zVal('smallest resistor to consider when both move (Ω, default 1k)')),
  r_max: o(zVal('largest resistor to consider when both move (Ω, default 1M)')),
}

const dividerTool = defineTool({
  name: 'calc.divider',
  description: 'Resistor divider (R1 top, R2 bottom): Vout from R1/R2/Vin with load current, worst case over tolerance, divider current and power; or the R1/R2 pair for a target Vout from an E-series (fix r1, r2 or total_current, or none and both move).',
  input: z.object({
    vin: zVal('input voltage (V)'),
    r1: o(zVal('top resistor (Ω)')),
    r2: o(zVal('bottom resistor (Ω)')),
    vout: o(zVal('target output voltage (V): solve for the resistors')),
    load_current: o(zVal('current drawn from the output (A), default 0')),
    tolerance: o(zTol('resistor tolerance, default 1 %')),
    vin_tolerance: o(zTol('supply tolerance, default 0')),
    total_current: o(zVal('current budget through R1 (A) when solving')),
    ...window,
    series: o(zSeries('E-series for the resistors, default E24')),
  }),
  run: (a) => divider(a),
})

const regulatorTool = defineTool({
  name: 'calc.regulator_feedback',
  description: 'Adjustable-regulator feedback divider: Vout from Vref and R_top/R_bottom (with FB bias or LM317 Iadj current), or the resistors for a target Vout; topology "feedback" (FB pin) or "adjust" (LM317).',
  input: z.object({
    vref: zVal('reference / feedback voltage (V)'),
    vout: o(zVal('target output voltage (V): solve for the resistors')),
    r_top: o(zVal('resistor from Vout to FB (or OUT to ADJ) (Ω)')),
    r_bottom: o(zVal('resistor from FB (or ADJ) to ground (Ω)')),
    topology: o(z.enum(['feedback', 'adjust']).describe('feedback (default): FB pin at Vref; adjust: LM317-style Vref across R_top')),
    bias_current: o(zVal('FB-pin bias current into the pin, or Iadj out of ADJ (A), default 0')),
    divider_current: o(zVal('current in the resistor across Vref (A) when solving')),
    tolerance: o(zTol('resistor tolerance, default 1 %')),
    vref_tolerance: o(zTol('reference tolerance, default 0')),
    ...window,
    series: o(zSeries('E-series, default E24')),
  }),
  run: (a) => regulatorFeedback(a),
})

const rcFilterTool = defineTool({
  name: 'calc.rc_filter',
  description: 'First-order RC or RL low/high-pass: cutoff from values, or the missing value for a cutoff from an E-series; gain/attenuation and phase at a frequency; time constant, 10-90 % rise and settling to N %.',
  input: z.object({
    kind: o(z.enum(['rc', 'rl']).describe('rc (default) or rl')),
    response: o(z.enum(['lowpass', 'highpass']).describe('lowpass (default) or highpass')),
    r: o(zVal('resistance (Ω)')),
    c: o(zVal('capacitance (F), rc')),
    l: o(zVal('inductance (H), rl')),
    fc: o(zVal('target cutoff (Hz): with r or c/l, picks the other')),
    frequency: o(zVal('frequency to evaluate gain and phase at (Hz)')),
    settle_pct: o(zVal('settle to within this % of final (default 1)')),
    r_series: o(zSeries('E-series for R, default E24')),
    c_series: o(zSeries('E-series for C/L, default E12')),
    tolerance_r: o(zTol('R tolerance, default 1 %')),
    tolerance_c: o(zTol('C/L tolerance, default 10 % (C) / 20 % (L)')),
  }),
  run: (a) => rcFilter(a),
})

const lcFilterTool = defineTool({
  name: 'calc.lc_filter',
  description: 'LC resonance, characteristic impedance and Q with a series R; or a second-order Butterworth LC low-pass (series L, shunt C) for a load resistance and cutoff, picked from an E-series.',
  input: z.object({
    l: o(zVal('inductance (H)')),
    c: o(zVal('capacitance (F)')),
    r_series: o(zVal('series resistance for Q (Ω)')),
    fc: o(zVal('target cutoff (Hz): design a Butterworth low-pass')),
    load: o(zVal('load resistance (Ω), required with fc')),
    series: o(zSeries('E-series for L and C, default E12')),
  }),
  run: (a) => lcFilter(a),
})

const activeFilterTool = defineTool({
  name: 'calc.active_filter',
  description: 'Unity-gain Sallen-Key second-order low/high-pass, Butterworth or Bessel: component values for a cutoff, capacitors from c_series, resistors from r_series, with achieved fc, Q and tolerance spread.',
  input: z.object({
    response: z.enum(['lowpass', 'highpass']).describe('lowpass or highpass'),
    fc: zVal('-3 dB frequency (Hz)'),
    alignment: o(z.enum(['butterworth', 'bessel']).describe('butterworth (default) or bessel')),
    c: o(zVal('fix the capacitor (C2 for low-pass, both for high-pass) (F)')),
    c_min: o(zVal('smallest capacitor to consider (F), default 100p')),
    c_max: o(zVal('largest capacitor to consider (F), default 1u')),
    r_min: o(zVal('smallest resistor (Ω), default 1k')),
    r_max: o(zVal('largest resistor (Ω), default 1M')),
    r_series: o(zSeries('default E24')),
    c_series: o(zSeries('default E12')),
    tolerance_r: o(zTol('default 1 %')),
    tolerance_c: o(zTol('default 5 %')),
  }),
  run: (a) => activeFilter(a),
})

const opampTool = defineTool({
  name: 'calc.opamp_gain',
  description: 'Op-amp inverting/non-inverting gain from Rf and Rg, or the resistors for a gain from an E-series; closed-loop bandwidth from GBW / noise gain.',
  input: z.object({
    config: z.enum(['inverting', 'noninverting']).describe('amplifier configuration'),
    rf: o(zVal('feedback resistor (Ω)')),
    rg: o(zVal('gain resistor: to ground (non-inverting) or from the input (inverting) (Ω)')),
    gain: o(zVal('target gain (V/V; magnitude for inverting)')),
    gbw: o(zVal('gain-bandwidth product (Hz)')),
    tolerance: o(zTol('resistor tolerance, default 1 %')),
    ...window,
    series: o(zSeries('default E24')),
  }),
  run: (a) => opampGain(a),
})

const traceWidthTool = defineTool({
  name: 'calc.trace_width',
  description: 'IPC-2221 trace width for a current at a temperature rise and copper weight (external/internal), or the current a width carries; with length, resistance, voltage drop and power at the copper temperature.',
  input: z.object({
    current: o(zVal('current (A): solve for width')),
    width: o(zVal('trace width (m): solve for current')),
    temp_rise: zVal('allowed temperature rise (°C)'),
    copper_oz: o(zVal('copper weight (oz/ft²), default 1')),
    layer: z.enum(['external', 'internal']).describe('external (outer) or internal layer'),
    ambient: o(zVal('ambient temperature (°C), default 25')),
    length: o(zVal('trace length (m) for resistance, drop and power')),
  }),
  run: (a) => traceWidth(a),
})

const viaTool = defineTool({
  name: 'calc.via',
  description: 'Plated via: current capacity (IPC-2221 on the barrel cross-section), resistance, thermal resistance, inductance (Johnson; Goldfarb-Pucel) and, with pad/antipad, capacitance; vias needed for a current.',
  input: z.object({
    drill: zVal('finished hole diameter (m)'),
    plating: o(zVal('barrel plating thickness (m), default 20u (IPC-6012 class 2)')),
    length: zVal('barrel length, usually board thickness (m)'),
    temp_rise: o(zVal('allowed temperature rise (°C), default 10')),
    layer: o(z.enum(['external', 'internal']).describe('IPC-2221 constant to apply, default internal (conservative)')),
    temperature: o(zVal('copper temperature for resistance (°C), default 25 + rise')),
    pad: o(zVal('pad diameter (m) for capacitance')),
    antipad: o(zVal('antipad (clearance) diameter (m) for capacitance')),
    er: o(zVal('dielectric constant for capacitance, default 4.4')),
    current: o(zVal('current to carry (A): vias needed, drop, power')),
  }),
  run: (a) => via(a),
})

const impedanceTool = defineTool({
  name: 'calc.impedance',
  description: 'Controlled impedance: microstrip (Hammerstad-Jensen), embedded microstrip, symmetric and asymmetric stripline (IPC-2141A), edge-coupled differential pairs; or the width for a target Z0/Zdiff by bisection. mode "fieldsolve" uses a 2D finite-difference field solver (handles solder mask and mixed dielectrics).',
  input: z.object({
    structure: z.enum(['microstrip', 'embedded_microstrip', 'stripline', 'asymmetric_stripline']).describe('line geometry'),
    differential: o(z.boolean().describe('edge-coupled pair (needs gap)')),
    width: o(zVal('trace width (m)')),
    target_z0: o(zVal('target impedance (Ω; Zdiff for a pair): solve for width')),
    gap: o(zVal('edge-to-edge gap of a pair (m)')),
    height: zVal('microstrip: dielectric under the trace; stripline: plane-to-plane spacing; asymmetric: trace to nearer plane (m)'),
    height2: o(zVal('asymmetric stripline: trace top to the farther plane (m)')),
    thickness: o(zVal('copper thickness (m), default 35u (1 oz)')),
    er: zVal('relative permittivity'),
    er2: o(zVal('second dielectric (cover or upper) permittivity (fieldsolve only)')),
    cover: o(zVal('embedded microstrip: plane to top of covering dielectric (m)')),
    mask_thickness: o(zVal('solder mask thickness over a surface microstrip (m) (fieldsolve only)')),
    mask_er: o(zVal('solder mask permittivity, default 3.5')),
    mode: o(z.enum(['closed_form', 'fieldsolve']).describe('closed_form (default) or fieldsolve')),
    grid: o(zVal('fieldsolve grid step at boundaries (m), default 2.5u')),
  }),
  run: (a) => impedance(a),
})

const ledTool = defineTool({
  name: 'calc.led_resistor',
  description: 'Series resistor for one or more LEDs in series from supply, Vf and If: nearest preferred values with actual current, resistor and LED power, and current spread.',
  input: z.object({
    vsupply: zVal('supply voltage (V)'),
    vf: zVal('LED forward voltage at the chosen current (V), from the datasheet'),
    current: zVal('LED current (A)'),
    count: o(z.number().int().describe('LEDs in series, default 1')),
    tolerance: o(zTol('resistor tolerance, default 5 %')),
    series: o(zSeries('default E24')),
  }),
  run: (a) => ledResistor(a),
})

const ldoTool = defineTool({
  name: 'calc.ldo_thermal',
  description: 'Linear regulator thermal check: dissipation (Vin-Vout) I + Vin Iq, junction temperature from theta-JA (or theta-JC + interface + heatsink), margin, and max ambient / current.',
  input: z.object({
    vin: zVal('input voltage (V)'),
    vout: zVal('output voltage (V)'),
    current: zVal('load current (A)'),
    iq: o(zVal('quiescent / ground current (A), default 0')),
    theta_ja: o(zVal('junction-to-ambient thermal resistance (°C/W)')),
    theta_jc: o(zVal('junction-to-case (°C/W), with theta_sa')),
    theta_cs: o(zVal('case-to-heatsink interface (°C/W), default 0')),
    theta_sa: o(zVal('heatsink-to-ambient (°C/W)')),
    ambient: o(zVal('ambient (°C), default 25')),
    tj_max: o(zVal('maximum junction temperature (°C), default 125')),
  }),
  run: (a) => ldoThermal(a),
})

const converterInput = (dir: 'buck' | 'boost') => z.object({
  vin: zVal('nominal input voltage (V)'),
  vout: zVal('output voltage (V)'),
  iout: zVal('output current (A)'),
  fsw: zVal('switching frequency (Hz)'),
  efficiency: o(zVal(`efficiency estimate (fraction or %), default ${dir === 'buck' ? '0.9' : '0.85'}`)),
  ripple_ratio: o(zVal('inductor ripple as a fraction of the (inductor) current, default 0.3')),
  inductor: o(zVal('use this inductor (H) instead of the minimum')),
  ripple_v: o(zVal('allowed output ripple (V): output capacitor and ESR')),
  esr: o(zVal('output capacitor ESR (Ω)')),
  ...(dir === 'buck' ? { vin_max: o(zVal('maximum input (V) the inductor is sized at')) } : { vin_min: o(zVal('minimum input (V) the switch current is sized at')) }),
  l_series: o(zSeries('E-series for inductor candidates, default E6')),
})

const buckTool = defineTool({
  name: 'calc.buck',
  description: 'Buck converter power stage (TI SLVA477): duty cycle, inductor for a ripple ratio, peak current, output capacitor for a ripple voltage and max ESR, input RMS current.',
  input: converterInput('buck'),
  run: (a) => buck(a),
})

const boostTool = defineTool({
  name: 'calc.boost',
  description: 'Boost converter power stage (TI SLVA372): duty cycle, inductor for a ripple ratio, peak switch current, output capacitor for a ripple voltage, input RMS current.',
  input: converterInput('boost'),
  run: (a) => boost(a),
})

const crystalTool = defineTool({
  name: 'calc.crystal_caps',
  description: 'Crystal load capacitors (ST AN2867): C1 = C2 for a load capacitance CL and stray capacitance, or CL from given caps; gain margin from the oscillator gm, ESR, C0 and frequency.',
  input: z.object({
    cl: o(zVal('crystal load capacitance (F), from its datasheet')),
    c1: o(zVal('capacitor 1 (F)')),
    c2: o(zVal('capacitor 2 (F)')),
    stray: zVal('stray capacitance of pins and board (F), typically 2-7 pF'),
    frequency: o(zVal('crystal frequency (Hz), for gain margin')),
    esr: o(zVal('crystal ESR (Ω), for gain margin')),
    c0: o(zVal('crystal shunt capacitance (F), for gain margin')),
    gm: o(zVal('oscillator transconductance (A/V), from the MCU datasheet')),
    series: o(zSeries('default E12')),
  }),
  run: (a) => crystalCaps(a),
})

const i2cTool = defineTool({
  name: 'calc.i2c_pullup',
  description: 'I2C pull-up range (NXP UM10204): Rp,min from VDD, VOL and IOL, Rp,max from bus capacitance and the mode rise time (standard, fast, fast_plus), with preferred values in range.',
  input: z.object({
    vdd: zVal('pull-up supply (V)'),
    capacitance: zVal('total bus capacitance (F)'),
    mode: o(z.enum(['standard', 'fast', 'fast_plus']).describe('bus mode, default fast')),
    vol: o(zVal('low-level output voltage (V), default 0.4 (0.2 VDD below 2 V)')),
    iol: o(zVal('sink current at VOL (A), default 3 mA (20 mA fast_plus)')),
    rise_time: o(zVal('rise time to design for (s), at most the mode limit')),
    series: o(zSeries('default E24')),
  }),
  run: (a) => i2cPullup(a),
})

const adcTool = defineTool({
  name: 'calc.adc',
  description: 'ADC figures (ADI MT-001/MT-003): LSB size, quantisation noise and ideal SNR for N bits; ENOB from SNR or SINAD; bits needed for a resolution.',
  input: z.object({
    bits: o(z.number().int().describe('resolution (bits)')),
    vref: zVal('reference voltage (V)'),
    snr_db: o(zVal('measured SNR (dB)')),
    sinad_db: o(zVal('measured SINAD (dB), preferred over SNR for ENOB')),
    resolution: o(zVal('required resolution (V)')),
    bipolar: o(z.boolean().describe('full scale is ±vref')),
  }),
  run: (a) => adc(a),
})

const rcTimingTool = defineTool({
  name: 'calc.rc_timing',
  description: 'RC timing: time to charge or discharge to a voltage; 555 astable (frequency, duty) and monostable (pulse width) from values, or resistors for a target from an E-series.',
  input: z.object({
    mode: z.enum(['charge', 'discharge', 'astable555', 'monostable555']).describe('calculation'),
    r: o(zVal('resistor (Ω)')),
    c: o(zVal('capacitor (F)')),
    r1: o(zVal('555 astable R1 (Ω)')),
    r2: o(zVal('555 astable R2 (Ω)')),
    vsupply: o(zVal('charging supply (V)')),
    v_start: o(zVal('starting capacitor voltage (V)')),
    v_end: o(zVal('target capacitor voltage (V)')),
    frequency: o(zVal('555 astable target frequency (Hz)')),
    duty: o(zVal('555 astable target duty (0.5-1 or %), default 0.6')),
    time: o(zVal('555 monostable target pulse (s)')),
    r_series: o(zSeries('default E24')),
    tolerance_r: o(zTol('default 1 %')),
    tolerance_c: o(zTol('default 10 %')),
  }),
  run: (a) => rcTiming(a),
})

const powerTool = defineTool({
  name: 'calc.power',
  description: 'Power utilities: battery life from capacity and a duty-cycled current profile; AWG wire diameter, resistance and NEC ampacity; dBm / W / V conversions at an impedance.',
  input: z.object({
    mode: z.enum(['battery', 'awg', 'convert']).describe('calculation'),
    capacity: o(zVal('battery capacity (A h, e.g. 2.2 for 2200 mAh)')),
    profile: o(z.array(z.object({ current: zVal('current in this phase (A)'), duration: zVal('phase duration (s)') })).describe('duty cycle phases, repeated')),
    derating: o(zTol('capacity derating (fraction or %), default 0')),
    self_discharge_per_month: o(zVal('self-discharge (fraction or % of capacity per month), default 0')),
    awg: o(z.number().int().describe('wire gauge (0 = 1/0, -1 = 2/0, ... -3 = 4/0)')),
    length: o(zVal('wire length (m)')),
    current: o(zVal('wire current (A)')),
    temperature: o(zVal('conductor temperature (°C), default 20')),
    dbm: o(zVal('power (dBm)')),
    watts: o(zVal('power (W)')),
    volts_rms: o(zVal('RMS voltage (V)')),
    impedance: o(zVal('impedance (Ω), default 50')),
  }),
  run: (a) => power(a),
})

/** The calc tools. */
export const tools: AnyTool[] = [
  dividerTool, regulatorTool, rcFilterTool, lcFilterTool, activeFilterTool, opampTool, traceWidthTool, viaTool,
  impedanceTool, ledTool, ldoTool, buckTool, boostTool, crystalTool, i2cTool, adcTool, rcTimingTool, powerTool,
]
