/**
 * The protocol tools: bus-functional models of I2C, SPI, UART / RS-232, CAN, 1-Wire and I2S that write VCDs; the
 * physical bus in SPICE; device interface specs in the project database, proposed from datasheets by rules; checks of
 * a capture (simulated, modelled or measured) against a spec or the bus standard; initiator-to-responder timing
 * budgets; timing diagrams; captures from real buses; and testbenches for HDL peripherals.
 *
 * Every tool that computes something records a run (protocol.model, protocol.check, …) with its measurements and
 * artifacts in the project database, so trends show across commits (trace runs protocol.check) and verify.run can
 * take any of them as a test item (it reads `pass` and the run ids).
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

import { defineTool, ToolError, type AnyTool, type ToolContext } from '../../core/registry.js'
import { dec, Work } from '../../core/store.js'
import { i2cPullup } from '../calc/power.js'
import { impedance } from '../calc/pcb.js'
import { library } from '../datasheets/library.js'
import { PdfReader } from '../datasheets/pdf.js'
import { artifactNames, readArtifact, Recorder } from '../sim/record.js'
import { parseRaw } from '../sim/spice.js'
import { loadCapture, logicTool, spiceTool } from '../sim/tools.js'
import * as wave from '../sim/wave.js'
import { busNetlist, measureBus, patternLogic, rcRise, type BusSetup } from './analog.js'
import { annotateCan, annotateI2c, annotateI2s, annotateOnewire, annotateSpi, annotateUart } from './annotate.js'
import { analogCsvToVcd, msoToVcd, sigrokCapture } from './capture.js'
import { judgeAll, limitsFor, modeCompat, type CheckRow } from './check.js'
import { i2cBudget, spiBudget, type Flights, type Range } from './compat.js'
import { eng, rasterise, renderSvg, wavedrom, type Arrow, type Lane, type Panel } from './diagram.js'
import { extractCandidates } from './extract.js'
import { measureCan, measureI2c, measureOnewire, measureSpi, measureUart, type Measured } from './measure.js'
import { roundTrip, runModel, type ModelRun } from './models.js'
import { deleteSpec, getSpec, listDevices, PROTOCOLS, putSpecRows, specMap, SpecRowIn, type Protocol } from './spec.js'
import { I2C_PARAMS, I2C_SPEEDS, I2C_STANDARD, RS232, SPI_PARAMS, UM10204_PULLUP, type I2cSpeed } from './standards.js'
import { verilogTestbench } from './testbench.js'
import { delayEdges, ModelError, type Annotation } from './waveform.js'

const protocol = z.enum(PROTOCOLS)
const r6 = (v: number | null | undefined): number | null => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toPrecision(6)))

function guard<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof ModelError || e instanceof wave.WaveError) throw new ToolError(e.message)
    if (e instanceof z.ZodError) throw new ToolError(e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '))
    throw e
  }
}

const source = {
  file: z.string().optional().describe('a capture on disk: .vcd or .csv'),
  run_id: z.string().optional().describe('or a run whose artifact holds it (protocol.model, sim.logic, protocol.capture, …)'),
  artifact: z.string().optional().describe('with run_id: the artifact (default the run\'s only .vcd)'),
  threshold: z.number().optional().describe('analog CSV columns: logic threshold (V)'),
  vil: z.number().optional(),
  vih: z.number().optional(),
}

const decodeArgs = {
  signals: z.record(z.string(), z.string()).optional().describe('role → signal name, e.g. {"scl": "D0", "sda": "D1"}; default the role names (a protocol.model run uses them)'),
  mode: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional().describe('SPI mode (default 0)'),
  bits: z.number().int().min(1).max(32).optional().describe('SPI word size; I2S word bits'),
  lsb_first: z.boolean().optional(),
  cs_active_high: z.boolean().optional(),
  baud: z.number().positive().optional(),
  data_bits: z.number().int().min(5).max(9).optional(),
  parity: z.enum(['none', 'even', 'odd', 'mark', 'space']).optional(),
  stop_bits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).optional(),
  invert: z.boolean().optional(),
  bitrate: z.number().positive().optional().describe('CAN'),
  sample_point: z.number().gt(0).lt(1).optional().describe('CAN'),
  format: z.enum(['i2s', 'left_justified']).optional(),
}
type DecodeArgs = { signals?: Record<string, string> | undefined; mode?: 0 | 1 | 2 | 3 | undefined; bits?: number | undefined; lsb_first?: boolean | undefined; cs_active_high?: boolean | undefined; baud?: number | undefined; data_bits?: number | undefined; parity?: 'none' | 'even' | 'odd' | 'mark' | 'space' | undefined; stop_bits?: 1 | 1.5 | 2 | undefined; invert?: boolean | undefined; bitrate?: number | undefined; sample_point?: number | undefined; format?: 'i2s' | 'left_justified' | undefined }

const ROLES: Readonly<Record<Protocol, readonly string[]>> = {
  i2c: ['scl', 'sda'], spi: ['sck', 'cs', 'mosi', 'miso'], uart: ['tx'], can: ['can'], onewire: ['dq'], i2s: ['sck', 'ws', 'sd'],
}

const REQUIRED: Readonly<Record<Protocol, readonly string[]>> = { i2c: ['scl', 'sda'], spi: ['sck'], uart: ['tx'], can: ['can'], onewire: ['dq'], i2s: ['sck', 'ws', 'sd'] }

/** role → Signal, from the map given or the role names themselves; optional roles (SPI cs, mosi, miso) may be absent. */
function bind(c: wave.Capture, p: Protocol, given: Record<string, string> | undefined, lv: { threshold?: number; vil?: number; vih?: number }): Record<string, wave.Signal> {
  const map: Record<string, string> = { ...Object.fromEntries(ROLES[p].map((r) => [r, r])), ...(given ?? {}) }
  if (p === 'uart' && (given?.rx || given?.line)) map.tx = (given.rx ?? given.line) as string
  if (p === 'can' && given?.rx) map.can = given.rx
  const out: Record<string, wave.Signal> = {}
  for (const [role, name] of Object.entries(map)) {
    if (c.has(name)) out[role] = c.get(name, lv)
    else if (given?.[role] || REQUIRED[p].includes(role)) throw new ToolError(`${role}: the capture has no signal ${JSON.stringify(name)} (it has: ${c.names().slice(0, 30).join(', ')})`)
  }
  return out
}

const levelsOf = (a: { threshold?: number | undefined; vil?: number | undefined; vih?: number | undefined }): { threshold?: number; vil?: number; vih?: number } => ({
  ...(a.threshold !== undefined ? { threshold: a.threshold } : {}), ...(a.vil !== undefined ? { vil: a.vil } : {}), ...(a.vih !== undefined ? { vih: a.vih } : {}),
})

function measureFor(p: Protocol, s: Record<string, wave.Signal>, a: DecodeArgs & { speed?: string | undefined }, end: number): { measured: Measured[]; count: number; windows: [number, number][] } {
  switch (p) {
    case 'i2c': { const r = measureI2c({ scl: s.scl as wave.Signal, sda: s.sda as wave.Signal }); return { measured: r.measured, count: r.frames, windows: r.windows } }
    case 'spi': { const r = measureSpi({ sck: s.sck as wave.Signal, cs: s.cs, mosi: s.mosi, miso: s.miso }, { mode: a.mode ?? 0, csActiveHigh: a.cs_active_high }); return { measured: r.measured, count: r.transfers, windows: r.windows } }
    case 'uart': {
      if (a.baud === undefined) throw new ToolError('uart needs baud')
      const r = measureUart(s.tx as wave.Signal, { baud: a.baud, dataBits: a.data_bits, parity: a.parity, stopBits: a.stop_bits, invert: a.invert }, end)
      return { measured: r.measured, count: r.frames, windows: r.windows }
    }
    case 'onewire': { const r = measureOnewire(s.dq as wave.Signal, (a.speed as 'standard' | 'overdrive') ?? 'standard'); return { measured: r.measured, count: r.events, windows: r.windows } }
    case 'can': {
      if (a.bitrate === undefined) throw new ToolError('can needs bitrate')
      const r = measureCan(s.can as wave.Signal, { bitrate: a.bitrate, samplePoint: a.sample_point }, end)
      return { measured: r.measured, count: r.frames, windows: r.windows }
    }
    case 'i2s': throw new ToolError('protocol.check has no I2S timing rules yet: decode it with sim.wave_decode, time it with sim.wave_timing (setup_hold of sd and ws to sck)')
  }
}

// ------------------------------------------------------------------ protocol.model

/** A model run's decode settings, from the run record (for check, diagram, testbench). */
function modelRunInfo(runId: string): { protocol: Protocol; decode: Record<string, unknown>; annotations: Annotation[] } | null {
  const w = new Work()
  try {
    const r = w.run(runId)
    if (!r || r.kind !== 'protocol.model') return null
    const res = (r.result ?? {}) as { protocol?: Protocol; decode?: Record<string, unknown> }
    const ann = w.getArtifact(runId, 'annotations.json')
    return { protocol: res.protocol as Protocol, decode: res.decode ?? {}, annotations: ann ? dec<Annotation[]>(new TextDecoder().decode(ann)) : [] }
  } finally {
    w.close()
  }
}

