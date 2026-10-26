/**
 * CAN: send frames, receive with id filters, capture to a log (candump, ASC, BLF, CSV, TRC), bus statistics, and DBC
 * decode/encode when cantools is installed.
 *
 * The bus itself is driven by python-can in the Python bridge (python/tracebridge/can.py): it is the one library that
 * reaches SocketCAN and the vendor interfaces (PCAN, Kvaser, Vector, IXXAT, gs_usb, slcan) through one API, gives an
 * in-process virtual bus for tests, and writes BLF/ASC logs. This module is the typed TypeScript side: frame
 * validation, the open/close discipline (a bus opened here is always closed in a finally) and the result shapes.
 */
import { z } from 'zod'
import { bridge } from '../../core/bridge.js'
import type { CanBusConfig } from '../../core/config.js'
import { ToolError } from '../../core/registry.js'

export interface Frame {
  id: number
  data: string
  extended?: boolean | undefined
  fd?: boolean | undefined
  brs?: boolean | undefined
  rtr?: boolean | undefined
}

export interface Filter {
  id: number
  mask?: number | undefined
  extended?: boolean | undefined
}

const FrameOut = z.object({
  t: z.number(), id: z.number(), ext: z.boolean(), data: z.string(), dlc: z.number(),
  fd: z.boolean().optional(), brs: z.boolean().optional(), rtr: z.boolean().optional(), error: z.boolean().optional(), channel: z.string().optional(),
})
export type FrameOut = z.output<typeof FrameOut>

const Opened = z.object({ session: z.string() })
const Sent = z.object({ sent: z.number() })
const Received = z.object({ frames: z.array(FrameOut) })
const Decoded = z.object({ id: z.number(), message: z.string(), signals: z.record(z.string(), z.union([z.number(), z.string()])).optional(), error: z.string().optional() })
const Captured = z.object({
  frames: z.number(), errors: z.number(), seconds: z.number(), rate_fps: z.number(),
  ids: z.array(z.object({ id: z.number(), count: z.number() })), first: z.array(FrameOut), decoded: z.array(Decoded),
  log_base64: z.string(), log_name: z.string(),
})
const Ok = z.object({ ok: z.literal(true) })
const Stats = z.object({ interface: z.string(), channel: z.string(), tx: z.number(), rx: z.number(), error_frames: z.number(), open_s: z.number(), state: z.string().optional() })
const Encoded = z.object({ id: z.number(), extended: z.boolean(), data: z.string(), fd: z.boolean() })
const Available = z.object({ available: z.boolean() })

/** Check a frame before it goes anywhere: id range for its width, hex data, length for classic or FD. */
export function checkFrame(f: Frame, i: number): void {
  const ext = f.extended ?? f.id > 0x7ff
  if (!Number.isInteger(f.id) || f.id < 0 || f.id > (ext ? 0x1fffffff : 0x7ff)) throw new ToolError(`frames[${i}].id ${f.id} is out of range for a ${ext ? 29 : 11}-bit id`)
  const hex = f.data.replace(/[\s:]/g, '')
  if (hex.length % 2 || /[^0-9a-f]/i.test(hex)) throw new ToolError(`frames[${i}].data ${JSON.stringify(f.data)} is not hex bytes`)
  const n = hex.length / 2
  if (n > (f.fd ? 64 : 8)) throw new ToolError(`frames[${i}]: ${n} bytes is too long for ${f.fd ? 'CAN FD (64)' : 'classic CAN (8)'}`)
  if (f.fd && ![0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64].includes(n)) throw new ToolError(`frames[${i}]: CAN FD payloads are 0-8, 12, 16, 20, 24, 32, 48 or 64 bytes, not ${n}`)
}

/** Parse "0x123", "123h", "291" into a number. */
export function parseId(s: string | number): number {
  if (typeof s === 'number') return s
  const t = s.trim()
  const v = /^0x/i.test(t) ? parseInt(t, 16) : /h$/i.test(t) ? parseInt(t.slice(0, -1), 16) : Number(t)
  if (!Number.isInteger(v)) throw new ToolError(`${JSON.stringify(s)} is not a CAN id`)
  return v
}

