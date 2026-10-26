/**
 * Serial ports: list them, open one by name, path or USB VID:PID[:serial], run an expect script against it, and
 * capture what it prints. Built on the `serialport` package.
 *
 * Why it is shaped like this: a device on a serial port answers in its own time, or not at all. Every open, write and
 * read here has a deadline, the port is closed in a `finally`, and a capture returns what it has when its time is up.
 * Port listing on Linux reads sysfs directly (the serialport package's own listing needs `udevadm`, which containers
 * and minimal images lack). Tests swap in @serialport/binding-mock with `useBinding`.
 */
import { readFileSync, readdirSync, readlinkSync, existsSync } from 'node:fs'
import { basename, join, resolve as resolvePath } from 'node:path'
import type { BindingInterface, PortInfo } from '@serialport/bindings-cpp'
import { SerialPortStream } from '@serialport/stream'
import type { SerialPortConfig } from '../core/config.js'
import { ToolError } from '../core/registry.js'
import { ByteBuffer, Closed, Timeout, hexBytes, printable, sleep } from './bytes.js'

let binding: BindingInterface | null = null
let bindingIsMock = false

/** Use another binding (tests: MockBinding from @serialport/binding-mock). `null` restores the system one. */
export function useBinding(b: BindingInterface | null): void {
  binding = b
  bindingIsMock = b !== null
}

async function systemBinding(): Promise<BindingInterface> {
  if (binding) return binding
  try {
    const mod = await import('@serialport/bindings-cpp')
    binding = mod.autoDetect() as unknown as BindingInterface
    return binding
  } catch (e) {
    throw new ToolError(`the serialport native binding could not load (${e instanceof Error ? e.message : String(e)}); reinstall with npm install serialport`)
  }
}

export interface PortListing {
  path: string
  vid?: string
  pid?: string
  serial?: string
  manufacturer?: string
  description?: string
  by_id?: string
}

const lower = (s: string | undefined): string | undefined => (s ? s.toLowerCase() : undefined)

function readSys(dir: string, file: string): string | undefined {
  try {
    return readFileSync(join(dir, file), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/** Linux: /sys/class/tty/<name>/device → walk up to the USB device for idVendor/idProduct/serial/product. */
function listLinux(): PortListing[] {
  const out: PortListing[] = []
  let names: string[]
  try {
    names = readdirSync('/sys/class/tty')
  } catch {
    return out
  }
  const byId = new Map<string, string>()
  try {
    for (const l of readdirSync('/dev/serial/by-id')) {
      byId.set(resolvePath('/dev/serial/by-id', readlinkSync(join('/dev/serial/by-id', l))), l)
    }
  } catch { /* no by-id links */ }
  for (const name of names) {
    const dev = join('/sys/class/tty', name, 'device')
    if (!existsSync(dev)) continue // virtual consoles and ptys have no device
    if (!/^(ttyS|ttyACM|ttyUSB|ttyAMA|ttyXRUSB|ttyWCH|ttyMFD|ttyO|rfcomm|ttyTHS|ttyGS)/.test(name)) continue
    const path = `/dev/${name}`
    const item: PortListing = { path }
    let d: string
    try {
      d = resolvePath(join('/sys/class/tty', name), readlinkSync(dev))
    } catch {
      out.push(item)
      continue
    }
    for (let i = 0; i < 6 && d !== '/'; i++, d = resolvePath(d, '..')) {
      const vid = readSys(d, 'idVendor')
      if (vid) {
        item.vid = lower(vid)
        item.pid = lower(readSys(d, 'idProduct'))
        item.serial = readSys(d, 'serial')
        item.manufacturer = readSys(d, 'manufacturer')
        item.description = readSys(d, 'product')
        break
      }
    }
    // a ttyS with no USB parent and no driver-reported port is usually a phantom 8250 entry
    if (name.startsWith('ttyS') && !item.vid && readSys(join('/sys/class/tty', name), 'type') === '0') continue
    const id = byId.get(path)
    if (id) item.by_id = id
    out.push(item)
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export async function listPorts(): Promise<PortListing[]> {
  if (process.platform === 'linux' && !bindingIsMock) return listLinux()
  const b = await systemBinding()
  const infos: PortInfo[] = await withTimeout(b.list(), 10_000, 'listing serial ports')
  return infos.map((p) => ({
    path: p.path,
    vid: lower(p.vendorId),
    pid: lower(p.productId),
    serial: p.serialNumber,
    manufacturer: p.manufacturer,
    ...(p.pnpId ? { by_id: p.pnpId } : {}),
  }))
}

const USB_MATCH = /^([0-9a-f]{4}):([0-9a-f]{4})(?::(.+))?$/i

/** A port spec (a path, or USB VID:PID[:serial]) → a device path. */
export async function resolvePort(spec: string): Promise<string> {
  const m = USB_MATCH.exec(spec)
  if (!m) return spec
  const [, vid, pid, serial] = m
  const ports = await listPorts()
  const hits = ports.filter((p) => p.vid === vid?.toLowerCase() && p.pid === pid?.toLowerCase() && (!serial || p.serial === serial))
  if (hits.length === 1 && hits[0]) return hits[0].path
  if (!hits.length) {
    const usb = ports.filter((p) => p.vid).map((p) => `${p.path} ${p.vid}:${p.pid}${p.serial ? `:${p.serial}` : ''}`)
    throw new ToolError(`no serial port matches USB ${spec}${usb.length ? ` (USB ports: ${usb.join('; ')})` : ' (no USB serial ports found)'}`)
  }
  throw new ToolError(`${hits.length} ports match USB ${spec} (${hits.map((h) => `${h.path} serial ${h.serial ?? '?'}`).join('; ')}); add :serial to choose one`)
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new ToolError(`${what}: no answer in ${ms / 1000} s`)), ms) }),
  ])
}

