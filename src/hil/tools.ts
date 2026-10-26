/**
 * The hil tools: the bench's serial ports, CAN buses and SCPI instruments, for agents.
 *
 * Every tool that drives a port, bus or instrument is `hardware: true` (refused unless the session allows hardware).
 * Every session is recorded in the project database (record.ts): transcripts, logs and waveforms as artifacts,
 * readings as measurements, and the run id comes back as `run_id` for trace.run / trace.artifact. Responses are
 * compact: tails, previews and decimated waveforms; the whole capture is in the record.
 */
import { z } from 'zod'
import { bridge } from '../core/bridge.js'
import { defineTool, ToolError, type AnyTool } from '../core/registry.js'
import { hexBytes, printable, tail } from './bytes.js'
import { CanSession, hexId, parseId, withBus, encode, type Filter, type Frame } from './can.js'
import { round, session } from './instruments/base.js'
import { DMM_DIALECTS, dmmUnit, parseReading, type DmmFunction } from './instruments/dmm.js'
import { psu } from './instruments/psu.js'
import { SCOPE_DIALECTS, decimate, single, stats, statsFor, toCsv, type MeasureKind, type Waveform } from './instruments/scope.js'
import { record } from './record.js'
import { canBus, instrument, serialPort, settings } from './resources.js'
import { capture, faultLines, listPorts, runExpect, SerialSession, unescape } from './serial.js'
import { drainErrors, idn, num, parseAddress, withTransport } from './scpi.js'
import { pickDialect } from './instruments/base.js'
import { PSU_DIALECTS } from './instruments/psu.js'

const instArgs = {
  instrument: z.string().optional().describe('an instrument name from hil.instruments'),
  address: z.string().optional().describe('or an explicit address: TCPIP::host::5025::SOCKET, tcp://host:port, TCPIP::host::INSTR, USB0::…::INSTR, ASRL/dev/ttyUSB0::INSTR'),
}
const serialArgs = {
  serial: z.string().optional().describe('a serial port name from hil.serial'),
  port: z.string().optional().describe('or a device path, or USB VID:PID[:serial]'),
  baud: z.number().int().positive().optional().describe('override the baud rate'),
}
const canArgs = {
  bus: z.string().optional().describe('a CAN bus name from hil.can'),
  interface: z.string().optional().describe('or a python-can interface (socketcan, pcan, slcan, kvaser, virtual, …)'),
  channel: z.string().optional().describe('with interface: can0, PCAN_USBBUS1, …'),
  bitrate: z.number().int().positive().optional(),
}
const FilterIn = z.object({ id: z.union([z.number().int(), z.string()]), mask: z.number().int().optional(), extended: z.boolean().optional() }).strict()
const toFilters = (f: z.output<typeof FilterIn>[] | undefined): Filter[] | undefined => f?.map((x) => ({ id: parseId(x.id), mask: x.mask, extended: x.extended }))

// ------------------------------------------------------------------ discovery

export const ports = defineTool({
  name: 'hil.ports',
  description: 'List serial ports (path, USB VID:PID, serial number, description), the configured hil.serial/can/instruments names, and optionally VISA resources.',
  input: z.object({ visa: z.boolean().default(false).describe('also list VISA resources (USBTMC/GPIB/VXI-11) through pyvisa') }),
  run: async ({ visa }) => {
    const cfg = settings().hil
    const serial = await listPorts()
    const out: Record<string, unknown> = {
      serial,
      configured: {
        serial: cfg.serial.map((s) => ({ name: s.name, port: s.port, baud: s.baud })),
        can: cfg.can.map((c) => ({ name: c.name, interface: c.interface, channel: c.channel, bitrate: c.bitrate, fd: c.fd })),
        instruments: cfg.instruments.map((i) => ({ name: i.name, kind: i.kind, model: i.model ?? null, address: i.address })),
      },
    }
    if (visa) {
      try {
        out.visa = await bridge().call('visa.list', {}, z.object({ resources: z.array(z.string()), error: z.string().optional() }), 30_000)
      } catch (e) {
        out.visa = { resources: [], error: e instanceof Error ? e.message : String(e) }
      }
    }
    return out
  },
})

// ------------------------------------------------------------------ serial

