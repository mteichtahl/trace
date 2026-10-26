/**
 * Formal verification of SystemVerilog assertions (assert / assume / cover in `always` blocks or under `ifdef FORMAL`).
 *
 *   engine sby      SymbiYosys runs a .sby file (the caller's, with its [files] staged as job inputs and the section
 *                   rewritten to their names; or one written here from files/top/mode/depth). Its log gives the verdict
 *                   (DONE (PASS|FAIL|UNKNOWN|ERROR|TIMEOUT)), the failed assertions and cover statements with steps,
 *                   and the trace files.
 *   engine smtbmc   without sby, the steps sby's smtbmc engine runs, done directly: yosys reads the sources with
 *                   -formal, `prep -top`, async2sync, dffunmap, write_smt2; then yosys-smtbmc checks
 *                     bmc    no assertion fails within `depth` steps from the initial state
 *                     prove  bmc to `depth` (the base case) and k-induction of depth `depth`: PASS when both hold, FAIL
 *                            when the base case fails, UNKNOWN when only induction fails (the property may hold but is
 *                            not inductive at that depth: strengthen it with more assertions, or raise depth)
 *                     cover  every cover statement is reached within `depth` steps (FAIL lists the unreached ones)
 *                   Only sby's smtbmc engine is reproduced (not abc pdr, aiger or multiclock options).
 *   engine auto     sby when it is installed or a .sby file is given, else smtbmc.
 *
 * Counterexample and cover traces (VCD) come back as artifacts (at most eight), for sim.wave_* to read. Cover
 * statements, reached or not, become coverage hits (kind cover) in the project database.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { ToolError } from '../../core/registry.js'
import { haveProgram, hdlStage, includeArgs, needProgram, shellJob, sq, stage } from './job.js'
import { parseSby, parseSmtbmc, type FormalLog } from './parse.js'

export interface FormalOptions {
  sby?: string | undefined
  task?: string | undefined
  files?: string[] | undefined
  top?: string | undefined
  mode: 'bmc' | 'prove' | 'cover'
  depth: number
  engine: 'auto' | 'sby' | 'smtbmc'
  solver?: string | undefined
  include_dirs?: string[] | undefined
  defines?: Record<string, string | number | boolean> | undefined
  timeout_s: number
}

export interface FormalRun {
  engine: 'sby' | 'smtbmc'
  status: NonNullable<FormalLog['status']>
  passed: boolean
  reason: string
  log: FormalLog
  logs: Record<string, string>
  traces: { name: string; from: string; bytes: Uint8Array }[]
  solver: string | null
  seconds: number
  where: string
}

const SOLVERS: [string, string][] = [['yices', 'yices-smt2'], ['z3', 'z3'], ['bitwuzla', 'bitwuzla'], ['boolector', 'boolector']]
const MAX_TRACES = 8
const TRACE_OUTS = Array.from({ length: MAX_TRACES }, (_, i) => `trace${i}.vcd`)

export function pickSolver(want?: string): string {
  if (want) return want
  if (process.env.TRACE_SMT_SOLVER) return process.env.TRACE_SMT_SOLVER
  for (const [name, exe] of SOLVERS) if (haveProgram(exe)) return name
  return 'yices'
}

/** The [files] section of a .sby file: each line `path` or `name path`. */
export function sbyFiles(text: string): { dest: string; src: string }[] {
  const out: { dest: string; src: string }[] = []
  let inFiles = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const sec = /^\[([^\]]+)\]$/.exec(line)
    if (sec) {
      inFiles = sec[1]?.trim() === 'files'
      continue
    }
    if (!inFiles || !line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    if (parts.length === 1) out.push({ dest: basename(parts[0] as string), src: parts[0] as string })
    else out.push({ dest: parts[0] as string, src: parts[1] as string })
  }
  return out
}