/** An open port: bytes arrive in `rx`; write with a deadline; always `close()`. */
export class SerialSession {
  readonly rx = new ByteBuffer(16 * 1024 * 1024)

  private constructor(private readonly port: SerialPortStream, readonly path: string, readonly cfg: SerialPortConfig) {
    port.on('data', (d: Buffer) => this.rx.push(d))
    port.on('close', () => this.rx.end(new Error(`${path} closed`)))
    port.on('error', (e: Error) => this.rx.end(e))
  }

  static async open(cfg: SerialPortConfig, timeoutMs = 5000): Promise<SerialSession> {
    const path = await resolvePort(cfg.port)
    const b = await systemBinding()
    const port = new SerialPortStream({
      binding: b,
      path,
      baudRate: cfg.baud,
      dataBits: cfg.data_bits,
      parity: cfg.parity,
      stopBits: cfg.stop_bits,
      rtscts: cfg.rtscts,
      xon: cfg.xon,
      xoff: cfg.xon,
      autoOpen: false,
    })
    try {
      await withTimeout(new Promise<void>((resolve, reject) => port.open((e) => (e ? reject(e) : resolve()))), timeoutMs, `opening ${path}`)
    } catch (e) {
      try { port.destroy() } catch { /* already gone */ }
      const msg = e instanceof Error ? e.message : String(e)
      if (/permission denied|EACCES/i.test(msg)) throw new ToolError(`${path}: permission denied (add yourself to the dialout/uucp group, then log in again)`)
      if (/busy|EBUSY|lock/i.test(msg)) throw new ToolError(`${path}: busy (another program has it open: a serial monitor, ModemManager?)`)
      throw new ToolError(`could not open ${path}: ${msg}`)
    }
    return new SerialSession(port, path, cfg)
  }

  async write(data: Buffer, timeoutMs = 5000): Promise<void> {
    await withTimeout(new Promise<void>((resolve, reject) => {
      this.port.write(data, (e) => {
        if (e) { reject(e); return }
        this.port.drain((e2) => (e2 ? reject(e2) : resolve()))
      })
    }), timeoutMs, `writing to ${this.path}`)
  }

  async close(): Promise<void> {
    if (!this.port.isOpen) {
      this.port.destroy()
      return
    }
    try {
      await withTimeout(new Promise<void>((resolve) => this.port.close(() => resolve())), 2000, `closing ${this.path}`)
    } catch {
      this.port.destroy()
    }
  }
}

