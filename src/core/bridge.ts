/**
 * The Python bridge: the few things trace does in Python because Node has no maintained equivalent —
 * reading tables and vector figures out of PDFs (pdfplumber), instruments over VXI-11/HiSLIP/USBTMC/GPIB (pyvisa),
 * and CAN through vendor interfaces and BLF/ASC logs (python-can). See python/pyproject.toml.
 *
 * One `python -m tracebridge` process per session, kept alive so a bus or instrument session opened by one call is
 * still open for the next. Requests and responses are one JSON object per line over its stdin/stdout. Each method's
 * result is validated with the caller's zod schema, so the TypeScript side stays strongly typed:
 *
 *   const tables = await bridge().call('pdf.tables', { path, page }, TablesSchema)
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { z } from 'zod'
import { ToolError } from './registry.js'

const PY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'python')

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

interface Response {
  id: number | null
  ok: boolean
  result?: unknown
  error?: string
  kind?: string
}

export class Bridge {
  private proc: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private stderr = ''

  constructor(private readonly python: string = process.env.TRACE_PYTHON || 'python3') {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null) return this.proc
    if (!existsSync(join(PY_DIR, 'tracebridge'))) throw new ToolError(`the Python bridge is missing (${PY_DIR})`)
    const env = { ...process.env, PYTHONPATH: [PY_DIR, process.env.PYTHONPATH].filter(Boolean).join(':'), PYTHONUNBUFFERED: '1' }
    const proc = spawn(this.python, ['-m', 'tracebridge'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    proc.on('error', (e) => this.failAll(new ToolError(`could not start ${this.python} for the Python bridge: ${e.message}`)))
    proc.on('exit', (code) => this.failAll(new ToolError(`the Python bridge exited (${code}): ${this.stderr.slice(-800)}`)))
    proc.stderr.on('data', (d: Buffer) => { this.stderr = (this.stderr + d.toString()).slice(-4000) })
    createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line))
    this.proc = proc
    return proc
  }

  private onLine(line: string): void {
    let msg: Response
    try {
      msg = JSON.parse(line) as Response
    } catch {
      return
    }
    if (typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(msg.kind === 'BridgeError' ? new ToolError(msg.error ?? 'bridge error') : new Error(`bridge: ${msg.error}`))
  }

  private failAll(e: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e) }
    this.pending.clear()
    this.proc = null
  }

  /** Call `method` with `params`; the result is checked against `schema`. */
  async call<S extends z.ZodType>(method: string, params: Record<string, unknown>, schema: S, timeoutMs = 120_000): Promise<z.output<S>> {
    const proc = this.start()
    const id = this.nextId++
    const raw = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new ToolError(`${method}: the Python bridge did not answer in ${timeoutMs / 1000} s`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
    const parsed = schema.safeParse(raw)
    if (!parsed.success) throw new Error(`bridge ${method} returned an unexpected shape: ${parsed.error.message}`)
    return parsed.data
  }

  close(): void {
    if (this.proc) {
      this.proc.stdin.end()
      this.proc.kill()
      this.proc = null
    }
  }
}

let shared: Bridge | null = null

/** The session's bridge (started on first use, stopped when the process exits). */
export function bridge(): Bridge {
  if (!shared) {
    shared = new Bridge()
    process.once('exit', () => shared?.close())
  }
  return shared
}
