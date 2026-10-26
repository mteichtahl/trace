import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { placement, runBatch, type BatchApi, type BatchJobDetail } from '../../src/gpu/batch.js'
import { GpuJobSchema, isInputName, runLocal } from '../../src/gpu/jobs.js'
import { decodeSpec, encodeSpec, jobsLocation, type RemoteSpec } from '../../src/gpu/protocol.js'
import { main, readSpec } from '../../src/gpu/runner.js'
import { FakeS3 } from '../core/fake-s3.js'

const env = { TRACE_GPU_QUEUE: 'q-arn', TRACE_GPU_JOB_DEFINITION: 'def-arn', TRACE_GPU_BUCKET: 'central-bucket', TRACE_GPU_QUEUE_WAIT_S: '60', TRACE_PROJECT: 'Acme/Board' }

/** A Batch whose job "runs" by calling the real runner against the same fake S3 when it is first described. */
class FakeBatch implements BatchApi {
  submitted: Parameters<BatchApi['submitJob']>[0][] = []
  terminated: string[] = []
  statuses: string[] = ['SUBMITTED', 'RUNNABLE', 'STARTING', 'RUNNING', 'SUCCEEDED']
  ran = false
  constructor(private readonly s3: FakeS3, private readonly run = true) {}
  async submitJob(i: Parameters<BatchApi['submitJob']>[0]) {
    this.submitted.push(i)
    return { jobId: 'job-1' }
  }
  async describeJobs(): Promise<{ jobs: BatchJobDetail[] }> {
    const status = this.statuses.length > 1 ? this.statuses.shift() as string : this.statuses[0] as string
    if (status === 'RUNNING' && this.run && !this.ran) {
      this.ran = true
      const e = Object.fromEntries((this.submitted[0]?.containerOverrides.environment ?? []).map((x) => [x.name, x.value]))
      await main({ s3: this.s3, env: e, echo: false })
    }
    return { jobs: [{ jobId: 'job-1', status, statusReason: status === 'FAILED' ? 'Host EC2 terminated' : undefined }] }
  }
  async terminateJob(i: { jobId: string }) {
    this.terminated.push(i.jobId)
    return {}
  }
}

const job = (over: Record<string, unknown> = {}) => {
  const d = mkdtempSync(join(tmpdir(), 'gpu-in-'))
  writeFileSync(join(d, 'a.txt'), 'hello gpu')
  return GpuJobSchema.parse({
    kind: 'blender', gpu: true, timeoutSeconds: 60,
    argv: ['sh', '-c', 'cat "$0" > "$1"; echo made; echo warn >&2', '{in:a.txt}', '{out:b.txt}'],
    inputs: { 'a.txt': join(d, 'a.txt') }, outputs: ['b.txt', 'never.txt'], ...over,
  })
}

