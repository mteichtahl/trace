/**
 * Running the simulators. ngspice, iverilog, vvp and kicad-cli are separate programs, so every simulation is a child
 * process: this module starts one with a hard timeout (the process is killed, not abandoned, when it runs over),
 * finds programs on PATH (or where an environment variable points), and runs many jobs with bounded concurrency so a
 * sweep of a thousand points never starts a thousand processes at once.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { availableParallelism } from 'node:os'
import { delimiter, join } from 'node:path'

export interface ProcResult {
  readonly code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly ms: number
}

export interface ProcOptions {
  readonly cwd?: string
  readonly timeoutMs: number
  readonly env?: NodeJS.ProcessEnv
  /** Keep at most this many characters of each stream (the tail is kept). */
  readonly maxOutput?: number
}

/** Run a program to completion, or kill it (SIGKILL) at the timeout. Never throws for a non-zero exit. */
export function run(cmd: string, args: readonly string[], opts: ProcOptions): Promise<ProcResult> {
  const max = opts.maxOutput ?? 4_000_000
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let timedOut = false
    const keep = (s: string, add: string): string => {
      const t = s + add
      return t.length > max ? t.slice(t.length - max) : t
    }
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out = keep(out, d) })
    child.stderr.setEncoding('utf8').on('data', (d: string) => { err = keep(err, d) })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout: out, stderr: err, timedOut, ms: Date.now() - t0 })
    })
  })
}

/** A program's path: $ENVVAR when set (and executable), else the first match on PATH, else null. */
export function which(name: string, envVar?: string): string | null {
  const exe = (p: string): boolean => {
    try {
      accessSync(p, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  const fromEnv = envVar ? process.env[envVar] : undefined
  if (fromEnv) return exe(fromEnv) ? fromEnv : null
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, name)
    if (exe(p)) return p
  }
  return null
}

/** The number of simulator processes run at once by default. */
export function defaultConcurrency(): number {
  return Math.max(1, availableParallelism())
}

/** Map `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const n = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: n }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i] as T, i)
    }
  })
  await Promise.all(workers)
  return out
}