const Step = z.object({
  send: z.string().optional().describe('text to send (\\n \\r \\t \\xNN escapes); the port newline is added unless raw'),
  send_hex: z.string().optional().describe('bytes to send, as hex'),
  expect: z.string().optional().describe('a regex the reply must match (named groups are returned)'),
  timeout_s: z.number().positive().max(600).optional(),
  delay_ms: z.number().int().min(0).max(60_000).optional(),
  raw: z.boolean().optional(),
}).strict()

export const serialExpect = defineTool({
  name: 'hil.serial_expect',
  description: 'Run a send/expect script on a serial port: each step sends text or hex and waits for a regex, with a timeout. Stops at the first unmet expect. The transcript is recorded.',
  hardware: true,
  input: z.object({
    ...serialArgs,
    steps: z.array(Step).min(1).max(200),
    timeout_s: z.number().positive().max(600).default(5).describe('default per-step timeout'),
    settle_ms: z.number().int().min(0).max(10_000).default(0).describe('wait after opening (boards that reset on open), then discard input'),
  }),
  run: async (a) => {
    const cfg = serialPort(a.serial, a.port, a.baud)
    return record('hil.serial_expect', { subject: cfg.name, args: a }, async (rec) => {
      const s = await SerialSession.open(cfg)
      try {
        if (a.settle_ms) { await new Promise((r) => setTimeout(r, a.settle_ms)); s.rx.clear() }
        const r = await runExpect(s, a.steps, a.timeout_s)
        const transcript = s.rx.received()
        rec.artifact('transcript.txt', printable(transcript))
        const failed = r.steps.find((x) => !x.ok)
        rec.measure('steps_passed', r.steps.filter((x) => x.ok).length)
        return {
          status: r.ok ? 'pass' : 'fail',
          summary: r.ok ? `${r.steps.length} steps passed on ${s.path}` : `step ${failed?.step}: ${failed?.error ?? 'failed'}`,
          result: { ok: r.ok, port: s.path, steps: r.steps, tail: tail(printable(transcript), 15) },
        }
      } finally {
        await s.close()
      }
    })
  },
})

export const serialCapture = defineTool({
  name: 'hil.serial_capture',
  description: 'Capture a serial port for N seconds or until a regex, optionally sending something first. The log is recorded; returns its tail and any panic/HardFault/assert/error lines.',
  hardware: true,
  input: z.object({
    ...serialArgs,
    seconds: z.number().positive().max(3600).default(10),
    until: z.string().optional().describe('stop early when this regex matches'),
    send: z.string().optional().describe('text to send first (escapes allowed; no newline added)'),
    send_hex: z.string().optional(),
    tail_lines: z.number().int().min(1).max(500).default(30),
  }),
  run: async (a) => {
    const cfg = serialPort(a.serial, a.port, a.baud)
    let until: RegExp | undefined
    try { until = a.until ? new RegExp(a.until, 'm') : undefined } catch (e) { throw new ToolError(`until: ${e instanceof Error ? e.message : String(e)}`) }
    const first = a.send_hex ? hexBytes(a.send_hex) : a.send ? Buffer.from(unescape(a.send), 'utf8') : undefined
    return record('hil.serial_capture', { subject: cfg.name, args: a }, async (rec) => {
      const s = await SerialSession.open(cfg)
      try {
        const c = await capture(s, a.seconds, until, first)
        const text = printable(c.data)
        rec.artifact('serial.log', c.data, 'text/plain')
        const faults = faultLines(text)
        rec.measure('bytes', c.data.length, 'B')
        rec.measure('faults', faults.length)
        return {
          status: faults.length ? 'fail' : 'pass',
          summary: `${c.data.length} bytes in ${c.seconds} s from ${s.path}${c.stopped ? ' (matched until)' : ''}${faults.length ? `, ${faults.length} fault lines` : ''}`,
          result: { port: s.path, bytes: c.data.length, lines: text.split('\n').length, seconds: c.seconds, stopped_on_match: c.stopped, faults, tail: tail(text, a.tail_lines) },
        }
      } finally {
        await s.close()
      }
    })
  },
})

// ------------------------------------------------------------------ CAN

