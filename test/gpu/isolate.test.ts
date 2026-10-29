/**
 * Isolated jobs (src/gpu/jobs.ts isolatedEnv, spawnJob; `isolate` in the spec, default for kind `cad`): the program
 * sees no credentials or tokens, and nothing it starts in the background outlives the job, run here (runLocal) or by
 * the function's runner (src/gpu/runner.ts main).
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GpuJobSchema, isolatedEnv, runLocal } from '../../src/gpu/jobs.js'
import { decodeSpec } from '../../src/gpu/protocol.js'
import { main } from '../../src/gpu/runner.js'
import { stageJob } from '../../src/gpu/staging.js'
import { FakeS3 } from '../core/fake-s3.js'

const SECRETS = {
  AWS_ACCESS_KEY_ID: 'AKIA0000', AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: 'tok', AWS_REGION: 'us-west-2',
  AWS_LAMBDA_RUNTIME_API: '127.0.0.1:9001', _HANDLER: 'x', AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials',
  AWS_CONTAINER_AUTHORIZATION_TOKEN: 'a', GITHUB_TOKEN: 'ghp_x', GITHUB_APP_PRIVATE_KEY: 'k', TRACE_TOKEN: 't', ANTHROPIC_API_KEY: 'sk-x',
  TRACE_HOME: 's3://b/central', TRACE_GPU_BUCKET: 'b',
}

/** Whether a process runs: not gone and not a zombie (a killed orphan may wait for a reaper that never comes in a container). */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return true
  }
}

const saved: Record<string, string | undefined> = {}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})
function withSecrets(): void {
  for (const [k, v] of Object.entries(SECRETS)) {
    if (!(k in saved)) saved[k] = process.env[k]
    process.env[k] = v
  }
}

describe('the isolated environment', () => {
  it('keeps PATH, HOME, locale and Python settings, and drops credentials, tokens and the Lambda runtime', () => {
    const env = isolatedEnv({ ...SECRETS, PATH: '/usr/bin', HOME: '/home/me', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', PYTHONPATH: '/py', XDG_CACHE_HOME: '/c' }, { PYTHONUNBUFFERED: '1' })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/me', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', PYTHONPATH: '/py', XDG_CACHE_HOME: '/c', PYTHONUNBUFFERED: '1' })
    for (const k of Object.keys(SECRETS)) expect(env[k], k).toBeUndefined()
  })

  it('moves HOME, TMPDIR and the XDG folders into the job\'s folder when given one', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'iso-')), 'home')
    const env = isolatedEnv({ PATH: '/bin', HOME: '/tmp', XDG_CACHE_HOME: '/tmp/.cache' }, {}, home)
    expect(env).toMatchObject({ PATH: '/bin', HOME: home, TMPDIR: join(home, 'tmp'), XDG_CACHE_HOME: join(home, '.cache'), PYTHONNOUSERSITE: '1' })
    expect(existsSync(join(home, 'tmp'))).toBe(true)
  })

  it('is the default for cad jobs only, and travels in the remote spec', async () => {
    expect(GpuJobSchema.parse({ kind: 'cad', argv: ['x'] }).isolate).toBe(true)
    expect(GpuJobSchema.parse({ kind: 'kicad', argv: ['x'] }).isolate).toBe(false)
    expect(GpuJobSchema.parse({ kind: 'kicad', argv: ['x'], isolate: true }).isolate).toBe(true)
    const s3 = new FakeS3()
    const st = await stageJob(GpuJobSchema.parse({ kind: 'cad', argv: ['x'] }), { env: { TRACE_GPU_BUCKET: 'bkt' }, s3, now: Date.now() })
    expect(decodeSpec(new TextDecoder().decode(s3.objects.get(`bkt/jobs/_local/${st.keys.spec}`)?.body)).isolate).toBe(true)
    // a spec written before the field: not isolated
    expect(decodeSpec(JSON.stringify({ v: 1, id: 'k-1', bucket: 'bkt', prefix: 'jobs', kind: 'kicad', argv: ['x'], inputs: [], outputs: [], env: {}, gpu: false, timeoutSeconds: 10 })).isolate).toBe(false)
  })
})

