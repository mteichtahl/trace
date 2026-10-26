import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runBatch, type BatchApi, type BatchJobDetail } from '../../src/gpu/batch.js'
import { GpuJobSchema } from '../../src/gpu/jobs.js'
import { decodeSpec, encodeSpec, jobsLocation, type RemoteSpec } from '../../src/gpu/protocol.js'
import { main } from '../../src/gpu/runner.js'
import { FakeS3 } from '../core/fake-s3.js'

const env = { TRACE_GPU_QUEUE: 'q-arn', TRACE_GPU_JOB_DEFINITION: 'def-arn', TRACE_GPU_BUCKET: 'central-bucket', TRACE_GPU_QUEUE_WAIT_S: '60' }

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
  it('uses TRACE_GPU_BUCKET, or TRACE_HOME\'s bucket under jobs/', () => {
    expect(jobsLocation({ TRACE_GPU_BUCKET: 'b1' })).toEqual({ bucket: 'b1', prefix: 'jobs' })
    expect(jobsLocation({ TRACE_GPU_BUCKET: 's3://b1/elsewhere/' })).toEqual({ bucket: 'b1', prefix: 'elsewhere' })
    expect(jobsLocation({ TRACE_HOME: 's3://b2/central' })).toEqual({ bucket: 'b2', prefix: 'jobs' })
    expect(() => jobsLocation({ TRACE_HOME: '/home/me/.trace' })).toThrow(/TRACE_GPU_BUCKET/)
  })

  it('round-trips the spec through the environment', () => {
    const s: RemoteSpec = { v: 1, id: 'blender-1', bucket: 'bkt', prefix: 'jobs', kind: 'blender', argv: ['x'], inputs: [], outputs: [], env: {}, gpu: true, timeoutSeconds: 10 }
    expect(decodeSpec(encodeSpec(s))).toEqual(s)
    expect(() => decodeSpec('nonsense')).toThrow(/not readable/)
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
    expect(sub?.jobName).toMatch(/^trace-blender-\d{8}-\d{6}-[0-9a-f]{8}$/)
    const spec = decodeSpec(sub?.containerOverrides.environment.find((e) => e.name === 'TRACE_GPU_JOB')?.value as string)
    expect(spec).toMatchObject({ bucket: 'central-bucket', prefix: 'jobs', kind: 'blender', inputs: ['a.txt'], outputs: ['b.txt', 'never.txt'] })
    const keys = [...s3.objects.keys()].map((k) => k.replace(spec.id, 'ID'))
    expect(keys.sort()).toEqual(['central-bucket/jobs/ID/exit', 'central-bucket/jobs/ID/in/a.txt', 'central-bucket/jobs/ID/log/stderr.txt', 'central-bucket/jobs/ID/log/stdout.txt', 'central-bucket/jobs/ID/out/b.txt'])
    expect(sleeps).toEqual([5000, 7500, 11250, 16875]) // backing off between the five looks
  })

  it('passes a large spec through S3 instead of the environment', async () => {
    const s3 = new FakeS3()
    const batch = new FakeBatch(s3)
    const r = await runBatch(job({ env: { BIG: 'x'.repeat(7000) } }), { s3, batch, env, sleep: async () => undefined })
    expect(r.exitCode).toBe(0)
    expect(batch.submitted[0]?.containerOverrides.environment[0]?.name).toBe('TRACE_GPU_JOB_URI')
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
  })
})
