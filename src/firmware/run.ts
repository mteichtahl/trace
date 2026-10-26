/**
 * Running a firmware command (a build, a flash, a log monitor) and reading its output.
 *
 *   run()          a shell command in the target's folder, output streamed into a capped in-memory log (stored in
 *                  the run record by the caller, never left on disk), with a hard timeout that kills the whole process
 *                  group (a probe tool that hangs, a monitor that never exits), and optionally stopped early when a
 *                  regex appears in its output.
 *   diagnostics()  rustc / gcc / clang error and warning lines → counts and the first few, with file:line.
 *   parseSize()    `size` (Berkeley) and `cargo size` output → text/data/bss → flash and RAM bytes.
 *   which()        is a program on PATH, so a missing one becomes "install it with …" instead of exit 127.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { ToolError } from '../core/registry.js'

export interface RunResult {
  code: number | null
  signal: string | null
  timed_out: boolean
  /** stopped because `until` matched */
  matched: boolean
  seconds: number
  /** stdout and stderr interleaved as they arrived (capped) */
  output: string
  truncated: boolean
}

export interface RunOptions {
  cwd: string
  env?: Record<string, string> | undefined
  timeoutMs: number
  /** stop (SIGINT, then SIGKILL) when this appears in the output */
  until?: RegExp | undefined
  /** keep at most this many bytes of output (the head and the tail are kept) */
  maxBytes?: number | undefined
  onData?: ((chunk: string) => void) | undefined
}

const KILL_GRACE_MS = 2000

/** Run `command` with sh -c in its own process group; resolve when it ends, is stopped, or times out. */
export function run(command: string, opts: RunOptions): Promise<RunResult> {
  const max = opts.maxBytes ?? 8 * 1024 * 1024
  const t0 = performance.now()
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, CLICOLOR_FORCE: '0', CARGO_TERM_COLOR: 'never', TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    let head = ''
    let tailBuf = ''
    let size = 0
    let truncated = false
    let timedOut = false
    let matched = false
    let scan = ''
    let killTimer: NodeJS.Timeout | undefined
    const stop = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, sig)
        else child.kill(sig)
      } catch { /* already gone */ }
    }
    const stopThenKill = (): void => {
      stop('SIGINT')
      killTimer ??= setTimeout(() => stop('SIGKILL'), KILL_GRACE_MS)
    }
    const onChunk = (b: Buffer): void => {
      const s = b.toString('utf8')
      opts.onData?.(s)
      size += b.length
      if (head.length < max / 2) {
        const room = max / 2 - head.length
        head += s.slice(0, room)
        if (s.length > room) { truncated = true; tailBuf = (tailBuf + s.slice(room)).slice(-max / 2) }
      } else {
        truncated = true
        tailBuf = (tailBuf + s).slice(-max / 2)
      }
      if (opts.until && !matched) {
        scan = (scan + s).slice(-65536)
        if (opts.until.test(scan)) { matched = true; stopThenKill() }
      }
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    const timer = setTimeout(() => { timedOut = true; stopThenKill() }, opts.timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); clearTimeout(killTimer); reject(new ToolError(`could not run ${command}: ${e.message}`)) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      // the shell may be gone while a grandchild (a probe tool) holds on: make sure the group is gone too
      stop('SIGKILL')
      const output = truncated ? `${head}\n… [${size - head.length - tailBuf.length} bytes not kept] …\n${tailBuf}` : head
      resolve({ code, signal, timed_out: timedOut, matched, seconds: Number(((performance.now() - t0) / 1000).toFixed(3)), output, truncated })
    })
  })
}

/** The path of `program` on PATH (or as given, if it is a path), else null. */
export function which(program: string, envPath = process.env.PATH ?? ''): string | null {
  const isFile = (p: string): boolean => {
    try {
      accessSync(p, constants.X_OK)
      return statSync(p).isFile()
    } catch {
      return false
    }
  }
  if (program.includes('/')) return isFile(program) ? program : null
  for (const dir of envPath.split(delimiter)) {
    if (!dir) continue
    const p = join(dir, program)
    if (isFile(p)) return p
  }
  return null
}

