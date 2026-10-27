/**
 * The bench emulator: hardware in the loop without the hardware. It starts a power supply, an oscilloscope and a
 * multimeter on local TCP ports (each a SCPI instrument from scpi.ts, speaking a real instrument's dialect) wired to a
 * model of the sample board (board.ts), and optionally the board's firmware console on a pseudo-terminal
 * (serial.ts). The hil tools reach it exactly as they reach real instruments: through the project settings that
 * `settings` holds, with TRACE_HARDWARE=1.
 *
 *   bench-psu    Rigol DP832 dialect. CH1 is the board's VIN. Limits 13 V / 0.1 A. The board draws VIN / 52 kΩ.
 *   bench-dmm    Keysight 34465A dialect, its probes on ADC_IN:
 *                  VOLT:DC   ADC_IN = VIN · 13/52 with the output on (else 0), clamped at 3.3 V + 0.25 V
 *                  CURR:DC   the board's supply current, VIN / 52 kΩ
 *                  RES/FRES  a Pt100 on the board at 25 °C (109.73 Ω), for thermal.measure's dmm_rtd
 *                  TEMP      25 °C, for thermal.measure's dmm_temp
 *                  FREQ      0
 *   bench-scope  Rigol DS1104Z dialect, 1200 points at 5 µs from −0.6 ms:
 *                  CH1  ADC_IN: the last change of VIN at t = 0 through the RC filter (τ ≈ 160 µs, 10-90 % ≈ 350 µs),
 *                       or flat at ADC_IN when VIN has not changed
 *                  CH2  the probe-compensation square wave: 1 kHz, 3.2 Vpp, centred on 0 V (what the hil tests use)
 *                  CH3, CH4  0 V
 *   bench-uart   (serial: true) the firmware console on /dev/pts/N: `adc raw=… mv=…` each second while VIN ≥ 4 V,
 *                answers READ, ID and HELP (serial.ts)
 *   bench-can    a hil.can entry on python-can's `virtual` interface, channel `bench`. A virtual bus exists only inside
 *                the one Python bridge process that opens it: the hil.can tools of one trace process (one MCP server,
 *                one test run) talk to each other on it; nothing in the emulator answers on it.
 *
 *   const bench = await startBench({ serial: true })
 *   for (const [key, value] of Object.entries(bench.settings)) setValue(key, value)
 *   …
 *   await bench.stop()
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changed, setValue, type CanBusConfig } from '../../../core/config.js'
import { AMBIENT_C, LOAD_OHMS, adcIn, adcStep, pt100 } from './board.js'
import { FakeScpi } from './scpi.js'
import { FirmwareConsole } from './serial.js'

export interface BenchOptions {
  /** the address the instruments listen on (default 127.0.0.1) */
  host?: string
  /** TCP ports (defaults psu 5555, scope 5556, dmm 5557; 0 = any free port) */
  ports?: { psu?: number; scope?: number; dmm?: number }
  /** also offer the firmware console on a pseudo-terminal (Linux/macOS, needs python3) */
  serial?: boolean
  /** with serial: a stable symlink to the pty to put in the settings (default <tmpdir>/trace-bench-uart-<psu port>) */
  serialLink?: string
}

export interface BenchInstrument {
  name: string
  kind: 'psu' | 'scope' | 'dmm'
  model: string
  address: string
  channels: number[]
  limits?: { max_voltage_v: number; max_current_a: number }
  note: string
}

export interface BenchSerial {
  name: string
  port: string
  baud: number
  note: string
}

/** The project settings the bench needs, by setting key (each value is valid for core/config.ts setValue). */
export interface BenchSettings {
  'hil.instruments': BenchInstrument[]
  'hil.can': Pick<CanBusConfig, 'name' | 'interface' | 'channel'>[]
  'hil.serial'?: BenchSerial[]
}

export interface Bench {
  settings: BenchSettings
  /** the instruments, for tests that look at or change their state */
  psu: FakeScpi
  scope: FakeScpi
  dmm: FakeScpi
  /** the pty's device path, when serial is on */
  serialDevice: string | null
  /** VIN as the board sees it now (0 with the output off) */
  vin(): number
  stop(): Promise<void>
}

export const BENCH_PORTS = { psu: 5555, scope: 5556, dmm: 5557 } as const
export const BENCH_LIMITS = { max_voltage_v: 13, max_current_a: 0.1 } as const

/** A wildcard listen address is reached at loopback. */
const clientHost = (host: string): string => (host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host)