function storeModel(m: ModelRun, args: unknown, subject: string): { run_id: string; artifacts: string[]; roundtrip: ReturnType<typeof roundTrip> } {
  const rec = new Recorder('protocol.model', subject, args)
  try {
    const rt = roundTrip(m)
    rec.artifact('model.vcd', m.wave.vcd(), 'text/x-vcd')
    rec.artifact('model.csv', m.wave.csv(), 'text/csv')
    const an = m.wave.analogCsv()
    if (an) rec.artifact('line.csv', an, 'text/csv')
    rec.artifact('annotations.json', JSON.stringify(m.wave.annotations), 'application/json')
    rec.measure('duration', m.wave.end, 's')
    rec.measure('transactions', m.expected.length)
    rec.measure('roundtrip_match', rt.match ? 1 : 0)
    const names = ['model.vcd', 'model.csv', ...(an ? ['line.csv'] : []), 'annotations.json']
    rec.finish(rt.match ? 'pass' : 'fail', `${m.protocol}: ${m.expected.length} transaction(s), ${eng(m.wave.end)}; decode ${rt.match ? 'matches' : 'differs from'} the model`, { protocol: m.protocol, decode: m.decode, roundtrip: rt.match })
    return { run_id: rec.id, artifacts: names, roundtrip: rt }
  } catch (e) {
    rec.fail(e)
    throw e
  }
}

export const modelTool = defineTool({
  name: 'protocol.model',
  description: 'Bus-functional model: transactions in, a waveform out (VCD model.vcd and CSV model.csv artifacts; RS-232 line voltages as line.csv), with every timing parameter configurable. i2c: standard/fast/fast_plus/high_speed, 7/10-bit, read/write/combined, ACK/NACK, clock stretching, two-master arbitration, general call. spi: modes 0-3, MSB/LSB, 1-32 bit words, several CS, daisy chains, dual/quad lanes, CS-to-clock and inter-word delays, slave tV/tHO. uart: baud, 5-9 bits, parity, stop bits, break, inverted, clock error, RS-232 levels. can: 2.0A/B, stuffing, CRC-15, ACK, bit timing from clock/sample point/SJW. onewire: reset/presence, slots, standard/overdrive. i2s: i2s/left-justified. The run decodes its own waveform with the sim.wave_decode decoders and reports whether it matches the transactions. Edges are ideal; protocol.bus_analog gives real ones.',
  input: z.object({
    protocol,
    config: z.record(z.string(), z.unknown()).optional().describe('i2c {speed, f_scl, t_low, t_high, thd_dat, thd_sta, tsu_sta, tsu_sto, t_buf}; spi {mode, bits, lsb_first, f_sck, duty, selects, cs_active_high, daisy, lanes, t_css, t_csh, t_csd, t_word, tv_master, tv_slave, tho_slave}; uart {baud, data_bits, parity, stop_bits, invert, baud_error, gap_bits, rs232: {v_mark, v_space, slew}}; can {bitrate, sample_point, sjw, clock}; onewire {speed, a..j, pdh, pdl, rd0}; i2s {sample_rate, word_bits, slot_bits, format}; times in s'),
    transactions: z.array(z.record(z.string(), z.unknown())).min(1).max(5000).describe('i2c [{addr, ten_bit?, general_call?, write?, read?, read_data?, nack?, stop?, stretch?, arbitration?}]; spi [{cs?, mosi?, miso?, io?, lanes?}]; uart [{bytes?|text?|break_bits?}]; can [{id, extended?, rtr?, data?, dlc?, ack?}]; onewire [{reset?, presence?, write?, read?}]; i2s [{left, right}]'),
    name: z.string().max(80).optional().describe('the run\'s subject'),
  }),
  run: (a) => {
    const m = guard(() => runModel(a.protocol, a.config ?? {}, a.transactions))
    const st = guard(() => storeModel(m, a, a.name ?? `${a.protocol} model`))
    return {
      run_id: st.run_id, protocol: a.protocol, signals: m.wave.names(), duration_s: r6(m.wave.end), transactions: m.expected.length,
      edges: m.wave.names().reduce((n, s) => n + m.wave.changes(s).length - 1, 0), artifacts: st.artifacts,
      roundtrip: { match: st.roundtrip.match, ...(st.roundtrip.first_difference ? { first_difference: st.roundtrip.first_difference } : {}) },
      decode: m.decode, info: m.info,
      expected: m.expected.slice(0, 20), ...(m.expected.length > 20 ? { expected_truncated: `${m.expected.length} transactions, 20 shown` } : {}),
    }
  },
})

// ------------------------------------------------------------------ protocol.spec / spec_extract

export const specTool = defineTool({
  name: 'protocol.spec',
  description: 'Interface timing specs in the project database (table protocol_specs): per device and protocol, each parameter\'s min/typ/max in the unit given (stored as SI), conditions and citation. verified is true only when the citation has part, sha256 and page; otherwise null. Parameters: i2c f_scl thd_sta t_low t_high tsu_sta thd_dat tsu_dat tvd_dat tvd_ack tsu_sto t_buf t_r t_f c_b t_sp vil vih vol iol; spi f_sck t_sck_high t_sck_low tcss tcsh tcsd tsu th tv tho tdis tsu_mi th_mi modes word_bits; uart baud baud_tol t_break. Actions: set, get, list, delete.',
  input: z.object({
    action: z.enum(['set', 'get', 'list', 'delete']),
    device: z.string().min(1).max(120).optional(),
    protocol: protocol.optional(),
    role: z.enum(['responder', 'initiator']).optional().describe('which side the figures describe (default responder)'),
    rows: z.array(SpecRowIn).max(200).optional().describe('set: [{parameter, min?, typ?, max?, unit, value?, conditions?, citation: {source, mpn?, sha256?, page?}, notes?}]'),
    parameter: z.string().optional().describe('delete one parameter'),
    by: z.string().optional(),
  }),
  run: (a) => {
    if (a.action === 'list') return { devices: listDevices() }
    if (!a.device) throw new ToolError(`${a.action} needs device`)
    if (a.action === 'get') {
      const rows = getSpec(a.device, a.protocol)
      return { device: a.device, rows: rows.map(compactRow), parameters: rows.length, unverified: rows.filter((r) => r.citation.verified !== true).length }
    }
    if (a.action === 'delete') return { deleted: deleteSpec(a.device, a.protocol, a.parameter) }
    if (!a.protocol || !a.rows?.length) throw new ToolError('set needs protocol and rows')
    const rows = putSpecRows(a.device, a.protocol, a.role ?? 'responder', a.rows, a.by)
    return { device: a.device, protocol: a.protocol, stored: a.rows.length, rows: rows.map(compactRow), unverified: rows.filter((r) => r.citation.verified !== true).map((r) => r.parameter) }
  },
})

function compactRow(r: ReturnType<typeof getSpec>[number]): Record<string, unknown> {
  return { parameter: r.parameter, role: r.role, ...(r.min !== undefined ? { min: r6(r.min) } : {}), ...(r.typ !== undefined ? { typ: r6(r.typ) } : {}), ...(r.max !== undefined ? { max: r6(r.max) } : {}), unit: r.unit, ...(r.value !== undefined ? { value: r.value } : {}), ...(r.conditions ? { conditions: r.conditions } : {}), citation: r.citation }
}

let reader: PdfReader | null = null

export const specExtractTool = defineTool({
  name: 'protocol.spec_extract',
  description: 'Propose interface timing specs from a datasheet in the shared library, by rules (no model): every characteristics-table row (datasheets.params) whose symbol (tSU;DAT, tHD;STA, tCSS, tV, …, normalised) or parameter name (data set-up time, bus free time, …) matches the protocol\'s vocabulary, with its numbers converted to SI and its citation (part, sha256, page). Rows whose cells are not plain numbers come back unparsed with their raw text. It never writes: read each candidate against the page, then store it with protocol.spec action=set.',
  input: z.object({
    mpn: z.string().min(1),
    protocol,
    pages: z.array(z.number().int().min(1)).max(50).optional().describe('only these pages (default all)'),
    sha256: z.string().regex(/^[0-9a-fA-F]{8,64}$/).optional(),
    library: z.string().optional().describe('a store location instead of TRACE_HOME (tests)'),
  }),
  run: async (a) => {
    const L = library(a.library)
    const { entry, version } = await L.version(a.mpn, a.sha256)
    const path = await L.localPath(version.sha256)
    reader ??= new PdfReader()
    const r = await reader.params(path, version.sha256, '\\S', { regex: true, limit: 2000, ...(a.pages ? { pages: a.pages } : {}) })
    const out = extractCandidates(r.rows, a.protocol, { mpn: entry.key, sha256: version.sha256 })
    return {
      mpn: entry.key, sha256: version.sha256, protocol: a.protocol, rows_read: r.total, candidates: out.candidates.map((c) => ({ ...c, ...(c.min !== undefined ? { min: r6(c.min) } : {}), ...(c.typ !== undefined ? { typ: r6(c.typ) } : {}), ...(c.max !== undefined ? { max: r6(c.max) } : {}) })),
      unparsed: out.unparsed.slice(0, 50),
      note: 'candidates only: confirm each against its page, then protocol.spec action=set with its citation (the unit field is the SI unit the numbers are now in)',
    }
  },
})

// ------------------------------------------------------------------ protocol.check

const checkInput = {
  ...source,
  protocol,
  ...decodeArgs,
  device: z.string().optional().describe('the responder whose stored spec (protocol.spec) the capture is judged against'),
  initiator: z.string().optional().describe('the initiator device, for SPI mode compatibility'),
  standard: z.string().optional().describe('the bus standard\'s limits: an I2C speed (standard, fast, fast_plus, high_speed, high_speed_400pf) or 1-Wire speed (standard, overdrive)'),
  limits: z.record(z.string(), z.object({ min: z.number().optional(), max: z.number().optional(), unit: z.string().optional() }).strict()).optional().describe('inline limits in SI, e.g. {"tsu": {"min": 5e-9}}; win over the spec'),
  vdd: z.number().positive().optional().describe('for limits given as a fraction of VDD'),
  edge_delays: z.record(z.string(), z.object({ rise: z.number().min(0), fall: z.number().min(0) }).strict()).optional().describe('role → receiver threshold delays (s), applied to the capture\'s edges before timing'),
  analog_runs: z.array(z.object({ role: z.string(), run_id: z.string() }).strict()).optional().describe('protocol.bus_analog runs whose rise_delay/fall_delay apply to a role, and whose t_r/t_f are checked too'),
  record: z.boolean().optional().describe('record the check as a run (default true)'),
}