const FrameIn = z.object({
  id: z.union([z.number().int(), z.string()]).describe('11- or 29-bit id: 291, "0x123"'),
  data: z.string().default('').describe('hex bytes'),
  extended: z.boolean().optional(),
  fd: z.boolean().optional(),
  brs: z.boolean().optional(),
  rtr: z.boolean().optional(),
}).strict()

export const canSend = defineTool({
  name: 'hil.can_send',
  description: 'Send CAN frames (standard/extended ids, hex data, CAN FD), or a DBC message by name with signal values (needs cantools), and optionally collect the replies.',
  hardware: true,
  input: z.object({
    ...canArgs,
    frames: z.array(FrameIn).max(10_000).default([]),
    message: z.string().optional().describe('a DBC message name to encode (the bus needs a dbc)'),
    signals: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
    interval_ms: z.number().min(0).max(10_000).default(0),
    reply_timeout_ms: z.number().int().min(0).max(60_000).default(0).describe('then listen this long for replies'),
    reply_filters: z.array(FilterIn).optional(),
    reply_max: z.number().int().min(1).max(10_000).default(50),
  }),
  run: async (a) => {
    const bus = canBus(a.bus, a.interface, a.channel, a.bitrate)
    const frames: Frame[] = a.frames.map((f) => ({ ...f, id: parseId(f.id) }))
    if (a.message) {
      if (!bus.dbc) throw new ToolError(`${bus.name} has no dbc set in hil.can`)
      frames.push(await encode(dbcPath(bus.dbc), a.message, a.signals ?? {}))
    }
    if (!frames.length) throw new ToolError('give frames, or a DBC message with signals')
    return record('hil.can_send', { subject: bus.name, args: a }, async (rec) => withBus(bus, async (s: CanSession) => {
      if (a.reply_timeout_ms) await s.flush()
      const sent = await s.send(frames, a.interval_ms)
      let replies: Awaited<ReturnType<CanSession['receive']>> | undefined
      if (a.reply_timeout_ms) replies = await s.receive(a.reply_timeout_ms, a.reply_max, toFilters(a.reply_filters))
      const stats = await s.stats()
      rec.measure('sent', sent)
      if (replies) {
        rec.measure('replies', replies.frames.length)
        rec.artifact('replies.txt', replies.frames.map((f) => `${f.t.toFixed(6)} ${hexId(f.id, f.ext)} [${f.dlc}] ${f.data}`).join('\n'))
      }
      return {
        status: 'pass',
        summary: `sent ${sent} frame(s) on ${bus.name}${replies ? `, ${replies.frames.length} repl${replies.frames.length === 1 ? 'y' : 'ies'}` : ''}`,
        result: { bus: bus.name, sent, ...(a.message ? { encoded: frames.at(-1) } : {}), ...(replies ? { replies: replies.frames.slice(0, 50) } : {}), stats },
      }
    }))
  },
})

function dbcPath(p: string): string {
  if (p.startsWith('/')) return p
  const root = settings().root
  return root ? `${root}/${p}` : p
}

export const canCapture = defineTool({
  name: 'hil.can_capture',
  description: 'Capture a CAN bus for N seconds (id filters) into a candump/ASC/BLF/CSV/TRC log kept in the run record; returns frame counts per id, the first frames and bus statistics (DBC-decoded when the bus has a dbc and cantools is installed).',
  hardware: true,
  input: z.object({
    ...canArgs,
    seconds: z.number().positive().max(3600).default(5),
    format: z.enum(['candump', 'asc', 'blf', 'csv', 'trc']).default('candump'),
    filters: z.array(FilterIn).optional(),
  }),
  run: async (a) => {
    const bus = canBus(a.bus, a.interface, a.channel, a.bitrate)
    return record('hil.can_capture', { subject: bus.name, args: a }, async (rec) => withBus(bus, async (s) => {
      const c = await s.capture(a.seconds, a.format, toFilters(a.filters), bus.dbc ? dbcPath(bus.dbc) : undefined)
      const log = Buffer.from(c.log_base64, 'base64')
      rec.artifact(c.log_name, log, a.format === 'blf' ? 'application/octet-stream' : 'text/plain')
      rec.measure('frames', c.frames)
      rec.measure('error_frames', c.errors)
      rec.measure('rate', c.rate_fps, 'frames/s')
      const stats = await s.stats()
      return {
        status: c.errors ? 'fail' : 'pass',
        summary: `${c.frames} frames (${c.ids.length} ids) in ${c.seconds} s on ${bus.name}${c.errors ? `, ${c.errors} error frames` : ''}`,
        result: {
          bus: bus.name, frames: c.frames, error_frames: c.errors, seconds: c.seconds, rate_fps: c.rate_fps,
          ids: c.ids.slice(0, 100).map((x) => ({ id: hexId(x.id, x.id > 0x7ff), count: x.count })),
          first: c.first.slice(0, 10), ...(c.decoded.length ? { decoded: c.decoded.slice(0, 10) } : {}),
          log: { name: c.log_name, bytes: log.length }, stats,
        },
      }
    }))
  },
})