describe('where GPU jobs are staged', () => {
  it('uses TRACE_GPU_BUCKET, or TRACE_HOME\'s bucket, under jobs/<project>/', () => {
    expect(jobsLocation({ TRACE_GPU_BUCKET: 'b1', TRACE_PROJECT: 'Acme/Board' })).toEqual({ bucket: 'b1', prefix: 'jobs/acme/board', project: 'acme/board' })
    expect(jobsLocation({ TRACE_GPU_BUCKET: 's3://b1/elsewhere/', TRACE_PROJECT: 'acme/board' })).toEqual({ bucket: 'b1', prefix: 'elsewhere/acme/board', project: 'acme/board' })
    expect(jobsLocation({ TRACE_HOME: 's3://b2/central', TRACE_PROJECT: 'acme/board.fw' })).toEqual({ bucket: 'b2', prefix: 'jobs/acme/board.fw', project: 'acme/board.fw' })
    // outside a project (a laptop): a prefix no project has
    expect(jobsLocation({ TRACE_GPU_BUCKET: 'b1' })).toEqual({ bucket: 'b1', prefix: 'jobs/_local', project: '_local' })
    expect(() => jobsLocation({ TRACE_GPU_BUCKET: 'b1', TRACE_PROJECT: '../other' })).toThrow(/TRACE_PROJECT/)
    expect(() => jobsLocation({ TRACE_HOME: '/home/me/.trace' })).toThrow(/TRACE_GPU_BUCKET/)
  })

  it('round-trips the spec, and refuses input names that leave the job folder', () => {
    const s: RemoteSpec = { v: 1, id: 'blender-1', bucket: 'bkt', prefix: 'jobs', kind: 'blender', argv: ['x'], inputs: ['a.v', 'rtl/sub/x.vh'], outputs: [], env: {}, gpu: true, timeoutSeconds: 10 }
    expect(decodeSpec(encodeSpec(s))).toEqual(s)
    expect(() => decodeSpec('nonsense')).toThrow(/not readable/)
    for (const bad of ['../x.v', 'a/../../x.v', '/etc/passwd', 'a\\b.v', 'a//b.v', './a.v', 'a/./b.v', '']) {
      expect(isInputName(bad), bad).toBe(false)
      expect(() => decodeSpec(encodeSpec({ ...s, inputs: [bad] }))).toThrow(/invalid/)
    }
    for (const good of ['a.v', 'rtl/core/alu.v', 'x/y/z/.hidden', 'a-b_c.d/e.v']) expect(isInputName(good), good).toBe(true)
    // a file and a folder of the same name cannot both be staged
    expect(() => decodeSpec(encodeSpec({ ...s, inputs: ['a', 'a/b.v'] }))).toThrow(/both an input and the folder/)
    expect(() => GpuJobSchema.parse({ kind: 'yosys', argv: ['x'], inputs: { '../up.v': '/tmp/x' } })).toThrow(/relative path/)
  })

  it('stages relative input names as a tree, locally', async () => {
    const d = mkdtempSync(join(tmpdir(), 'gpu-tree-'))
    writeFileSync(join(d, 'top.v'), 'top')
    writeFileSync(join(d, 'x.vh'), 'inc')
    const r = await runLocal({ kind: 'yosys', timeoutSeconds: 30, argv: ['sh', '-c', 'cat "$0" in/sub/deep/x.vh > "$1"', '{in:top.v}', '{out:o.txt}'], inputs: { 'top.v': join(d, 'top.v'), 'sub/deep/x.vh': join(d, 'x.vh') }, outputs: ['o.txt'] })
    expect(r.exitCode).toBe(0)
    expect(readFileSync(r.outputs['o.txt'] as string, 'utf8')).toBe('topinc')
  })
})