type CheckArgs = z.output<z.ZodObject<typeof checkInput>>

export async function runCheck(a: CheckArgs): Promise<Record<string, unknown>> {
  const c = await loadCapture(a)
  const fromModel = a.run_id ? modelRunInfo(a.run_id) : null
  const d: DecodeArgs & { speed?: string | undefined } = { ...(fromModel?.decode as DecodeArgs | undefined), ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) }
  if (a.protocol === 'onewire') d.speed = a.standard ?? (fromModel?.decode.speed as string | undefined) ?? 'standard'
  const lv = levelsOf(a)
  const s = guard(() => bind(c, a.protocol, a.signals, lv))
  const delays: Record<string, { rise: number; fall: number }> = { ...(a.edge_delays ?? {}) }
  const analog: { role: string; t_r: number | null; t_f: number | null; run_id: string }[] = []
  for (const ar of a.analog_runs ?? []) {
    const w = new Work()
    try {
      const r = w.run(ar.run_id)
      if (!r || r.kind !== 'protocol.bus_analog') throw new ToolError(`${ar.run_id} is not a protocol.bus_analog run`)
      const m = (n: string): number | null => r.measurements.find((x) => x.name === n)?.value ?? null
      delays[ar.role] = { rise: m('rise_delay') ?? 0, fall: m('fall_delay') ?? 0 }
      analog.push({ role: ar.role, t_r: m('t_r'), t_f: m('t_f'), run_id: ar.run_id })
    } finally {
      w.close()
    }
  }
  for (const [role, dl] of Object.entries(delays)) {
    const sig = s[role]
    if (!sig) throw new ToolError(`edge_delays: no role ${role} in this capture`)
    s[role] = delayEdges(sig, dl.rise, dl.fall)
  }
  const frameBits = a.protocol === 'uart' ? 1 + (d.data_bits ?? 8) + (d.parity && d.parity !== 'none' ? 1 : 0) + 1 : undefined
  const { measured, count, windows } = guard(() => measureFor(a.protocol, s, d, c.end))
  const extra: Measured[] = []
  for (const an of analog) {
    if (an.t_r !== null) extra.push({ parameter: 't_r', value: an.t_r, unit: 's', worst: 'max', from: an.role, count: 1 })
    if (an.t_f !== null) extra.push({ parameter: 't_f', value: an.t_f, unit: 's', worst: 'max', from: an.role, count: 1 })
  }
  const merged = [...measured]
  for (const e of extra) {
    const k = merged.findIndex((x) => x.parameter === e.parameter)
    if (k < 0) merged.push(e)
    else if ((merged[k]?.value ?? -Infinity) < (e.value ?? -Infinity)) merged[k] = e
  }
  const { limits, spec } = limitsFor(a.protocol, { device: a.device, standard: a.standard, frameBits, vdd: a.vdd, inline: a.limits })
  const txAt = (t: number): number | undefined => { const k = windows.findIndex(([x, y]) => t >= x - 1e-15 && t <= y + 1e-15); return k >= 0 ? k : undefined }
  const rows = judgeAll(merged, limits, txAt)
  const initiator = a.initiator ? specMap(a.initiator, a.protocol) : null
  const modes = a.protocol === 'spi' ? modeCompat(d.mode ?? 0, spec, initiator) : { ok: null, notes: [] as string[] }
  const fails = rows.filter((r) => r.status === 'fail')
  const judged = rows.filter((r) => r.status === 'pass' || r.status === 'fail')
  const pass = judged.length > 0 && fails.length === 0 && modes.ok !== false && count > 0
  const worst = judged.filter((r) => r.margin !== null).sort((x, y) => relMargin(x) - relMargin(y))[0] ?? null
  const result = {
    protocol: a.protocol, device: a.device ?? null, standard: a.standard ?? null, transactions: count, pass,
    rows: rows.map(compactCheckRow),
    worst: worst ? compactCheckRow(worst) : null,
    not_seen: rows.filter((r) => r.status === 'not_seen').map((r) => r.parameter),
    ...(modes.notes.length ? { modes } : {}),
    ...(Object.keys(delays).length ? { edge_delays: delays } : {}),
    ...(count === 0 ? { note: 'nothing decoded: check the signal names, the mode and the levels' } : {}),
    windows: windows.slice(0, 50).map(([x, y]) => [r6(x), r6(y)]),
  }
  if (a.record === false) return result
  const rec = new Recorder('protocol.check', a.device ?? a.standard ?? a.protocol, a)
  for (const r of rows) {
    if (r.measured === null) continue
    rec.measure(r.parameter, r.measured, r.unit, { limit: r.limit, status: r.status, at: r.at })
    if (r.margin !== null) rec.measure(`${r.parameter}.margin`, r.margin, r.unit)
  }
  rec.finish(pass ? 'pass' : 'fail', `${a.protocol}${a.device ? ` vs ${a.device}` : a.standard ? ` vs ${a.standard}` : ''}: ${judged.length - fails.length}/${judged.length} pass${worst ? `, worst ${worst.parameter} margin ${eng(worst.margin as number, worst.unit === 's' ? 's' : worst.unit)}` : ''}`, result)
  return { run_id: rec.id, ...result }
}

const relMargin = (r: CheckRow): number => {
  const l = r.limit.min ?? r.limit.max ?? 0
  return Math.abs(l) > 0 ? (r.margin as number) / Math.abs(l) : (r.margin as number)
}

function compactCheckRow(r: CheckRow): Record<string, unknown> {
  return {
    parameter: r.parameter, status: r.status, measured: r6(r.measured), unit: r.unit, limit: { ...(r.limit.min !== undefined ? { min: r6(r.limit.min) } : {}), ...(r.limit.max !== undefined ? { max: r6(r.limit.max) } : {}) },
    margin: r6(r.margin), source: r.source, verified: r.verified,
    ...(r.at && (r.at.t0 !== undefined || r.at.tx !== undefined) ? { at: { ...(r.at.t0 !== undefined ? { t0: r6(r.at.t0), t1: r6(r.at.t1) } : {}), ...(r.at.from ? { from: r.at.from, to: r.at.to } : {}), ...(r.at.tx !== undefined ? { transaction: r.at.tx } : {}) } } : {}),
  }
}

export const checkTool = defineTool({
  name: 'protocol.check',
  description: 'Judge a capture (a protocol.model run, a sim.logic VCD, a logic-analyser or scope capture, a file) against a device\'s stored interface spec (protocol.spec), the bus standard\'s limits (I2C UM10204 speed modes; 1-Wire standard/overdrive), or inline limits. Per parameter: the measured worst case, the limit, the margin, pass/fail, and the edges and transaction where the worst case is; SPI mode compatibility with the responder (and initiator) spec. Receiver threshold delays from protocol.bus_analog runs (or given) are applied to the edges first, and their tr/tf are checked too. Recorded as a protocol.check run with one measurement per parameter (and its margin), so verify.run can use it as a test item and trends show over commits. Measures at the capture\'s pins only; I2S timing is not judged here.',
  input: z.object(checkInput),
  run: (a) => runCheck(a),
})

// ------------------------------------------------------------------ protocol.compat

const FlightIn = z.object({
  delay: z.number().min(0).optional().describe('flight time (s)'),
  delay_min: z.number().min(0).optional(),
  delay_max: z.number().min(0).optional(),
  length_m: z.number().min(0).optional().describe('or a length, with delay_per_m'),
  net: z.string().optional().describe('or a board net (kicad.net_length), with from/to pads for a path'),
  from: z.string().optional(),
  to: z.string().optional(),
}).strict()

async function flightOf(role: string, f: z.output<typeof FlightIn> | undefined, o: { project?: string | undefined; delay_per_m?: number | undefined; tolerance: number }, ctx: ToolContext): Promise<{ range: Range; how: string }> {
  if (!f) return { range: { min: 0, max: 0 }, how: 'none given: 0' }
  if (f.delay !== undefined || f.delay_min !== undefined || f.delay_max !== undefined) {
    const mn = f.delay_min ?? f.delay ?? f.delay_max ?? 0
    const mx = f.delay_max ?? f.delay ?? f.delay_min ?? 0
    return { range: { min: mn, max: mx }, how: 'given' }
  }
  let len = f.length_m
  let how = 'length × delay per m'
  let pathDelay: number | null = null
  if (len === undefined && f.net) {
    const { allTools } = await import('../index.js')
    const r = (await allTools().call('kicad.net_length', { ...(o.project ? { project: o.project } : {}), nets: [f.net], ...(f.from && f.to ? { from: f.from, to: f.to } : {}) }, ctx)) as { nets: { length_mm: number }[]; path?: { length_mm: number; delay_ps: number | null }; run_id: string }
    if (r.path) {
      len = r.path.length_mm / 1e3
      pathDelay = r.path.delay_ps !== null ? r.path.delay_ps * 1e-12 : null
      how = `kicad.net_length ${f.net} ${f.from} → ${f.to} (run ${r.run_id})`
    } else {
      len = (r.nets[0]?.length_mm ?? 0) / 1e3
      how = `kicad.net_length ${f.net}, whole net (run ${r.run_id}): an upper bound for one path`
    }
  }
  if (len === undefined) throw new ToolError(`flight ${role}: give delay, length_m or net`)
  const d = pathDelay ?? (o.delay_per_m !== undefined ? len * o.delay_per_m : null)
  if (d === null) throw new ToolError(`flight ${role}: ${eng(len, 'm')} needs delay_per_m (or impedance for calc.impedance)`)
  return { range: { min: d * (1 - o.tolerance), max: d * (1 + o.tolerance) }, how }
}