describe('an isolated job here (runLocal)', () => {
  it('sees none of this process\'s secrets', async () => {
    withSecrets()
    const r = await runLocal({ kind: 'cad', argv: ['sh', '-c', 'env > "$0"', '{out:env.txt}'], outputs: ['env.txt'], timeoutSeconds: 10, env: { PYTHONUNBUFFERED: '1' } })
    const seen = readFileSync(r.outputs['env.txt'] as string, 'utf8')
    for (const k of Object.keys(SECRETS)) expect(seen, k).not.toMatch(new RegExp(`^${k}=`, 'm'))
    expect(seen).toMatch(/^PATH=/m)
    expect(seen).toMatch(/^PYTHONUNBUFFERED=1$/m)
    // a job that is not isolated still gets the environment, as before
    const k = await runLocal({ kind: 'kicad', argv: ['sh', '-c', 'env > "$0"', '{out:env.txt}'], outputs: ['env.txt'], timeoutSeconds: 10 })
    expect(readFileSync(k.outputs['env.txt'] as string, 'utf8')).toMatch(/^TRACE_TOKEN=t$/m)
  })

  it('leaves nothing running: a background child is killed with the job', async () => {
    const r = await runLocal({ kind: 'cad', argv: ['sh', '-c', 'sleep 30 & echo $! > "$0"', '{out:pid}'], outputs: ['pid'], timeoutSeconds: 10 })
    expect(r.exitCode).toBe(0)
    expect(r.seconds).toBeLessThan(10)
    const pid = Number(readFileSync(r.outputs.pid as string, 'utf8').trim())
    expect(pid).toBeGreaterThan(0)
    await new Promise((res) => setTimeout(res, 100))
    expect(alive(pid)).toBe(false)
  })

  it('kills the whole group at the time limit', async () => {
    const r = await runLocal({ kind: 'cad', argv: ['sh', '-c', 'sleep 60 & echo $! > "$0"; wait', '{out:pid}'], outputs: ['pid'], timeoutSeconds: 10 })
    expect(r.exitCode).not.toBe(0)
    const pid = Number(readFileSync(r.outputs.pid as string, 'utf8').trim())
    await new Promise((res) => setTimeout(res, 100))
    expect(alive(pid)).toBe(false)
  }, 20_000)
})

describe('an isolated job on the function (the runner)', () => {
  it('runs with no credentials, its HOME in the job folder, and its background children killed', async () => {
    withSecrets()
    const s3 = new FakeS3()
    const job = GpuJobSchema.parse({ kind: 'cad', argv: ['sh', '-c', 'env > "$0"; sleep 30 & echo $! > "$1"', '{out:env.txt}', '{out:pid}'], outputs: ['env.txt', 'pid'], timeoutSeconds: 10 })
    const st = await stageJob(job, { env: { TRACE_GPU_BUCKET: 'bkt' }, s3, now: Date.now() })
    const code = await main({ s3, env: { TRACE_GPU_JOB_URI: st.specUri }, echo: false })
    expect(code).toBe(0)
    const seen = new TextDecoder().decode(s3.objects.get(`bkt/jobs/_local/${st.keys.output('env.txt')}`)?.body)
    for (const k of Object.keys(SECRETS)) expect(seen, k).not.toMatch(new RegExp(`^${k}=`, 'm'))
    expect(seen).toMatch(/^HOME=.*\/home$/m)
    expect(seen).toMatch(/^TMPDIR=.*\/home\/tmp$/m)
    const pid = Number(new TextDecoder().decode(s3.objects.get(`bkt/jobs/_local/${st.keys.output('pid')}`)?.body).trim())
    await new Promise((res) => setTimeout(res, 100))
    expect(alive(pid)).toBe(false)
  })
})
