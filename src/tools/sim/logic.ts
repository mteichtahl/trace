/**
 * Icarus Verilog: compile a design and its testbench, run it, and report what it said and whether it passed.
 *
 * Sources are compiled with `iverilog -g2012` (include directories, defines and the top module as given) and run with
 * `vvp -n` (no interactive prompt on $stop). The VCD comes from the testbench's own $dumpfile/$dumpvars; when the
 * sources have none, a small module is compiled in beside them that dumps the whole top-level hierarchy, so there is
 * always a waveform to look at. The top module is the one given, or else the single root module iverilog found (read
 * from the compiled file's scope lines).
 *
 * Pass or fail, in order: the compile failed; vvp reported FATAL or ERROR ($fatal, $error, or a runtime error), or
 * exited non-zero; the output matched the FAIL pattern; a PASS pattern was given and never matched; the run hit the
 * time limit. $display output comes back as lines (capped), with the ERROR/WARNING/FATAL messages and their times
 * pulled out.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { scratchDir } from '../../core/store.js'
import { run, which } from './proc.js'

export class LogicError extends Error {
  override name = 'LogicError'
  constructor(message: string, readonly log = '') {
    super(message)
  }
}

export function iverilog(): string | null {
  return which('iverilog', 'IVERILOG')
}

export function vvp(): string | null {
  return which('vvp', 'VVP')
}

export async function iverilogVersion(): Promise<string | null> {
  const exe = iverilog()
  if (!exe) return null
  try {
    const r = await run(exe, ['-V'], { timeoutMs: 30_000 })
    const m = /version (\d+\.\d+)/.exec(r.stdout + r.stderr)
    return m ? (m[1] ?? null) : null
  } catch {
    return null
  }
}

export interface LogicSource {
  /** A file on disk… */
  path?: string
  /** …or text, written to the scratch directory as `name`. */
  name?: string
  text?: string
}

export interface LogicOptions {
  sources: readonly LogicSource[]
  top?: string
  includeDirs?: readonly string[]
  defines?: Readonly<Record<string, string | number | boolean>>
  /** Regex (JavaScript) the output must match for a pass. */
  pass?: string
  /** Regex that marks a failure when the output matches it. */
  fail?: string
  /** +plusargs passed to vvp. */
  plusargs?: readonly string[]
  timeoutMs?: number
  /** Inject a $dumpvars module when the sources have no $dumpfile (default true). */
  dump?: boolean
}

export interface Message {
  severity: 'error' | 'warning' | 'fatal' | 'info'
  text: string
  where?: string
  time?: string
  scope?: string
}

export interface LogicRun {
  passed: boolean
  reason: string
  top: string
  compileLog: string
  output: string
  messages: Message[]
  vcd: Uint8Array | null
  vcdName: string | null
  sources: { name: string; text: string }[]
  timedOut: boolean
  ms: number
}

const DUMPFILE = /\$dumpfile\s*\(\s*"([^"]+)"\s*\)/

/** Root modules of a compiled vvp file (scopes with no parent), in file order. */
export function rootModules(vvpText: string): string[] {
  const out: string[] = []
  for (const m of vvpText.matchAll(/^S_\w+ \.scope module, "([^"]+)" "[^"]+" [^;]*;$/gm)) {
    const line = m[0]
    // a child scope ends with ", S_<parent>;"
    if (!/,\s*S_\w+;$/.test(line)) out.push(m[1] as string)
  }
  return out
}

/** vvp's ERROR/WARNING/FATAL/INFO messages, each with the "Time: … Scope: …" line that follows it. */
export function parseMessages(output: string): Message[] {
  const lines = output.split('\n')
  const out: Message[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^(ERROR|WARNING|FATAL|INFO): (?:([^\s:]+:\d+): )?(.*)$/.exec(lines[i] as string)
    if (!m) continue
    const msg: Message = { severity: (m[1] as string).toLowerCase() as Message['severity'], text: (m[3] ?? '').trim() }
    if (m[2]) msg.where = m[2]
    const t = /^\s+Time: (\S+(?:\s+\w+)?)\s+Scope: (\S+)/.exec(lines[i + 1] ?? '')
    if (t) {
      msg.time = t[1]
      msg.scope = t[2]
      i++
    }
    out.push(msg)
  }
  return out
}

function dumpModule(top: string): string {
  return ['`timescale 1ns/1ps', 'module trace_dump;', '  initial begin', '    $dumpfile("trace_dump.vcd");', `    $dumpvars(0, ${top});`, '  end', 'endmodule', ''].join('\n')
}

