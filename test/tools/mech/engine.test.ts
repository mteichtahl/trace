/**
 * The enclosure engine as a job (src/tools/mech/engine.ts): its kind's dispatch, the job spec runJob gets (inputs,
 * outputs, argv), and, when build123d and tracebridge.mech import here, mech.init + mech.build end to end on the
 * sample board through the tool registry (plus mech.fit, mech.settings, mech.hand_in and mech.order).
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FUNCTION_KINDS, GpuJobSchema, backendFor } from '../../../src/gpu/jobs.js'
import { boardFacts } from '../../../src/tools/mech/board.js'
import { PY_DIR, caseJob, engineAvailable, engineOutputs } from '../../../src/tools/mech/engine.js'
import { CaseSettingsSchema, defaults } from '../../../src/tools/mech/settings.js'
import { allTools } from '../../../src/tools/index.js'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const SAMPLE = join(ROOT, 'templates', 'sample', 'hardware', 'trace-sample.kicad_pcb')
const dir = mkdtempSync(join(tmpdir(), 'mech-engine-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('the cad job kind', () => {
  it('runs on the tools function when the project has one, else here', () => {
    expect(FUNCTION_KINDS.has('cad')).toBe(true)
    expect(backendFor({ kind: 'cad' }, { TRACE_TOOLS_FUNCTION: 'trace-tools-x', TRACE_GPU: '0' })).toBe('function')
    expect(backendFor({ kind: 'cad' }, { TRACE_GPU: '0' })).toBe('local')
    expect(backendFor({ kind: 'cad' }, { TRACE_GPU_QUEUE: 'q', TRACE_TOOLS_ELSEWHERE: '1', TRACE_GPU: '0' })).toBe('batch')
  })
})

describe('the job spec', () => {
  const facts = boardFacts(SAMPLE, ROOT)

  it('stages facts, settings and capabilities, runs the module locally with TRACE_PYTHON and PYTHONPATH at python/', () => {
    const d = mkdtempSync(join(dir, 'a-'))
    const { job, where } = caseJob({ facts, settings: defaults(facts.board), script: '/repo/mechanical/case.py' }, d, { TRACE_PYTHON: '/venv/bin/python', TRACE_GPU: '0' })
    expect(where).toBe('local')
    expect(GpuJobSchema.parse(job)).toBeTruthy()
    expect(job.kind).toBe('cad')
    expect(job.argv).toEqual([
      '/venv/bin/python', '-m', 'tracebridge.mech', 'run', '--facts', '{in:facts.json}', '--settings', '{in:case.json}', '--capabilities', '{in:capabilities.json}',
      '--script', '{in:case.py}', '--out', '{dir}/out', '--formats', 'step,stl,3mf',
    ])
    expect(Object.keys(job.inputs ?? {}).sort()).toEqual(['capabilities.json', 'case.json', 'case.py', 'facts.json'])
    expect(job.inputs?.['case.py']).toBe('/repo/mechanical/case.py')
    expect(JSON.parse(readFileSync(job.inputs!['facts.json']!, 'utf8')).sha256).toBe(facts.sha256)
    expect(JSON.parse(readFileSync(job.inputs!['capabilities.json']!, 'utf8')).checked).toBe('2026-10-29')
    expect(job.outputs).toEqual(['case.step', 'case-base.step', 'case-base.stl', 'case-base.3mf', 'case-lid.step', 'case-lid.stl', 'case-lid.3mf', 'fit.json', 'case.jsonld', 'result.json'])
    expect(job.env?.PYTHONPATH?.split(':')[0]).toBe(PY_DIR)
    expect(existsSync(join(PY_DIR, 'tracebridge'))).toBe(true)
  })

  it('on the function: python3 from the image\'s venv, no PYTHONPATH; a handed-in STEP is its one part', () => {
    const d = mkdtempSync(join(dir, 'b-'))
    const settings = CaseSettingsSchema.parse({ board: facts.board, source: 'file', file: 'mechanical/mine.step' })
    const { job, where } = caseJob({ facts, settings, caseFile: '/repo/mechanical/mine.STP', formats: ['step', 'stl'] }, d, { TRACE_TOOLS_FUNCTION: 'fn', TRACE_PYTHON: '/ignored', TRACE_GPU: '0' })
    expect(where).toBe('function')
    expect(job.argv[0]).toBe('python3')
    expect(job.argv).toContain('--case-file')
    expect(job.argv[job.argv.indexOf('--case-file') + 1]).toBe('{in:handed-in.stp}')
    expect(job.argv).not.toContain('--script')
    expect(job.argv.at(-1)).toBe('step,stl')
    expect(job.inputs?.['handed-in.stp']).toBe('/repo/mechanical/mine.STP')
    expect(job.outputs).toEqual(['case.step', 'case-case.step', 'case-case.stl', 'fit.json', 'case.jsonld', 'result.json'])
    expect(job.env?.PYTHONPATH).toBeUndefined()
    expect(engineOutputs('file', ['stl'])).toEqual(['case-case.stl', 'fit.json', 'case.jsonld', 'result.json'])
  })

  it('without a script, the engine uses its packaged template', () => {
    const { job } = caseJob({ facts, settings: defaults(facts.board) }, mkdtempSync(join(dir, 'c-')), { TRACE_GPU: '0' })
    expect(job.argv).not.toContain('--script')
    expect(job.argv[0]).toBe('python3')
  })
})

// ------------------------------------------------------------------ end to end, where the engine runs

const engine = existsSync(join(PY_DIR, 'tracebridge', 'mech', '__main__.py')) || !!process.env.TRACE_MECH_PYTHONPATH ? engineAvailable() : { ok: false, why: 'python/tracebridge/mech is not in this checkout' }

describe.skipIf(!engine.ok)('mech.init and mech.build on the sample board', () => {
  type Dict = Record<string, any>
  const reg = allTools()
  const call = async (name: string, args: Dict): Promise<Dict> => (await reg.call(name, args, { hardware: false, via: 'test' })) as Dict
  const repo = join(dir, 'repo')
  const cwd = process.cwd()

  it('builds the case, writes mechanical/out and records the fit', async () => {
    mkdirSync(join(repo, 'hardware'), { recursive: true })
    for (const ext of ['kicad_pcb', 'kicad_pro', 'kicad_sch']) copyFileSync(SAMPLE.replace('kicad_pcb', ext), join(repo, 'hardware', `trace-sample.${ext}`))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    process.chdir(repo)
    try {
      const init = await call('mech.init', {})
      expect(init.written).toEqual(['mechanical/case.json', 'mechanical/case.py'])
      expect(init.settings.process).toEqual({ service: 'jlc3dp', process: 'MJF', material: 'PA12-HP' })
      await expect(call('mech.init', {})).rejects.toThrow(/already exist/)

      const b = await call('mech.build', {})
      expect(b.run_id).toMatch(/^[0-9a-f]{16}$/)
      // the sample board has no mounting holes and a tall header (J2) in a corner: the rests and posts move off it
      expect(b.fit_status, b.fit_summary).toBe('pass')
      expect(b.passed).toBe(true)
      expect(b.case.parts.map((p: Dict) => p.name).sort()).toEqual(['base', 'lid'])
      for (const f of ['case.step', 'case-base.step', 'case-lid.step', 'case-base.stl', 'case-lid.stl', 'fit.json', 'case.jsonld']) {
        expect(b.files, f).toContain(`mechanical/out/${f}`)
        expect(readFileSync(join(repo, 'mechanical', 'out', f)).length, f).toBeGreaterThan(0)
      }
      expect(b.next).toMatch(b.passed ? /journey\.check criterion "layout\.fit"/ : /clashes and gaps/)
      // each clash and failing gap is named by its part
      for (const p of b.problems as string[]) expect(p).toMatch(/^(J|U|R|C|D|board)\w*/)

      const fit = await call('mech.fit', {})
      expect(fit).toMatchObject({ build_run: b.run_id, stale: false })

      // a change away from the recommendation needs its reason; then the fit is stale until rebuilt
      await expect(call('mech.settings', { clearance: [{ ref: 'J1', mm: 2 }] })).rejects.toThrow(/needs its reason/)
      await call('mech.settings', { clearance: [{ ref: 'J1', mm: 2, reason: 'mating face of the plug' }] })
      expect((await call('mech.fit', {})).stale_reasons).toEqual(['mechanical/case.json changed since the build'])

      // the script handed in as it stands builds the same case
      const h = await call('mech.hand_in', { path: 'mechanical/case.py', formats: ['step'] })
      expect(h.handed_in).toEqual({ from: 'mechanical/case.py', kept: 'mechanical/case.py', source: 'script' })
      expect(h.case.parts.map((p: Dict) => p.name).sort()).toEqual(['base', 'lid'])
      expect((await call('mech.fit', {})).stale).toBe(false)

      // an order sheet from a passing build
      expect(h.passed).toBe(true)
      expect((await call('mech.order', {})).written).toEqual(['mechanical/out/order.json', 'mechanical/out/order.md'])
      expect(readFileSync(join(repo, 'mechanical', 'out', 'order.md'), 'utf8')).toMatch(/trace places no order/)

      // a failing build orders only with a waiver
      await call('mech.settings', { clearance: [{ ref: 'J2', mm: 40, reason: 'room for a ribbon cable bend' }] })
      const f = await call('mech.build', { formats: ['step'] })
      expect(f.passed).toBe(false)
      await expect(call('mech.order', {})).rejects.toThrow(/does not pass/)
      const o = await call('mech.order', { waiver: 'a first print to check the header heights', format: 'step' })
      expect(o.order).toMatchObject({ service: 'jlc3dp', process: 'MJF', material: 'PA12-HP', quantity: 5, files: ['mechanical/out/case-base.step', 'mechanical/out/case-lid.step'] })
    } finally {
      process.chdir(cwd)
    }
  }, 240_000)

  it('hands in a STEP as the case body', async () => {
    process.chdir(repo)
    try {
      writeFileSync(join(repo, 'mine.step'), readFileSync(join(repo, 'mechanical', 'out', 'case.step')))
      const h = await call('mech.hand_in', { path: 'mine.step', formats: ['step'] })
      expect(h.handed_in).toEqual({ from: 'mine.step', kept: 'mechanical/mine.step', source: 'file' })
      expect(h.source).toBe('file')
      expect(h.files).toContain('mechanical/out/case-case.step')
      expect(h.rules_not_checked.some((r: Dict) => r.rule === 'wall')).toBe(true)
      expect(JSON.parse(readFileSync(join(repo, 'mechanical', 'case.json'), 'utf8'))).toMatchObject({ source: 'file', file: 'mechanical/mine.step' })
    } finally {
      process.chdir(cwd)
    }
  }, 240_000)
})

if (!engine.ok) console.log(`mech end to end skipped: ${engine.why}`)
