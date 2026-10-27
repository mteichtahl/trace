/**
 * verify.run: execute test items and record their verdicts.
 *
 * A test item runs one of three ways:
 *   tool        the registered tool it names (verify.verilator, verify.cocotb, verify.formal, sim.logic, sim.spice,
 *               kicad.drc, a hil.* tool, …) with its stored args, called through the registry like any other call, so
 *               the tool records its own run. The verdict is the tool's `passed` / `pass` field when it has one, else
 *               the status of the run it recorded (pass | fail | error). A hardware tool in a session without hardware
 *               is not called: the test is `blocked`.
 *   command     an argv run in the repository root (exit status 0 passes), with its output kept as artifacts of the
 *               verify.run record itself. Commands run on this machine, not through the job queue: they belong to the
 *               repository (make test, a script).
 *   inspection  no tool or command: a person's (or agent's) verdict, given in `verdicts` with a note. Without one the
 *               test is `blocked`.
 * Then each `expect` limit is checked against the measurements of the evidence runs; a missing or out-of-range
 * measurement fails the test.
 *
 * Every verdict is a verify.run record (its evidence: the run ids it rests on) and a test_results row, and sets the
 * test item's status and last_run. TRACE_COVER lines in an evidence run's *.log artifacts are recorded as functional
 * coverage hits when that run recorded none itself (sim.logic, say).
 */
import { ToolError, type ToolContext } from '../../core/registry.js'
import { findRoot, Work, type Json } from '../../core/store.js'
import { run as runProc } from '../sim/proc.js'
import { Recorder } from '../sim/record.js'
import { type Expect, type TestItem, type TestResult, VerifyDb } from './db.js'
import { coverLines, tail } from './job.js'

export interface Verdict {
  test: string
  status: TestResult['status']
  reason: string
  run_id: string
  evidence: string[]
  checks?: { measurement: string; value: number | null; ok: boolean; limit: string }[]
}

/** run_id fields anywhere in a tool's (JSON) result, in order: the first is the tool's own run. */
export function runIds(result: unknown): string[] {
  const out: string[] = []
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4 || v === null || typeof v !== 'object') return
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 200)) walk(x, depth + 1)
      return
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if ((k === 'run_id' || k === 'best_run_id') && typeof x === 'string' && /^[0-9a-f]{8,32}$/.test(x)) out.push(x)
      else walk(x, depth + 1)
    }
  }
  walk(result, 0)
  return [...new Set(out)]
}

function check(e: Expect, value: number | null): { ok: boolean; limit: string } {
  const parts: string[] = []
  let ok = value !== null && Number.isFinite(value)
  if (e.min !== undefined) {
    parts.push(`>= ${e.min}`)
    ok &&= (value as number) >= e.min
  }
  if (e.max !== undefined) {
    parts.push(`<= ${e.max}`)
    ok &&= (value as number) <= e.max
  }
  if (e.equals !== undefined) {
    parts.push(`= ${e.equals}${e.tolerance ? ` ± ${e.tolerance}` : ''}`)
    ok &&= Math.abs((value as number) - e.equals) <= (e.tolerance ?? 0)
  }
  return { ok, limit: parts.join(' and ') || 'present' }
}

function harvestCover(v: VerifyDb, runIds: readonly string[]): void {
  const w = new Work()
  try {
    for (const id of runIds) {
      if (v.hasHits(id)) continue
      const rec = w.run(id)
      if (!rec) continue
      const hits = new Map<string, { hits: number; location: string | null }>()
      for (const a of rec.artifacts.filter((x) => /\.log$/i.test(x.name) && x.size < 20_000_000)) {
        const b = w.getArtifact(id, a.name)
        if (!b) continue
        for (const [n, h] of coverLines(new TextDecoder().decode(b))) hits.set(n, { hits: (hits.get(n)?.hits ?? 0) + h, location: null })
      }
      if (hits.size) v.addHits(id, 'functional', hits)
    }
  } finally {
    w.close()
  }
}

function runStatus(id: string): string | null {
  const w = new Work()
  try {
    return w.run(id)?.status ?? null
  } finally {
    w.close()
  }
}

function measurementOf(ids: readonly string[], name: string): number | null {
  const w = new Work()
  try {
    for (const id of ids) {
      const m = w.run(id)?.measurements.find((x) => x.name === name)
      if (m) return m.value
    }
    return null
  } finally {
    w.close()
  }
}