export const compatTool = defineTool({
  name: 'protocol.compat',
  description: 'Initiator-to-responder interface timing budget from two stored specs, at corners (slow: every delay at max, fast: at min, bound: the worst mix). SPI: write setup/hold at the responder (H + fl_sck - tV,m - fl_mosi - tSU,s; H + tHO,m + fl_mosi - fl_sck - tH,s), read setup/hold at the initiator (H - fl_sck - tV,s - fl_miso - tSU,m; …), the read path fmax, fSCK against both maxima, SCK high/low, tCSS/tCSH/tCSD, shared modes. I2C: each generated timing against the responder minimum, fSCL, and tLOW - tr - tVD;DAT - tSU;DAT. Flight time from given delays, lengths, or board nets (kicad.net_length; delay per m given or from calc.impedance). A missing figure is listed and its check skipped, never assumed. Recorded.',
  input: z.object({
    protocol: z.enum(['spi', 'i2c']),
    initiator: z.string().describe('initiator device (protocol.spec)'),
    responder: z.string().describe('responder device (protocol.spec)'),
    f: z.number().positive().optional().describe('clock frequency to budget at (Hz); default the lower maximum'),
    duty_min: z.number().gt(0).lt(1).optional(),
    duty_max: z.number().gt(0).lt(1).optional(),
    flight: z.object({ sck: FlightIn.optional(), mosi: FlightIn.optional(), miso: FlightIn.optional() }).strict().optional().describe('SPI flight time per line'),
    project: z.string().optional().describe('KiCad project for nets (default the configured one)'),
    delay_per_m: z.number().positive().optional().describe('propagation delay (s/m) for lengths'),
    impedance: z.record(z.string(), z.unknown()).optional().describe('calc.impedance args ({structure, width, height, er, …}) for the delay per m'),
    length_tolerance: z.number().min(0).max(1).optional().describe('± fraction on a flight time from a length (default 0.1)'),
    t_r: z.number().positive().optional().describe('I2C rise time (s) for the read budget (or from the responder spec)'),
  }),
  run: async (a, ctx) => {
    const m = specMap(a.initiator, a.protocol)
    const s = specMap(a.responder, a.protocol)
    const rec = new Recorder('protocol.compat', `${a.initiator} → ${a.responder}`, a)
    try {
      let delayPerM = a.delay_per_m
      if (delayPerM === undefined && a.impedance) {
        const z0 = impedance(a.impedance as never) as { delay_s_per_m?: number; z0_ohm?: number }
        delayPerM = z0.delay_s_per_m
      }
      if (a.protocol === 'spi') {
        const fS = s.get('f_sck')?.max
        const fM = m.get('f_sck')?.max
        const f = a.f ?? (fS !== undefined && fM !== undefined ? Math.min(fS, fM) : fS ?? fM)
        if (f === undefined) throw new ToolError('give f: neither spec has f_sck max')
        const o = { project: a.project, delay_per_m: delayPerM, tolerance: a.length_tolerance ?? 0.1 }
        const fl = {
          sck: await flightOf('sck', a.flight?.sck, o, ctx), mosi: await flightOf('mosi', a.flight?.mosi, o, ctx), miso: await flightOf('miso', a.flight?.miso, o, ctx),
        }
        const flights: Flights = { sck: fl.sck.range, mosi: fl.mosi.range, miso: fl.miso.range }
        const b = spiBudget({ initiator: m, responder: s, f, duty: { min: a.duty_min ?? 0.5, max: a.duty_max ?? a.duty_min ?? 0.5 }, flight: flights })
        const modes = modeCompat(undefined, s, m)
        for (const r of b.rows) if (r.corners.bound !== null) rec.measure(r.check, r.corners.bound, r.check.startsWith('fSCK') ? 'Hz' : 's')
        if (b.f_max_read !== null) rec.measure('f_max_read', b.f_max_read, 'Hz')
        const pass = b.rows.every((r) => r.pass !== false) && b.rows.some((r) => r.pass === true) && modes.ok !== false
        const result = {
          protocol: 'spi', f, half_period_s: r6(b.half_period), pass,
          rows: b.rows.map((r) => ({ check: r.check, formula: r.formula, slack: { bound: r6(r.corners.bound), slow: r6(r.corners.slow), fast: r6(r.corners.fast) }, pass: r.pass, ...(r.missing ? { missing: r.missing } : {}) })),
          f_max_read: r6(b.f_max_read), f_max_write: r6(b.f_max_write),
          flights: Object.fromEntries(Object.entries(fl).map(([k, v]) => [k, { min: r6(v.range.min), max: r6(v.range.max), how: v.how }])),
          modes,
          skipped: b.rows.filter((r) => r.pass === null).map((r) => r.check),
        }
        rec.finish(pass ? 'pass' : 'fail', `SPI ${a.initiator} → ${a.responder} at ${eng(f, 'Hz')}: ${b.rows.filter((r) => r.pass === true).length} pass, ${b.rows.filter((r) => r.pass === false).length} fail${b.f_max_read ? `, read fmax ${eng(b.f_max_read, 'Hz')}` : ''}`, result)
        return { run_id: rec.id, ...result }
      }
      const b = i2cBudget({ initiator: m, responder: s, f: a.f, t_r: a.t_r })
      for (const r of b.rows) if (r.corners.bound !== null) rec.measure(r.check, r.corners.bound, r.check.startsWith('fSCL') ? 'Hz' : 's')
      const pass = b.rows.every((r) => r.pass !== false) && b.rows.some((r) => r.pass === true)
      const result = { protocol: 'i2c', pass, rows: b.rows.map((r) => ({ check: r.check, formula: r.formula, slack: r6(r.corners.bound), pass: r.pass, ...(r.missing ? { missing: r.missing } : {}) })), skipped: b.rows.filter((r) => r.pass === null).map((r) => r.check) }
      rec.finish(pass ? 'pass' : 'fail', `I2C ${a.initiator} → ${a.responder}: ${b.rows.filter((r) => r.pass === true).length} pass, ${b.rows.filter((r) => r.pass === false).length} fail`, result)
      return { run_id: rec.id, ...result }
    } catch (e) {
      rec.fail(e)
      throw e
    }
  },
})

// ------------------------------------------------------------------ protocol.bus_analog / pullup

const TraceIn = z.object({
  model: z.enum(['none', 'rc', 'tline']).default('none'),
  r: z.number().min(0).optional().describe('rc: series resistance (Ω)'),
  c: z.number().min(0).optional().describe('rc: capacitance (F)'),
  z0: z.number().positive().optional().describe('tline: characteristic impedance (Ω)'),
  delay_per_m: z.number().positive().optional().describe('tline: s/m'),
  length_m: z.number().positive().optional(),
  r_per_m: z.number().min(0).optional().describe('tline: series loss (Ω/m): LTRA when given, an ideal T line otherwise'),
}).strict()

const busInput = {
  kind: z.enum(['open_drain', 'push_pull', 'rs232']),
  vdd: z.number().positive().optional().describe('supply (V); default 3.3'),
  rp: z.number().positive().optional().describe('open drain: pull-up (Ω)'),
  cb: z.number().positive().optional().describe('open drain: total bus capacitance (F)'),
  ron: z.number().positive().optional().describe('open drain: driver on-resistance (Ω); default VOL / IOL'),
  vol: z.number().positive().optional().describe('open drain: VOL (V) at iol, for ron (default 0.4 V)'),
  iol: z.number().positive().optional().describe('open drain: IOL (A) (default 3 mA; 20 mA for fast_plus)'),
  r_drv: z.number().positive().optional().describe('push-pull: driver output resistance (Ω), default 25'),
  t_edge: z.number().positive().optional().describe('driver intrinsic edge time (s), default 1 ns'),
  trace: TraceIn.optional(),
  board: z.object({ project: z.string().optional(), net: z.string(), from: z.string().optional(), to: z.string().optional() }).strict().optional().describe('take the length (and delay, Z0 on a from/to path) from kicad.net_length'),
  impedance: z.record(z.string(), z.unknown()).optional().describe('calc.impedance args for the line\'s Z0 and delay per m'),
  c_in: z.number().min(0).optional().describe('receiver input capacitance (F), default 5 pF'),
  vil: z.number().optional().describe('receiver VIL (V); open drain default 0.3 VDD'),
  vih: z.number().optional().describe('receiver VIH (V); open drain default 0.7 VDD'),
  levels: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional().describe('transition measured between these fractions; default [0.3, 0.7] open drain (UM10204), [0.1, 0.9] otherwise'),
  rs232: z.object({ v_mark: z.number().max(0).default(-5.5), v_space: z.number().min(0).default(5.5), slew: z.number().positive().default(10e6), r_out: z.number().positive().default(100), r_load: z.number().positive().default(5e3), c_cable: z.number().min(0).default(1000e-12) }).strict().optional()
    .describe('RS-232 driver and line: levels (V), slew (V/s), output resistance (assumed 100 Ω), receiver load (3-7 kΩ), cable capacitance'),
  stimulus: z.object({
    pattern: z.string().regex(/^[01]+$/).optional().describe('bits, e.g. "0101"'),
    bit_time: z.number().positive().optional(),
    run_id: z.string().optional().describe('or the edges of a signal in a run\'s VCD (protocol.model, sim.logic)'),
    signal: z.string().optional(),
    artifact: z.string().optional(),
    from: z.number().optional(),
    to: z.number().optional(),
  }).strict().optional().describe('default: "0101" at a bit time of 10 RC (or 1 µs)'),
  speed: z.enum(I2C_SPEEDS).optional().describe('open drain: judge tr/tf against this UM10204 mode'),
  max_points: z.number().int().min(0).max(5000).optional().describe('waveform points returned (default 0: none; the raw data is in the sim.spice run)'),
}

type BusArgs = z.output<z.ZodObject<typeof busInput>>

