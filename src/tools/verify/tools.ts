/**
 * The verification tools, for the Verification agent: requirements and the test plan kept in the project database,
 * running the plan and recording verdicts with evidence, coverage, the report, and the digital verification
 * programs (Verilator, cocotb, formal with SymbiYosys or yosys-smtbmc).
 *
 *   verify.requirements  add / list / update / extract (candidates from a spec's text or a PDF/text file, by rules)
 *   verify.plan          add / list / update / delete test items, each linked to requirements
 *   verify.run           run test items through their tools or commands; record pass/fail with evidence run ids
 *   verify.coverage      requirement coverage matrix, coverage points, functional and code coverage merged
 *   verify.report        the verification status as Markdown (stored as an artifact, optionally written to a file)
 *   verify.verilator     lint + build + run a testbench with line/toggle/branch/user coverage
 *   verify.cocotb        cocotb tests on Icarus or Verilator; per-test verdicts from results.xml
 *   verify.formal        assertions and covers: bmc / prove / cover
 *
 * The simulator tools record a run each (logs, coverage.dat, results.xml, traces as artifacts) and return its run_id.
 * The programs run through runJob as CPU jobs (local unless TRACE_GPU_REMOTE=always).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'
import { z } from 'zod'
import { defineTool, ToolError, type AnyTool } from '../../core/registry.js'
import type { Json } from '../../core/store.js'
import { Recorder } from '../sim/record.js'
import { ExpectSchema, METHODS, POINT_KINDS, REQ_KINDS, REQ_STATUS, TEST_STATUS, withVerify, type TestItem } from './db.js'
import { extractCandidates } from './extract.js'
import { tail } from './job.js'
import { buildMatrix, reportMarkdown } from './matrix.js'
import { runCocotb } from './cocotb.js'
import { runFormal } from './formal.js'
import { runTest, validateToolArgs, type Verdict } from './run.js'
import { coverageSummary, runVerilator } from './verilator.js'

const Defines = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
const Params = z.record(z.string(), z.union([z.string(), z.number()]))

// ------------------------------------------------------------------ verify.requirements

const ReqInput = z.object({
  id: z.string().optional().describe('default: a new random REQ-xxxxxx (6 hex digits, so branches do not collide); existing ids such as REQ-001 are kept'),
  text: z.string().min(3),
  kind: z.enum(REQ_KINDS),
  acceptance: z.string().optional().describe('the acceptance criterion: what a test must show'),
  source: z.string().optional().describe('the document it comes from (path, datasheet sha256, title)'),
  page: z.number().int().positive().optional(),
  status: z.enum(REQ_STATUS).optional().describe('default proposed'),
  tags: z.array(z.string()).optional(),
}).strict()

async function documentPages(path: string): Promise<string[]> {
  const p = resolve(path)
  if (!existsSync(p)) throw new ToolError(`no file ${p}`)
  if (extname(p).toLowerCase() === '.pdf') {
    const { pdfText } = await import('../datasheets/text.js')
    return (await pdfText(new Uint8Array(readFileSync(p)))).pages
  }
  // text: form feeds separate pages (pdftotext's output); otherwise one page
  return readFileSync(p, 'utf8').split('\f')
}

export const requirementsTool = defineTool({
  name: 'verify.requirements',
  description: 'Requirements in the project database (only the Verification specialist adds or updates them; others list). add (one or many, e.g. confirmed candidates), list (filter by kind/status), update one, or extract: candidate requirements from a specification (text, or a .pdf/.txt/.md file), found by rules: requirement verbs (shall/must/should…), spec-table rows with min/typ/max, numeric limits; each with a kind, an acceptance criterion from its limits, its page and a score. extract never writes; confirm candidates with add.',
  input: z.object({
    action: z.enum(['add', 'list', 'update', 'extract']),
    requirements: z.array(ReqInput).optional().describe('add: the requirements'),
    id: z.string().optional().describe('update: which'),
    set: ReqInput.partial().omit({ id: true }).optional().describe('update: the fields to change'),
    kind: z.enum(REQ_KINDS).optional().describe('list: only this kind'),
    status: z.enum(REQ_STATUS).optional().describe('list: only this status'),
    text: z.string().optional().describe('extract: the specification text'),
    path: z.string().optional().describe('extract: or a document (.pdf, or text with form feeds between pages)'),
    pages: z.array(z.number().int().positive()).optional().describe('extract: only these pages'),
    min_score: z.number().min(0).max(1).default(0.3).describe('extract: drop weaker candidates'),
    limit: z.number().int().min(1).max(2000).default(200),
  }),
  run: async (a) => {
    if (a.action === 'extract') {
      if ((a.text === undefined) === (a.path === undefined)) throw new ToolError('extract: give text or path')
      let pages = a.text !== undefined ? [a.text] : await documentPages(a.path as string)
      const keep = a.pages ? new Set(a.pages) : null
      if (keep) pages = pages.map((p, i) => (keep.has(i + 1) ? p : ''))
      const all = extractCandidates(pages, { minScore: a.min_score, pageNumbers: a.path !== undefined })
      return {
        source: a.path ?? null, pages: pages.length, candidates: all.slice(0, a.limit).map((c) => ({ ...c, ...(a.path ? { source: a.path } : {}) })),
        total: all.length, by_kind: Object.fromEntries(REQ_KINDS.map((k) => [k, all.filter((c) => c.kind === k).length])),
        note: 'candidates only: confirm, edit or drop each, then add them (action add)',
      }
    }
    // the requirements are the Verification specialist's: another specialist reads them (list) and hands a change to
    // it (journey.handoff); a worker or a person's own session (no TRACE_AGENT, or worker) is not a specialist
    const agent = (process.env.TRACE_AGENT ?? '').trim().toLowerCase()
    if ((a.action === 'add' || a.action === 'update') && agent && agent !== 'verify' && agent !== 'worker' && agent !== 'local') {
      throw new ToolError(`${a.action}: the requirements are the Verification specialist's to change. Read them with action list, and hand the change to it with journey.handoff (the requirement, the new wording or criterion, and why).`)
    }
    return withVerify((v) => {
      if (a.action === 'add') {
        if (!a.requirements?.length) throw new ToolError('add: give requirements')
        const added = a.requirements.map((r) => v.addRequirement(r))
        return { added: added.map((r) => r.id), requirements: added }
      }
      if (a.action === 'update') {
        if (!a.id || !a.set) throw new ToolError('update: give id and set')
        return { requirement: v.updateRequirement(a.id, a.set) }
      }
      const list = v.requirements({ kind: a.kind, status: a.status })
      const notes = v.mergeNotes()
      return { total: list.length, requirements: list.slice(0, a.limit), ...(notes.length ? { merge_notes: notes } : {}) }
    })
  },
})

// ------------------------------------------------------------------ verify.plan

const TestInput = z.object({
  id: z.string().optional().describe('default: the next TST-nnn'),
  title: z.string().min(3),
  requirements: z.array(z.string()).min(1).describe('requirement ids it verifies'),
  method: z.enum(METHODS),
  tool: z.string().optional().describe('the tool verify.run calls, e.g. verify.cocotb, verify.formal, sim.spice, kicad.drc'),
  args: z.record(z.string(), z.unknown()).optional().describe('its arguments (checked against the tool now)'),
  command: z.array(z.string()).min(1).optional().describe('or an argv run in the repository root (exit 0 passes)'),
  expect: z.array(ExpectSchema).optional().describe('measurement limits the run must meet, e.g. [{"measurement":"f3db","min":900,"max":1100}]'),
  note: z.string().optional(),
  status: z.enum(TEST_STATUS).optional().describe('default planned; waived to set one aside'),
}).strict()

async function checkHow(t: { method?: string | undefined; tool?: string | undefined; args?: Record<string, unknown> | undefined; command?: string[] | undefined }): Promise<void> {
  if (t.tool && t.command) throw new ToolError('give tool (+ args) or command, not both')
  if (t.tool) await validateToolArgs(t.tool, t.args ?? {})
  else if (t.args) throw new ToolError('args go with a tool')
  if (!t.tool && !t.command && t.method !== undefined && t.method !== 'inspection') throw new ToolError(`method ${t.method} needs a tool or a command (only inspection may have neither)`)
}

export const planTool = defineTool({
  name: 'verify.plan',
  description: 'The test plan in the project database: add test items (each linked to requirement ids, with a method — sim, formal, spice, hil, inspection, drc — and how it runs: a tool call with args, or a command), list (by requirement, method or status, with each item\'s last result), update, delete. Tool args are checked against the tool\'s input schema when planned.',
  input: z.object({
    action: z.enum(['add', 'list', 'update', 'delete']),
    tests: z.array(TestInput).optional().describe('add: the test items'),
    id: z.string().optional().describe('update/delete: which'),
    set: TestInput.partial().omit({ id: true }).optional().describe('update: fields to change'),
    requirement: z.string().optional().describe('list: tests of this requirement'),
    method: z.enum(METHODS).optional(),
    status: z.enum(TEST_STATUS).optional(),
    limit: z.number().int().min(1).max(2000).default(200),
  }),
  run: async (a) => {
    if (a.action === 'add') {
      if (!a.tests?.length) throw new ToolError('add: give tests')
      for (const t of a.tests) await checkHow(t)
      return withVerify((v) => {
        const added = a.tests?.map((t) => v.addTest({ ...t, args: t.args as Record<string, Json> | undefined })) ?? []
        return { added: added.map((t) => t.id), tests: added }
      })
    }
    if (a.action === 'update') {
      if (!a.id || !a.set) throw new ToolError('update: give id and set')
      const cur = withVerify((v) => v.test(a.id as string))
      if (!cur) throw new ToolError(`no test item ${a.id}`)
      const s = a.set
      if (s.tool !== undefined || s.args !== undefined || s.command !== undefined || s.method !== undefined) {
        const tool = s.command ? undefined : s.tool ?? cur.tool ?? undefined
        await checkHow({ method: s.method ?? cur.method, tool, args: (s.args ?? (s.tool === undefined ? cur.args ?? undefined : undefined)) as Record<string, unknown> | undefined, command: s.command ?? (s.tool ? undefined : cur.command ?? undefined) })
      }
      return withVerify((v) => ({
        test: v.updateTest(a.id as string, {
          ...s, args: s.args as Record<string, Json> | undefined,
          ...(s.command ? { tool: null, args: null } : {}), ...(s.tool ? { command: null } : {}),
        } as Partial<TestItem>),
      }))
    }
    if (a.action === 'delete') {
      if (!a.id) throw new ToolError('delete: give id')
      return withVerify((v) => ({ deleted: v.deleteTest(a.id as string) }))
    }
    return withVerify((v) => {
      const list = v.tests({ requirement: a.requirement, method: a.method, status: a.status })
      return {
        total: list.length,
        tests: list.slice(0, a.limit).map((t) => {
          const r = v.latestResult(t.id)
          return { ...t, last_result: r ? { status: r.status, reason: r.reason, evidence: r.evidence, at: new Date(r.at * 1000).toISOString() } : null }
        }),
      }
    })
  },
})

// ------------------------------------------------------------------ verify.run

export const runTool = defineTool({
  name: 'verify.run',
  description: 'Run test items from the plan: each through its tool (called via the registry, so the tool records its own run) or its command (in the repository root), then its expected measurement limits. Records pass/fail/error/blocked with the evidence run ids, and sets each item\'s status. Hardware tools are blocked unless hardware is allowed; inspection items take their verdict from verdicts.',
  input: z.object({
    ids: z.array(z.string()).optional().describe('these test items'),
    requirement: z.string().optional().describe('or every test of this requirement'),
    status: z.enum(TEST_STATUS).optional().describe('or every test with this status (e.g. planned, fail)'),
    all: z.boolean().default(false).describe('or every test not waived'),
    verdicts: z.record(z.string(), z.object({ status: z.enum(['pass', 'fail']), note: z.string().optional() }).strict()).optional()
      .describe('inspection verdicts by test id: {"TST-007": {"status": "pass", "note": "checked U3 orientation on the assembled board"}}'),
    stop_on_fail: z.boolean().default(false),
    timeout_s: z.number().positive().max(24 * 3600).default(1800).describe('for command tests'),
  }),
  run: async (a, ctx) => {
    const tests = withVerify((v) => {
      if (a.ids?.length) {
        return a.ids.map((id) => {
          const t = v.test(id)
          if (!t) throw new ToolError(`no test item ${id}`)
          return t
        })
      }
      if (a.requirement) return v.tests({ requirement: a.requirement })
      if (a.status) return v.tests({ status: a.status })
      if (a.all) return v.tests().filter((t) => t.status !== 'waived')
      throw new ToolError('give ids, requirement, status or all')
    })
    if (!tests.length) return { ran: 0, results: [], summary: 'no test items matched' }
    const results: Verdict[] = []
    for (const t of tests) {
      const r = await runTest(t, ctx, { verdict: a.verdicts?.[t.id], timeoutS: a.timeout_s })
      results.push(r)
      if (a.stop_on_fail && r.status !== 'pass') break
    }
    const count = (s: string): number => results.filter((r) => r.status === s).length
    return {
      ran: results.length, pass: count('pass'), fail: count('fail'), error: count('error'), blocked: count('blocked'),
      results, summary: `${count('pass')}/${results.length} passed${count('fail') ? `, ${count('fail')} failed` : ''}${count('error') ? `, ${count('error')} errored` : ''}${count('blocked') ? `, ${count('blocked')} blocked` : ''}`,
    }
  },
})

// ------------------------------------------------------------------ verify.coverage

const PointInput = z.object({
  id: z.string().optional().describe('default: the next COV-nnn; an existing id is replaced'),
  requirements: z.array(z.string()).min(1),
  kind: z.enum(POINT_KINDS).describe('functional: verilator cover property / TRACE_COVER hits; cover: formal cover statements'),
  match: z.string().min(1).describe('the hit name (or its last dotted part), or /regex/'),
  goal: z.number().int().min(1).optional().describe('hits needed (default 1)'),
  description: z.string().optional(),
}).strict()

export const coverageTool = defineTool({
  name: 'verify.coverage',
  description: 'Requirement coverage matrix: each requirement\'s verdict (verified, coverage_gap, failing, partial, untested, no_test, waived) from its tests\' statuses and its coverage points; functional coverage (hits from the tests\' latest evidence runs, matched to coverage points; unplanned hits listed); code coverage (line/toggle/branch) merged from those runs\' Verilator coverage.dat. define/remove manage coverage points.',
  input: z.object({
    define: z.array(PointInput).optional().describe('coverage points to add or replace first'),
    remove: z.array(z.string()).optional().describe('coverage point ids to delete first'),
    runs: z.array(z.string()).optional().describe('merge these runs instead of the tests\' latest evidence'),
    code: z.boolean().default(true).describe('merge code coverage'),
    exclude: z.string().default('(^|/)(tb_|test_)[^/]*$|_tb\\.s?v$').describe('regex of files left out of code coverage ("" keeps all)'),
    verdict: z.enum(['verified', 'coverage_gap', 'failing', 'partial', 'untested', 'no_test', 'waived']).optional().describe('list only requirements with this verdict'),
    limit: z.number().int().min(1).max(5000).default(500),
  }),
  run: (a) => withVerify((v) => {
    const defined = (a.define ?? []).map((p) => v.definePoint(p).id)
    const removed = (a.remove ?? []).filter((id) => v.deletePoint(id))
    const m = buildMatrix(v, { runs: a.runs, code: a.code, exclude: a.exclude || undefined })
    const rows = a.verdict ? m.requirements.filter((r) => r.verdict === a.verdict) : m.requirements
    return {
      ...(defined.length ? { defined } : {}), ...(removed.length ? { removed } : {}),
      summary: m.summary, requirements: rows.slice(0, a.limit), requirements_listed: Math.min(rows.length, a.limit),
      orphan_tests: m.orphan_tests, coverage_points: m.points, unplanned_hits: m.unplanned_hits,
      code: m.code, code_runs: m.code_runs, evidence_runs: m.evidence_runs.length,
    }
  }),
})

// ------------------------------------------------------------------ verify.report

export const reportTool = defineTool({
  name: 'verify.report',
  description: 'The verification status as a Markdown report: summary, requirements with verdicts, tests with last runs, coverage points, code coverage by file, open items. Recorded (report.md artifact); written to path when given.',
  input: z.object({
    title: z.string().default('Verification report'),
    path: z.string().optional().describe('also write the report here (e.g. docs/verification.md)'),
    exclude: z.string().default('(^|/)(tb_|test_)[^/]*$|_tb\\.s?v$').describe('regex of files left out of code coverage'),
    max_chars: z.number().int().min(500).max(200_000).default(20_000).describe('characters of the report returned (all is stored)'),
  }),
  run: (a) => {
    const rec = new Recorder('verify.report', a.path ?? 'verification', a)
    try {
      const { md, m } = withVerify((v) => {
        const m = buildMatrix(v, { exclude: a.exclude || undefined })
        return { m, md: reportMarkdown(m, v.tests(), { title: a.title, generated: new Date().toISOString().replace(/\.\d+Z$/, 'Z') }) }
      })
      rec.artifact('report.md', md, 'text/markdown')
      if (a.path) {
        const p = resolve(a.path)
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, md)
      }
      const s = m.summary
      const summary = `${s.verified}/${s.requirements} requirements verified, ${s.failing} failing, ${s.no_test} without a test`
      rec.measure('requirements', s.requirements)
      rec.measure('verified', s.verified)
      rec.finish(s.failing ? 'fail' : 'pass', summary, { summary: s as unknown as Json })
      return { run_id: rec.id, summary, counts: s, ...(a.path ? { written: resolve(a.path) } : {}), markdown: md.length > a.max_chars ? `${md.slice(0, a.max_chars)}\n… (${md.length} characters; the whole report is the report.md artifact)` : md }
    } catch (e) {
      throw rec.fail(e)
    }
  },
})

// ------------------------------------------------------------------ verify.verilator

function recordHits(runId: string, kind: 'functional' | 'cover', hits: Map<string, { hits: number; location: string | null }>): void {
  if (hits.size) withVerify((v) => v.addHits(runId, kind, hits))
}

const lines = (s: string, n: number): string[] => {
  const ls = s.split('\n').filter((l) => l.length)
  return ls.length > n ? [...ls.slice(0, Math.ceil(n / 2)), `… ${ls.length - n} lines …`, ...ls.slice(-Math.floor(n / 2))] : ls
}

export const verilatorTool = defineTool({
  name: 'verify.verilator',
  description: 'Verilator: lint (--lint-only, -Wall by default) and, in run mode, build and run a testbench — the caller\'s C++ (cpp) or a SystemVerilog/Verilog testbench top (run to $finish with --timing) — with coverage (line, toggle, user; branch comes with line). Pass/fail from lint errors, the build, exit status, %Error/%Fatal output and optional regexes. Coverage per kind and file from coverage.dat (also as lcov .info); cover property points and TRACE_COVER output lines are recorded as functional coverage. Returns run_id.',
  input: z.object({
    files: z.array(z.string()).min(1).describe('HDL sources (design and testbench)'),
    top: z.string().describe('top module: the testbench, or the design for lint / a C++ testbench'),
    mode: z.enum(['lint', 'run']).default('run'),
    cpp: z.array(z.string()).optional().describe('C++ testbench files (with main); omit for an HDL testbench'),
    include_dirs: z.array(z.string()).optional(),
    defines: Defines.optional(),
    parameters: Params.optional().describe('top-level parameter overrides (-G)'),
    coverage: z.array(z.enum(['line', 'toggle', 'user'])).default(['line', 'toggle', 'user']).describe('[] for none'),
    coverage_exclude: z.string().default('(^|/)(tb_|test_)[^/]*$|_tb\\.s?v$').describe('regex of files left out of the coverage percentages ("" keeps all)'),
    lint_flags: z.array(z.string()).default(['-Wall']),
    build_flags: z.array(z.string()).default([]).describe('extra verilator flags for the build, e.g. ["--trace", "-O3"]'),
    plusargs: z.array(z.string()).default([]),
    pass: z.string().optional().describe('regex the output must match to pass'),
    fail: z.string().optional().describe('regex that marks failure'),
    warnings_fail: z.boolean().default(false).describe('lint warnings fail the run'),
    max_lines: z.number().int().min(0).max(5000).default(80),
    timeout_s: z.number().positive().max(6 * 3600).default(1800),
  }),
  run: async (a) => {
    const rec = new Recorder('verify.verilator', a.top, a)
    try {
      const r = await runVerilator({ ...a })
      for (const f of a.files) rec.artifact(`src/${basename(f)}`, readFileSync(resolve(f), 'utf8'))
      rec.artifact('lint.log', tail(r.lintLog, 2_000_000))
      rec.artifact('build.log', tail(r.buildLog, 1_000_000))
      rec.artifact('sim.log', tail(r.output, 4_000_000))
      if (r.coverageDat) rec.artifact('coverage.dat', r.coverageDat)
      if (r.coverageInfo) rec.artifact('coverage.info', r.coverageInfo)
      const cov = r.points.length ? coverageSummary(r.points, a.coverage_exclude) : null
      for (const k of cov?.by_kind ?? []) rec.measure(`coverage.${k.kind}`, k.percent, '%', { covered: k.covered, total: k.total })
      rec.measure('lint.warnings', r.lint.filter((m) => m.severity === 'warning').length)
      rec.measure('lint.errors', r.lint.filter((m) => m.severity === 'error').length)
      recordHits(rec.id, 'functional', r.functional)
      const result = {
        run_id: rec.id, passed: r.passed, reason: r.reason, mode: a.mode, stages: r.stage,
        lint: { errors: r.lint.filter((m) => m.severity === 'error').length, warnings: r.lint.filter((m) => m.severity === 'warning').length, messages: r.lint.slice(0, 40) },
        ...(r.build_errors.length ? { build_errors: r.build_errors.slice(0, 20) } : {}),
        ...(a.mode === 'run' ? { output: lines(r.output, a.max_lines) } : {}),
        coverage: cov ? { by_kind: cov.by_kind, by_file: cov.by_file, uncovered: cov.uncovered.slice(0, 40), uncovered_total: cov.uncovered.length } : null,
        functional: [...r.functional].map(([name, h]) => ({ name, hits: h.hits, location: h.location })).slice(0, 100),
        where: r.where, seconds: Math.round(r.seconds * 10) / 10,
      }
      rec.finish(r.passed ? 'pass' : 'fail', `${a.top}: ${r.reason}`, { passed: r.passed, reason: r.reason, coverage: (cov?.by_kind ?? []) as unknown as Json })
      return result
    } catch (e) {
      throw rec.fail(e)
    }
  },
})

// ------------------------------------------------------------------ verify.cocotb

export const cocotbTool = defineTool({
  name: 'verify.cocotb',
  description: 'cocotb: build an HDL design and run Python test modules against it on Icarus Verilog or Verilator (cocotb\'s own runner, cocotb 1.8+ or 2.x); per-test pass/fail/skip with failure messages and simulated time from results.xml. TRACE_COVER lines are recorded as functional coverage; the waveform is kept when waves is set. Returns run_id.',
  input: z.object({
    files: z.array(z.string()).min(1).describe('HDL sources'),
    top: z.string().describe('the HDL top level the tests drive'),
    modules: z.array(z.string()).min(1).describe('Python test files (test_*.py)'),
    simulator: z.enum(['icarus', 'verilator']).default('icarus'),
    testcase: z.array(z.string()).optional().describe('only these test functions'),
    include_dirs: z.array(z.string()).optional(),
    defines: Defines.optional(),
    parameters: Params.optional(),
    plusargs: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}).describe('extra environment for the tests'),
    build_args: z.array(z.string()).default([]),
    timescale: z.tuple([z.string(), z.string()]).optional().describe('e.g. ["1ns", "1ps"]'),
    seed: z.number().int().optional().describe('COCOTB_RANDOM_SEED, for a repeatable run'),
    waves: z.boolean().default(false),
    max_lines: z.number().int().min(0).max(5000).default(60),
    timeout_s: z.number().positive().max(6 * 3600).default(1800),
  }),
  run: async (a) => {
    const rec = new Recorder('verify.cocotb', a.top, a)
    try {
      const r = await runCocotb({ ...a })
      rec.artifact('cocotb.log', tail(r.output, 4_000_000))
      if (r.resultsXml) rec.artifact('results.xml', r.resultsXml, 'application/xml')
      if (r.waves) rec.artifact(r.wavesName ?? 'waves.fst', r.waves, 'application/octet-stream')
      rec.measure('tests', r.cases.length)
      rec.measure('tests.failed', r.cases.filter((c) => c.status === 'fail' || c.status === 'error').length)
      recordHits(rec.id, 'functional', r.functional)
      rec.finish(r.passed ? 'pass' : 'fail', `${a.top}: ${r.reason}`, { passed: r.passed, reason: r.reason })
      return {
        run_id: rec.id, passed: r.passed, reason: r.reason, cocotb: r.cocotbVersion, simulator: a.simulator, tests: r.cases,
        functional: [...r.functional].map(([name, h]) => ({ name, hits: h.hits })),
        ...(r.waves ? { waves: { artifact: r.wavesName ?? 'waves.fst', bytes: r.waves.length } } : {}),
        output: lines(r.output.split('\n').filter((l) => !/^\s+-\.--ns INFO\s+gpi/.test(l)).join('\n'), a.max_lines),
        where: r.where, seconds: Math.round(r.seconds * 10) / 10,
      }
    } catch (e) {
      throw rec.fail(e)
    }
  },
})

// ------------------------------------------------------------------ verify.formal

export const formalTool = defineTool({
  name: 'verify.formal',
  description: 'Formal check of SystemVerilog assert/assume/cover: a SymbiYosys .sby file (its [files] are staged; optional task), or files + top with mode bmc (no failure within depth), prove (bmc base case + k-induction: PASS, FAIL, or UNKNOWN when only induction fails) or cover (every cover reached). Uses sby when installed, else yosys + yosys-smtbmc directly (sby\'s smtbmc engine steps). Returns the verdict, failed assertions, cover statements with steps, and counterexample/cover traces as VCD artifacts. Returns run_id.',
  input: z.object({
    sby: z.string().optional().describe('a .sby file'),
    task: z.string().optional().describe('with sby: the task to run'),
    files: z.array(z.string()).optional().describe('or the sources (design and properties)'),
    top: z.string().optional(),
    mode: z.enum(['bmc', 'prove', 'cover']).default('bmc'),
    depth: z.number().int().min(1).max(10_000).default(20),
    engine: z.enum(['auto', 'sby', 'smtbmc']).default('auto'),
    solver: z.string().optional().describe('yices, z3, bitwuzla, boolector… (default: TRACE_SMT_SOLVER, else the first installed)'),
    include_dirs: z.array(z.string()).optional(),
    defines: Defines.optional().describe('FORMAL is defined by yosys read -formal already'),
    timeout_s: z.number().positive().max(24 * 3600).default(1800),
  }),
  run: async (a) => {
    const rec = new Recorder('verify.formal', a.top ?? a.sby ?? 'formal', a)
    try {
      const r = await runFormal({ ...a })
      for (const [n, t] of Object.entries(r.logs)) if (t) rec.artifact(n, tail(t, 4_000_000))
      for (const t of r.traces) rec.artifact(t.name, t.bytes, 'text/x-vcd')
      const hits = new Map<string, { hits: number; location: string | null }>()
      for (const f of r.log.findings) {
        if (f.kind !== 'cover_reached' && f.kind !== 'cover_unreached') continue
        const name = f.name ?? f.location ?? '?'
        hits.set(name, { hits: (hits.get(name)?.hits ?? 0) + (f.kind === 'cover_reached' ? 1 : 0), location: f.location })
      }
      recordHits(rec.id, 'cover', hits)
      if (r.log.steps !== null) rec.measure('steps', r.log.steps)
      rec.finish(r.passed ? 'pass' : r.status === 'ERROR' || r.status === 'TIMEOUT' ? 'error' : 'fail', `${a.top ?? a.sby}: ${r.status}: ${r.reason}`, { status: r.status, reason: r.reason })
      return {
        run_id: rec.id, passed: r.passed, status: r.status, reason: r.reason, engine: r.engine, solver: r.solver, mode: a.sby ? undefined : a.mode, depth: a.sby ? undefined : a.depth,
        findings: r.log.findings.slice(0, 100), traces: r.traces.map((t) => ({ artifact: t.name, from: t.from, bytes: t.bytes.length })),
        steps: r.log.steps, where: r.where, seconds: Math.round(r.seconds * 10) / 10,
      }
    } catch (e) {
      throw rec.fail(e)
    }
  },
})

export const tools: AnyTool[] = [
  requirementsTool, planTool, runTool, coverageTool, reportTool, verilatorTool, cocotbTool, formalTool,
] as unknown as AnyTool[]
