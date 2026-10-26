/**
 * A byte buffer that a port or socket pushes into and a tool reads out of, with a deadline on every read.
 *
 * Serial ports, SCPI sockets and process pipes all deliver bytes in arbitrary chunks. Tools want "everything up to
 * this regex", "the next line" or "exactly N bytes", and they must never wait for ever: every wait here takes a
 * timeout and resolves (with what arrived so far) or rejects when it passes. Matching is done on a latin1 view of the
 * bytes, so a regex match index is a byte index and binary data survives.
 */

export class Timeout extends Error {
  override name = 'Timeout'
  constructor(message: string, readonly partial: Buffer) {
    super(message)
  }
}

export class Closed extends Error {
  override name = 'Closed'
  constructor(message: string, readonly partial: Buffer) {
    super(message)
  }
}

/** Return the number of bytes to consume when `buf` satisfies the read, or null to keep waiting. Throw to fail. */
type Want = (buf: Buffer) => number | null

interface Waiter {
  want: Want
  resolve: (n: number) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

export class ByteBuffer {
  private buf: Buffer = Buffer.alloc(0)
  private waiter: Waiter | null = null
  private ended: Error | null = null
  /** Every byte ever pushed, for transcripts; capped so a chatty port cannot use unbounded memory. */
  private transcript: Buffer[] = []
  private transcriptBytes = 0

  constructor(private readonly keepTranscript = 0) {}

  push(chunk: Buffer): void {
    if (!chunk.length) return
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk)
    if (this.keepTranscript && this.transcriptBytes < this.keepTranscript) {
      this.transcript.push(chunk)
      this.transcriptBytes += chunk.length
    }
    this.check()
  }

  /** The source is gone: a waiting read fails, later reads fail at once. */
  end(reason: Error): void {
    this.ended = reason
    this.check()
  }

  get length(): number {
    return this.buf.length
  }

  get closed(): boolean {
    return this.ended !== null
  }

  /** Bytes received since the buffer was made (up to the transcript cap). */
  received(): Buffer {
    return Buffer.concat(this.transcript)
  }

  /** Everything buffered now, removed. */
  take(): Buffer {
    const out = this.buf
    this.buf = Buffer.alloc(0)
    return out
  }

  /** Discard what is buffered (stale input before a command). */
  clear(): void {
    this.buf = Buffer.alloc(0)
  }

  private check(): void {
    const w = this.waiter
    if (!w) return
    let n: number | null
    try {
      n = w.want(this.buf)
    } catch (e) {
      this.waiter = null
      clearTimeout(w.timer)
      w.reject(e instanceof Error ? e : new Error(String(e)))
      return
    }
    if (n !== null) {
      this.waiter = null
      clearTimeout(w.timer)
      w.resolve(n)
    } else if (this.ended) {
      this.waiter = null
      clearTimeout(w.timer)
      w.reject(new Closed(this.ended.message, Buffer.from(this.buf)))
    }
  }

  /** Wait until `want` accepts the buffer; consume and return that many bytes. */
  async wait(want: Want, timeoutMs: number, what = 'data'): Promise<Buffer> {
    if (this.waiter) throw new Error('ByteBuffer: one read at a time')
    const n = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null
        reject(new Timeout(`no ${what} in ${(timeoutMs / 1000).toFixed(timeoutMs < 1000 ? 3 : 1)} s`, Buffer.from(this.buf)))
      }, Math.max(0, timeoutMs))
      this.waiter = { want, resolve, reject, timer }
      this.check()
    })
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return Buffer.from(out)
  }

  /** Up to and including the first match of `re`. */
  async until(re: RegExp, timeoutMs: number): Promise<{ data: Buffer; match: RegExpExecArray }> {
    const flags = re.flags.replace('g', '').replace('y', '')
    const rx = new RegExp(re.source, flags)
    let found: RegExpExecArray | null = null
    const data = await this.wait((b) => {
      const m = rx.exec(b.toString('latin1'))
      if (!m) return null
      found = m
      return m.index + m[0].length
    }, timeoutMs, `match for /${re.source}/`)
    if (!found) throw new Error('unreachable')
    return { data, match: found }
  }

  /** Up to and including `delim`. */
  async line(timeoutMs: number, delim = 0x0a): Promise<Buffer> {
    return this.wait((b) => {
      const i = b.indexOf(delim)
      return i < 0 ? null : i + 1
    }, timeoutMs, 'line')
  }

  async exact(n: number, timeoutMs: number): Promise<Buffer> {
    return this.wait((b) => (b.length >= n ? n : null), timeoutMs, `${n} bytes`)
  }

  /** Collect for `ms`, or until `stop` matches (when given), never longer. */
  async collect(ms: number, stop?: RegExp): Promise<{ data: Buffer; stopped: boolean }> {
    if (stop) {
      try {
        const { data } = await this.until(stop, ms)
        return { data, stopped: true }
      } catch (e) {
        if (e instanceof Timeout || e instanceof Closed) {
          return { data: Buffer.concat([e.partial, this.take()]).subarray(0), stopped: false }
        }
        throw e
      }
    }
    await new Promise((r) => setTimeout(r, ms))
    return { data: this.take(), stopped: false }
  }
}

/** Text for people: UTF-8, with control characters other than tab/newline shown as \xNN. */
export function printable(b: Buffer): string {
  // eslint-disable-next-line no-control-regex
  return b.toString('utf8').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

/** The last `n` lines of a text. */
export function tail(text: string, n: number): string {
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines.slice(-n).join('\n')
}

/** Parse "de ad be ef", "deadbeef", "0xDE,0xAD" into bytes. */
export function hexBytes(s: string): Buffer {
  const clean = s.replace(/0x/gi, '').replace(/[\s,:_-]/g, '')
  if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) throw new Error(`${JSON.stringify(s)} is not hex bytes`)
  return Buffer.from(clean, 'hex')
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
