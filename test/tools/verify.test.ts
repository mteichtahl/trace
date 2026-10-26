/**
 * The verify area: requirement extraction, the parsers (on captured output), the verification record and its merge,
 * and — where the programs are installed — Verilator, cocotb and formal on the sensor-node's moving_average, and the
 * whole loop: requirements → plan → run → coverage → report.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { merge } from '../../src/core/dbmerge.js'
import { VerifyDb } from '../../src/tools/verify/db.js'
import { classify, extractCandidates, limitsOf, tableRow } from '../../src/tools/verify/extract.js'
import { coverLines, sq, stage } from '../../src/tools/verify/job.js'
import { backendFor } from '../../src/gpu/jobs.js'
import { generatedSby, rewriteSbyFiles, sbyFiles } from '../../src/tools/verify/formal.js'
import { mergeCoverage, parseCocotbResults, parseCoverageDat, parseSby, parseSmtbmc, summarizeCoverage, verilatorMessages } from '../../src/tools/verify/parse.js'
import { runIds } from '../../src/tools/verify/run.js'
import { allTools } from '../../src/tools/index.js'

const LOGIC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'sensor-node', 'logic')
const f = (n: string): string => join(LOGIC, n)
const has = (cmd: string, args: string[] = ['--version']): boolean => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 30_000 })
    return true
  } catch {
    return false
  }
}
const hasVerilator = has('verilator')
const hasCocotb = has('cocotb-config') && has('iverilog', ['-V'])
const hasSmtbmc = has('yosys', ['-V']) && has('yosys-smtbmc', ['-h']) && (has('z3') || has('yices-smt2', ['--version']))

type Dict = Record<string, unknown>
const reg = allTools()
const call = async (name: string, args: Dict): Promise<Dict> => (await reg.call(name, args, { hardware: false, via: 'test' })) as Dict

// ------------------------------------------------------------------ extraction

describe('requirement extraction', () => {
  it('finds limits in statements', () => {
    expect(limitsOf('The supply current shall not exceed 5 mA.')).toEqual([expect.objectContaining({ op: '<=', value: 5, unit: 'mA' })])
    expect(limitsOf('VDD from 2.7 V to 3.6 V')).toEqual([expect.objectContaining({ op: 'range', low: 2.7, high: 3.6, unit: 'V' })])
    expect(limitsOf('accuracy ±2 % over temperature')).toEqual([expect.objectContaining({ op: 'tol', value: 2, unit: '%' })])
    expect(limitsOf('at least 10 MHz')).toEqual([expect.objectContaining({ op: '>=', value: 10, unit: 'MHz' })])
  })

  it('reads min/typ/max rows', () => {
    expect(tableRow('Supply voltage   VDD   2.7   3.3   3.6   V')).toEqual({ name: 'Supply voltage', min: 2.7, typ: 3.3, max: 3.6, unit: 'V' })
    expect(tableRow('Quiescent current   IQ   –   45   60   µA')).toEqual({ name: 'Quiescent current', typ: 45, max: 60, unit: 'µA' })
    expect(tableRow('This is just a sentence about things.')).toBeNull()
  })

  it('classifies by keyword and unit', () => {
    expect(classify('The unit shall pass IEC 61000-4-2 contact discharge at 4 kV')).toBe('emc')
    expect(classify('The output shall settle within 2 ms')).toBe('timing')
    expect(classify('Input impedance shall be at least 1 MΩ')).toBe('electrical')
    expect(classify('The device shall report its firmware version')).toBe('functional')
  })

  it('extracts candidates with pages, scores and acceptance', () => {
    const pages = [
      'Overview\nThe sensor node measures a 0-12 V input. It shall report a reading every 100 ms.\nThe board should be blue.',
      'Electrical characteristics\nSupply voltage   VDD   3.0   3.3   3.6   V\nThe input shall withstand ESD of 8 kV (IEC 61000-4-2 air discharge).\nThe input shall withstand ESD of 8 kV (IEC 61000-4-2 air discharge).',
    ]
    const c = extractCandidates(pages)
    const report = c.find((x) => /every 100 ms/.test(x.text))
    expect(report).toMatchObject({ kind: 'timing', page: 1 })
    expect(report?.score).toBeGreaterThanOrEqual(0.6)
    const vdd = c.find((x) => /Supply voltage/.test(x.text))
    expect(vdd).toMatchObject({ kind: 'electrical', page: 2, acceptance: 'measured value within 3 to 3.6 V' })
    expect(c.filter((x) => /ESD/.test(x.text))).toHaveLength(1) // repeated once
    expect(c.find((x) => /ESD/.test(x.text))?.kind).toBe('emc')
    const blue = c.find((x) => /blue/.test(x.text))
    expect(blue?.score).toBeLessThan(0.6) // "should": weak
    expect(extractCandidates(pages, { minScore: 0.5 }).some((x) => /blue/.test(x.text))).toBe(false)
  })

  it('extract through the tool never writes', async () => {
    const r = await call('verify.requirements', { action: 'extract', text: 'The ADC shall sample at 1 kHz. Power must stay below 50 mW.' })
    expect(r.total).toBe(2)
    expect((await call('verify.requirements', { action: 'list' })).total).toBe(0)
  })
})

// ------------------------------------------------------------------ parsers

const COVDAT = [
  '# SystemC::Coverage-3',
  "C '\x01f\x02/x/ma.v\x01l\x0212\x01n\x0229\x01page\x02v_toggle/ma\x01o\x02clk\x01h\x02TOP.tb.dut' 3046",
  "C '\x01f\x02/x/ma.v\x01l\x0213\x01n\x0229\x01page\x02v_toggle/ma\x01o\x02rst\x01h\x02TOP.tb.dut' 0",
  "C '\x01f\x02/x/ma.v\x01l\x0230\x01n\x025\x01page\x02v_line/ma\x01o\x02block\x01h\x02TOP.tb.dut' 7",
  "C '\x01f\x02/x/ma.v\x01l\x0231\x01n\x025\x01page\x02v_branch/ma\x01o\x02if\x01h\x02TOP.tb.dut' 0",
  "C '\x01f\x02/x/ma.v\x01l\x0240\x01n\x023\x01page\x02v_user/ma\x01o\x02c_full\x01h\x02TOP.tb.dut' 2",
  "C '\x01f\x02/x/ma_tb.v\x01l\x025\x01n\x021\x01page\x02v_line/tb\x01o\x02block\x01h\x02TOP.tb' 1",
].join('\n')

describe('parsers', () => {
  it('reads verilator messages', () => {
    const m = verilatorMessages([
      '%Warning-WIDTHEXPAND: /x/ma.v:32:28: Operator ADD expects 14 bits on the RHS',
      '                     : ... note: In instance moving_average',
      '%Error: /x/ma.v:3:1: syntax error, unexpected endmodule',
      '%Error: Exiting due to 1 error(s)',
    ].join('\n'))
    expect(m).toEqual([
      { severity: 'warning', code: 'WIDTHEXPAND', file: '/x/ma.v', line: 32, col: 28, text: 'Operator ADD expects 14 bits on the RHS' },
      { severity: 'error', code: null, file: '/x/ma.v', line: 3, col: 1, text: 'syntax error, unexpected endmodule' },
    ])
  })

  it('reads, merges and summarises coverage.dat', () => {
    const p = parseCoverageDat(COVDAT)
    expect(p).toHaveLength(6)
    expect(p[0]).toMatchObject({ kind: 'toggle', file: '/x/ma.v', line: 12, comment: 'clk', hier: 'TOP.tb.dut', count: 3046 })
    expect(p.map((x) => x.kind)).toEqual(['toggle', 'toggle', 'line', 'branch', 'user', 'line'])
    const merged = mergeCoverage([p, p.map((x) => (x.comment === 'rst' ? { ...x, count: 1 } : { ...x, count: 0 }))])
    expect(merged.find((x) => x.comment === 'rst')?.count).toBe(1)
    const s = summarizeCoverage(merged.filter((x) => x.kind !== 'user'), { exclude: /_tb\.v$/ })
    expect(s.by_kind).toEqual([
      { kind: 'branch', covered: 0, total: 1, percent: 0 },
      { kind: 'line', covered: 1, total: 1, percent: 100 },
      { kind: 'toggle', covered: 2, total: 2, percent: 100 },
    ])
    expect(s.uncovered).toEqual([{ kind: 'branch', file: '/x/ma.v', line: 31, comment: 'if', hier: 'TOP.tb.dut' }])
  })

  it('reads cocotb results.xml', () => {
    const xml = `<?xml version='1.0' encoding='utf-8'?><testsuites name="cocotb tests"><testsuite name="t" tests="3">
<testcase classname="t" name="ok" time="0.001"><properties><property name="sim_time_unit" value="ns" /><property name="sim_time_duration" value="75.0" /></properties></testcase>
<testcase classname="t" name="bad" time="0.000"><failure message="deliberate&#10;assert False" type="AssertionError">trace</failure></testcase>
<testcase classname="t" name="later" time="0"><skipped /></testcase></testsuite></testsuites>`
    expect(parseCocotbResults(xml)).toEqual([
      { name: 'ok', classname: 't', status: 'pass', message: null, sim_time_ns: 75, seconds: 0.001 },
      { name: 'bad', classname: 't', status: 'fail', message: 'deliberate\nassert False', sim_time_ns: null, seconds: 0 },
      { name: 'later', classname: 't', status: 'skip', message: null, sim_time_ns: null, seconds: 0 },
    ])
  })

  it('reads yosys-smtbmc output (captured from yosys 0.33)', () => {
    const bmcFail = [
      '##   0:00:00  Solver: z3', '##   0:00:00  Checking assumptions in step 0..', '##   0:00:00  Checking assertions in step 4..',
      '##   0:00:00  BMC failed!', '##   0:00:00  Assert failed in moving_average_props: ma_props.sv:25.23-25.50 ($assert$ma_props.sv:25$34)',
      '##   0:00:00  Writing trace to VCD file: trace.vcd', '##   0:00:00  Status: FAILED',
    ].join('\n')
    expect(parseSmtbmc(bmcFail)).toEqual({
      status: 'FAIL', steps: 4, traces: ['trace.vcd'],
      findings: [{ kind: 'assert_failed', name: '$assert$ma_props.sv:25$34', location: 'ma_props.sv:25.23-25.50', step: null }],
    })
    const cover = [
      '##   0:00:00  Checking cover reachability in step 6..',
      '##   0:00:00  Reached cover statement at ma_props.sv:25.51-26.45 ($cover$ma_props.sv:25$35) in step 6.',
      '##   0:00:00  Writing trace to VCD file: cover_0.vcd', '##   0:00:00  Status: PASSED',
    ].join('\n')
    expect(parseSmtbmc(cover).findings).toEqual([{ kind: 'cover_reached', name: '$cover$ma_props.sv:25$35', location: 'ma_props.sv:25.51-26.45', step: 6 }])
    const induct = ['##   0:00:00  Trying induction in step 1..', '##   0:00:00  Temporal induction failed!',
      '##   0:00:00  Assert failed in m: a.sv:3.1-3.9 ($assert$a.sv:3$1)', '##   0:00:00  Status: FAILED'].join('\n')
    expect(parseSmtbmc(induct).findings[0]?.kind).toBe('induction_failed')
  })

  it('reads a SymbiYosys log (format as sby prints it; sby is not installed in CI)', () => {
    const log = [
      'SBY 15:02:12 [job] engine_0: smtbmc z3',
      'SBY 15:02:12 [job] engine_0: ##   0:00:00  Assert failed in top: top.sv:18.13-18.31 ($assert$top.sv:18$12)',
      'SBY 15:02:12 [job] engine_0: ##   0:00:00  Writing trace to VCD file: engine_0/trace.vcd',
      'SBY 15:02:12 [job] engine_0: ##   0:00:00  Status: failed',
      'SBY 15:02:12 [job] summary: engine_0 (smtbmc z3) returned FAIL',
      'SBY 15:02:12 [job] summary: counterexample trace: job/engine_0/trace.vcd',
      'SBY 15:02:12 [job] summary:   failed assertion top.$assert$top.sv:18$12 at top.sv:18.13-18.31 in step 5',
      'SBY 15:02:12 [job] DONE (FAIL, rc=2)',
    ].join('\n')
    expect(parseSby(log)).toEqual({
      status: 'FAIL', steps: null, traces: ['job/engine_0/trace.vcd', 'engine_0/trace.vcd'],
      findings: [{ kind: 'assert_failed', name: 'top.$assert$top.sv:18$12', location: 'top.sv:18.13-18.31', step: 5 }],
    })
  })

  it('rewrites and writes .sby files', () => {
    const text = '[options]\nmode bmc\n\n[files]\n../rtl/a.v\nprops.sv ../formal/p.sv\n'
    expect(sbyFiles(text)).toEqual([{ dest: 'a.v', src: '../rtl/a.v' }, { dest: 'props.sv', src: '../formal/p.sv' }])
    expect(rewriteSbyFiles(text, [{ dest: 'a.v', name: 'a.v' }, { dest: 'props.sv', name: 'p.sv' }])).toBe('[options]\nmode bmc\n\n[files]\na.v\nprops.sv p.sv')
    expect(generatedSby({ files: ['a.v'], top: 'a', mode: 'cover', depth: 9, solver: 'z3' })).toContain('[engines]\nsmtbmc z3\n')
  })

  it('keeps CPU jobs local unless TRACE_GPU_REMOTE=always, and stages inputs by unique file name', () => {
    const saved = { q: process.env.TRACE_GPU_QUEUE, m: process.env.TRACE_GPU_REMOTE }
    try {
      process.env.TRACE_GPU_QUEUE = 'trace-gpu'
      delete process.env.TRACE_GPU_REMOTE
      expect(backendFor({ gpu: false })).toBe('local')
      process.env.TRACE_GPU_REMOTE = 'always'
      expect(backendFor({ gpu: false })).toBe('batch')
      process.env.TRACE_GPU_REMOTE = 'never'
      expect(backendFor({ gpu: false })).toBe('local')
    } finally {
      if (saved.q === undefined) delete process.env.TRACE_GPU_QUEUE
      else process.env.TRACE_GPU_QUEUE = saved.q
      if (saved.m === undefined) delete process.env.TRACE_GPU_REMOTE
      else process.env.TRACE_GPU_REMOTE = saved.m
    }
    const d = mkdtempSync(join(tmpdir(), 'stage-'))
    try {
      mkdirSync(join(d, 'a'))
      mkdirSync(join(d, 'b'))
      writeFileSync(join(d, 'a', 'x.v'), '')
      writeFileSync(join(d, 'b', 'x.v'), '')
      expect(stage([join(d, 'a', 'x.v'), join(d, 'a', 'x.v')]).names).toEqual(['x.v'])
      expect(() => stage([join(d, 'a', 'x.v'), join(d, 'b', 'x.v')])).toThrow(/both called x.v/)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('finds TRACE_COVER lines, run ids, and quotes for sh', () => {
    expect([...coverLines('x\nTRACE_COVER full\nTRACE_COVER full 3\n  [12] TRACE_COVER tb.reset_seen\n')]).toEqual([['full', 4], ['tb.reset_seen', 1]])
    expect(runIds({ run_id: 'abcdef0123456789', results: [{ run_id: '0123456789abcdef' }], x: 'notarun' })).toEqual(['abcdef0123456789', '0123456789abcdef'])
    expect(sq("it's")).toBe(`'it'\\''s'`)
  })
})

// ------------------------------------------------------------------ the record and its merge

describe('verification record', () => {
  it('keeps requirements, tests, results and coverage, and refuses dangling links', async () => {
    const add = await call('verify.requirements', { action: 'add', requirements: [{ text: 'avg is the mean of the last four samples', kind: 'functional' }, { id: 'REQ-T1', text: 'avg_valid one clock after valid', kind: 'timing', acceptance: 'formal bmc to depth 10' }] })
    expect(add.added).toEqual(['REQ-001', 'REQ-T1'])
    await expect(call('verify.plan', { action: 'add', tests: [{ title: 'dangling', requirements: ['REQ-999'], method: 'inspection' }] })).rejects.toThrow(/no such requirement: REQ-999/)
    await expect(call('verify.plan', { action: 'add', tests: [{ title: 'bad args', requirements: ['REQ-001'], method: 'sim', tool: 'sim.logic', args: { nonsense: 1 } }] })).rejects.toThrow(/args for sim.logic/)
    await expect(call('verify.plan', { action: 'add', tests: [{ title: 'how?', requirements: ['REQ-001'], method: 'sim' }] })).rejects.toThrow(/needs a tool or a command/)
    const plan = await call('verify.plan', { action: 'add', tests: [
      { title: 'visual check', requirements: ['REQ-001'], method: 'inspection' },
      { title: 'node runs', requirements: ['REQ-T1'], method: 'sim', command: [process.execPath, '-e', 'process.exit(0)'] },
    ] })
    expect(plan.added).toEqual(['TST-001', 'TST-002'])
    const run = await call('verify.run', { all: true, verdicts: { 'TST-001': { status: 'pass', note: 'read the RTL' } } })
    expect(run).toMatchObject({ ran: 2, pass: 2 })
    const cov = await call('verify.coverage', { define: [{ requirements: ['REQ-001'], kind: 'functional', match: 'full_scale' }] })
    const reqs = cov.requirements as { id: string; verdict: string }[]
    expect(reqs.find((r) => r.id === 'REQ-T1')?.verdict).toBe('verified')
    expect(reqs.find((r) => r.id === 'REQ-001')?.verdict).toBe('coverage_gap') // the point has no hits
    const rep = await call('verify.report', { title: 'Test report' })
    expect(String(rep.markdown)).toMatch(/\| REQ-T1 \| timing \| verified \|/)
    // clean up for the tests below
    const v = new VerifyDb()
    v.db.exec('DELETE FROM test_items; DELETE FROM requirements; DELETE FROM coverage_points; DELETE FROM test_results; DELETE FROM coverage_hits')
    v.close()
  })

  it('merges by newest row, and unions results', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-merge-'))
    try {
      const seed = (p: string, text: string, updated: number): void => {
        const env = process.env.TRACE_PROJECT_DB
        process.env.TRACE_PROJECT_DB = p
        try {
          const v = new VerifyDb()
          v.addRequirement({ id: 'REQ-001', text, kind: 'functional' })
          v.db.prepare('UPDATE requirements SET updated=? WHERE id=?').run(updated, 'REQ-001')
          v.close()
        } finally {
          process.env.TRACE_PROJECT_DB = env
        }
      }
      const base = join(dir, 'base.db')
      const ours = join(dir, 'ours.db')
      const theirs = join(dir, 'theirs.db')
      seed(base, 'original', 1)
      copyFileSync(base, ours)
      copyFileSync(base, theirs)
      const set = (p: string, text: string, t: number): void => {
        const db = new DatabaseSync(p)
        db.prepare('UPDATE requirements SET text=?, updated=? WHERE id=?').run(text, t, 'REQ-001')
        db.prepare("INSERT INTO requirements (id, text, kind, status, created, updated) VALUES (?, ?, 'timing', 'proposed', ?, ?)").run(`REQ-${p.includes('ours') ? 'O' : 'T'}`, 'side', t, t)
        db.close()
      }
      set(ours, 'ours, older', 10)
      set(theirs, 'theirs, newer', 20)
      expect(merge(base, ours, theirs)).toEqual([])
      const db = new DatabaseSync(ours)
      const rows = db.prepare('SELECT id, text FROM requirements ORDER BY id').all()
      db.close()
      expect(rows).toEqual([{ id: 'REQ-001', text: 'theirs, newer' }, { id: 'REQ-O', text: 'side' }, { id: 'REQ-T', text: 'side' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ------------------------------------------------------------------ the programs, for real

describe.skipIf(!hasVerilator)('verify.verilator (Verilator installed)', () => {
  it('lints the filter and reports width warnings without failing', async () => {
    const r = await call('verify.verilator', { files: [f('moving_average.v')], top: 'moving_average', mode: 'lint' })
    expect(r.passed).toBe(true)
    expect((r.lint as { warnings: number }).warnings).toBeGreaterThan(0)
    const strict = await call('verify.verilator', { files: [f('moving_average.v')], top: 'moving_average', mode: 'lint', warnings_fail: true })
    expect(strict.passed).toBe(false)
  })

  it('builds and runs the SV testbench with coverage', async () => {
    const r = await call('verify.verilator', { files: [f('moving_average.v'), f('moving_average_tb.v')], top: 'moving_average_tb', pass: 'ALL TESTS PASSED' })
    expect(r.reason).toMatch(/pass pattern/)
    expect(r.passed).toBe(true)
    const cov = r.coverage as { by_kind: { kind: string; covered: number; total: number }[]; by_file: { file: string }[] }
    expect(cov.by_kind.map((k) => k.kind)).toEqual(['branch', 'line', 'toggle'])
    expect(cov.by_file.every((x) => x.file.endsWith('moving_average.v'))).toBe(true) // the testbench is excluded
    const line = cov.by_kind.find((k) => k.kind === 'line')
    expect(line?.covered).toBeGreaterThan(0)
    const rec = await call('trace.run', { id: r.run_id })
    expect((rec.artifacts as { name: string }[]).map((a) => a.name)).toEqual(expect.arrayContaining(['coverage.dat', 'coverage.info', 'sim.log', 'lint.log']))
  }, 300_000)

  it('fails on a $fatal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vfatal-'))
    try {
      writeFileSync(join(dir, 'bad_tb.v'), 'module bad_tb; initial begin #5; $fatal(1, "deliberate"); end endmodule\n')
      const r = await call('verify.verilator', { files: [join(dir, 'bad_tb.v')], top: 'bad_tb', coverage: [] })
      expect(r.passed).toBe(false)
      expect(String(r.reason)).toMatch(/deliberate|exited/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)
})

describe.skipIf(!hasCocotb)('verify.cocotb (cocotb + Icarus installed)', () => {
  it('runs the Python tests against moving_average and records TRACE_COVER hits', async () => {
    const r = await call('verify.cocotb', { files: [f('moving_average.v')], top: 'moving_average', modules: [f('test_moving_average.py')] })
    expect(r.reason).toMatch(/3 passed/)
    expect(r.passed).toBe(true)
    expect((r.tests as { name: string; status: string }[]).map((t) => [t.name, t.status])).toEqual([
      ['step_and_full_scale', 'pass'], ['random_with_gaps', 'pass'], ['reset_clears_history', 'pass']])
    expect((r.functional as { name: string }[]).map((h) => h.name).sort()).toEqual(['back_to_zero', 'full_scale', 'random_200', 'reset_mid_stream'])
  }, 300_000)

  it('runs one test case only', async () => {
    const r = await call('verify.cocotb', { files: [f('moving_average.v')], top: 'moving_average', modules: [f('test_moving_average.py')], testcase: ['reset_clears_history'] })
    expect((r.tests as unknown[]).length).toBe(1)
  }, 300_000)
})

describe.skipIf(!hasSmtbmc)('verify.formal with yosys-smtbmc (yosys + an SMT solver installed)', () => {
  const files = [f('moving_average.v'), f('moving_average_props.sv')]
  it('bmc: no assertion fails within depth 8', async () => {
    const r = await call('verify.formal', { files, top: 'moving_average_props', mode: 'bmc', depth: 8, engine: 'smtbmc' })
    expect(r).toMatchObject({ passed: true, status: 'PASS', engine: 'smtbmc' })
  }, 300_000)

  it('cover: reaches full scale and returns the trace', async () => {
    const r = await call('verify.formal', { files, top: 'moving_average_props', mode: 'cover', depth: 10, engine: 'smtbmc' })
    expect(r.status).toBe('PASS')
    expect((r.findings as { kind: string; name: string }[])[0]).toMatchObject({ kind: 'cover_reached', name: 'reaches_full_scale' })
    expect((r.traces as unknown[]).length).toBe(1)
  }, 300_000)

  it('prove: induction does not close without strengthening (UNKNOWN)', async () => {
    const r = await call('verify.formal', { files, top: 'moving_average_props', mode: 'prove', depth: 4, engine: 'smtbmc' })
    expect(r.status).toBe('UNKNOWN')
  }, 300_000)

  it('a wrong property fails with a counterexample', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vformal-'))
    try {
      // claims the average never exceeds half scale: false once two full-scale samples arrive
      writeFileSync(join(dir, 'wrong_props.sv'), [
        'module wrong_props (input wire clk, input wire rst, input wire valid, input wire [3:0] sample);',
        '  wire [3:0] avg; wire avg_valid; reg init = 1;',
        '  moving_average #(.WIDTH(4)) dut (.clk(clk), .rst(rst), .valid(valid), .sample(sample), .avg(avg), .avg_valid(avg_valid));',
        '  always @(posedge clk) init <= 0;',
        '  always @(*) if (init) assume(rst);',
        '  always @(posedge clk) if (!init) never_above_half: assert(avg <= 4\'d7);',
        'endmodule', ''].join('\n'))
      const r = await call('verify.formal', { files: [f('moving_average.v'), join(dir, 'wrong_props.sv')], top: 'wrong_props', mode: 'bmc', depth: 8, engine: 'smtbmc' })
      expect(r.status).toBe('FAIL')
      expect((r.findings as { kind: string; name: string }[])[0]).toMatchObject({ kind: 'assert_failed', name: 'never_above_half' })
      expect((r.traces as unknown[]).length).toBe(1)
      const w = await call('sim.wave_read', { run_id: r.run_id, artifact: 'trace0.vcd' })
      expect(JSON.stringify(w)).toMatch(/avg_valid/) // the counterexample is a readable VCD of the design's signals
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)
})

describe.skipIf(!hasCocotb || !hasSmtbmc)('the verification loop', () => {
  let ids: string[] = []
  beforeAll(async () => {
    const r = await call('verify.requirements', { action: 'add', requirements: [
      { id: 'MA-1', text: 'avg shall be the mean of the last four samples', kind: 'functional', acceptance: 'cocotb random test passes; formal bmc to depth 8' },
      { id: 'MA-2', text: 'avg_valid shall be high for one clock after each accepted sample', kind: 'timing', acceptance: 'formal bmc to depth 8' },
      { id: 'MA-3', text: 'The filter shall fit an iCE40 UP5K', kind: 'electrical' },
    ] })
    ids = r.added as string[]
    await call('verify.plan', { action: 'add', tests: [
      { id: 'MA-T1', title: 'cocotb tests', requirements: ['MA-1'], method: 'sim', tool: 'verify.cocotb', args: { files: [f('moving_average.v')], top: 'moving_average', modules: [f('test_moving_average.py')] } },
      { id: 'MA-T2', title: 'bmc', requirements: ['MA-1', 'MA-2'], method: 'formal', tool: 'verify.formal', args: { files: [f('moving_average.v'), f('moving_average_props.sv')], top: 'moving_average_props', mode: 'bmc', depth: 8, engine: 'smtbmc' } },
      { id: 'MA-T3', title: 'cover full scale', requirements: ['MA-1'], method: 'formal', tool: 'verify.formal', args: { files: [f('moving_average.v'), f('moving_average_props.sv')], top: 'moving_average_props', mode: 'cover', depth: 10, engine: 'smtbmc' } },
    ] })
    await call('verify.coverage', { define: [
      { id: 'MA-C1', requirements: ['MA-1'], kind: 'functional', match: 'random_200' },
      { id: 'MA-C2', requirements: ['MA-1'], kind: 'cover', match: 'reaches_full_scale' },
    ] })
  }, 60_000)

  afterAll(() => {
    const v = new VerifyDb()
    v.db.exec('DELETE FROM test_items; DELETE FROM requirements; DELETE FROM coverage_points')
    v.close()
  })

  it('runs the plan, and coverage and the report reflect it', async () => {
    expect(ids).toEqual(['MA-1', 'MA-2', 'MA-3'])
    const run = await call('verify.run', { all: true })
    expect(run).toMatchObject({ ran: 3, pass: 3 })
    const cov = await call('verify.coverage', {})
    const verdict = Object.fromEntries((cov.requirements as { id: string; verdict: string }[]).map((r) => [r.id, r.verdict]))
    expect(verdict).toEqual({ 'MA-1': 'verified', 'MA-2': 'verified', 'MA-3': 'no_test' })
    expect((cov.coverage_points as { id: string; met: boolean }[]).map((p) => [p.id, p.met])).toEqual([['MA-C1', true], ['MA-C2', true]])
    const rep = await call('verify.report', {})
    expect(String(rep.markdown)).toMatch(/MA-3 \(no_test\)/)
    const plan = await call('verify.plan', { action: 'list', requirement: 'MA-1' })
    expect((plan.tests as { last_result: { evidence: string[] } }[])[0]?.last_result.evidence.length).toBe(1)
  }, 600_000)
})