// ------------------------------------------------------------------ SCPI

export const scpi = defineTool({
  name: 'hil.scpi',
  description: 'Send raw SCPI to an instrument: commands in order, each ending in "?" is a query (its reply returned), or binary=true to read the last as an IEEE 488.2 block. Reports the error queue after. Raw SCPI bypasses the PSU limits, so it is refused on a PSU unless allow_psu is set.',
  hardware: true,
  input: z.object({
    ...instArgs,
    commands: z.array(z.string().min(1)).min(1).max(200),
    binary: z.boolean().default(false).describe('read the last query as a binary block (returned as hex, truncated)'),
    timeout_s: z.number().positive().max(600).optional(),
    allow_psu: z.boolean().default(false).describe('a PSU: you take responsibility for staying within its limits'),
  }),
  run: async (a) => {
    const inst = instrument(a.instrument, a.address)
    if (inst.kind === 'psu' && !inst.adhoc && !a.allow_psu) {
      throw new ToolError(`${inst.name} is a PSU: raw SCPI would bypass its limits; use hil.psu, or set allow_psu if you must`)
    }
    const timeoutMs = (a.timeout_s ?? inst.timeout_s) * 1000
    return record('hil.scpi', { subject: inst.name, args: a }, async (rec) => withTransport(inst.address, timeoutMs, async (t) => {
      const replies: { command: string; reply?: string; bytes?: number; hex?: string }[] = []
      for (const [i, c] of a.commands.entries()) {
        const last = i === a.commands.length - 1
        if (last && a.binary) {
          const b = await t.queryBinary(c, timeoutMs)
          rec.artifact('block.bin', b, 'application/octet-stream')
          replies.push({ command: c, bytes: b.length, hex: b.subarray(0, 64).toString('hex') })
        } else if (/\?(\s|$)/.test(c)) {
          replies.push({ command: c, reply: (await t.query(c, timeoutMs)).slice(0, 2000) })
        } else {
          await t.write(c)
          replies.push({ command: c })
        }
      }
      const errors = await drainErrors(t).catch((e: unknown) => [`(could not read SYST:ERR?: ${e instanceof Error ? e.message : String(e)})`])
      rec.artifact('session.txt', replies.map((r) => `> ${r.command}${r.reply !== undefined ? `\n< ${r.reply}` : r.bytes !== undefined ? `\n< <block ${r.bytes} bytes>` : ''}`).join('\n'))
      return { status: errors.length ? 'fail' : 'pass', summary: `${a.commands.length} command(s) to ${inst.name}${errors.length ? `, ${errors.length} SCPI error(s)` : ''}`, result: { instrument: inst.name, replies, errors } }
    }))
  },
})