describe('runBatch with the runner', () => {
  it('uploads inputs, submits, polls with backoff, runs, and brings back outputs and logs', async () => {
    const s3 = new FakeS3()
    const batch = new FakeBatch(s3)
    const sleeps: number[] = []
    const r = await runBatch(job(), { s3, batch, env, sleep: async (ms) => { sleeps.push(ms) } })
    expect(r).toMatchObject({ exitCode: 0, where: 'batch', jobId: 'job-1' })
    expect(readFileSync(r.outputs['b.txt'] as string, 'utf8')).toBe('hello gpu')
    expect(r.outputs).not.toHaveProperty('never.txt')
    expect(r.stdout.trim()).toBe('made')
    expect(r.stderr.trim()).toBe('warn')
    const sub = batch.submitted[0]
    expect(sub).toMatchObject({ jobQueue: 'q-arn', jobDefinition: 'def-arn', timeout: { attemptDurationSeconds: 660 } })
    // the project's role may submit only jobs tagged with its project
    expect(sub?.tags).toMatchObject({ 'trace:project': 'acme/board', 'trace:kind': 'blender' })
    expect(sub?.jobName).toMatch(/^trace-blender-\d{8}-\d{6}-[0-9a-f]{8}$/)
    // only where the spec is: no argv, file names or program env in what Batch shows any project
    expect(sub?.containerOverrides.environment.map((e) => e.name)).toEqual(['TRACE_GPU_JOB_URI'])
    expect(sub).not.toHaveProperty('containerOverrides.command')
    expect(sub?.containerOverrides).not.toHaveProperty('resourceRequirements')
    const shown = JSON.stringify(sub)
    for (const leak of ['a.txt', 'b.txt', 'never.txt', 'cat ']) expect(shown).not.toContain(leak)
    const uri = sub?.containerOverrides.environment[0]?.value as string
    expect(uri).toMatch(/^s3:\/\/central-bucket\/jobs\/acme\/board\/blender-[\w-]+\/spec$/)
    const spec = await readSpec({ TRACE_GPU_JOB_URI: uri }, s3)
    expect(spec).toMatchObject({ bucket: 'central-bucket', prefix: 'jobs/acme/board', kind: 'blender', inputs: ['a.txt'], outputs: ['b.txt', 'never.txt'] })
    const keys = [...s3.objects.keys()].map((k) => k.replace(spec.id, 'ID'))
    const P = 'central-bucket/jobs/acme/board/ID'
    expect(keys.sort()).toEqual([`${P}/exit`, `${P}/in/a.txt`, `${P}/log/stderr.txt`, `${P}/log/stdout.txt`, `${P}/out/b.txt`, `${P}/spec`])
    expect(sleeps).toEqual([5000, 7500, 11250, 16875]) // backing off between the five looks
  })

  it('passes the program env through the spec only, however large', async () => {
    const s3 = new FakeS3()
    const batch = new FakeBatch(s3)
    const r = await runBatch(job({ env: { BIG: 'x'.repeat(7000), SECRET_FILE: 'secret-name.v' }, argv: ['sh', '-c', 'printf %s "$SECRET_FILE" > "$0"', '{out:b.txt}'] }), { s3, batch, env, sleep: async () => undefined })
    expect(r.exitCode).toBe(0)
    expect(readFileSync(r.outputs['b.txt'] as string, 'utf8')).toBe('secret-name.v')
    expect(batch.submitted[0]?.containerOverrides.environment.map((e) => e.name)).toEqual(['TRACE_GPU_JOB_URI'])
    expect(JSON.stringify(batch.submitted[0])).not.toContain('secret-name')
  })

  it('stages relative input names as a tree, with S3 keys that mirror it', async () => {
    const s3 = new FakeS3()
    const batch = new FakeBatch(s3)
    const d = mkdtempSync(join(tmpdir(), 'gpu-in-'))
    mkdirSync(join(d, 'sub'))
    writeFileSync(join(d, 'top.v'), 'top ')
    writeFileSync(join(d, 'sub', 'x.vh'), 'inc')
    const j = GpuJobSchema.parse({ kind: 'verilator', gpu: false, timeoutSeconds: 60, argv: ['sh', '-c', 'cat "$0" in/rtl/sub/x.vh > "$1"', '{in:rtl/top.v}', '{out:o.txt}'],
      inputs: { 'rtl/top.v': join(d, 'top.v'), 'rtl/sub/x.vh': join(d, 'sub', 'x.vh') }, outputs: ['o.txt'] })
    const r = await runBatch(j, { s3, batch, env, sleep: async () => undefined })
    expect(r.exitCode).toBe(0)
    expect(readFileSync(r.outputs['o.txt'] as string, 'utf8')).toBe('top inc')
    const keys = [...s3.objects.keys()].filter((k) => k.includes('/in/')).map((k) => k.replace(/^.*\/in\//, 'in/')).sort()
    expect(keys).toEqual(['in/rtl/sub/x.vh', 'in/rtl/top.v'])
  })

  it('refuses a spec URI that holds another job\'s spec', async () => {
    const s3 = new FakeS3()
    const batch = new FakeBatch(s3, false)
    batch.statuses = ['SUCCEEDED']
    await runBatch(job(), { s3, batch, env, sleep: async () => undefined }).catch(() => undefined)
    const uri = batch.submitted[0]?.containerOverrides.environment[0]?.value as string
    const body = s3.objects.get(uri.replace('s3://', ''))?.body as Uint8Array
    await s3.putObject({ Bucket: 'central-bucket', Key: 'jobs/acme/board/other/spec', Body: body })
    await expect(readSpec({ TRACE_GPU_JOB_URI: 's3://central-bucket/jobs/acme/board/other/spec' }, s3)).rejects.toThrow(/spec of another job/)
    await expect(readSpec({}, s3)).rejects.toThrow(/TRACE_GPU_JOB_URI is not set/)
  })

  it('reports the program\'s exit code, and a program that is not installed', async () => {
    const s3 = new FakeS3()
    const r = await runBatch(job({ argv: ['sh', '-c', 'exit 3'] }), { s3, batch: new FakeBatch(s3), env, sleep: async () => undefined })
    expect(r.exitCode).toBe(3)
    const s3b = new FakeS3()
    await expect(runBatch(job({ argv: ['definitely-not-a-program-here'] }), { s3: s3b, batch: new FakeBatch(s3b), env, sleep: async () => undefined }))
      .rejects.toThrow(/definitely-not-a-program-here is not installed in the GPU image/)
  })

  it('explains a job that failed before the runner finished', async () => {
    const s3 = new FakeS3()
    const batch = new FakeBatch(s3, false)
    batch.statuses = ['RUNNABLE', 'FAILED']
    await expect(runBatch(job(), { s3, batch, env, sleep: async () => undefined })).rejects.toThrow(/failed before its runner finished: Host EC2 terminated/)
  })

  it('terminates a job stuck past its deadline', async () => {
    const s3 = new FakeS3()
    const batch = new FakeBatch(s3, false)
    batch.statuses = ['RUNNABLE']
    let t = 0
    await expect(runBatch(job(), { s3, batch, env, now: () => t, sleep: async (ms) => { t += ms } }))
      .rejects.toThrow(/still RUNNABLE after \d+ s and was terminated: no GPU instance came up/)
    expect(batch.terminated).toEqual(['job-1'])
  })

  it('needs the queue settings', async () => {
    await expect(runBatch(job(), { s3: new FakeS3(), batch: new FakeBatch(new FakeS3()), env: {} })).rejects.toThrow(/TRACE_GPU_QUEUE and TRACE_GPU_JOB_DEFINITION/)
    await expect(runBatch(job({ gpu: false }), { s3: new FakeS3(), batch: new FakeBatch(new FakeS3()), env: {} })).rejects.toThrow(/TRACE_CPU_QUEUE and TRACE_CPU_JOB_DEFINITION, or TRACE_GPU_QUEUE/)
  })
})

describe('queue selection', () => {
  const both = { ...env, TRACE_CPU_QUEUE: 'cpu-q', TRACE_CPU_JOB_DEFINITION: 'cpu-def' }

  it('sends gpu jobs to the GPU queue and CPU jobs to the CPU queue, falling back to the GPU queue', () => {
    expect(placement({ gpu: true }, both)).toMatchObject({ queue: 'q-arn', definition: 'def-arn', pool: 'gpu', vcpus: null })
    expect(placement({ gpu: false }, both)).toMatchObject({ queue: 'cpu-q', definition: 'cpu-def', pool: 'cpu' })
    expect(placement({ gpu: false }, env)).toMatchObject({ queue: 'q-arn', definition: 'def-arn', pool: 'gpu' })
    // half a CPU setting is no CPU queue
    expect(placement({ gpu: false }, { ...env, TRACE_CPU_QUEUE: 'cpu-q' })).toMatchObject({ pool: 'gpu' })
    // a CPU queue alone serves CPU jobs, but not GPU ones
    const cpuOnly = { TRACE_CPU_QUEUE: 'cpu-q', TRACE_CPU_JOB_DEFINITION: 'cpu-def' }
    expect(placement({ gpu: false }, cpuOnly)).toMatchObject({ pool: 'cpu' })
    expect(() => placement({ gpu: true }, cpuOnly)).toThrow(/TRACE_GPU_QUEUE/)
  })

  it('applies a vcpus hint as an override, capped at the definition\'s limit', () => {
    expect(placement({ gpu: false, vcpus: 16 }, { ...both, TRACE_CPU_JOB_MAX_VCPUS: '32' })).toMatchObject({ pool: 'cpu', vcpus: 16, note: null })
    expect(placement({ gpu: false, vcpus: 64 }, { ...both, TRACE_CPU_JOB_MAX_VCPUS: '32' })).toMatchObject({ vcpus: 32, note: expect.stringMatching(/capped at 32/) })
    expect(placement({ gpu: true, vcpus: 8 }, { ...both, TRACE_GPU_JOB_MAX_VCPUS: '4', TRACE_CPU_JOB_MAX_VCPUS: '32' })).toMatchObject({ pool: 'gpu', vcpus: 4 })
    // the GPU queue standing in for the CPU one uses the GPU definition's limit
    expect(placement({ gpu: false, vcpus: 8 }, { ...env, TRACE_GPU_JOB_MAX_VCPUS: '4', TRACE_CPU_JOB_MAX_VCPUS: '32' })).toMatchObject({ pool: 'gpu', vcpus: 4 })
    expect(placement({ gpu: false, vcpus: 8 }, both)).toMatchObject({ vcpus: null, note: expect.stringMatching(/TRACE_CPU_JOB_MAX_VCPUS .* not set/) })
  })

  it('submits a CPU job to the CPU queue with the vCPU override', async () => {
    const s3 = new FakeS3()
    const batch = new FakeBatch(s3)
    const logs: string[] = []
    const r = await runBatch(job({ gpu: false, kind: 'openems', vcpus: 48 }), { s3, batch, env: { ...both, TRACE_CPU_JOB_MAX_VCPUS: '32' }, sleep: async () => undefined, log: (l) => logs.push(l) })
    expect(r.exitCode).toBe(0)
    expect(batch.submitted[0]).toMatchObject({ jobQueue: 'cpu-q', jobDefinition: 'cpu-def', containerOverrides: { resourceRequirements: [{ type: 'VCPU', value: '32' }] } })
    expect(logs.join('\n')).toMatch(/capped at 32[\s\S]*CPU queue/)
  })
})