export async function busAnalog(a: BusArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  const vdd = a.vdd ?? 3.3
  const od = a.kind === 'open_drain'
  const trace = TraceIn.parse(a.trace ?? {})
  const notes: string[] = []
  // the line from the board and calc.impedance
  if (a.board || a.impedance) {
    if (a.impedance) {
      const z0 = impedance(a.impedance as never) as { z0_ohm?: number; delay_s_per_m?: number }
      trace.z0 ??= z0.z0_ohm
      trace.delay_per_m ??= z0.delay_s_per_m
      notes.push(`calc.impedance: Z0 ${r6(z0.z0_ohm ?? NaN)} Ω, ${r6((z0.delay_s_per_m ?? NaN) * 1e9)} ns/m`)
    }
    if (a.board) {
      const { allTools } = await import('../index.js')
      const r = (await allTools().call('kicad.net_length', { ...(a.board.project ? { project: a.board.project } : {}), nets: [a.board.net], ...(a.board.from && a.board.to ? { from: a.board.from, to: a.board.to } : {}) }, ctx)) as { nets: { length_mm: number; capacitance_pf: number | null }[]; path?: { length_mm: number; delay_ps: number | null; z0_ohm: number | null }; run_id: string }
      const len = (r.path?.length_mm ?? r.nets[0]?.length_mm ?? 0) / 1e3
      trace.length_m ??= len
      if (r.path?.delay_ps && len > 0) trace.delay_per_m ??= (r.path.delay_ps * 1e-12) / len
      if (r.path?.z0_ohm) trace.z0 ??= r.path.z0_ohm
      if (od && r.nets[0]?.capacitance_pf) notes.push(`the net's routed capacitance is ${r.nets[0].capacitance_pf} pF (kicad.net_length run ${r.run_id}); it is part of cb, which you give`)
      notes.push(`kicad.net_length ${a.board.net}: ${r6(len * 1e3)} mm (run ${r.run_id})`)
    }
    if (trace.model === 'none' && trace.z0 && trace.delay_per_m && trace.length_m) trace.model = 'tline'
  }
  // the stimulus
  const tau = od ? (a.rp ?? 0) * (a.cb ?? 0) : (a.r_drv ?? 25) * ((a.c_in ?? 5e-12) + (trace.c ?? 0) + (a.rs232?.c_cable ?? 0))
  let logic: [number, 0 | 1][]
  let stop: number
  const st = a.stimulus ?? {}
  if (st.run_id) {
    if (!st.signal) throw new ToolError('stimulus.run_id needs signal')
    const c = await loadCapture({ run_id: st.run_id, artifact: st.artifact })
    const s = c.get(st.signal)
    logic = []
    for (let k = 0; k < s.t.length; k++) {
      const t = s.t[k] as number
      if ((st.from !== undefined && t < st.from) || (st.to !== undefined && t > st.to)) continue
      const v = s.v[k]
      if (v !== '0' && v !== '1') continue
      logic.push([logic.length ? t - (st.from ?? 0) : 0, v === '1' ? 1 : 0])
    }
    if (!logic.length) throw new ToolError(`${st.signal} has no 0/1 levels in the window`)
    if (logic.length > 2000) throw new ToolError(`${logic.length} edges: narrow the window (from/to) to at most 2000`)
    stop = (st.to ?? c.end) - (st.from ?? 0)
  } else {
    const bt = st.bit_time ?? Math.max(1e-9, Number.isFinite(tau) && tau > 0 ? 10 * tau : 1e-6)
    const p = patternLogic(st.pattern ?? '0101', bt)
    logic = p.logic
    stop = p.stop
  }
  const ron = a.ron ?? (a.vol ?? 0.4) / (a.iol ?? (a.speed === 'fast_plus' ? 20e-3 : 3e-3))
  const setup: BusSetup = {
    kind: a.kind, vdd, rp: a.rp, cb: a.cb, ron, r_drv: a.r_drv, t_edge: a.t_edge ?? 1e-9, trace, c_in: a.c_in ?? 5e-12,
    rs232: a.rs232 ? { v_mark: a.rs232.v_mark, v_space: a.rs232.v_space, slew: a.rs232.slew, r_out: a.rs232.r_out, r_load: a.rs232.r_load, c_cable: a.rs232.c_cable } : undefined,
    logic, stop,
  }
  const net = guard(() => busNetlist(setup))
  const sp = (await spiceTool.run({ netlist: net.netlist, analyses: [net.analysis], save: [`v(${net.node})`] } as never, ctx)) as { run_id: string }
  const raw = new TextDecoder().decode(readArtifact(sp.run_id, artifactNames(sp.run_id).find((n) => n.startsWith('tran')) ?? 'tran.raw'))
  const plot = parseRaw(raw)[0]
  const time = plot?.vectors.get('time')
  const v = plot?.vectors.get(`v(${net.node})`)
  if (!time || !v) throw new ToolError(`the SPICE run ${sp.run_id} has no v(${net.node})`)
  const lv = a.levels ?? (od ? [0.3, 0.7] : [0.1, 0.9])
  const level0 = a.kind === 'rs232' ? (a.rs232?.v_space ?? 5.5) : 0
  const level1 = a.kind === 'rs232' ? (a.rs232?.v_mark ?? -5.5) : vdd
  const thrUp = a.kind === 'rs232' ? 3 : a.vih ?? 0.7 * vdd
  const thrDown = a.kind === 'rs232' ? -3 : a.vil ?? 0.3 * vdd
  const ramp = a.kind === 'rs232' && a.rs232 ? Math.abs(a.rs232.v_space - a.rs232.v_mark) / a.rs232.slew : setup.t_edge
  const mb = measureBus(time, v, logic, { lo: lv[0], hi: lv[1], thrUp, thrDown, level0, level1, lead: ramp / 2 })
  // closed forms to compare with
  const expect: Record<string, number | null> = {}
  if (od && a.rp && a.cb) {
    const rc = rcRise(a.rp, a.cb)
    expect.t_r_rc = lv[0] === 0.3 && lv[1] === 0.7 ? rc.t_30_70 : lv[0] === 0.1 && lv[1] === 0.9 ? rc.t_10_90 : Math.log((1 - lv[0]) / (1 - lv[1])) * a.rp * a.cb
  } else if (trace.model !== 'tline' && a.kind === 'push_pull') {
    const R = (a.r_drv ?? 25) + (trace.model === 'rc' ? (trace.r ?? 0) : 0)
    const C = (a.c_in ?? 5e-12) + (trace.model === 'rc' ? (trace.c ?? 0) : 0)
    expect.t_r_rc = Math.log((1 - lv[0]) / (1 - lv[1])) * R * C
    notes.push('the RC closed form ignores the source edge time and treats R and C as one lump')
  }
  if (trace.model === 'tline' && trace.delay_per_m && trace.length_m) expect.line_delay = trace.delay_per_m * trace.length_m
  const checks: { name: string; value: number | null; limit: string; pass: boolean | null; cite: string }[] = []
  if (od && a.speed) {
    const lim = I2C_STANDARD[a.speed as I2cSpeed]
    if (lim.t_r?.max !== undefined) checks.push({ name: 't_r', value: r6(mb.t_r), limit: `≤ ${eng(lim.t_r.max)}`, pass: mb.t_r === null ? null : mb.t_r <= lim.t_r.max, cite: lim.t_r.cite.source })
    if (lim.t_f?.max !== undefined) checks.push({ name: 't_f', value: r6(mb.t_f), limit: `≤ ${eng(lim.t_f.max)}`, pass: mb.t_f === null ? null : mb.t_f <= lim.t_f.max, cite: lim.t_f.cite.source })
    if (lim.c_b?.max !== undefined && a.cb) checks.push({ name: 'c_b', value: a.cb, limit: `≤ ${eng(lim.c_b.max, 'F')}`, pass: a.cb <= lim.c_b.max, cite: lim.c_b.cite.source })
    if (mb.v_low !== null) checks.push({ name: 'v_low', value: r6(mb.v_low), limit: `≤ ${eng(0.3 * vdd, 'V')} (VIL)`, pass: mb.v_low <= (a.vil ?? 0.3 * vdd), cite: (lim.vil?.cite ?? UM10204_PULLUP).source })
  }
  let slewMax: number | null = null
  if (a.kind === 'rs232') {
    for (let i = 1; i < time.length; i++) {
      const dt = (time[i] as number) - (time[i - 1] as number)
      const vm = ((v[i] as number) + (v[i - 1] as number)) / 2
      if (dt > 0 && Math.abs(vm) < 3) slewMax = Math.max(slewMax ?? 0, Math.abs(((v[i] as number) - (v[i - 1] as number)) / dt))
    }
    const lo = mb.v_low
    const hi = mb.v_high
    checks.push({ name: 'space_level', value: r6(hi), limit: '≥ +3 V and ≤ +15 V at the receiver', pass: hi === null ? null : hi >= 3 && hi <= 15, cite: (RS232.receiver_threshold as { cite: { source: string } }).cite.source })
    checks.push({ name: 'mark_level', value: r6(lo), limit: '≤ -3 V and ≥ -15 V at the receiver', pass: lo === null ? null : lo <= -3 && lo >= -15, cite: (RS232.receiver_threshold as { cite: { source: string } }).cite.source })
    checks.push({ name: 'slew', value: r6(slewMax), limit: '≤ 30 V/µs (between ±3 V)', pass: slewMax === null ? null : slewMax <= 30e6, cite: (RS232.slew as { cite: { source: string } }).cite.source })
    if (a.rs232 && (a.rs232.r_load < 3e3 || a.rs232.r_load > 7e3)) notes.push('r_load is outside TIA-232\'s 3 to 7 kΩ')
    if (a.rs232 && a.rs232.c_cable > 2500e-12) notes.push('c_cable is above TIA-232\'s 2500 pF')
  }
  const rec = new Recorder('protocol.bus_analog', `${a.kind}${a.board ? ` ${a.board.net}` : ''}`, a)
  rec.artifact('netlist.cir', net.netlist)
  const ms: [string, number | null, string][] = [['t_r', mb.t_r, 's'], ['t_f', mb.t_f, 's'], ['rise_delay', mb.rise_delay, 's'], ['fall_delay', mb.fall_delay, 's'], ['overshoot_v', mb.overshoot_v, 'V'], ['undershoot_v', mb.undershoot_v, 'V'], ['v_low', mb.v_low, 'V'], ['v_high', mb.v_high, 'V'], ['settle', mb.settle, 's'], ...(slewMax !== null ? [['slew', slewMax, 'V/s'] as [string, number, string]] : [])]
  for (const [n, val, u] of ms) rec.measure(n, val, u)
  for (const [n, val] of Object.entries(expect)) rec.measure(`expected.${n}`, val, 's')
  const pass = checks.length ? checks.every((c) => c.pass !== false) : mb.t_r !== null || mb.t_f !== null
  const result = {
    spice_run_id: sp.run_id, kind: a.kind, node: net.node,
    measured: Object.fromEntries(ms.map(([n, val]) => [n, r6(val)])),
    expected: Object.fromEntries(Object.entries(expect).map(([k, val]) => [k, r6(val)])),
    ...(expect.t_r_rc && mb.t_r ? { t_r_vs_rc_pct: r6((mb.t_r / (expect.t_r_rc as number) - 1) * 100) } : {}),
    effective: { rise_delay: r6(mb.rise_delay), fall_delay: r6(mb.fall_delay), thresholds: { up: thrUp, down: thrDown }, note: 'pass this run to protocol.check analog_runs to time the digital capture at the receiver thresholds' },
    checks, pass, edges: mb.edges.length,
    trace: { ...trace, ...(od ? { rp: a.rp, cb: a.cb, ron: r6(ron) } : {}) },
    ...(notes.length ? { notes } : {}),
    ...(a.max_points ? { waveform: decimated(time, v, a.max_points) } : {}),
  }
  rec.finish(pass ? 'pass' : 'fail', `${a.kind}: tr ${mb.t_r === null ? '—' : eng(mb.t_r)}, tf ${mb.t_f === null ? '—' : eng(mb.t_f)}, rise delay ${mb.rise_delay === null ? '—' : eng(mb.rise_delay)}`, result)
  return { run_id: rec.id, ...result }
}