export async function runTest(t: TestItem, ctx: ToolContext, opts: { verdict?: { status: 'pass' | 'fail'; note?: string | undefined } | undefined; timeoutS: number }): Promise<Verdict> {
  const rec = new Recorder('verify.run', t.id, { test: t.id, method: t.method, tool: t.tool, args: t.args, command: t.command })
  let status: TestResult['status'] = 'error'
  let reason = ''
  let evidence: string[] = []
  let checks: Verdict['checks']
  try {
    if (t.tool) {
      const { allTools } = await import('../index.js')
      const reg = allTools()
      const tool = reg.get(t.tool)
      if (!tool) throw new ToolError(`no tool ${t.tool}`)
      if (t.tool.startsWith('verify.run') || t.tool === 'verify.report') throw new ToolError(`${t.tool} cannot be a test item's tool`)
      if (tool.hardware && !ctx.hardware) {
        status = 'blocked'
        reason = `${t.tool} drives real hardware: run it with hardware allowed (TRACE_HARDWARE=1)`
      } else {
        let result: unknown
        try {
          result = await reg.call(t.tool, t.args ?? {}, ctx)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          const m = /\(run ([0-9a-f]{8,32})/.exec(msg)
          if (m) evidence = [m[1] as string]
          status = 'error'
          reason = `${t.tool}: ${msg}`.slice(0, 500)
          result = undefined
        }
        if (result !== undefined) {
          evidence = runIds(result)
          const r = (result ?? {}) as Record<string, unknown>
          const flag = typeof r.passed === 'boolean' ? r.passed : typeof r.pass === 'boolean' ? r.pass : null
          const st = evidence[0] ? runStatus(evidence[0]) : null
          if (flag !== null) status = flag ? 'pass' : 'fail'
          else if (st === 'pass' || st === 'fail' || st === 'error') status = st
          else status = 'error'
          reason = typeof r.reason === 'string' ? r.reason : typeof r.summary === 'string' ? r.summary : `${t.tool}: ${status}${st ? ` (run ${st})` : ''}`
          if (flag === null && st === null) reason = `${t.tool} returned no verdict and recorded no run`
          rec.artifact('result.json', JSON.stringify(result, null, 1).slice(0, 2_000_000), 'application/json')
        }
      }
    } else if (t.command?.length) {
      const root = findRoot() ?? process.cwd()
      const [cmd, ...args] = t.command as [string, ...string[]]
      let r
      try {
        r = await runProc(cmd, args, { cwd: root, timeoutMs: opts.timeoutS * 1000 })
      } catch (e) {
        throw new ToolError(`${cmd}: ${e instanceof Error && 'code' in e && e.code === 'ENOENT' ? 'not found' : String(e)}`)
      }
      rec.artifact('stdout.log', tail(r.stdout, 2_000_000))
      rec.artifact('stderr.log', tail(r.stderr, 2_000_000))
      evidence = [rec.id]
      if (r.timedOut) [status, reason] = ['fail', `${t.command.join(' ')}: ran over ${opts.timeoutS} s`]
      else if (r.code === 0) [status, reason] = ['pass', `${t.command.join(' ')}: exit 0`]
      else [status, reason] = ['fail', `${t.command.join(' ')}: exit ${r.code ?? r.signal}: ${(r.stderr || r.stdout).trim().split('\n').slice(-1)[0]?.slice(0, 200) ?? ''}`]
    } else if (opts.verdict) {
      status = opts.verdict.status
      reason = `inspection: ${opts.verdict.note ?? opts.verdict.status}`
      evidence = [rec.id]
      if (opts.verdict.note) rec.artifact('inspection.txt', opts.verdict.note)
    } else {
      status = 'blocked'
      reason = 'inspection: give the verdict (verdicts: {"<test id>": {"status": "pass", "note": "…"}})'
    }

    if (t.expect.length && (status === 'pass' || status === 'fail')) {
      checks = t.expect.map((e) => {
        const value = measurementOf(evidence, e.measurement)
        return { measurement: e.measurement, value, ...check(e, value) }
      })
      for (const c of checks) rec.measure(`expect.${c.measurement}`, c.value, '', { ok: c.ok, limit: c.limit })
      const bad = checks.filter((c) => !c.ok)
      if (bad.length && status === 'pass') {
        status = 'fail'
        reason = `expectation not met: ${bad.map((c) => `${c.measurement} = ${c.value ?? 'missing'} (want ${c.limit})`).join('; ')}`
      } else if (!bad.length && status === 'pass') reason = `${reason}; ${checks.length} expectation(s) met`
    }
  } catch (e) {
    status = 'error'
    reason = e instanceof Error ? e.message : String(e)
  }
  const v = new VerifyDb()
  try {
    if (evidence.length) harvestCover(v, evidence.filter((id) => id !== rec.id))
    rec.finish(status === 'blocked' ? 'error' : status, `${t.id} ${status}: ${reason}`, { test: t.id, status, reason, evidence, ...(checks ? { checks } : {}) } as unknown as Json)
    v.addResult({ run_id: rec.id, test_id: t.id, status, evidence, reason: reason.slice(0, 1000) })
    v.updateTest(t.id, { status, last_run: rec.id })
  } finally {
    v.close()
  }
  return { test: t.id, status, reason, run_id: rec.id, evidence, ...(checks ? { checks } : {}) }
}

/** The stored args of a test item, validated against its tool's input schema (so a typo is caught when planned). */
export async function validateToolArgs(tool: string, args: unknown): Promise<void> {
  const { allTools } = await import('../index.js')
  const t = allTools().get(tool)
  if (!t) throw new ToolError(`no tool ${JSON.stringify(tool)} (tracectl tools lists them)`)
  const r = t.input.strict().safeParse(args ?? {})
  if (!r.success) throw new ToolError(`args for ${tool}: ${r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`)
}

