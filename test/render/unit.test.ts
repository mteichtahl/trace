/** The render plumbing without Blender: runJob is stubbed, so these run anywhere. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { GpuJob, JobResult } from '../../src/gpu/jobs.js'

const calls: { spec: GpuJob; job: unknown }[] = []
let reply: (spec: GpuJob) => Partial<JobResult> = () => ({})

vi.mock('../../src/gpu/jobs.js', async (orig) => {
  const real = await orig<typeof import('../../src/gpu/jobs.js')>()
  return {
    ...real,
    runJob: vi.fn(async (spec: GpuJob): Promise<JobResult> => {
      const jobPath = spec.inputs?.['job.json']
      calls.push({ spec, job: jobPath ? JSON.parse(readFileSync(jobPath, 'utf8')) as unknown : null })
      return { exitCode: 0, stdout: '', stderr: '', outputs: {}, where: 'local', seconds: 1, ...reply(spec) }
    }),
  }
})

const { parseResultLine, readResult, runBlender, pngSize } = await import('../../src/render/blender.js')
const { selectDevice, defaultDevice, probe, DEFAULTS } = await import('../../src/render/device.js')
const { freeName, tools } = await import('../../src/render/tools.js')
const { commitOf } = await import('../../src/render/model.js')
const { renderingAgentPrompt } = await import('../../src/render/agent.js')
const { Cache } = await import('../../src/core/store.js')

const fakeBlender = join(mkdtempSync(join(tmpdir(), 'fake-blender-')), 'blender')
writeFileSync(fakeBlender, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

beforeEach(() => {
  calls.length = 0
  reply = () => ({})
  process.env.TRACE_BLENDER = fakeBlender
  delete process.env.TRACE_GPU_QUEUE
  delete process.env.TRACE_RENDER_DEVICE
  const c = new Cache()
  c.clear('render.probe')
  c.close()
})

const dev = (type: string, name: string, gpu = type !== 'CPU') => ({ type, name, id: `${type}_${name}`, gpu })

describe('result line', () => {
  it('takes the last TRACE_RESULT line', () => {
    const out = 'Blender 4.0\nTRACE_RESULT {"ok":true,"n":1}\nnoise\nTRACE_RESULT {"ok":true,"n":2}\nBlender quit\n'
    expect(parseResultLine(out)).toEqual({ ok: true, n: 2 })
    expect(parseResultLine('nothing here')).toBeNull()
    expect(() => parseResultLine('TRACE_RESULT {oops')).toThrow(/malformed/)
  })

  it('turns failures into clear errors', () => {
    const S = z.object({ n: z.number() })
    expect(readResult({ exitCode: 0, stdout: 'TRACE_RESULT {"ok":true,"n":3}', stderr: '', seconds: 1 }, S, 60)).toEqual({ n: 3 })
    expect(() => readResult({ exitCode: 1, stdout: 'TRACE_RESULT {"ok":false,"error":"JobError: no mesh"}', stderr: '', seconds: 1 }, S, 60)).toThrow(/no mesh/)
    expect(() => readResult({ exitCode: -1, stdout: 'Fra:1 ...', stderr: '', seconds: 60 }, S, 60)).toThrow(/timed out after 60 s/)
    expect(() => readResult({ exitCode: 139, stdout: '', stderr: 'Segmentation fault', seconds: 2 }, S, 60)).toThrow(/exited 139.*\n.*Segmentation/s)
    expect(() => readResult({ exitCode: 0, stdout: 'TRACE_RESULT {"ok":true,"n":"x"}', stderr: '', seconds: 1 }, S, 60)).toThrow(/expected shape/)
  })
})

describe('runBlender', () => {
  it('passes the script, common.py and the job through runJob with placeholders', async () => {
    reply = () => ({ stdout: 'TRACE_RESULT {"ok":true,"v":"4.0.2"}' })
    const r = await runBlender({
      script: 'render_model.py', job: { views: ['iso'], device: 'cpu' }, inputs: { 'model.obj': fakeBlender },
      args: ['{in:model.obj}', '{out:iso.png}'], outputs: ['iso.png'], schema: z.object({ v: z.string() }), timeoutSeconds: 30,
    })
    expect(r.result.v).toBe('4.0.2')
    const c = calls[0]
    expect(c?.spec.kind).toBe('blender')
    expect(c?.spec.gpu).toBe(true)
    expect(c?.spec.timeoutSeconds).toBe(30)
    expect(c?.spec.argv).toEqual([fakeBlender, '-b', '--factory-startup', '--python-exit-code', '1', '-P', '{in:render_model.py}', '--',
      '{in:job.json}', '{out:result.json}', '{in:model.obj}', '{out:iso.png}'])
    expect(Object.keys(c?.spec.inputs ?? {}).sort()).toEqual(['common.py', 'job.json', 'model.obj', 'render_model.py'])
    expect(c?.spec.outputs).toEqual(['result.json', 'iso.png'])
    expect(c?.spec.env).toMatchObject({ PYTHONDONTWRITEBYTECODE: '1' })
    expect(c?.job).toEqual({ views: ['iso'], device: 'cpu' })
  })

  it('reports a timeout when runJob stopped Blender', async () => {
    reply = (s) => ({ exitCode: -1, stdout: 'Fra:1 Mem ... Sample 3/32', seconds: s.timeoutSeconds ?? 0 })
    await expect(runBlender({ script: 'probe.py', job: {}, schema: z.object({}), timeoutSeconds: 12 })).rejects.toThrow(/timed out after 12 s/)
  })

  it('says when Blender is missing', async () => {
    process.env.TRACE_BLENDER = '/nonexistent/blender'
    await expect(runBlender({ script: 'probe.py', job: {}, schema: z.object({}) })).rejects.toThrow(/Blender is not installed/)
  })
})

describe('device selection', () => {
  const all = [dev('CPU', 'Xeon'), dev('METAL', 'M2'), dev('HIP', 'RX 7900'), dev('CUDA', 'RTX 4090'), dev('OPTIX', 'RTX 4090'), dev('ONEAPI', 'Arc')]

  it('auto takes the best backend: OPTIX > CUDA > HIP > ONEAPI > METAL', () => {
    expect(selectDevice(all, 'auto')).toEqual({ type: 'OPTIX', gpu: true, names: ['RTX 4090'] })
    expect(selectDevice(all.filter((d) => d.type !== 'OPTIX'), 'auto').type).toBe('CUDA')
    expect(selectDevice(all.filter((d) => !['OPTIX', 'CUDA'].includes(d.type)), 'auto').type).toBe('HIP')
    expect(selectDevice([dev('CPU', 'x'), dev('METAL', 'M2'), dev('ONEAPI', 'Arc')], 'auto').type).toBe('ONEAPI')
    expect(selectDevice([dev('CPU', 'x'), dev('METAL', 'M2')], 'gpu')).toEqual({ type: 'METAL', gpu: true, names: ['M2'] })
  })

  it('takes every device of the chosen backend', () => {
    expect(selectDevice([dev('CUDA', 'A'), dev('CUDA', 'B'), dev('CPU', 'x')], 'gpu').names).toEqual(['A', 'B'])
  })

  it('cpu is always the CPU, and auto falls back to it', () => {
    expect(selectDevice(all, 'cpu')).toEqual({ type: 'CPU', gpu: false, names: ['Xeon'] })
    expect(selectDevice([dev('CPU', 'Xeon')], 'auto')).toEqual({ type: 'CPU', gpu: false, names: ['Xeon'] })
    // a CPU listed under a GPU backend's devices is still not a GPU
    expect(selectDevice([dev('CPU', 'Xeon'), { type: 'CUDA', name: 'cpu-ish', id: 'x', gpu: false }], 'auto').type).toBe('CPU')
  })

  it('gpu without a GPU fails and says so', () => {
    expect(() => selectDevice([dev('CPU', 'Xeon')], 'gpu')).toThrow(/device=gpu.*no GPU/)
  })

  it('TRACE_RENDER_DEVICE sets the default', () => {
    expect(defaultDevice()).toBe('auto')
    process.env.TRACE_RENDER_DEVICE = 'GPU'
    expect(defaultDevice()).toBe('gpu')
    process.env.TRACE_RENDER_DEVICE = 'fast'
    expect(() => defaultDevice()).toThrow(/auto, gpu or cpu/)
  })

  it('GPU defaults are larger than CPU defaults', () => {
    expect(DEFAULTS.gpu.samples).toBeGreaterThan(DEFAULTS.cpu.samples)
    expect(DEFAULTS.cpu).toEqual({ width: 1280, height: 800, samples: 32 })
  })
})

const cannedProbe = (devices: ReturnType<typeof dev>[]) =>
  `TRACE_RESULT ${JSON.stringify({ ok: true, blender: '4.2.0', engines: ['CYCLES', 'BLENDER_EEVEE_NEXT'], compute_types: ['CUDA', 'OPTIX'], devices, gltf_import: true, denoisers: ['OPENIMAGEDENOISE'], python: '3.11', eevee: { engine: 'BLENDER_EEVEE_NEXT', renders_headless: false, error: 'no EGL' }, seconds: 2 })}`

describe('probe and render.status', () => {
  it('caches the probe per Blender binary', async () => {
    reply = () => ({ stdout: cannedProbe([dev('CPU', 'Xeon'), dev('OPTIX', 'L4')]) })
    const a = await probe()
    const b = await probe()
    expect(a?.cached).toBe(false)
    expect(b?.cached).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.spec.argv).toContain('{in:probe.py}')
    await probe({ refresh: true })
    expect(calls).toHaveLength(2)
  })

  it('render.status lists every device and what auto picks', async () => {
    reply = () => ({ stdout: cannedProbe([dev('CPU', 'Xeon'), dev('CUDA', 'L4'), dev('OPTIX', 'L4')]) })
    const status = tools.find((t) => t.name === 'render.status')
    const s = await status?.run({ refresh: false }, { hardware: false, via: 'test' }) as Record<string, unknown>
    expect(s.found).toBe(true)
    expect(s.devices).toHaveLength(3)
    expect(s.gpu_available).toBe(true)
    expect(s.auto_device).toEqual({ type: 'OPTIX', gpu: true, name: 'L4' })
    expect(s.board_model_format).toBe('glb')
  })

  it('device=gpu fails before any render when the probe finds no GPU', async () => {
    reply = () => ({ stdout: cannedProbe([dev('CPU', 'Xeon')]) })
    const model = tools.find((t) => t.name === 'render.model')
    const obj = join(mkdtempSync(join(tmpdir(), 'm-')), 'm.obj')
    writeFileSync(obj, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')
    const args = model?.input.parse({ path: obj, device: 'gpu' })
    await expect(model?.run(args as never, { hardware: false, via: 'test' })).rejects.toThrow(/no GPU/)
    expect(calls.every((c) => c.spec.argv.includes('{in:probe.py}'))).toBe(true)
  })

  it('engine=eevee fails when EEVEE cannot render headless', async () => {
    reply = () => ({ stdout: cannedProbe([dev('CPU', 'Xeon')]) })
    const model = tools.find((t) => t.name === 'render.model')
    const obj = join(mkdtempSync(join(tmpdir(), 'm-')), 'm.obj')
    writeFileSync(obj, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')
    await expect(model?.run(model.input.parse({ path: obj, engine: 'eevee' }) as never, { hardware: false, via: 'test' })).rejects.toThrow(/EEVEE cannot render headless/)
  })
})

describe('helpers', () => {
  it('never replaces an existing file', () => {
    const d = mkdtempSync(join(tmpdir(), 'out-'))
    expect(freeName(d, 'top.png')).toBe(join(d, 'top.png'))
    writeFileSync(join(d, 'top.png'), 'x')
    writeFileSync(join(d, 'top-1.png'), 'x')
    expect(freeName(d, 'top.png')).toBe(join(d, 'top-2.png'))
  })

  it('reads a PNG size from its header', () => {
    const h = Buffer.alloc(24)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(h)
    h.writeUInt32BE(320, 16)
    h.writeUInt32BE(200, 20)
    expect(pngSize(h)).toEqual({ width: 320, height: 200 })
    expect(pngSize(Buffer.from('not a png at all, no sir.'))).toBeNull()
  })

  it('reads the checked-out commit from .git without running git', () => {
    const repo = mkdtempSync(join(tmpdir(), 'repo-'))
    const sha = 'a'.repeat(40)
    mkdirSync(join(repo, '.git', 'refs', 'heads'), { recursive: true })
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), `${sha}\n`)
    mkdirSync(join(repo, 'hw'))
    expect(commitOf(join(repo, 'hw'))).toBe(sha)
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/dev\n')
    writeFileSync(join(repo, '.git', 'packed-refs'), `# pack-refs\n${'b'.repeat(40)} refs/heads/dev\n`)
    expect(commitOf(repo)).toBe('b'.repeat(40))
    expect(commitOf(mkdtempSync(join(tmpdir(), 'norepo-')))).toBeNull()
  })

  it('the rendering-agent prompt names the tools and the rules', () => {
    const p = renderingAgentPrompt('Render the board for the README', { electronics: { projects: ['hw/main.kicad_pro'], models: [] } })
    for (const s of ['render_status', 'render_board', 'render_model', 'render_turntable', 'device=auto', 'GPU', 'hw/main.kicad_pro', 'commit', 'Never overwrite', 'Look at every image']) {
      expect(p).toContain(s)
    }
  })

  it('every render tool takes device auto|gpu|cpu and is not a hardware tool', () => {
    for (const t of tools.filter((x) => x.name !== 'render.status')) {
      expect(t.hardware).toBe(false)
      expect(t.input.safeParse({ path: 'x.obj', device: 'gpu' }).success || t.input.safeParse({ device: 'gpu' }).success).toBe(true)
      expect(t.input.safeParse({ path: 'x.obj', device: 'tpu' }).success).toBe(false)
    }
    expect(tools.map((t) => t.name).sort()).toEqual(['render.board', 'render.model', 'render.status', 'render.turntable'])
  })
})