export const idnTool = defineTool({
  name: 'hil.idn',
  description: 'Identify an instrument (*IDN?): manufacturer, model, serial, firmware, and the trace dialect it maps to; optionally *RST. Drains the error queue.',
  hardware: true,
  input: z.object({ ...instArgs, reset: z.boolean().default(false).describe('send *RST and wait for *OPC?') }),
  run: async (a) => {
    const inst = instrument(a.instrument, a.address)
    const transport = parseAddress(inst.address).kind
    return record('hil.idn', { subject: inst.name, args: a }, async () => withTransport(inst.address, inst.timeout_s * 1000, async (t) => {
      const id = await idn(t)
      const stale = await drainErrors(t).catch(() => [])
      if (a.reset) { await t.write('*RST'); num(await t.query('*OPC?', 20_000)) }
      const key = { manufacturer: id.manufacturer, model: id.model, serial: id.serial, firmware: id.firmware, raw: id.raw }
      const dialects: Record<string, string> = {
        psu: pickDialect(PSU_DIALECTS, 'psu', undefined, key).id,
        scope: pickDialect(SCOPE_DIALECTS, 'scope', undefined, key).id,
        dmm: pickDialect(DMM_DIALECTS, 'dmm', undefined, key).id,
      }
      const known = Object.entries(dialects).filter(([, v]) => v !== 'generic').map(([k, v]) => `${k}:${v}`)
      return { status: 'pass', summary: `${id.manufacturer} ${id.model}`, result: { instrument: inst.name, transport, ...id, dialect: known[0] ?? 'generic', errors_before: stale, reset: a.reset } }
    }))
  },
})

// ------------------------------------------------------------------ PSU

export const psuTool = defineTool({
  name: 'hil.psu',
  description: 'Bench PSU, one channel: set voltage and current limit, output on/off, measure. Set-points above the configured limits are refused; a PSU without limits never has its output enabled. Returns what the instrument reports it is set to (read back) and the measured output.',
  hardware: true,
  input: z.object({
    instrument: z.string().describe('a psu from hil.instruments (limits come from there)'),
    channel: z.number().int().positive().default(1),
    voltage: z.number().min(0).optional().describe('V'),
    current: z.number().min(0).optional().describe('current limit, A'),
    output: z.enum(['on', 'off']).optional(),
    measure: z.boolean().default(true),
  }),
  run: async (a) => {
    const inst = instrument(a.instrument, undefined, 'psu')
    return record('hil.psu', { subject: `${inst.name}:CH${a.channel}`, args: a }, async (rec) => {
      const st = await psu(inst, { channel: a.channel, voltage: a.voltage, current: a.current, output: a.output, measure: a.measure })
      rec.measure('set_voltage', st.set.voltage_v, 'V')
      rec.measure('set_current', st.set.current_a, 'A')
      if (st.measured) { rec.measure('voltage', st.measured.voltage_v, 'V'); rec.measure('current', st.measured.current_a, 'A') }
      rec.artifact('session.txt', st.commands.join('\n'))
      const { commands: _c, ...compact } = st
      void _c
      return {
        status: st.errors.length ? 'fail' : 'pass',
        summary: `CH${a.channel} set ${st.set.voltage_v} V / ${st.set.current_a} A, output ${st.output}${st.measured ? `, measured ${round(st.measured.voltage_v, 4)} V ${round(st.measured.current_a, 4)} A` : ''}`,
        result: compact,
      }
    })
  },
})

// ------------------------------------------------------------------ scope

const ChannelIn = z.object({
  channel: z.number().int().positive(),
  scale_v: z.number().positive().optional().describe('V/div'),
  offset_v: z.number().optional(),
  coupling: z.enum(['dc', 'ac', 'gnd']).optional(),
  probe: z.number().positive().optional().describe('attenuation: 1, 10, 100'),
  enabled: z.boolean().optional(),
}).strict()

const MEASURES = ['vpp', 'vmax', 'vmin', 'vavg', 'vrms', 'freq', 'period', 'rise', 'fall', 'duty'] as const
const MEASURE_UNIT: Record<MeasureKind, string> = { vpp: 'V', vmax: 'V', vmin: 'V', vavg: 'V', vrms: 'V', freq: 'Hz', period: 's', rise: 's', fall: 's', duty: '%' }