export interface ExpectStep {
  send?: string | undefined
  send_hex?: string | undefined
  /** a regex the reply must match before the next step */
  expect?: string | undefined
  timeout_s?: number | undefined
  /** wait this long after the send (e.g. a device that resets) */
  delay_ms?: number | undefined
  /** don't add the port's newline to `send` */
  raw?: boolean | undefined
}

export interface StepResult {
  step: number
  sent?: string
  expect?: string
  ok: boolean
  seconds: number
  matched?: string
  groups?: Record<string, string>
  error?: string
  /** what had arrived when the step failed */
  got?: string
}

/** Unescape \n \r \t \xNN in a `send` string. */
export function unescape(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{2}|n|r|t|\\)/g, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c === '\\' ? '\\' : String.fromCharCode(parseInt(c.slice(1), 16))))
}

function compile(re: string, where: string): RegExp {
  try {
    return new RegExp(re, 'm')
  } catch (e) {
    throw new ToolError(`${where}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Run send/expect steps in order; stop at the first step whose expect is not met. */
export async function runExpect(s: SerialSession, steps: readonly ExpectStep[], defaultTimeoutS: number): Promise<{ ok: boolean; steps: StepResult[] }> {
  const results: StepResult[] = []
  const regexes = steps.map((st, i) => (st.expect !== undefined ? compile(st.expect, `steps[${i}].expect`) : null))
  for (const [i, st] of steps.entries()) {
    const t0 = performance.now()
    const r: StepResult = { step: i, ok: true, seconds: 0 }
    try {
      if (st.send !== undefined || st.send_hex !== undefined) {
        const data = st.send_hex !== undefined ? hexBytes(st.send_hex) : Buffer.from(unescape(st.send ?? '') + (st.raw ? '' : s.cfg.newline), 'utf8')
        r.sent = st.send_hex !== undefined ? data.toString('hex') : printable(data)
        await s.write(data)
      }
      if (st.delay_ms) await sleep(st.delay_ms)
      const re = regexes[i]
      if (re) {
        r.expect = st.expect
        const { match } = await s.rx.until(re, (st.timeout_s ?? defaultTimeoutS) * 1000)
        r.matched = printable(Buffer.from(match[0], 'latin1')).slice(0, 200)
        if (match.groups) r.groups = Object.fromEntries(Object.entries(match.groups).filter((e): e is [string, string] => e[1] !== undefined))
      }
    } catch (e) {
      r.ok = false
      if (e instanceof Timeout || e instanceof Closed) {
        r.error = e.message
        r.got = printable(e.partial).slice(-300)
      } else {
        r.error = e instanceof Error ? e.message : String(e)
      }
    }
    r.seconds = Number(((performance.now() - t0) / 1000).toFixed(3))
    results.push(r)
    if (!r.ok) return { ok: false, steps: results }
  }
  return { ok: true, steps: results }
}

/** Capture for `seconds`, or until `until` matches; optionally send something first. */
export async function capture(s: SerialSession, seconds: number, until?: RegExp, sendFirst?: Buffer): Promise<{ data: Buffer; stopped: boolean; seconds: number }> {
  const t0 = performance.now()
  if (sendFirst) await s.write(sendFirst)
  const { data, stopped } = await s.rx.collect(seconds * 1000, until)
  // with a stop regex, keep whatever trailed the match in the same chunk
  const rest = s.rx.take()
  return { data: Buffer.concat([data, rest]), stopped, seconds: Number(((performance.now() - t0) / 1000).toFixed(3)) }
}

/** Lines that look like a crash, an assertion or an error. */
export const FAULT = /panicked|panic|HardFault|hard fault|assert(ion)? fail|ASSERT|Guru Meditation|abort\(\)|stack overflow|BusFault|UsageFault|MemManage|\bFATAL\b|\bERROR\b/

export function faultLines(text: string, extra?: RegExp, max = 20): string[] {
  return text.split(/\r?\n/).filter((l) => FAULT.test(l) || (extra?.test(l) ?? false)).slice(0, max).map((l) => l.slice(0, 300))
}

export const portLabel = (p: PortListing): string => basename(p.path)
