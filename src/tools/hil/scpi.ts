/**
 * SCPI: one Transport interface over the three ways instruments are reached.
 *
 *   raw socket   TCPIP::host::5025::SOCKET or tcp://host:port — newline-terminated SCPI over TCP (TypeScript)
 *   serial       ASRL/dev/ttyUSB0::INSTR (TypeScript, through the serial module)
 *   VISA         TCPIP::host::INSTR (VXI-11), TCPIP::host::hislip0 (HiSLIP), USB…::INSTR (USBTMC), GPIB…
 *                — through the Python bridge's pyvisa / pyvisa-py, because Node has no maintained implementation of
 *                these protocols (python/tracebridge/visa.py)
 *
 * On top: write / query / queryBinary (IEEE 488.2 definite-length blocks, `#<n><len><bytes>`), *IDN?, *RST, and
 * draining the error queue (SYST:ERR? until it reports 0). Every operation has a timeout; `close()` always runs.
 */
import { Socket, connect } from 'node:net'
import { z } from 'zod'
import { bridge } from '../../core/bridge.js'
import { ToolError } from '../../core/registry.js'
import { SerialPortSchema } from '../../core/config.js'
import { ByteBuffer, Closed, Timeout } from './bytes.js'
import { SerialSession } from './serial.js'

export type Address =
  | { kind: 'socket'; host: string; port: number }
  | { kind: 'serial'; path: string; baud: number }
  | { kind: 'visa'; resource: string }

/** Parse an instrument address into how to reach it. */
export function parseAddress(address: string): Address {
  const a = address.trim()
  let m = /^tcp:\/\/([^:/]+):(\d+)\/?$/i.exec(a)
  if (m?.[1] && m[2]) return { kind: 'socket', host: m[1], port: Number(m[2]) }
  m = /^TCPIP\d*::([^:]+)::(\d+)::SOCKET$/i.exec(a)
  if (m?.[1] && m[2]) return { kind: 'socket', host: m[1], port: Number(m[2]) }
  m = /^ASRL(.+?)::INSTR$/i.exec(a)
  if (m?.[1]) {
    // ASRL/dev/ttyUSB0::INSTR, ASRL/dev/ttyUSB0@9600::INSTR, ASRLCOM3::INSTR
    const [path, baud] = m[1].split('@')
    if (path && /^(\/|COM\d+)/i.test(path)) return { kind: 'serial', path, baud: baud ? Number(baud) : 9600 }
    return { kind: 'visa', resource: a }
  }
  if (/^(TCPIP\d*::.+::(INSTR|hislip\d+(::INSTR)?)|TCPIP\d*::[^:]+$|USB\d*::.+|GPIB\d*::.+|VXI\d*::.+|PXI\d*::.+)$/i.test(a)) return { kind: 'visa', resource: a }
  throw new ToolError(`${JSON.stringify(address)} is not an instrument address (TCPIP::host::5025::SOCKET, tcp://host:port, TCPIP::host::INSTR, USB0::…::INSTR, ASRL/dev/ttyUSB0::INSTR)`)
}

export interface Transport {
  readonly address: string
  write(cmd: string): Promise<void>
  /** One response line, terminator stripped. */
  query(cmd: string, timeoutMs?: number): Promise<string>
  /** An IEEE 488.2 definite-length block (or raw bytes up to the terminator for an indefinite `#0` block). */
  queryBinary(cmd: string, timeoutMs?: number): Promise<Buffer>
  close(): Promise<void>
}

// ------------------------------------------------------------------ IEEE 488.2 blocks

/**
 * How many bytes of `b` make a whole block including its trailing newline, or null if more are needed.
 * Throws when `b` does not start a block (after optional whitespace).
 */
export function blockLength(b: Buffer): number | null {
  let i = 0
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x0d || b[i] === 0x0a)) i++
  if (i >= b.length) return null
  if (b[i] !== 0x23) throw new ToolError(`expected an IEEE 488.2 block (#…), got ${JSON.stringify(b.subarray(i, i + 40).toString('latin1'))}`)
  if (i + 1 >= b.length) return null
  const nd = b[i + 1]! - 0x30
  if (nd < 0 || nd > 9) throw new ToolError(`bad block header digit ${JSON.stringify(String.fromCharCode(b[i + 1]!))}`)
  if (nd === 0) {
    // indefinite: until a newline that ends the message
    const j = b.indexOf(0x0a, i + 2)
    return j < 0 ? null : j + 1
  }
  if (b.length < i + 2 + nd) return null
  const lenText = b.subarray(i + 2, i + 2 + nd).toString('latin1')
  if (!/^\d+$/.test(lenText)) throw new ToolError(`bad block length ${JSON.stringify(lenText)}`)
  const end = i + 2 + nd + Number(lenText)
  if (b.length < end) return null
  // swallow one trailing terminator if it is there (\n or \r\n), but don't wait for it
  if (b[end] === 0x0d && b[end + 1] === 0x0a) return end + 2
  if (b[end] === 0x0a) return end + 1
  if (b.length === end) return end
  return end
}