export const scopeCapture = defineTool({
  name: 'hil.scope_capture',
  description: 'Oscilloscope: set up channels, timebase and an edge trigger, take a single acquisition (or use what is on screen), and fetch waveforms scaled to volts/seconds. Full waveforms go into the run record as CSV; returns decimated points and statistics (Vpp, min/max, mean, RMS, frequency, rise/fall, duty) over every sample.',
  hardware: true,
  input: z.object({
    ...instArgs,
    setup: z.array(ChannelIn).default([]),
    timebase_s: z.number().positive().optional().describe('s/div'),
    position_s: z.number().optional(),
    trigger: z.object({ source: z.number().int().positive(), level_v: z.number(), slope: z.enum(['rising', 'falling', 'either']).default('rising') }).strict().optional(),
    acquire: z.enum(['single', 'none', 'stop']).default('single').describe('single: arm and wait; none: fetch what is there; stop: stop then fetch'),
    wait_s: z.number().positive().max(600).default(10).describe('how long to wait for the trigger'),
    fetch: z.array(z.number().int().positive()).default([1]).describe('channels to fetch'),
    max_points: z.number().int().min(10).max(5000).default(500).describe('points returned per channel (the record keeps all)'),
  }),
  run: async (a) => {
    const inst = instrument(a.instrument, a.address, 'scope')
    return record<Record<string, unknown>>('hil.scope_capture', { subject: inst.name, args: a }, async (rec) => {
      const { value, s } = await session(inst, SCOPE_DIALECTS, 'scope', async ({ t, dialect: d }) => {
        for (const c of a.setup) for (const cmd of d.channel(c)) await t.write(cmd)
        if (a.timebase_s !== undefined) for (const cmd of d.timebase(a.timebase_s, a.position_s)) await t.write(cmd)
        if (a.trigger) for (const cmd of d.trigger(a.trigger)) await t.write(cmd)
        let triggered: boolean | null = null
        if (a.acquire === 'single') triggered = await single(t, d, a.wait_s * 1000)
        else if (a.acquire === 'stop') for (const cmd of d.stop()) await t.write(cmd)
        const waves: { name: string; w: Waveform }[] = []
        if (triggered !== false) {
          for (const ch of a.fetch) waves.push({ name: `CH${ch}`, w: await d.fetch(t, ch, 0) })
        }
        return { triggered, waves }
      })
      if (value.triggered === false) {
        rec.artifact('session.txt', s.log.join('\n'))
        return { status: 'fail', summary: `no trigger in ${a.wait_s} s`, result: { instrument: inst.name, dialect: s.dialect.id, triggered: false, errors: s.errors } }
      }
      rec.artifact('waveform.csv', toCsv(value.waves), 'text/csv')
      rec.artifact('session.txt', s.log.join('\n'))
      const channels = value.waves.map(({ name, w }) => {
        const st = stats(w)
        for (const k of MEASURES) {
          const v = statsFor(st, k)
          if (v !== null) rec.measure(`${name}.${k}`, v, MEASURE_UNIT[k])
        }
        const dec = decimate(w, a.max_points)
        return {
          channel: name, points: st.points, t0_s: w.t0, dt_s: w.dt,
          stats: Object.fromEntries(Object.entries(st).map(([k, v]) => [k, typeof v === 'number' ? round(v, 5) : v])),
          t: dec.t, v: dec.v,
        }
      })
      return {
        status: s.errors.length ? 'fail' : 'pass',
        summary: channels.map((c) => `${c.channel} ${c.points} pts Vpp ${c.stats.vpp ?? '?'} V`).join('; '),
        result: { instrument: inst.name, dialect: s.dialect.id, triggered: value.triggered, channels, errors: s.errors, artifact: 'waveform.csv' },
      }
    })
  },
})