/** The .sby text with its [files] section replaced by `dest name` lines (name: the staged input). */
export function rewriteSbyFiles(text: string, files: readonly { dest: string; name: string }[]): string {
  const out: string[] = []
  let inFiles = false
  for (const raw of text.split('\n')) {
    const sec = /^\s*\[([^\]]+)\]\s*$/.exec(raw)
    if (sec) {
      inFiles = sec[1]?.trim() === 'files'
      out.push(raw)
      // a lone path is copied to its basename: a name with a folder is written as `dest name` to keep its place
      if (inFiles) for (const f of files) out.push(f.dest === f.name && !f.name.includes('/') ? f.name : `${f.dest} ${f.name}`)
      continue
    }
    if (!inFiles) out.push(raw)
  }
  return out.join('\n')
}

/** A .sby for files + top. `files` are read; `others` (include files) are copied beside them; `incdirs` become -I.
 * Paths are relative to the .sby file and keep their folders in sby's src/. */
export function generatedSby(o: { files: string[]; others?: string[]; incdirs?: string[]; top: string; mode: FormalOptions['mode']; depth: number; solver: string; defines?: FormalOptions['defines'] }): string {
  const defs = Object.entries(o.defines ?? {}).filter(([, v]) => v !== false).map(([k, v]) => (v === true ? `-D${k}` : `-D${k}=${v}`))
  const incs = [...new Set(o.incdirs ?? [])].map((d) => `-I${d}`)
  const flags = [...defs, ...incs].join(' ')
  const all = [...new Set([...o.files, ...(o.others ?? [])])]
  return [
    '[options]', `mode ${o.mode}`, `depth ${o.depth}`, '',
    '[engines]', `smtbmc ${o.solver}`, '',
    '[script]', `read -formal ${flags ? `${flags} ` : ''}${o.files.join(' ')}`, `prep -top ${o.top}`, '',
    '[files]', ...all.map((f) => (f.includes('/') ? `${f} ${f}` : f)), '',
  ].join('\n')
}