/** The payload of a whole block (as delimited by blockLength). */
export function parseBlock(b: Buffer): Buffer {
  let i = 0
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x0d || b[i] === 0x0a)) i++
  if (b[i] !== 0x23) throw new ToolError('not an IEEE 488.2 block')
  const nd = b[i + 1]! - 0x30
  if (nd === 0) {
    let end = b.length
    while (end > i + 2 && (b[end - 1] === 0x0a || b[end - 1] === 0x0d)) end--
    return Buffer.from(b.subarray(i + 2, end))
  }
  const len = Number(b.subarray(i + 2, i + 2 + nd).toString('latin1'))
  const start = i + 2 + nd
  if (b.length < start + len) throw new ToolError(`block is short: ${b.length - start} of ${len} bytes`)
  return Buffer.from(b.subarray(start, start + len))
}

/** Build a definite-length block (the fake server and siggen arbitrary waveforms use it). */
export function makeBlock(payload: Buffer): Buffer {
  const len = String(payload.length)
  return Buffer.concat([Buffer.from(`#${len.length}${len}`, 'latin1'), payload])
}

// ------------------------------------------------------------------ a byte-stream transport (socket, serial)

abstract class StreamTransport implements Transport {
  constructor(readonly address: string, protected readonly timeoutMs: number, protected readonly rx: ByteBuffer) {}
  protected abstract send(data: Buffer): Promise<void>
  abstract close(): Promise<void>

  async write(cmd: string): Promise<void> {
    await this.send(Buffer.from(cmd.endsWith('\n') ? cmd : `${cmd}\n`, 'latin1'))
  }

  private fail(e: unknown, cmd: string): never {
    if (e instanceof Timeout) throw new ToolError(`${this.address}: no answer to ${JSON.stringify(cmd)} in ${(this.timeoutMs / 1000).toFixed(1)} s${e.partial.length ? ` (partial: ${JSON.stringify(e.partial.subarray(0, 80).toString('latin1'))})` : ''}`)
    if (e instanceof Closed) throw new ToolError(`${this.address}: connection closed while waiting for ${JSON.stringify(cmd)}`)
    throw e
  }

  async query(cmd: string, timeoutMs = this.timeoutMs): Promise<string> {
    this.rx.clear()
    await this.write(cmd)
    try {
      return (await this.rx.line(timeoutMs)).toString('latin1').replace(/\r?\n$/, '')
    } catch (e) {
      this.fail(e, cmd)
    }
  }

  async queryBinary(cmd: string, timeoutMs = this.timeoutMs): Promise<Buffer> {
    this.rx.clear()
    await this.write(cmd)
    try {
      return parseBlock(await this.rx.wait(blockLength, timeoutMs, 'block'))
    } catch (e) {
      this.fail(e, cmd)
    }
  }
}

export class SocketTransport extends StreamTransport {
  private constructor(address: string, timeoutMs: number, private readonly sock: Socket) {
    super(address, timeoutMs, new ByteBuffer())
    sock.on('data', (d: Buffer) => this.rx.push(d))
    sock.on('close', () => this.rx.end(new Error('closed')))
    sock.on('error', (e) => this.rx.end(e))
  }

  static async open(address: string, host: string, port: number, timeoutMs: number): Promise<SocketTransport> {
    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ host, port })
      const timer = setTimeout(() => { s.destroy(); reject(new ToolError(`${address}: could not connect in ${timeoutMs / 1000} s`)) }, timeoutMs)
      s.once('connect', () => { clearTimeout(timer); resolve(s) })
      s.once('error', (e) => { clearTimeout(timer); s.destroy(); reject(new ToolError(`${address}: ${e.message}`)) })
    })
    sock.setNoDelay(true)
    return new SocketTransport(address, timeoutMs, sock)
  }

  protected async send(data: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ToolError(`${this.address}: write timed out`)), this.timeoutMs)
      this.sock.write(data, (e) => { clearTimeout(timer); if (e) reject(new ToolError(`${this.address}: ${e.message}`)); else resolve() })
    })
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.sock.destroy(); resolve() }, 1000)
      this.sock.end(() => { clearTimeout(timer); this.sock.destroy(); resolve() })
    })
  }
}