export const scopeMeasure = defineTool({
  name: 'hil.scope_measure',
  description: "Oscilloscope measurements on one channel (vpp, vmax, vmin, vavg, vrms, freq, period, rise, fall, duty) from the scope's own measurement system; any it cannot give are computed from the fetched waveform.",
  hardware: true,
  input: z.object({
    ...instArgs,
    channel: z.number().int().positive().default(1),
    measurements: z.array(z.enum(MEASURES)).min(1).default(['vpp', 'freq']),
    source: z.enum(['auto', 'instrument', 'waveform']).default('auto'),
  }),
  run: async (a) => {
    const inst = instrument(a.instrument, a.address, 'scope')
    return record('hil.scope_measure', { subject: `${inst.name}:CH${a.channel}`, args: a }, async (rec) => {
      const { value, s } = await session(inst, SCOPE_DIALECTS, 'scope', async ({ t, dialect: d }) => {
        const out: Record<string, { value: number | null; unit: string; from: 'instrument' | 'waveform' }> = {}
        if (a.source !== 'waveform') {
          for (const k of a.measurements) out[k] = { value: await d.measure(t, a.channel, k), unit: MEASURE_UNIT[k], from: 'instrument' }
        }
        const missing = a.measurements.filter((k) => out[k]?.value === null || out[k] === undefined)
        if (missing.length && a.source !== 'instrument') {
          const st = stats(await d.fetch(t, a.channel, 0))
          for (const k of missing) out[k] = { value: statsFor(st, k), unit: MEASURE_UNIT[k], from: 'waveform' }
        }
        return out
      })
      for (const [k, m] of Object.entries(value)) rec.measure(`CH${a.channel}.${k}`, m.value, m.unit, { from: m.from })
      rec.artifact('session.txt', s.log.join('\n'))
      return {
        status: s.errors.length ? 'fail' : 'pass',
        summary: Object.entries(value).map(([k, m]) => `${k} ${m.value === null ? '—' : round(m.value, 4)}${m.unit}`).join(', '),
        result: { instrument: inst.name, dialect: s.dialect.id, channel: a.channel, measurements: value, errors: s.errors },
      }
    })
  },
})

// ------------------------------------------------------------------ DMM

export const dmm = defineTool({
  name: 'hil.dmm',
  description: 'Bench DMM reading: DC/AC volts or amps, 2-/4-wire resistance, frequency, continuity, diode; range (or auto) and NPLC; N samples with mean/min/max/stdev.',
  hardware: true,
  input: z.object({
    ...instArgs,
    function: z.enum(['vdc', 'vac', 'idc', 'iac', 'res', 'fres', 'freq', 'cont', 'diode']).default('vdc'),
    range: z.union([z.number().positive(), z.literal('auto')]).default('auto'),
    nplc: z.number().positive().max(200).optional(),
    samples: z.number().int().min(1).max(1000).default(1),
  }),
  run: async (a) => {
    const inst = instrument(a.instrument, a.address, 'dmm')
    const fn: DmmFunction = a.function
    const unit = dmmUnit(fn)
    return record('hil.dmm', { subject: inst.name, args: a }, async (rec) => {
      const { value, s } = await session(inst, DMM_DIALECTS, 'dmm', async ({ t, dialect: d }) => {
        for (const c of d.configure(fn, a.range, a.nplc)) await t.write(c)
        const readings: (number | null)[] = []
        const perRead = Math.max(inst.timeout_s * 1000, (a.nplc ?? 10) * 25 + 2000)
        for (let i = 0; i < a.samples; i++) readings.push(parseReading(await t.query(d.read, perRead)))
        return readings
      })
      const ok = value.filter((x): x is number => x !== null)
      const mean = ok.length ? ok.reduce((x, y) => x + y, 0) / ok.length : null
      const sd = ok.length > 1 && mean !== null ? Math.sqrt(ok.reduce((x, y) => x + (y - mean) ** 2, 0) / (ok.length - 1)) : null
      rec.measure(fn, mean, unit, { samples: value.length, overloads: value.length - ok.length })
      if (value.length > 1) rec.artifact('readings.csv', `i,${fn}_${unit}\n${value.map((v, i) => `${i},${v ?? 'OL'}`).join('\n')}\n`, 'text/csv')
      return {
        status: s.errors.length || mean === null ? 'fail' : 'pass',
        summary: mean === null ? `${fn}: overload` : `${fn} ${round(mean, 6)} ${unit}${value.length > 1 ? ` (n=${value.length})` : ''}`,
        result: {
          instrument: inst.name, dialect: s.dialect.id, function: fn, unit, value: mean === null ? null : round(mean, 7),
          ...(value.length > 1 ? { min: Math.min(...ok), max: Math.max(...ok), stdev: sd === null ? null : round(sd, 4), samples: value.length } : {}),
          overload: value.some((x) => x === null), errors: s.errors,
        },
      }
    })
  },
})

/** The hil tools. */
export const tools: AnyTool[] = [ports, serialExpect, serialCapture, canSend, canCapture, scpi, idnTool, psuTool, scopeCapture, scopeMeasure, dmm] as unknown as AnyTool[]