export async function runFormal(o: FormalOptions): Promise<FormalRun> {
  const sbyHere = haveProgram('sby')
  const engine: 'sby' | 'smtbmc' = o.engine === 'auto' ? (o.sby || sbyHere ? 'sby' : 'smtbmc') : o.engine
  if (engine === 'smtbmc' && o.sby) throw new ToolError('a .sby file needs engine sby (SymbiYosys); give files and top for engine smtbmc')
  const solver = pickSolver(o.solver)
  const tmp = mkdtempSync(join(tmpdir(), 'trace-formal-'))
  try {
    if (engine === 'sby') {
      needProgram('sby', 'install SymbiYosys (the OSS CAD Suite has it), or use engine smtbmc with files and top')
      let sbyText: string
      let st: ReturnType<typeof hdlStage>
      let files: { dest: string; name: string }[]
      if (o.sby) {
        const p = resolve(o.sby)
        if (!existsSync(p)) throw new ToolError(`no file ${p}`)
        sbyText = readFileSync(p, 'utf8')
        const listed = sbyFiles(sbyText)
        // the listed files keep their layout; [files] is rewritten to their staged names, dest names as given
        st = hdlStage({ files: listed.map((f) => resolve(dirname(p), f.src)), include_dirs: o.include_dirs })
        files = listed.map((f, i) => ({ dest: f.dest, name: st.sources[i] as string }))
      } else {
        if (!o.files?.length || !o.top) throw new ToolError('give a .sby file, or files and top')
        st = hdlStage({ files: o.files, include_dirs: o.include_dirs })
        const others = st.names.filter((n) => !st.sources.includes(n))
        const incdirs = includeArgs(st, '').map((a) => a.replace(/^\{dir\}\/in\/?/, '') || '.')
        files = [...st.sources, ...others].map((n) => ({ dest: n, name: n }))
        sbyText = generatedSby({ files: st.sources, others, incdirs, top: o.top, mode: o.mode, depth: o.depth, solver, defines: o.defines })
      }
      writeFileSync(join(tmp, 'trace_job.sby'), rewriteSbyFiles(sbyText, files))
      stage([join(tmp, 'trace_job.sby')], st)
      const script = [
        'cd {dir}/in',
        `sby -f -d {dir}/work trace_job.sby ${o.task ? sq(o.task) : ''} > {out:sby.log} 2>&1`,
        'echo "rc=$?" > {out:status.txt}',
        '[ -f {dir}/work/logfile.txt ] && cp {dir}/work/logfile.txt {out:logfile.txt}',
        copyTraces('{dir}/work'),
      ].join('\n')
      const r = await shellJob({ kind: 'formal', script, inputs: st.inputs, outputs: ['sby.log', 'logfile.txt', 'status.txt', 'traces.txt', ...TRACE_OUTS], timeoutSeconds: o.timeout_s })
      try {
        const text = r.text('logfile.txt') || r.text('sby.log')
        const log = parseSby(text)
        const status = log.status ?? (r.job.exitCode === 137 ? 'TIMEOUT' : 'ERROR')
        return finish('sby', status, log, { 'sby.log': r.text('sby.log'), 'logfile.txt': r.text('logfile.txt') }, traces(r), solver, r.job.seconds, r.job.where, text)
      } finally {
        r.cleanup()
      }
    }
    // smtbmc
    needProgram('yosys', 'apt install yosys, or the OSS CAD Suite')
    needProgram('yosys-smtbmc', 'it comes with yosys (Debian/Ubuntu: the yosys package)')
    if (!o.files?.length || !o.top) throw new ToolError('engine smtbmc needs files and top')
    if (!/^[A-Za-z_][\w$]*$/.test(o.top)) throw new ToolError(`top ${JSON.stringify(o.top)} is not a module name`)
    const st = hdlStage({ files: o.files, include_dirs: o.include_dirs })
    const src = [...st.sources]
    const defs = Object.entries(o.defines ?? {}).filter(([, v]) => v !== false).map(([k, v]) => (v === true ? `-D${k}` : `-D${k}=${v}`))
    const ys = `read_verilog -formal -sv ${[...defs, ...includeArgs(st)].join(' ')} ${src.map((n) => `{in:${n}}`).join(' ')}; prep -top ${o.top}; async2sync; dffunmap; write_smt2 -wires {dir}/model.smt2`
    const smt = (flags: string, vcd: string, log: string): string =>
      `yosys-smtbmc -s ${sq(solver)} --noprogress ${flags} -t ${o.depth} --dump-vcd {dir}/vcd/${vcd} {dir}/model.smt2 > {out:${log}} 2>&1; echo "${log}=$?" >> {out:status.txt}`
    const steps = o.mode === 'cover' ? [smt('-c', 'cover_%.vcd', 'cover.log')]
      : o.mode === 'prove' ? [smt('', 'bmc.vcd', 'bmc.log'), smt('-i', 'induction.vcd', 'induction.log')]
        : [smt('', 'bmc.vcd', 'bmc.log')]
    const script = [
      'cd {dir}', 'mkdir -p {dir}/vcd',
      `yosys -q -l {out:yosys.log} -p ${sq(ys)} > /dev/null 2>&1`,
      'rc=$?; echo "yosys=$rc" > {out:status.txt}',
      '[ "$rc" -eq 0 ] || exit 0',
      ...steps,
      copyTraces('{dir}/vcd'),
    ].join('\n')
    const r = await shellJob({ kind: 'formal', script, inputs: st.inputs, timeoutSeconds: o.timeout_s,
      outputs: ['yosys.log', 'bmc.log', 'induction.log', 'cover.log', 'status.txt', 'traces.txt', ...TRACE_OUTS] })
    try {
      const statusTxt = r.text('status.txt')
      const logs: Record<string, string> = { 'yosys.log': r.text('yosys.log') }
      for (const n of ['bmc.log', 'induction.log', 'cover.log']) if (r.has(n)) logs[n] = r.text(n)
      const tr = traces(r)
      if (!/yosys=0/.test(statusTxt)) {
        const err = (logs['yosys.log'] ?? '').split('\n').find((l) => /ERROR/.test(l)) ?? 'yosys failed to read the design'
        return finish('smtbmc', 'ERROR', { status: 'ERROR', findings: [], traces: [], steps: null }, logs, tr, solver, r.job.seconds, r.job.where, err)
      }
      if (o.mode === 'prove') {
        const base = parseSmtbmc(logs['bmc.log'] ?? '')
        const ind = parseSmtbmc(logs['induction.log'] ?? '')
        const status = base.status === 'FAIL' ? 'FAIL' : base.status === 'PASS' && ind.status === 'PASS' ? 'PASS' : base.status === 'PASS' && ind.status === 'FAIL' ? 'UNKNOWN' : 'ERROR'
        const log: FormalLog = { status, findings: [...base.findings, ...ind.findings.map((f) => ({ ...f, kind: 'induction_failed' as const }))], traces: [...base.traces, ...ind.traces], steps: Math.max(base.steps ?? 0, ind.steps ?? 0) }
        return finish('smtbmc', status, log, logs, tr, solver, r.job.seconds, r.job.where, (logs['bmc.log'] ?? '') + (logs['induction.log'] ?? ''))
      }
      const text = logs[o.mode === 'cover' ? 'cover.log' : 'bmc.log'] ?? ''
      const log = parseSmtbmc(text)
      return finish('smtbmc', log.status ?? (r.job.exitCode === 137 ? 'TIMEOUT' : 'ERROR'), log, logs, tr, solver, r.job.seconds, r.job.where, text)
    } finally {
      r.cleanup()
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** Shell: copy the first MAX_TRACES .vcd files under `root` to {out:traceN.vcd}, listing their paths in traces.txt. */
function copyTraces(root: string): string {
  return [
    `: > {out:traces.txt}`,
    `i=0; for f in $(find ${root} -name '*.vcd' 2>/dev/null | sort | head -${MAX_TRACES}); do`,
    `  echo "$i ${'$'}{f#${root}/}" >> {out:traces.txt}`,
    ...TRACE_OUTS.map((n, k) => `  [ "$i" -eq ${k} ] && cp "$f" {out:${n}}`),
    '  i=$((i+1)); done; true',
  ].join('\n')
}

function traces(r: { text: (n: string) => string; bytes: (n: string) => Uint8Array | null }): FormalRun['traces'] {
  const out: FormalRun['traces'] = []
  for (const line of r.text('traces.txt').split('\n')) {
    const m = /^(\d+) (.+)$/.exec(line.trim())
    if (!m) continue
    const b = r.bytes(`trace${m[1]}.vcd`)
    if (b) out.push({ name: `trace${m[1]}.vcd`, from: m[2] as string, bytes: b })
  }
  return out
}

function finish(engine: FormalRun['engine'], status: FormalRun['status'], log: FormalLog, logs: Record<string, string>, tr: FormalRun['traces'],
  solver: string, seconds: number, where: string, text: string): FormalRun {
  const failedAsserts = log.findings.filter((f) => f.kind === 'assert_failed')
  const unreached = log.findings.filter((f) => f.kind === 'cover_unreached')
  const reached = log.findings.filter((f) => f.kind === 'cover_reached')
  let reason: string
  if (status === 'PASS') reason = reached.length ? `all ${reached.length} cover statement(s) reached` : 'no assertion fails'
  else if (status === 'FAIL') {
    reason = failedAsserts.length ? `assertion failed: ${failedAsserts.slice(0, 3).map((f) => f.location ?? f.name).join(', ')}`
      : unreached.length ? `${unreached.length} cover statement(s) unreached: ${unreached.slice(0, 3).map((f) => f.location ?? f.name).join(', ')}` : 'failed'
  } else if (status === 'UNKNOWN') reason = 'the base case holds but induction failed at this depth: the property is not (yet) inductive'
  else if (status === 'TIMEOUT') reason = 'the solver ran out of time'
  else {
    const line = text.split('\n').map((l) => l.trim()).find((l) => /error|unexpected|traceback|not found/i.test(l))
    reason = `error: ${(line ?? 'no verdict in the log').slice(0, 300)}`
  }
  return { engine, status, passed: status === 'PASS', reason, log, logs, traces: tr, solver, seconds, where }
}