export async function simulateLogic(o: LogicOptions): Promise<LogicRun> {
  const iv = iverilog()
  const vp = vvp()
  if (!iv || !vp) throw new LogicError('Icarus Verilog (iverilog and vvp) not found: apt install iverilog / brew install icarus-verilog, or set IVERILOG and VVP')
  if (!o.sources.length) throw new LogicError('no sources given')
  const dir = scratchDir('trace-logic-')
  const t0 = Date.now()
  const timeoutMs = o.timeoutMs ?? 300_000
  try {
    const files: string[] = []
    const sources: { name: string; text: string }[] = []
    o.sources.forEach((s, k) => {
      if (s.path) {
        const p = resolve(s.path)
        if (!existsSync(p)) throw new LogicError(`no source file ${p}`)
        files.push(p)
        sources.push({ name: basename(p), text: readFileSync(p, 'utf8') })
      } else if (s.text !== undefined) {
        const name = basename(s.name ?? `source${k}.sv`)
        writeFileSync(join(dir, name), s.text)
        files.push(join(dir, name))
        sources.push({ name, text: s.text })
      } else throw new LogicError('each source needs a path or text')
    })
    const hasDump = sources.some((s) => DUMPFILE.test(s.text))
    const args = ['-g2012', '-o', 'sim.vvp']
    for (const d of o.includeDirs ?? []) args.push('-I', resolve(d))
    for (const [k, v] of Object.entries(o.defines ?? {})) args.push(v === true ? `-D${k}` : `-D${k}=${v}`)
    if (o.top) args.push('-s', o.top)

    // First compile: find the top (and check the sources) before adding the dump module.
    let c = await run(iv, [...args, ...files], { cwd: dir, timeoutMs })
    let compileLog = c.stdout + c.stderr
    const failed = (reason: string, timedOut = false): LogicRun => ({ passed: false, reason, top: o.top ?? '', compileLog, output: '', messages: [], vcd: null, vcdName: null, sources, timedOut, ms: Date.now() - t0 })
    if (c.timedOut) return failed('the compile ran over the time limit', true)
    if (c.code !== 0) return failed(`compile failed: ${firstLine(compileLog)}`)
    const roots = rootModules(readFileSync(join(dir, 'sim.vvp'), 'utf8'))
    const top = o.top ?? (roots.length === 1 ? (roots[0] as string) : '')
    if (!top) throw new LogicError(`several root modules (${roots.join(', ')}): give top`)
    let vcdName: string | null = null
    if (hasDump) {
      const m = DUMPFILE.exec(sources.find((s) => DUMPFILE.test(s.text))?.text ?? '')
      vcdName = m ? (m[1] as string) : null
    } else if (o.dump !== false) {
      writeFileSync(join(dir, 'trace_dump.v'), dumpModule(top))
      const a2 = [...args]
      if (!o.top) a2.push('-s', top)
      a2.push('-s', 'trace_dump')
      c = await run(iv, [...a2, ...files, join(dir, 'trace_dump.v')], { cwd: dir, timeoutMs })
      compileLog = c.stdout + c.stderr
      if (c.code !== 0) return failed(`compile with the dump module failed: ${firstLine(compileLog)}`)
      vcdName = 'trace_dump.vcd'
    }
    const r = await run(vp, ['-n', 'sim.vvp', ...(o.plusargs ?? []).map((p) => (p.startsWith('+') ? p : `+${p}`))], { cwd: dir, timeoutMs })
    const output = r.stdout + r.stderr
    const messages = parseMessages(output)
    const vcdPath = vcdName ? join(dir, vcdName) : null
    const vcd = vcdPath && existsSync(vcdPath) ? new Uint8Array(readFileSync(vcdPath)) : null
    let passed = true
    let reason = 'finished'
    const fatal = messages.find((m) => m.severity === 'fatal')
    const err = messages.find((m) => m.severity === 'error')
    if (r.timedOut) [passed, reason] = [false, `ran over the time limit (${Math.round(timeoutMs / 1000)} s): a testbench without $finish?`]
    else if (fatal) [passed, reason] = [false, `$fatal: ${fatal.text}`]
    else if (err) [passed, reason] = [false, `$error: ${err.text}`]
    else if (o.fail && new RegExp(o.fail, 'm').test(output)) [passed, reason] = [false, `output matched the fail pattern: ${firstMatch(output, o.fail)}`]
    else if (r.code !== 0) [passed, reason] = [false, `vvp exited with ${r.code}: ${firstLine(output)}`]
    else if (o.pass) {
      if (new RegExp(o.pass, 'm').test(output)) reason = `output matched the pass pattern: ${firstMatch(output, o.pass)}`
      else [passed, reason] = [false, 'the pass pattern never appeared in the output']
    }
    return { passed, reason, top, compileLog, output, messages, vcd, vcdName, sources, timedOut: r.timedOut, ms: Date.now() - t0 }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function firstLine(log: string): string {
  const lines = log.split('\n').map((l) => l.trim()).filter(Boolean)
  return (lines.find((l) => /error|syntax|fatal|unknown|not found/i.test(l)) ?? lines[0] ?? '(no output)').slice(0, 300)
}

function firstMatch(text: string, re: string): string {
  const m = new RegExp(`^.*(?:${re}).*$`, 'm').exec(text)
  return (m?.[0] ?? '').trim().slice(0, 200)
}
