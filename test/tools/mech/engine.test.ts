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
import { CAD_SCRIPT_OUTPUTS, FUNCTION_KINDS, GpuJobSchema, backendFor } from '../../../src/gpu/jobs.js'
import { boardFacts } from '../../../src/tools/mech/board.js'
import { PY_DIR, caseJob, engineAvailable, engineOutputs, mechSkipReason, pyDir, scriptIsTemplate, scriptJob, templatePath } from '../../../src/tools/mech/engine.js'
import { CASE_TEMPLATE } from '../../../src/tools/mech/tools.js'
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

  it('a custom script: a cad-script job (build-only, the raw settings and the capabilities in, parts and claims out), locally with TRACE_PYTHON and PYTHONPATH at python/', () => {
    const d = mkdtempSync(join(dir, 'a-'))
    const { job, where } = scriptJob({ facts, settings: defaults(facts.board), script: '/repo/mechanical/case.py' }, d, { TRACE_PYTHON: '/venv/bin/python', TRACE_GPU: '0' })
    expect(where).toBe('local')
    expect(GpuJobSchema.parse(job)).toBeTruthy()
    expect(job.kind).toBe('cad-script')
    expect(job.isolate).toBe(true)
    expect(job.argv).toEqual([
      '/venv/bin/python', '-m', 'tracebridge.mech', 'build-only', '--facts', '{in:facts.json}', '--settings', '{in:settings.json}', '--capabilities', '{in:capabilities.json}',
      '--script', '{in:case.py}', '--out', '{dir}/out',
    ])
    expect(Object.keys(job.inputs ?? {}).sort()).toEqual(['capabilities.json', 'case.py', 'facts.json', 'settings.json'])
    expect(job.inputs?.['case.py']).toBe('/repo/mechanical/case.py')
    expect(JSON.parse(readFileSync(job.inputs!['facts.json']!, 'utf8')).sha256).toBe(facts.sha256)
    expect(JSON.parse(readFileSync(job.inputs!['capabilities.json']!, 'utf8')).checked).toBe('2026-10-29')
    expect(job.outputs).toEqual([...CAD_SCRIPT_OUTPUTS])
    expect(job.env?.PYTHONPATH?.split(':')[0]).toBe(PY_DIR)
    expect(existsSync(join(PY_DIR, 'tracebridge'))).toBe(true)
    // on the cad function: the venv's python3, no PYTHONPATH
    const f = scriptJob({ facts, settings: defaults(facts.board), script: '/repo/mechanical/case.py' }, mkdtempSync(join(dir, 'a2-')), { TRACE_CAD_FUNCTION: 'fn', TRACE_PYTHON: '/ignored', TRACE_GPU: '0' })
    expect(f.where).toBe('function')
    expect(f.job.argv[0]).toBe('python3')
    expect(f.job.env?.PYTHONPATH).toBeUndefined()
  })

  it('then a cad job that checks what the script built (--built), never running the script itself', () => {
    const d = mkdtempSync(join(dir, 'a3-'))
    const built = { 'part-1.step': '/scratch/out/part-1.step', 'part-2.step': '/scratch/out/part-2.step', 'claims.json': '/scratch/out/claims.json' }
    const { job, where } = caseJob({ facts, settings: defaults(facts.board), script: '/repo/mechanical/case.py' }, d, { TRACE_PYTHON: '/venv/bin/python', TRACE_GPU: '0' }, built)
    expect(where).toBe('local')
    expect(job.kind).toBe('cad')
    expect(job.argv).toEqual([
      '/venv/bin/python', '-m', 'tracebridge.mech', 'run', '--facts', '{in:facts.json}', '--settings', '{in:case.json}', '--capabilities', '{in:capabilities.json}',
      '--built', '{dir}/in/built', '--out', '{dir}/out', '--formats', 'step,stl,3mf',
    ])
    expect(job.argv).not.toContain('--script')
    expect(Object.keys(job.inputs ?? {}).sort()).toEqual(['built/claims.json', 'built/part-1.step', 'built/part-2.step', 'capabilities.json', 'case.json', 'facts.json'])
    expect(job.inputs?.['built/part-1.step']).toBe('/scratch/out/part-1.step')
    expect(job.outputs).toEqual(['case.step', 'case-base.step', 'case-base.stl', 'case-base.3mf', 'case-lid.step', 'case-lid.stl', 'case-lid.3mf', 'fit.json', 'case.jsonld', 'result.json'])
    expect(GpuJobSchema.parse(job)).toBeTruthy()
  })

  it('knows the packaged template by its bytes: that script never runs anywhere', () => {
    expect(templatePath({})).toBe(join(PY_DIR, 'tracebridge', 'mech', 'templates', 'printed-shell.py'))
    expect(pyDir({ TRACE_MECH_PYTHONPATH: '/elsewhere/python' })).toBe('/elsewhere/python')
    expect(templatePath({ TRACE_MECH_PYTHONPATH: '/elsewhere/python' })).toBe('/elsewhere/python/tracebridge/mech/templates/printed-shell.py')
    const d = mkdtempSync(join(dir, 't-'))
    writeFileSync(join(d, 'same.py'), readFileSync(templatePath({})))
    writeFileSync(join(d, 'changed.py'), `${readFileSync(templatePath({}), 'utf8')}\n# a comment\n`)
    expect(scriptIsTemplate(join(d, 'same.py'), {})).toBe(true)
    expect(scriptIsTemplate(join(d, 'changed.py'), {})).toBe(false)
    expect(scriptIsTemplate(join(d, 'missing.py'), {})).toBe(false)
    // and without the template to compare with, a script is user code
    expect(scriptIsTemplate(join(d, 'same.py'), { TRACE_MECH_PYTHONPATH: d })).toBe(false)
    // what mech.init writes is the packaged template
    expect(CASE_TEMPLATE).toBe(readFileSync(templatePath({}), 'utf8'))
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

  it('without a script, or with one given but no built parts, the engine uses its packaged template', () => {
    const { job } = caseJob({ facts, settings: defaults(facts.board) }, mkdtempSync(join(dir, 'c-')), { TRACE_GPU: '0' })
    expect(job.argv).not.toContain('--script')
    expect(job.argv).not.toContain('--built')
    expect(job.argv[0]).toBe('python3')
    const t = caseJob({ facts, settings: defaults(facts.board), script: '/repo/mechanical/case.py' }, mkdtempSync(join(dir, 'c2-')), { TRACE_GPU: '0' })
    expect(t.job.argv).not.toContain('--script')
    expect(Object.keys(t.job.inputs ?? {})).not.toContain('case.py')
  })
})