export class CanSession {
  private constructor(readonly bus: CanBusConfig, private readonly session: string) {}

  static async open(bus: CanBusConfig, opts: { receiveOwn?: boolean } = {}): Promise<CanSession> {
    const { session } = await bridge().call('can.open', {
      interface: bus.interface, channel: bus.channel, bitrate: bus.bitrate, fd: bus.fd,
      data_bitrate: bus.data_bitrate ?? null, receive_own_messages: opts.receiveOwn ?? false,
    }, Opened, 30_000)
    return new CanSession(bus, session)
  }

  async send(frames: Frame[], intervalMs = 0): Promise<number> {
    frames.forEach(checkFrame)
    const timeout = 10_000 + intervalMs * frames.length
    return (await bridge().call('can.send', { session: this.session, frames, interval_ms: intervalMs }, Sent, timeout)).sent
  }

  /** Forget frames buffered so far (before a request whose replies are wanted). */
  async flush(): Promise<void> {
    await bridge().call('can.flush', { session: this.session }, z.object({ dropped: z.number() }), 10_000)
  }

  /**
   * Frames matching `filters` until `maxFrames`, `untilId` is seen, or `timeoutMs` passes. The bridge is asked in short
   * slices, so other calls (a send on another session, say) are served in between. Each slice is a held call that
   * returns as soon as frames arrive (wait_ms is how long it may hold, not a sleep), so frames reach the caller as they
   * come; the whole receive is bounded by `timeoutMs`.
   */
  async receive(timeoutMs: number, maxFrames: number, filters?: Filter[], untilId?: number): Promise<{ frames: FrameOut[]; timed_out: boolean }> {
    const frames: FrameOut[] = []
    const end = Date.now() + timeoutMs
    let t0: number | null = null
    for (;;) {
      const left = end - Date.now()
      if (left <= 0) break
      const r = await bridge().call('can.receive', { session: this.session, wait_ms: Math.min(left, 200), max_frames: maxFrames - frames.length, filters: filters ?? null }, Received, 15_000)
      for (const f of r.frames) {
        t0 ??= f.t
        frames.push({ ...f, t: Number((f.t - t0).toFixed(6)) })
        if (untilId !== undefined && f.id === untilId) return { frames, timed_out: false }
      }
      if (frames.length >= maxFrames) return { frames, timed_out: false }
    }
    return { frames, timed_out: true }
  }

  /** Record the bus for `seconds` into a log; frames are written by the bridge's reader as they arrive. */
  async capture(seconds: number, fmt: string, filters?: Filter[], dbc?: string): Promise<z.output<typeof Captured>> {
    await bridge().call('can.capture_start', { session: this.session, fmt, filters: filters ?? null, dbc: dbc ?? null }, Ok, 30_000)
    await new Promise((r) => setTimeout(r, seconds * 1000))
    return bridge().call('can.capture_stop', { session: this.session }, Captured, 60_000)
  }

  async stats(): Promise<z.output<typeof Stats>> {
    return bridge().call('can.stats', { session: this.session }, Stats, 10_000)
  }

  async close(): Promise<void> {
    try {
      await bridge().call('can.close', { session: this.session }, Ok, 10_000)
    } catch { /* the bridge closes every bus when it exits */ }
  }
}

export async function withBus<T>(bus: CanBusConfig, fn: (s: CanSession) => Promise<T>, opts: { receiveOwn?: boolean } = {}): Promise<T> {
  const s = await CanSession.open(bus, opts)
  try {
    return await fn(s)
  } finally {
    await s.close()
  }
}

export async function dbcAvailable(): Promise<boolean> {
  return (await bridge().call('can.dbc_available', {}, Available, 15_000)).available
}

export async function encode(dbc: string, message: string, signals: Record<string, number | string>): Promise<Frame> {
  const r = await bridge().call('can.encode', { dbc, message, signals }, Encoded, 15_000)
  return { id: r.id, extended: r.extended, data: r.data, fd: r.fd }
}

export const hexId = (id: number, ext: boolean): string => `0x${id.toString(16).toUpperCase().padStart(ext ? 8 : 3, '0')}`