/** The first word of each `&&`/`;`/`|`-joined part of a shell command (env assignments skipped). */
export function programsIn(command: string): string[] {
  const out: string[] = []
  for (const part of command.split(/&&|\|\||;|\|/)) {
    const words = part.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
    const w = words[0]
    if (w && !['cd', 'export', 'echo', 'true', 'false', 'test', '[', 'exit', 'sleep', 'env'].includes(w)) out.push(w.replace(/^["']|["']$/g, ''))
  }
  return [...new Set(out)]
}

// ------------------------------------------------------------------ diagnostics

export interface Diagnostic {
  severity: 'error' | 'warning'
  message: string
  file?: string
  line?: number
  col?: number
  code?: string
}

export interface Diagnostics {
  errors: number
  warnings: number
  first_errors: Diagnostic[]
  first_warnings: Diagnostic[]
  /** an environment problem that stopped the build before compiling (cargo home not writable, no network) */
  environment?: string
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

/**
 * gcc/clang: `path/file.c:12:5: error: message` (also `fatal error:`, and the linker's `ld: … undefined reference`).
 * rustc: `error[E0308]: message` followed by `  --> src/main.rs:12:5`.
 */
export function diagnostics(output: string, max = 5): Diagnostics {
  const lines = output.replace(ANSI, '').split(/\r?\n/)
  const all: Diagnostic[] = []
  const gcc = /^(.+?):(\d+):(?:(\d+):)?\s+(fatal error|error|warning):\s+(.*)$/
  const rust = /^(error|warning)(?:\[([A-Z]\d{4})\])?:\s+(.*)$/
  const arrow = /^\s*-->\s+(.+?):(\d+):(\d+)/
  const ld = /(?:^|\s)(?:\/\S*\/)?(?:[\w.-]*-)?ld(?:\.\w+)?:\s+(.*(?:undefined reference|cannot find|will not fit|overflowed|multiple definition|region `?\w+'? overflowed).*)$/
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    let m = gcc.exec(l)
    if (m) {
      const sev = m[4] === 'warning' ? 'warning' : 'error'
      all.push({ severity: sev, file: m[1]!, line: Number(m[2]), ...(m[3] ? { col: Number(m[3]) } : {}), message: m[5]!.slice(0, 300) })
      continue
    }
    m = rust.exec(l)
    if (m) {
      const msg = m[3]!
      // rustc's summaries are not diagnostics of their own
      if (/^(aborting due to|could not compile|\d+ warnings? emitted|build failed|`.*` \(.*\) generated \d+ warning)/.test(msg)) continue
      if (/generated \d+ warnings?/.test(msg)) continue
      const d: Diagnostic = { severity: m[1] === 'warning' ? 'warning' : 'error', message: msg.slice(0, 300), ...(m[2] ? { code: m[2] } : {}) }
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        const a = arrow.exec(lines[j]!)
        if (a) { d.file = a[1]!; d.line = Number(a[2]); d.col = Number(a[3]); break }
      }
      all.push(d)
      continue
    }
    m = ld.exec(l)
    if (m) all.push({ severity: 'error', message: m[1]!.slice(0, 300) })
  }
  const errs = all.filter((d) => d.severity === 'error')
  const warns = all.filter((d) => d.severity === 'warning')
  const out: Diagnostics = { errors: errs.length, warnings: warns.length, first_errors: errs.slice(0, max), first_warnings: warns.slice(0, Math.min(max, 3)) }
  const env = environmentProblem(output)
  if (env) out.environment = env
  return out
}

/** Failures that are the machine's, not the code's. */
export function environmentProblem(output: string): string | undefined {
  if (/failed to (create|open|write).*(\.cargo|CARGO_HOME|registry)|Permission denied.*\.cargo|could not create.*cargo home/i.test(output)) return 'cargo home is not writable: set CARGO_HOME to a writable folder (the target env)'
  if (/failed to download|could not resolve host|network failure|failed to get .* as a dependency/i.test(output)) return 'a dependency could not be downloaded (network)'
  if (/error: toolchain '.*' is not installed|the '.*' toolchain is not installed/i.test(output)) return 'the pinned Rust toolchain is not installed: rustup toolchain install (rust-toolchain.toml)'
  if (/target may not be installed|can't find crate for `core`/i.test(output)) return 'the Rust target is not installed: rustup target add <triple>'
  if (/arm-none-eabi-gcc: (command )?not found|No CMAKE_C_COMPILER could be found/i.test(output)) return 'the cross compiler is not installed (gcc-arm-none-eabi)'
  if (/PICO_SDK_PATH/.test(output) && /not (found|set|exist)/i.test(output)) return 'PICO_SDK_PATH is not set'
  return undefined
}

// ------------------------------------------------------------------ size

export interface SizeRow {
  file: string
  text: number
  data: number
  bss: number
}

export interface Size extends SizeRow {
  /** what goes into flash: code + read-only data + the initial values of .data */
  flash_bytes: number
  /** static RAM: .data + .bss (the stack and heap come out of what is left) */
  ram_bytes: number
}

/**
 * Berkeley `size` / `llvm-size` / `arm-none-eabi-size` / `cargo size` output:
 *      text    data     bss     dec     hex filename
 *     12345     256    4096   16697    4139 build/app.elf
 */
export function parseSize(output: string): Size[] {
  const rows: Size[] = []
  const lines = output.replace(ANSI, '').split(/\r?\n/)
  const hdr = lines.findIndex((l) => /^\s*text\s+data\s+bss\s+dec\s+hex/.test(l))
  if (hdr < 0) return rows
  for (const l of lines.slice(hdr + 1)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([0-9a-fA-F]+)\s*(.*)$/.exec(l)
    if (!m) continue
    const text = Number(m[1]), data = Number(m[2]), bss = Number(m[3])
    rows.push({ file: (m[6] ?? '').trim(), text, data, bss, flash_bytes: text + data, ram_bytes: data + bss })
  }
  return rows
}

/** A `size` program for this host: arm-none-eabi-size, llvm-size, rust-size (cargo-binutils), then GNU size. */
export function sizeTool(prefer?: string): string | null {
  for (const p of [prefer, 'arm-none-eabi-size', 'llvm-size', 'rust-size', 'riscv64-unknown-elf-size', 'xtensa-esp32-elf-size', 'size']) {
    if (p && which(p)) return p
  }
  return null
}

/** Memory regions from a GNU ld map / memory.x: FLASH and RAM lengths, to report percentages. */
export function memoryRegions(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  const re = /(?:^|[\s{])([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*:\s*ORIGIN\s*=\s*[^,]+,\s*LENGTH\s*=\s*([0-9xXa-fA-F]+)\s*([KkMm])?/gm
  for (const m of text.matchAll(re)) {
    const n = m[2]!.startsWith('0x') || m[2]!.startsWith('0X') ? parseInt(m[2]!, 16) : Number(m[2])
    const mul = m[3] ? (m[3].toUpperCase() === 'K' ? 1024 : 1024 * 1024) : 1
    out[m[1]!.toUpperCase()] = n * mul
  }
  return out
}

export const abs = (root: string, p: string): string => (isAbsolute(p) ? p : join(root, p))