describe('tracectl check and the case', () => {
  it('builds it on a laptop unless told not to, and in CI only when the workflow says TRACE_CHECK_MECH=1 (fail closed)', () => {
    expect(mechSkipReason({})).toBeNull()
    expect(mechSkipReason({ TRACE_CHECK_MECH: '1' })).toBeNull()
    expect(mechSkipReason({ TRACE_CHECK_MECH: '0' })).toBe('TRACE_CHECK_MECH=0, no case script is run')
    expect(mechSkipReason({ TRACE_CHECK_MECH: 'no', TRACE_CHECK_MECH_WHY: 'pull request from a fork runs no case script' })).toBe('pull request from a fork runs no case script')
    for (const ci of [{ GITHUB_ACTIONS: 'true' }, { CI: 'true' }, { CI: '1' }]) {
      expect(mechSkipReason(ci)).toBe('TRACE_CHECK_MECH is not set in CI')
      expect(mechSkipReason({ ...ci, TRACE_CHECK_MECH: '' })).toBe('TRACE_CHECK_MECH is not set in CI')
      expect(mechSkipReason({ ...ci, TRACE_CHECK_MECH: 'maybe' })).toBe('TRACE_CHECK_MECH is not set in CI')
      expect(mechSkipReason({ ...ci, TRACE_CHECK_MECH_WHY: 'the workflow chose not to' })).toBe('the workflow chose not to')
      for (const yes of ['1', 'true', 'yes', ' TRUE ']) expect(mechSkipReason({ ...ci, TRACE_CHECK_MECH: yes })).toBeNull()
      expect(mechSkipReason({ ...ci, TRACE_CHECK_MECH: '0', TRACE_CHECK_MECH_WHY: 'fork' })).toBe('fork')
    }
    // the workflow template sets 1 for pushes and the repository's own pull requests, 0 with the reason for a fork's
    const yml = readFileSync(join(ROOT, 'templates', 'build', 'kicad.yml'), 'utf8')
    expect(yml).toContain("TRACE_CHECK_MECH: ${{ github.event.pull_request.head.repo.fork && '0' || '1' }}")
    expect(yml).toMatch(/TRACE_CHECK_MECH_WHY: \$\{\{ github\.event\.pull_request\.head\.repo\.fork && 'pull request from a fork runs no case script' \|\| '' \}\}/)
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
      expect(b.next).toMatch(/journey\.check criterion "layout\.fit"/)
      expect(b.problems).toEqual([])
      // the template byte for byte: one cad job, no script run anywhere
      expect(b.stages).toHaveLength(1)
      expect(b.stages[0]).toMatchObject({ kind: 'cad', where: 'local' })
      // the build records what it was built from: files, facts, the capabilities' date and the engine
      expect(b.inputs).toMatchObject({ board: 'hardware/trace-sample.kicad_pcb', capabilities_checked: '2026-10-29', engine: { ts: '1' } })
      expect(b.inputs.facts_sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(b.inputs.engine.py_sha256).toMatch(/^[0-9a-f]{64}$/)

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
      expect(f.fit_status).toBe('fail')
      // the failure names the part: J2's 40 mm clearance is not met above it
      expect(f.problems.length).toBeGreaterThan(0)
      expect(f.problems.some((p: string) => /^J2 /.test(p)), f.problems.join('; ')).toBe(true)
      for (const p of f.problems as string[]) expect(p).toMatch(/^(J|U|R|C|D|board)\w* /)
      expect(f.next).toMatch(/clashes and gaps/)
      await expect(call('mech.order', {})).rejects.toThrow(/does not pass/)
      const o = await call('mech.order', { waiver: 'a first print to check the header heights', format: 'step' })
      expect(o.order).toMatchObject({ service: 'jlc3dp', process: 'MJF', material: 'PA12-HP', quantity: 5, files: ['mechanical/out/case-base.step', 'mechanical/out/case-lid.step'] })
    } finally {
      process.chdir(cwd)
    }
  }, 240_000)

  // the engine's `--built` (the cad job reading a cad-script job's parts) may not be in this checkout's python/ yet
  const builtSupported = /--built/.test(readFileSync(join(pyDir(), 'tracebridge', 'mech', '__init__.py'), 'utf8'))
  if (!builtSupported) console.log(`mech custom-script end to end skipped: ${pyDir()}/tracebridge/mech has no --built yet`)

  it.skipIf(!builtSupported)('a changed case.py runs as its own cad-script job, then the cad job checks its parts', async () => {
    process.chdir(repo)
    try {
      // the 40 mm clearance the first test left on J2 is taken off again
      await call('mech.settings', { clearance: [{ ref: 'J2', mm: null }] })
      // back to the script, changed: a note from the script, so the parts are seen to come from it
      const script = `${readFileSync(templatePath(), 'utf8')}\n\ndef build(board, settings):  # noqa: F811\n    case = shell.two_part(board, settings)\n    case.notes.append("custom script ran")\n    return case\n`
      writeFileSync(join(repo, 'custom.py'), script)
      const h = await call('mech.hand_in', { path: 'custom.py', formats: ['step'] })
      expect(h.handed_in).toEqual({ from: 'custom.py', kept: 'mechanical/case.py', source: 'script' })
      expect(h.stages.map((x: Dict) => [x.kind, x.where])).toEqual([['cad-script', 'local'], ['cad', 'local']])
      expect(h.case.parts.map((p: Dict) => p.name).sort()).toEqual(['base', 'lid'])
      expect(h.notes).toContain('custom script ran')
      expect(h.fit_status, h.fit_summary).toBe('pass')
      // a script that fails: its own error, named, and no cad job after it
      writeFileSync(join(repo, 'broken.py'), 'def build(board, settings):\n    raise ValueError("no lid today")\n')
      await expect(call('mech.hand_in', { path: 'broken.py', formats: ['step'] })).rejects.toThrow(/case script \(mechanical\/case\.py\) failed:.*no lid today/s)
      // and back to the template for the STEP hand-in below
      writeFileSync(join(repo, 'mechanical', 'case.py'), readFileSync(templatePath()))
      const t = await call('mech.build', { formats: ['step'] })
      expect(t.stages).toHaveLength(1)
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