function decimated(t: readonly number[], v: readonly number[], n: number): { t: (number | null)[]; v: (number | null)[] } {
  const step = Math.max(1, Math.ceil(t.length / n))
  const ti: (number | null)[] = []
  const vi: (number | null)[] = []
  for (let i = 0; i < t.length; i += step) { ti.push(r6(t[i] as number)); vi.push(r6(v[i] as number)) }
  return { t: ti, v: vi }
}

export const busAnalogTool = defineTool({
  name: 'protocol.bus_analog',
  description: 'The physical bus as a SPICE netlist, run with sim.spice (ngspice): open drain (I2C: pull-up Rp, bus capacitance Cb, driver Ron = VOL/IOL), push-pull (SPI/UART: driver resistance and edge, trace as RC or a transmission line, ideal or lossy LTRA, from calc.impedance and kicad.net_length when a board net is given, receiver capacitance) or RS-232 (±V levels, slew, cable C, 3-7 kΩ load). Measures per edge at the receiver: rise/fall time (30-70 % for I2C per UM10204, 10-90 % otherwise), overshoot, undershoot, settling, levels, and the delay to the receiver\'s VIH/VIL: the effective timing protocol.check applies (analog_runs). Compares with the RC closed form (0.8473 RC for 30-70 %, 2.1972 RC for 10-90 %); judges I2C tr/tf/Cb against a speed mode, RS-232 levels (±3..±15 V) and slew (≤ 30 V/µs). A lumped/line model, not a field solver.',
  input: z.object(busInput),
  run: (a, ctx) => busAnalog(a, ctx),
})

export const pullupTool = defineTool({
  name: 'protocol.pullup',
  description: 'I2C pull-up range by UM10204 section 7.1: Rp(min) = (VDD - VOL) / IOL (eq. 1), Rp(max) = tr / (0.8473 Cb) (eq. 2), with preferred values in range (calc.i2c_pullup does the arithmetic); the citation says the equations were not read from a PDF in the library (verified: null). With simulate, the chosen value is run through protocol.bus_analog and its SPICE 30-70 % rise time reported against the mode limit.',
  input: z.object({
    vdd: z.number().positive(),
    cb: z.number().positive().describe('total bus capacitance (F): pins + trace + cable'),
    mode: z.enum(['standard', 'fast', 'fast_plus']).optional(),
    vol: z.number().positive().optional(),
    iol: z.number().positive().optional(),
    rise_time: z.number().positive().optional().describe('design for this tr (s), at most the mode limit'),
    series: z.enum(['E6', 'E12', 'E24', 'E48', 'E96']).optional(),
    simulate: z.boolean().optional().describe('run the pick through protocol.bus_analog'),
  }),
  run: async (a, ctx) => {
    const r = i2cPullup({ vdd: a.vdd, capacitance: a.cb, mode: a.mode, vol: a.vol, iol: a.iol, rise_time: a.rise_time, series: a.series }) as Record<string, unknown>
    const cands = (r.candidates ?? []) as { rp_ohm: number; rise_time_s: number }[]
    const out: Record<string, unknown> = { ...r, citation: UM10204_PULLUP, via: 'calc.i2c_pullup' }
    const pick = cands[0]
    if (a.simulate && pick) {
      const sim = await busAnalog({ kind: 'open_drain', vdd: a.vdd, rp: pick.rp_ohm, cb: a.cb, vol: a.vol, iol: a.iol, speed: a.mode ?? 'fast' } as BusArgs, ctx)
      out.simulated = { rp_ohm: pick.rp_ohm, run_id: sim.run_id, spice_run_id: sim.spice_run_id, t_r: (sim.measured as Record<string, unknown>).t_r, t_r_closed_form: pick.rise_time_s, checks: sim.checks, pass: sim.pass }
    }
    return out
  },
})

// ------------------------------------------------------------------ protocol.diagram

function lanesOf(c: wave.Capture, names: readonly string[]): Lane[] {
  return names.map((n) => {
    const s = c.get(n)
    return { name: n, width: s.width, changes: s.t.map((t, k) => [t, s.v[k] as string] as const) }
  })
}

function annotationsFor(p: Protocol, c: wave.Capture, s: Record<string, wave.Signal>, d: DecodeArgs & { speed?: string | undefined }): Annotation[] {
  switch (p) {
    case 'i2c': return annotateI2c(s.scl as wave.Signal, s.sda as wave.Signal)
    case 'spi': return annotateSpi({ sck: s.sck as wave.Signal, mosi: s.mosi, miso: s.miso, cs: s.cs }, { mode: d.mode ?? 0, bits: d.bits ?? 8, lsbFirst: d.lsb_first, csActiveHigh: d.cs_active_high }, c.end)
    case 'uart': return d.baud ? annotateUart(s.tx as wave.Signal, { baud: d.baud, dataBits: d.data_bits, parity: d.parity, stopBits: d.stop_bits, invert: d.invert }, c.end) : []
    case 'can': return d.bitrate ? annotateCan(s.can as wave.Signal, { bitrate: d.bitrate, samplePoint: d.sample_point }, c.end) : []
    case 'onewire': return annotateOnewire(s.dq as wave.Signal, (d.speed as 'standard') ?? 'standard')
    case 'i2s': return annotateI2s({ sck: s.sck as wave.Signal, ws: s.ws as wave.Signal, sd: s.sd as wave.Signal }, { wordBits: d.bits ?? 16, format: d.format })
  }
}

const SYM: Readonly<Record<string, string>> = {
  t_low: 'tLOW', t_high: 'tHIGH', tsu_dat: 'tSU;DAT', thd_dat: 'tHD;DAT', tvd_dat: 'tVD;DAT', thd_sta: 'tHD;STA', tsu_sta: 'tSU;STA', tsu_sto: 'tSU;STO', t_buf: 'tBUF', f_scl: 'fSCL',
  tcss: 'tCSS', tcsh: 'tCSH', tcsd: 'tCSD', tsu: 'tSU', th: 'tH', tv: 'tV', tho: 'tHO', tsu_mi: 'tSU(MISO)', th_mi: 'tH(MISO)', f_sck: 'fSCK', t_sck_high: 'tHIGH', t_sck_low: 'tLOW',
  t_rstl: 'tRSTL', t_pdh: 'tPDH', t_pdl: 'tPDL', t_slot: 'tSLOT', t_low1: 'tLOW1', t_low0: 'tLOW0', t_rd0: 'tRD0', t_rec: 'tREC', baud_error: 'baud error',
}

function limitText(l: { min?: number | null; max?: number | null }, unit: string): string {
  const u = unit === 's' ? 's' : unit
  return [l.min !== undefined && l.min !== null ? `≥ ${eng(l.min, u)}` : '', l.max !== undefined && l.max !== null ? `≤ ${eng(l.max, u)}` : ''].filter(Boolean).join(' ')
}

/** Arrows from a protocol.check run's rows (only time spans: frequency rows have no two-event span to draw). */
function arrowsFromCheck(runId: string, roleToSignal: Record<string, string>): Arrow[] {
  const w = new Work()
  try {
    const r = w.run(runId)
    if (!r || r.kind !== 'protocol.check') throw new ToolError(`${runId} is not a protocol.check run`)
    const rows = ((r.result as { rows?: Record<string, unknown>[] } | null)?.rows ?? [])
    const out: Arrow[] = []
    for (const row of rows) {
      const at = row.at as { t0?: number; t1?: number; from?: string; to?: string } | undefined
      if (!at || at.t0 === undefined || at.t1 === undefined || row.unit !== 's') continue
      const lim = row.limit as { min?: number; max?: number }
      out.push({
        t0: at.t0, t1: at.t1, from: roleToSignal[at.from ?? ''] ?? at.from, to: roleToSignal[at.to ?? ''] ?? at.to,
        label: `${SYM[String(row.parameter)] ?? row.parameter} ${eng(Number(row.measured), 's')}${limitText(lim, 's') ? ` (${limitText(lim, 's')})` : ''}`,
        pass: row.status === 'pass' ? true : row.status === 'fail' ? false : null,
      })
    }
    return out
  } finally {
    w.close()
  }
}