export async function startBench(o: BenchOptions = {}): Promise<Bench> {
  const host = o.host ?? '127.0.0.1'
  const ports = { ...BENCH_PORTS, ...o.ports }
  const psu = new FakeScpi('rigol-dp832')
  const scope = new FakeScpi('rigol-ds1104z')
  const dmm = new FakeScpi('keysight-34465a')
  for (const i of [psu, scope, dmm]) i.keepLog = false
  // a fresh bench: everything off, CH1 loaded by the board's divider
  psu.psu[0]!.r = LOAD_OHMS

  const vin = (): number => {
    const c = psu.psu[0]!
    // the supply holds its set voltage while the board's current is under the limit (it always is: 0.25 mA at 13 V)
    return c.on && c.v / c.r <= c.i ? c.v : c.on ? c.i * c.r : 0
  }

  // the last change of VIN, which the scope's CH1 shows at its trigger point
  let lastVin = 0
  let step: { from: number; to: number } | null = null
  let uart: FirmwareConsole | null = null
  psu.model = {
    onCommand: () => {
      const now = vin()
      if (now !== lastVin) { step = { from: lastVin, to: now }; lastVin = now }
      uart?.poll()
    },
  }

  dmm.model = {
    dmmReading: (func) => {
      if (/^VOLT(:DC)?$/.test(func)) return adcIn(vin())
      if (/^VOLT:AC$/.test(func)) return 0
      if (/^CURR(:DC)?$/.test(func)) return vin() / LOAD_OHMS
      if (/^CURR:AC$/.test(func)) return 0
      if (/^F?RES$/.test(func)) return pt100(AMBIENT_C)
      if (/^TEMP/.test(func)) return AMBIENT_C
      if (/^(FREQ|PER)/.test(func)) return 0
      if (/^CONT$/.test(func)) return 9.9e37
      if (/^DIOD$/.test(func)) return 0.3
      return 9.9e37
    },
  }

  scope.model = {
    waveform: (ch, points, xinc, xorig) => {
      if (ch === 2) return null // the default square wave
      const v = new Float64Array(points)
      if (ch !== 1) return v
      const s = step ?? { from: vin(), to: vin() }
      for (let i = 0; i < points; i++) v[i] = adcStep(s.from, s.to, xorig + i * xinc)
      return v
    },
  }

  const started: { stop(): Promise<void> }[] = []
  try {
    await psu.start(ports.psu, host)
    started.push(psu)
    await scope.start(ports.scope, host)
    started.push(scope)
    await dmm.start(ports.dmm, host)
    started.push(dmm)
    if (o.serial) {
      uart = new FirmwareConsole(vin)
      await uart.start(o.serialLink ?? join(tmpdir(), `trace-bench-uart-${psu.port}`))
      started.push(uart)
    }
  } catch (e) {
    for (const s of started.reverse()) await s.stop()
    throw e
  }

  const at = (i: FakeScpi): string => `TCPIP::${clientHost(host)}::${i.port}::SOCKET`
  const settings: BenchSettings = {
    'hil.instruments': [
      { name: 'bench-psu', kind: 'psu', model: 'rigol-dp800', address: at(psu), channels: [1], limits: { ...BENCH_LIMITS },
        note: "bench emulator (tracectl hil emulate): Rigol DP832; CH1 is the sample board's VIN" },
      { name: 'bench-scope', kind: 'scope', model: 'rigol-ds1000z', address: at(scope), channels: [1, 2, 3, 4],
        note: 'bench emulator: Rigol DS1104Z; CH1 is ADC_IN (the last VIN step through the RC filter), CH2 a 1 kHz 3.2 Vpp square' },
      { name: 'bench-dmm', kind: 'dmm', model: 'keysight-344xx', address: at(dmm), channels: [1],
        note: 'bench emulator: Keysight 34465A on ADC_IN (VIN x 13/52 with the PSU output on)' },
    ],
    'hil.can': [{ name: 'bench-can', interface: 'virtual', channel: 'bench' }],
  }
  if (uart) {
    settings['hil.serial'] = [{ name: 'bench-uart', port: uart.path, baud: 115200,
      note: `bench emulator: the sample firmware's console (pty ${uart.device}); adc raw=… mv=… each second, answers READ` }]
  }

  let stopped = false
  return {
    settings,
    psu, scope, dmm,
    serialDevice: uart?.device ?? null,
    vin,
    stop: async () => {
      if (stopped) return
      stopped = true
      for (const s of started.reverse()) await s.stop()
    },
  }
}

/**
 * Write the bench's entries into a project's settings (.trace/project.db): each hil list keeps its other entries, and
 * an entry with a bench name is replaced. Returns the keys written.
 */
export function writeBenchSettings(settings: BenchSettings, root?: string): string[] {
  const own = changed(root)
  const keys: string[] = []
  for (const [key, entries] of Object.entries(settings) as [keyof BenchSettings, { name: string }[]][]) {
    const names = new Set(entries.map((e) => e.name))
    const current = Array.isArray(own[key]) ? (own[key] as { name?: unknown }[]) : []
    setValue(key, [...current.filter((e) => typeof e.name !== 'string' || !names.has(e.name)), ...entries], root)
    keys.push(key)
  }
  return keys
}