export class SerialTransport extends StreamTransport {
  private constructor(address: string, timeoutMs: number, private readonly s: SerialSession) {
    super(address, timeoutMs, s.rx)
  }

  static async open(address: string, path: string, baud: number, timeoutMs: number): Promise<SerialTransport> {
    const s = await SerialSession.open(SerialPortSchema.parse({ name: 'scpi', port: path, baud }), timeoutMs)
    return new SerialTransport(address, timeoutMs, s)
  }

  protected async send(data: Buffer): Promise<void> {
    await this.s.write(data, this.timeoutMs)
  }

  async close(): Promise<void> {
    await this.s.close()
  }
}

// ------------------------------------------------------------------ VISA through the bridge

const Opened = z.object({ session: z.string() })
const Text = z.object({ text: z.string() })
const Bytes = z.object({ base64: z.string() })
const Ok = z.object({ ok: z.literal(true) })

export class VisaTransport implements Transport {
  private constructor(readonly address: string, private readonly session: string, private readonly timeoutMs: number) {}

  static async open(resource: string, timeoutMs: number): Promise<VisaTransport> {
    const { session } = await bridge().call('visa.open', { resource, timeout_ms: timeoutMs }, Opened, timeoutMs + 10_000)
    return new VisaTransport(resource, session, timeoutMs)
  }

  async write(cmd: string): Promise<void> {
    await bridge().call('visa.write', { session: this.session, command: cmd }, Ok, this.timeoutMs + 5000)
  }

  async query(cmd: string, timeoutMs = this.timeoutMs): Promise<string> {
    return (await bridge().call('visa.query', { session: this.session, command: cmd, timeout_ms: timeoutMs }, Text, timeoutMs + 5000)).text
  }

  async queryBinary(cmd: string, timeoutMs = this.timeoutMs): Promise<Buffer> {
    const r = await bridge().call('visa.query_binary', { session: this.session, command: cmd, timeout_ms: timeoutMs }, Bytes, timeoutMs + 10_000)
    return Buffer.from(r.base64, 'base64')
  }

  async close(): Promise<void> {
    try {
      await bridge().call('visa.close', { session: this.session }, Ok, 10_000)
    } catch { /* the bridge closes everything when it exits */ }
  }
}

// ------------------------------------------------------------------ opening and common commands

export async function openTransport(address: string, timeoutMs = 5000): Promise<Transport> {
  const a = parseAddress(address)
  if (a.kind === 'socket') return SocketTransport.open(address, a.host, a.port, timeoutMs)
  if (a.kind === 'serial') return SerialTransport.open(address, a.path, a.baud, timeoutMs)
  return VisaTransport.open(a.resource, timeoutMs)
}

/** Open, run `fn`, close — whatever happens. */
export async function withTransport<T>(address: string, timeoutMs: number, fn: (t: Transport) => Promise<T>): Promise<T> {
  const t = await openTransport(address, timeoutMs)
  try {
    return await fn(t)
  } finally {
    await t.close()
  }
}

export interface Identity {
  raw: string
  manufacturer: string
  model: string
  serial: string
  firmware: string
}

export function parseIdn(raw: string): Identity {
  const [manufacturer = '', model = '', serial = '', firmware = ''] = raw.split(',').map((s) => s.trim())
  return { raw: raw.trim(), manufacturer, model, serial, firmware }
}

export async function idn(t: Transport): Promise<Identity> {
  return parseIdn(await t.query('*IDN?'))
}

/** SYST:ERR? until it says 0 (at most `max` reads, so a broken instrument cannot loop us for ever). */
export async function drainErrors(t: Transport, max = 32): Promise<string[]> {
  const errs: string[] = []
  for (let i = 0; i < max; i++) {
    const r = (await t.query('SYST:ERR?')).trim()
    if (/^[+]?0\b/.test(r) || /no error/i.test(r) || r === '') break
    errs.push(r)
  }
  return errs
}

export async function reset(t: Transport): Promise<void> {
  await t.write('*RST')
  await t.query('*OPC?', 15_000)
}

/** Parse a SCPI number ("+1.234E+00", "1.2V", "9.9E37" = overload). */
export function num(s: string): number {
  const m = /[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(s)
  if (!m) throw new ToolError(`expected a number, got ${JSON.stringify(s.slice(0, 60))}`)
  return Number(m[0])
}