/** The spec's timing drawn: a model run at the spec's own limits, its measured spans labelled with the limits. */
function specPanel(device: string, p: Protocol): { panel: Panel; model: ModelRun } {
  const s = specMap(device, p)
  const mn = (k: string): number | undefined => s.get(k)?.min
  const mx = (k: string): number | undefined => s.get(k)?.max
  let m: ModelRun
  if (p === 'i2c') {
    const f = mx('f_scl') ?? 400e3
    const speed: I2cSpeed = f <= 100e3 ? 'standard' : f <= 400e3 ? 'fast' : f <= 1e6 ? 'fast_plus' : 'high_speed'
    const std = I2C_STANDARD[speed]
    const tl = mn('t_low') ?? (std.t_low?.min as number)
    const th = mn('t_high') ?? (std.t_high?.min as number)
    const T = Math.max(1 / f, tl + th)
    const tLow = T * (tl / (tl + th))
    const tsu = mn('tsu_dat') ?? (std.tsu_dat?.min as number)
    const thd = Math.min(Math.max(mn('thd_dat') ?? 0, tLow / 8), tLow - tsu)
    m = runModel('i2c', {
      speed: speed === 'high_speed' ? 'fast_plus' : speed, f_scl: 1 / T, t_low: tLow, t_high: T - tLow, thd_dat: Math.max(thd, 0),
      ...(mn('thd_sta') ? { thd_sta: mn('thd_sta') } : {}), ...(mn('tsu_sta') ? { tsu_sta: mn('tsu_sta') } : {}), ...(mn('tsu_sto') ? { tsu_sto: mn('tsu_sto') } : {}), ...(mn('t_buf') ? { t_buf: mn('t_buf') } : {}),
    }, [{ addr: 0x50, write: [0xa5], read: 1 }, { addr: 0x50, write: [0x00] }])
  } else if (p === 'spi') {
    const modes = s.get('modes')?.value
    const mode = Array.isArray(modes) && modes.length ? Number(modes[0]) : 0
    const f = mx('f_sck') ?? 1e6
    m = runModel('spi', {
      mode, f_sck: f, bits: 8, ...(mn('tcss') !== undefined ? { t_css: mn('tcss') } : {}), ...(mn('tcsh') !== undefined ? { t_csh: mn('tcsh') } : {}), ...(mn('tcsd') !== undefined ? { t_csd: mn('tcsd') } : {}),
      tv_slave: mx('tv') ?? 0, ...(mn('tho') !== undefined ? { tho_slave: mn('tho') } : {}),
    }, [{ mosi: [0xa5], miso: [0x3c] }, { mosi: [0x0f], miso: [0xf0] }])
  } else if (p === 'uart') {
    const baud = s.get('baud')?.typ ?? 115200
    m = runModel('uart', { baud }, [{ text: 'U' }])
  } else throw new ToolError(`spec diagrams are drawn for i2c, spi and uart, not ${p}`)
  const c = m.wave.capture()
  const sig = Object.fromEntries(m.wave.names().map((n) => [n, c.get(n)]))
  const meas = measureFor(p, sig, m.decode as DecodeArgs, c.end).measured
  const arrows: Arrow[] = []
  for (const x of meas) {
    const row = s.get(x.parameter)
    if (!row || x.t0 === undefined || x.t1 === undefined || x.unit !== 's') continue
    const cite = row.citation.page ? ` p.${row.citation.page}` : ''
    arrows.push({ t0: x.t0, t1: x.t1, from: x.from, to: x.to, label: `${SYM[x.parameter] ?? x.parameter} ${limitText({ min: row.min, max: row.max }, 's')} (spec${cite}${row.citation.verified ? '' : ', unverified'})`, pass: null })
  }
  return { panel: { title: `${device}: ${p.toUpperCase()} spec timing (drawn at the spec limits)`, lanes: lanesOf(c, m.wave.names()), decode: m.wave.annotations, arrows, cursors: [], from: 0, to: m.wave.end }, model: m }
}

export const diagramTool = defineTool({
  name: 'protocol.diagram',
  description: 'Timing diagram of a capture (protocol.model run, sim.logic VCD, logic-analyser or scope capture, file) or of a stored spec (spec mode: the datasheet timing drawn at the spec limits), or both stacked to compare. Signal lanes, bus lanes with values, decoded-protocol rows (START, ADDR 0x50 W, ACK, DATA …), measurement arrows from a protocol.check run (measured against the limit, green pass / red fail), time cursors, zoom to a window or a transaction. Output: diagram.svg (written in TypeScript, no dependency), diagram.png when a rasteriser is installed (resvg, rsvg-convert or sharp; otherwise skipped and said so), and WaveDrom JSON as text in the result (sampled on a fixed tick, so approximate). Recorded.',
  input: z.object({
    ...source,
    protocol: protocol.optional().describe('for the decoded rows (a protocol.model run knows its own)'),
    ...decodeArgs,
    speed: z.enum(['standard', 'overdrive']).optional().describe('1-Wire decode speed'),
    lanes: z.array(z.string()).max(32).optional().describe('signals to draw, in order (default every signal, or the protocol\'s roles)'),
    from: z.number().optional(),
    to: z.number().optional(),
    transaction: z.number().int().min(0).optional().describe('zoom to this transaction (0-based)'),
    cursors: z.array(z.object({ t: z.number(), label: z.string().max(40) }).strict()).max(20).optional(),
    check_run_id: z.string().optional().describe('draw the measurement arrows of this protocol.check run'),
    spec: z.object({ device: z.string(), protocol }).strict().optional().describe('draw this stored spec (alone, or under the capture to compare)'),
    title: z.string().max(120).optional(),
    width: z.number().int().min(400).max(4000).optional(),
    png: z.boolean().optional().describe('try to rasterise (default true)'),
    out: z.string().optional().describe('also write the SVG to this path'),
  }),
  run: async (a) => {
    const panels: Panel[] = []
    let subject = 'spec'
    if (a.file || a.run_id) {
      const c = await loadCapture(a)
      const fromModel = a.run_id ? modelRunInfo(a.run_id) : null
      const p = a.protocol ?? fromModel?.protocol
      const d: DecodeArgs & { speed?: string | undefined } = { ...(fromModel?.decode as DecodeArgs | undefined), ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) }
      const lv = levelsOf(a)
      const roleMap: Record<string, string> = p ? { ...Object.fromEntries(ROLES[p].map((r) => [r, r])), ...(a.signals ?? {}) } : {}
      const roleSignals = Object.values(roleMap).map((n) => c.resolve(n)).filter((n): n is string => n !== undefined)
      const names = a.lanes ?? (p ? [...new Set([...roleSignals, ...[...c.signals.keys()].filter((n) => !roleSignals.includes(n))])] : [...c.signals.keys()])
      const decode: Annotation[] = fromModel ? fromModel.annotations : p ? guard(() => annotationsFor(p, c, bind(c, p, a.signals, lv), d)) : []
      let from = a.from ?? c.start
      let to = a.to ?? c.end
      if (a.transaction !== undefined) {
        const tx = decode.filter((x) => x.tx === a.transaction)
        if (!tx.length) throw new ToolError(`no transaction ${a.transaction} in the decoded rows (there are ${new Set(decode.map((x) => x.tx)).size})`)
        const t0 = Math.min(...tx.map((x) => x.t0))
        const t1 = Math.max(...tx.map((x) => x.t1))
        const pad = (t1 - t0) * 0.06
        from = t0 - pad
        to = t1 + pad
      }
      const arrows = a.check_run_id ? arrowsFromCheck(a.check_run_id, roleMap) : []
      const lanes = lanesOf(c, names.map((n) => c.resolve(n) ?? n))
      // short lane names (the leaf, when unique): arrows name signals by role or leaf
      for (const l of lanes) { const leaf = l.name.split('.').pop() ?? l.name; if (c.resolve(leaf) === l.name) l.name = leaf }
      panels.push({ title: a.title ?? `${p ? `${p.toUpperCase()} ` : ''}${a.run_id ? `run ${a.run_id}` : a.file}`, lanes, decode, arrows, cursors: a.cursors ?? [], from, to })
      subject = a.run_id ?? a.file ?? 'capture'
    }
    if (a.spec) panels.push(guard(() => specPanel(a.spec?.device as string, a.spec?.protocol as Protocol)).panel)
    if (!panels.length) throw new ToolError('give a capture (file or run_id), a spec, or both')
    const svg = renderSvg(panels, a.width ?? 1200)
    const wd = wavedrom(panels[0] as Panel)
    const png = a.png === false ? { png: null, via: null, note: 'not asked for' } : await rasterise(svg)
    const rec = new Recorder('protocol.diagram', subject, a)
    rec.artifact('diagram.svg', svg, 'image/svg+xml')
    if (png.png) rec.artifact('diagram.png', png.png, 'image/png')
    const wdText = JSON.stringify(wd.json)
    rec.artifact('wavedrom.txt', wdText, 'text/plain')
    if (a.out) writeFileSync(resolve(a.out), svg)
    const p0 = panels[0] as Panel
    rec.measure('arrows', panels.reduce((n, p) => n + p.arrows.length, 0))
    rec.finish('pass', `${panels.length} panel(s), ${p0.lanes.length} lane(s), ${eng(p0.to - p0.from)} window${png.png ? ', PNG' : ''}`, { panels: panels.length, window: [p0.from, p0.to] })
    return {
      run_id: rec.id, artifacts: ['diagram.svg', ...(png.png ? ['diagram.png'] : []), 'wavedrom.txt'], panels: panels.map((p) => ({ title: p.title, lanes: p.lanes.map((l) => l.name), decoded: p.decode.length, arrows: p.arrows.length, window: [r6(p.from), r6(p.to)] })),
      png: png.png ? { via: png.via, bytes: png.png.length } : { skipped: png.note },
      svg_bytes: svg.length, ...(a.out ? { written: resolve(a.out) } : {}),
      wavedrom: wdText, wavedrom_tick_s: r6(wd.tick),
    }
  },
})

// ------------------------------------------------------------------ protocol.capture

export const captureTool = defineTool({
  name: 'protocol.capture',
  description: 'Capture a real bus and turn it into a VCD (artifact capture.vcd), then (with protocol) check it like protocol.check. source sigrok: sigrok-cli with a logic analyser (fx2lafw by default; not installed by trace, reported when missing). scope: hil.scope_capture\'s analog channels, digitised at a threshold or VIL/VIH. mso: an oscilloscope\'s digital channels over SCPI via hil.scpi (Rigol MSO5000-style commands by default; other instruments need their own; not tried on an instrument here). Drives hardware: only with TRACE_HARDWARE=1.',
  hardware: true,
  input: z.object({
    source: z.enum(['sigrok', 'scope', 'mso']),
    roles: z.record(z.string(), z.string()).describe('role → channel: {"scl": "D0", "sda": "D1"} (sigrok/mso channel names, or scope CH1/CH2)'),
    // sigrok
    driver: z.string().optional().describe('sigrok driver (default fx2lafw)'),
    samplerate: z.number().positive().optional().describe('sigrok samples per second (default 8 MHz)'),
    samples: z.number().int().positive().optional(),
    time_ms: z.number().positive().optional(),
    trigger: z.string().optional().describe('sigrok trigger, e.g. D1=f'),
    // scope / mso
    instrument: z.string().optional(),
    address: z.string().optional(),
    scope: z.record(z.string(), z.unknown()).optional().describe('scope: hil.scope_capture args (setup, timebase_s, trigger, acquire, fetch …)'),
    commands: z.array(z.string()).optional().describe('mso: the per-channel command sequence with {n} for the channel; the last is the binary data query'),
    threshold: z.number().optional(),
    vil: z.number().optional(),
    vih: z.number().optional(),
    timeout_s: z.number().positive().max(600).optional(),
    // the check
    protocol: protocol.optional(),
    check: z.record(z.string(), z.unknown()).optional().describe('protocol.check args besides the capture (device, standard, mode, baud, limits …)'),
  }),
  run: async (a, ctx) => {
    const rec = new Recorder('protocol.capture', a.source, a)
    let vcd: string
    const evidence: string[] = []
    try {
      if (a.source === 'sigrok') {
        const channels = Object.entries(a.roles).map(([role, ch]) => `${ch}=${role}`)
        const r = await sigrokCapture({ driver: a.driver ?? 'fx2lafw', channels, samplerate: a.samplerate ?? 8e6, samples: a.samples, time_ms: a.time_ms, trigger: a.trigger, timeout_s: a.timeout_s ?? 60 })
        vcd = r.vcd
        rec.artifact('argv.txt', r.argv.join(' '))
      } else if (a.source === 'scope') {
        const { allTools } = await import('../index.js')
        const sc = (await allTools().call('hil.scope_capture', { ...(a.instrument ? { instrument: a.instrument } : {}), ...(a.address ? { address: a.address } : {}), ...(a.scope ?? {}) }, ctx)) as { run_id: string }
        evidence.push(sc.run_id)
        const conv = await analogCsvToVcd(readArtifact(sc.run_id, 'waveform.csv'), a.roles, { threshold: a.threshold, vil: a.vil, vih: a.vih })
        vcd = conv.vcd
      } else {
        const { allTools } = await import('../index.js')
        const seq = a.commands ?? [':WAV:SOUR D{n}', ':WAV:MODE NORM', ':WAV:FORM BYTE', ':WAV:XINC?', ':WAV:XOR?', ':WAV:DATA?']
        const chans: { role: string; bytes: Uint8Array; xinc: number; xorig: number }[] = []
        for (const [role, ch] of Object.entries(a.roles)) {
          const n = /(\d+)$/.exec(ch)?.[1]
          if (n === undefined) throw new ToolError(`${role}: mso channels are D0, D1, …`)
          const r = (await allTools().call('hil.scpi', { ...(a.instrument ? { instrument: a.instrument } : {}), ...(a.address ? { address: a.address } : {}), commands: seq.map((x) => x.replaceAll('{n}', n)), binary: true }, ctx)) as { run_id: string; replies: { command: string; reply?: string }[] }
          evidence.push(r.run_id)
          const q = (k: RegExp): number => Number(r.replies.find((x) => k.test(x.command))?.reply ?? NaN)
          chans.push({ role, bytes: readArtifact(r.run_id, 'block.bin'), xinc: q(/XINC/i), xorig: q(/XOR/i) })
        }
        vcd = msoToVcd(chans)
      }
      rec.artifact('capture.vcd', vcd, 'text/x-vcd')
      const cap = wave.parseVcdText(vcd)
      const summary = wave.summarize(cap, { limit: 16 })
      rec.finish('pass', `${a.source}: ${cap.signals.size} signal(s), ${eng(cap.end - cap.start)}`, { summary, evidence })
    } catch (e) {
      rec.fail(e)
      throw e
    }
    const out: Record<string, unknown> = { run_id: rec.id, artifact: 'capture.vcd', evidence }
    if (a.protocol) {
      const ck = checkTool.input.parse({ ...(a.check ?? {}), run_id: rec.id, artifact: 'capture.vcd', protocol: a.protocol })
      out.check = await runCheck(ck)
    }
    return out
  },
})

// ------------------------------------------------------------------ protocol.testbench

export const testbenchTool = defineTool({
  name: 'protocol.testbench',
  description: 'A self-checking Verilog testbench from a protocol model (config + transactions, as protocol.model): the initiator\'s signals replayed into a DUT edge for edge at the model\'s timing, and every bit the DUT must drive checked where the initiator samples it. spi (DUT ports sck, cs, mosi, miso), i2c (scl, sda_in, sda_low: the DUT pulls SDA low while sda_low is 1), uart (rx, data, valid, with a clock). MISMATCH lines and $fatal on failure, ALL TESTS PASSED otherwise; TRACE_COVER lines per clean transaction and response value for verify.coverage. With run, sim.logic runs it with the DUT sources and the verdict comes back. Verilog only (no cocotb output).',
  input: z.object({
    protocol: z.enum(['spi', 'i2c', 'uart']),
    config: z.record(z.string(), z.unknown()).optional(),
    transactions: z.array(z.record(z.string(), z.unknown())).min(1).max(2000),
    dut: z.object({
      module: z.string(),
      instance: z.string().optional(),
      ports: z.record(z.string(), z.string()).describe('role → port'),
      ties: z.record(z.string(), z.string()).optional().describe('constant inputs: port → Verilog constant'),
      params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      clock: z.object({ port: z.string(), hz: z.number().positive() }).strict().optional(),
      reset: z.object({ port: z.string(), active: z.union([z.literal(0), z.literal(1)]), s: z.number().positive() }).strict().optional(),
      data_bits: z.number().int().min(5).max(9).optional(),
    }).strict(),
    name: z.string().optional().describe('testbench module name (default <dut>_tb)'),
    out: z.string().optional().describe('write the testbench to this path'),
    run: z.boolean().optional().describe('run it with sim.logic'),
    dut_files: z.array(z.string()).optional().describe('with run: the DUT sources'),
  }),
  run: async (a, ctx) => {
    const m = guard(() => runModel(a.protocol, a.config ?? {}, a.transactions))
    const windows = [...new Set(m.wave.annotations.map((x) => x.tx).filter((x): x is number => x !== undefined))].sort((x, y) => x - y).map((k) => {
      const an = m.wave.annotations.filter((x) => x.tx === k)
      return [Math.min(...an.map((x) => x.t0)), Math.max(...an.map((x) => x.t1))] as [number, number]
    })
    const bytes = a.protocol === 'uart' ? (m.expected as { kind: string; value: number | null }[]).filter((e) => e.kind === 'frame').map((e) => e.value as number) : undefined
    const text = guard(() => verilogTestbench({ protocol: a.protocol, wave: m.wave, dut: a.dut, name: a.name, expectedBytes: bytes, txWindows: windows }))
    const tbName = a.name ?? `${a.dut.module}_tb`
    if (a.out) writeFileSync(resolve(a.out), text)
    const out: Record<string, unknown> = { testbench: tbName, lines: text.split('\n').length, checks: m.wave.samples.length, transactions: m.expected.length, ...(a.out ? { written: resolve(a.out) } : {}) }
    if (a.run) {
      if (!a.dut_files?.length) throw new ToolError('run needs dut_files')
      const r = (await logicTool.run({ files: a.dut_files, sources: [{ name: `${tbName}.v`, text }], top: tbName, pass: 'ALL TESTS PASSED', fail: 'MISMATCH' } as never, ctx)) as Record<string, unknown>
      Object.assign(out, { run_id: r.run_id, passed: r.passed, reason: r.reason, output: (r.output as string[] | undefined)?.slice(-12) })
    } else out.text = text
    return out
  },
})

export const tools: AnyTool[] = [
  modelTool, specTool, specExtractTool, checkTool, compatTool, busAnalogTool, pullupTool, diagramTool, captureTool, testbenchTool,
] as unknown as AnyTool[]

/** For the README and tests: the parameter vocabularies. */
export const VOCAB = { i2c: I2C_PARAMS, spi: SPI_PARAMS }
