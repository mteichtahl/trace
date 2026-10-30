/**
 * The case script's own job kind (docs/enclosure-build.md "Trust"): `cad-script` runs the project's case script on the
 * cad function (TRACE_CAD_FUNCTION) or locally, never on the queue or the tools function, and `cad` (trace's code) runs
 * as before. Here: where each kind runs, the defaults, and the outputs a script job hands back.
 */
import { describe, expect, it } from 'vitest'
import { CAD_SCRIPT_OUTPUTS, FUNCTION_KINDS, GpuJobSchema, ISOLATED_KINDS, NO_CAD_FUNCTION, backendFor, runJob } from '../../src/gpu/jobs.js'

describe('the cad-script job kind', () => {
  const at = (e: Record<string, string>, j: Parameters<typeof backendFor>[0]) => backendFor(j, { TRACE_GPU: '0', ...e })

  it('is not one the tools function runs, and is isolated by default, as cad is', () => {
    expect(FUNCTION_KINDS.has('cad-script')).toBe(false)
    expect(FUNCTION_KINDS.has('cad')).toBe(true)
    expect(ISOLATED_KINDS.has('cad-script')).toBe(true)
    expect(GpuJobSchema.parse({ kind: 'cad-script', argv: ['x'] }).isolate).toBe(true)
    expect(GpuJobSchema.parse({ kind: 'cad', argv: ['x'] }).isolate).toBe(true)
    expect(GpuJobSchema.parse({ kind: 'cad-script', argv: ['x'], isolate: false }).isolate).toBe(false)
  })

  it('runs on the cad function when the project has one, else here; never the queue or the tools function', () => {
    expect(at({ TRACE_CAD_FUNCTION: 'trace-cad-x', TRACE_TOOLS_FUNCTION: 'trace-tools-x' }, { kind: 'cad-script' })).toBe('function')
    expect(at({ TRACE_CAD_FUNCTION: 'trace-cad-x' }, { kind: 'cad-script' })).toBe('function')
    // the tools function alone does not take it: it holds credentials
    expect(at({ TRACE_TOOLS_FUNCTION: 'trace-tools-x' }, { kind: 'cad-script' })).toBe('local')
    expect(at({}, { kind: 'cad-script' })).toBe('local')
    // no queue, whatever the settings say
    expect(at({ TRACE_GPU_QUEUE: 'q', TRACE_GPU_REMOTE: 'always' }, { kind: 'cad-script' })).toBe('local')
    expect(at({ TRACE_GPU_QUEUE: 'q', TRACE_TOOLS_ELSEWHERE: '1' }, { kind: 'cad-script' })).toBe('local')
    expect(at({ TRACE_GPU_QUEUE: 'q' }, { kind: 'cad-script', remote: true })).toBe('local')
    expect(at({ TRACE_CAD_FUNCTION: 'f', TRACE_GPU_REMOTE: 'never' }, { kind: 'cad-script' })).toBe('local')
    // cad is unchanged: the tools function, or the queue from the agent image
    expect(at({ TRACE_TOOLS_FUNCTION: 'trace-tools-x', TRACE_CAD_FUNCTION: 'trace-cad-x' }, { kind: 'cad' })).toBe('function')
    expect(at({ TRACE_GPU_QUEUE: 'q', TRACE_TOOLS_ELSEWHERE: '1' }, { kind: 'cad' })).toBe('batch')
  })

  it('refuses to run on the agent image without a cad function (the flat layout), saying where a script builds', async () => {
    const saved = { ...process.env }
    try {
      process.env.TRACE_TOOLS_ELSEWHERE = '1'
      process.env.TRACE_GPU_QUEUE = 'q'
      delete process.env.TRACE_CAD_FUNCTION
      await expect(runJob({ kind: 'cad-script', argv: ['true'], timeoutSeconds: 10 })).rejects.toThrow(NO_CAD_FUNCTION)
      expect(NO_CAD_FUNCTION).toMatch(/cad function \(nested layout\) or on a laptop/)
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })

  it('hands back one STEP per part and claims.json', () => {
    expect(CAD_SCRIPT_OUTPUTS.at(-1)).toBe('claims.json')
    expect(CAD_SCRIPT_OUTPUTS[0]).toBe('part-1.step')
    expect(CAD_SCRIPT_OUTPUTS).toContain('part-16.step')
    expect(CAD_SCRIPT_OUTPUTS).not.toContain('part-0.step')
    expect(CAD_SCRIPT_OUTPUTS.filter((n) => n.endsWith('.step'))).toHaveLength(16)
    // names the remote spec and the staging accept
    expect(GpuJobSchema.parse({ kind: 'cad-script', argv: ['x'], outputs: [...CAD_SCRIPT_OUTPUTS] }).outputs).toHaveLength(17)
  })
})

// ------------------------------------------------------------------ the transport: presigned URLs

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSpec, jobKeys, type RemoteSpec } from '../../src/gpu/protocol.js'
import { main } from '../../src/gpu/runner.js'
import { type FetchLike, JobUrlsSchema, UrlStore, type JobUrls } from '../../src/gpu/urls.js'

/** A bucket behind URLs: GET and PUT by URL, recording each request's method and headers. */
export class FakeUrls {
  readonly objects = new Map<string, Uint8Array>()
  readonly requests: { method: string; url: string; headers: Record<string, string> }[] = []
  readonly fetch: FetchLike = async (url, init) => {
    this.requests.push({ method: init.method, url, headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) })
    const u = new URL(url)
    if (u.searchParams.get('X-Amz-Expires') === '0') return reply(403, new Uint8Array())
    const k = `${u.host}${u.pathname}`
    if (init.method === 'PUT') {
      if (u.searchParams.get('verb') !== 'put') return reply(403, new Uint8Array())
      this.objects.set(k, new Uint8Array(init.body ?? new Uint8Array()))
      return reply(200, new Uint8Array())
    }
    if (u.searchParams.get('verb') !== 'get') return reply(403, new Uint8Array())
    const b = this.objects.get(k)
    return b ? reply(200, b) : reply(404, new Uint8Array())
  }
  /** `urls` for a job as the worker would sign them, against this bucket */
  urlsFor(id: string, inputs: string[], outputs: string[]): JobUrls {
    const k = jobKeys(id)
    const url = (key: string, verb: 'get' | 'put') => `https://bucket.s3.amazonaws.com/jobs/acme/board/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&verb=${verb}`
    return JobUrlsSchema.parse({
      spec: url(k.spec, 'get'), inputs: Object.fromEntries(inputs.map((n) => [n, url(k.input(n), 'get')])),
      outputs: Object.fromEntries(outputs.map((n) => [n, url(k.output(n), 'put')])), stdout: url(k.stdout, 'put'), stderr: url(k.stderr, 'put'), exit: url(k.exit, 'put'),
    })
  }
  key = (id: string, key: string) => `bucket.s3.amazonaws.com/jobs/acme/board/${key}`
}
const reply = (status: number, body: Uint8Array) => ({ status, ok: status >= 200 && status < 300, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, headers: { get: () => null } })

const scriptSpec = (id: string, argv: string[], inputs: string[], outputs: string[]): RemoteSpec => ({
  v: 1, id, bucket: 'bucket', prefix: 'jobs/acme/board', kind: 'cad-script', argv, inputs, outputs, env: {}, gpu: false, timeoutSeconds: 30, isolate: true,
})

describe('the URL store', () => {
  it('maps the job\'s keys to its URLs, GETs (404 is null) and PUTs with no content-type header, and knows no other key', async () => {
    const f = new FakeUrls()
    const id = 'cad-script-1'
    const st = new UrlStore(id, f.urlsFor(id, ['facts.json', 'missing.json'], ['claims.json']), f.fetch)
    const k = jobKeys(id)
    f.objects.set(f.key(id, k.input('facts.json')), new TextEncoder().encode('{"v":1}'))
    expect(new TextDecoder().decode((await st.get(k.input('facts.json')))?.body)).toBe('{"v":1}')
    expect(await st.get(k.input('missing.json'))).toBeNull()
    // an output's URL is signed for PUT only: a read through it is refused, and the runner never makes one
    await expect(st.get(k.output('claims.json'))).rejects.toThrow(/HTTP 403/)
    await st.put(k.output('claims.json'), new TextEncoder().encode('{}'), { contentType: 'application/json' })
    await st.put(k.exit, new TextEncoder().encode('{"exitCode":0}'), { contentType: 'application/json' })
    expect(new TextDecoder().decode(f.objects.get(f.key(id, k.exit)))).toBe('{"exitCode":0}')
    const puts = f.requests.filter((r) => r.method === 'PUT')
    expect(puts).toHaveLength(2)
    for (const r of puts) expect(Object.keys(r.headers)).toEqual([])
    await expect(st.get(k.input('other.json'))).rejects.toThrow(/not one of this job's URLs/)
    await expect(st.get('cache/w1/abcd')).rejects.toThrow(/not one of this job's URLs/)
    await expect(st.put(k.input('facts.json'), new Uint8Array())).rejects.toThrow(/HTTP 403/)
    expect(st.url).toBe(`urls:${id}`)
  })

  it('validates the event\'s urls: https, named inputs and outputs, every field', () => {
    const f = new FakeUrls()
    const good = f.urlsFor('cad-script-2', ['a/b.json'], ['part-1.step'])
    expect(JobUrlsSchema.safeParse(good).success).toBe(true)
    expect(JobUrlsSchema.safeParse({ ...good, spec: 'http://x/y' }).success).toBe(false)
    expect(JobUrlsSchema.safeParse({ ...good, inputs: { '../x': good.spec } }).success).toBe(false)
    expect(JobUrlsSchema.safeParse({ ...good, outputs: { 'a/b': good.spec } }).success).toBe(false)
    const { exit: _e, ...noExit } = good
    expect(JobUrlsSchema.safeParse(noExit).success).toBe(false)
    expect(JobUrlsSchema.safeParse({ ...good, extra: 1 }).success).toBe(false)
  })

  it('carries a whole job through the runner: inputs in, program run isolated, outputs, logs and exit record out', async () => {
    const f = new FakeUrls()
    const id = 'cad-script-3'
    const k = jobKeys(id)
    const spec = scriptSpec(id, ['sh', '-c', 'cat "$0" > "$1"; echo built; echo note >&2; env | grep -c AWS_ || true', '{in:case.py}', '{out:part-1.step}'], ['case.py'], ['part-1.step', 'part-2.step', 'claims.json'])
    f.objects.set(f.key(id, k.spec), new TextEncoder().encode(encodeSpec(spec)))
    f.objects.set(f.key(id, k.input('case.py')), new TextEncoder().encode('def build(b, s): ...'))
    const urls = f.urlsFor(id, ['case.py'], ['part-1.step', 'part-2.step', 'claims.json'])
    expect((await UrlStore.readSpec(urls, f.fetch)).id).toBe(id)
    const store = new UrlStore(id, urls, f.fetch)
    const code = await main({ store, env: { ...process.env, AWS_SECRET_ACCESS_KEY: 'never-seen' }, workRoot: mkdtempSync(join(tmpdir(), 'url-run-')), echo: false }, spec)
    expect(code).toBe(0)
    expect(new TextDecoder().decode(f.objects.get(f.key(id, k.output('part-1.step'))))).toBe('def build(b, s): ...')
    expect(f.objects.has(f.key(id, k.output('part-2.step')))).toBe(false)
    expect(new TextDecoder().decode(f.objects.get(f.key(id, k.stdout)))).toBe('built\n0\n')
    expect(new TextDecoder().decode(f.objects.get(f.key(id, k.stderr)))).toBe('note\n')
    expect(JSON.parse(new TextDecoder().decode(f.objects.get(f.key(id, k.exit))))).toMatchObject({ exitCode: 0, outputs: ['part-1.step'] })
    // nothing reached any URL but the job's own
    for (const r of f.requests) expect(r.url).toContain(`/jobs/acme/board/${id}/`)
    // without the spec given, a URL store cannot be run
    await expect(main({ store, echo: false })).rejects.toThrow(/needs the spec given/)
  })
})

// ------------------------------------------------------------------ the handler: two events, two functions

import { handle } from '../../src/gpu/lambda.js'
import { observedMain } from '../../src/gpu/runner.js'

describe('the function handler', () => {
  const cadEnv = { TRACE_CAD_FUNCTION_ROLE: '1', TRACE_PROJECT: 'acme/board' }

  it('runs a urls event on a URL store, with the event\'s traceparent and no S3 address in the environment', async () => {
    const f = new FakeUrls()
    const id = 'cad-script-4'
    const k = jobKeys(id)
    const spec = scriptSpec(id, ['sh', '-c', 'echo "$TRACEPARENT" > "$0"; echo "${TRACE_GPU_JOB_URI:-unset}"', '{out:claims.json}'], [], ['claims.json'])
    f.objects.set(f.key(id, k.spec), new TextEncoder().encode(encodeSpec(spec)))
    const urls = f.urlsFor(id, [], ['claims.json'])
    let seen: Record<string, unknown> = {}
    const reply = await handle({ urls, traceparent: '00-abc-def-01' }, {
      env: cadEnv, fetch: f.fetch, workRoot: mkdtempSync(join(tmpdir(), 'h-')),
      run: (deps = {}, given) => { seen = { env: deps.env, store: deps.store?.url, given: given?.id }; return observedMain({ ...deps, echo: false }, given) },
    })
    expect(reply).toEqual({ exitCode: 0 })
    expect(seen.store).toBe(`urls:${id}`)
    expect(seen.given).toBe(id)
    expect((seen.env as NodeJS.ProcessEnv).TRACEPARENT).toBe('00-abc-def-01')
    expect((seen.env as NodeJS.ProcessEnv).TRACE_GPU_JOB_URI).toBeUndefined()
    // the isolated program saw no trace context either: isolatedEnv keeps TRACEPARENT out
    expect(new TextDecoder().decode(f.objects.get(f.key(id, k.output('claims.json'))))).toBe('\n')
    expect(new TextDecoder().decode(f.objects.get(f.key(id, k.stdout)))).toBe('unset\n')
  })

  it('refuses invalid urls, a urls event whose spec is not a case script, and on the cad function any spec event', async () => {
    const f = new FakeUrls()
    const id = 'cad-5'
    const k = jobKeys(id)
    f.objects.set(f.key(id, k.spec), new TextEncoder().encode(encodeSpec({ ...scriptSpec(id, ['true'], [], []), kind: 'cad' })))
    const urls = f.urlsFor(id, [], [])
    const run = () => { throw new Error('must not run') }
    await expect(handle({ urls }, { env: cadEnv, fetch: f.fetch, run })).rejects.toThrow(/kind cad-script\), not cad/)
    await expect(handle({ urls: { ...urls, exit: 'ftp://x' } }, { env: cadEnv, fetch: f.fetch, run })).rejects.toThrow(/urls are invalid: exit/)
    await expect(handle({ urls: 'nope' }, { env: cadEnv, fetch: f.fetch, run })).rejects.toThrow(/urls are invalid/)
    await expect(handle({ spec: 's3://bucket/jobs/acme/board/x/spec' }, { env: cadEnv, run })).rejects.toThrow(/cad function runs case scripts through URLs only/)
    await expect(handle({}, { env: cadEnv, run })).rejects.toThrow(/names no job spec/)
    // the tools function (no role flag) still takes a spec event, as before
    let got: string | undefined
    await handle({ spec: 's3://bucket/jobs/acme/board/x/spec' }, { env: { TRACE_PROJECT: 'acme/board' }, run: async (deps = {}) => { got = deps.env?.TRACE_GPU_JOB_URI; return 0 } })
    expect(got).toBe('s3://bucket/jobs/acme/board/x/spec')
  })
})

// ------------------------------------------------------------------ the worker's side: stage, sign, invoke, read back

import { type FunctionApi, type Presigner, runFunction, signJobUrls } from '../../src/gpu/function.js'
import { GpuJobSchema as Schema } from '../../src/gpu/jobs.js'
import { stageJob } from '../../src/gpu/staging.js'
import { FakeS3 } from '../core/fake-s3.js'

/** URLs that name the bucket, key and verb, and a fetch that serves them from the FakeS3 as S3 would. */
function urlBridge(s3: FakeS3): { presign: Presigner; fetch: FetchLike; signed: { key: string; method: string; expiresIn: number }[] } {
  const signed: { key: string; method: string; expiresIn: number }[] = []
  return {
    signed,
    presign: { sign: async (i) => { signed.push({ key: i.key, method: i.method, expiresIn: i.expiresIn }); return `https://${i.bucket}.s3.test/${i.key}?X-Amz-Expires=${i.expiresIn}&m=${i.method}` } },
    fetch: async (url, init) => {
      const u = new URL(url)
      const Bucket = u.host.split('.')[0] as string
      const Key = u.pathname.slice(1)
      if (u.searchParams.get('m') !== init.method) return reply(403, new Uint8Array())
      if (init.method === 'PUT') {
        if (init.headers && Object.keys(init.headers).length) return reply(403, new Uint8Array())
        await s3.putObject({ Bucket, Key, Body: init.body ?? new Uint8Array() })
        return reply(200, new Uint8Array())
      }
      try {
        return reply(200, (await s3.getObject({ Bucket, Key })).Body)
      } catch {
        return reply(404, new Uint8Array())
      }
    },
  }
}

const workerEnv = { TRACE_CAD_FUNCTION: 'trace-cad-0123abcd', TRACE_TOOLS_FUNCTION: 'trace-tools-0123abcd', TRACE_GPU_BUCKET: 'central-bucket', TRACE_PROJECT: 'Acme/Board', TRACE_CAD_FUNCTION_MEMORY_MB: '3072' }

describe('a case script on the cad function', () => {
  const scriptJob = (over: Record<string, unknown> = {}) => {
    const d = mkdtempSync(join(tmpdir(), 'cad-in-'))
    writeFileSync(join(d, 'case.py'), 'def build(board, settings): ...')
    writeFileSync(join(d, 'facts.json'), '{"version":1}')
    return Schema.parse({
      kind: 'cad-script', timeoutSeconds: 60,
      argv: ['sh', '-c', 'cat "$0" > "$1"; echo "{\\"parts\\":[]}" > "$2"; echo built; env | grep -c "AWS_\\|TRACE_" || true', '{in:case.py}', '{out:part-1.step}', '{out:claims.json}'],
      inputs: { 'case.py': join(d, 'case.py'), 'facts.json': join(d, 'facts.json') }, outputs: ['part-1.step', 'part-2.step', 'claims.json'], ...over,
    })
  }

  it('stages it, signs a URL per file, invokes the cad function with urls only, and reads the results back from S3', async () => {
    const s3 = new FakeS3()
    const bridge = urlBridge(s3)
    const calls: { FunctionName: string; event: Record<string, unknown> }[] = []
    const lambda: FunctionApi = {
      invoke: async (i) => {
        const event = JSON.parse(new TextDecoder().decode(i.Payload)) as Record<string, unknown>
        calls.push({ FunctionName: i.FunctionName, event })
        // the cad function: no S3 client, the role flag set, a fetch of its own
        const reply = await handle(event, { env: { TRACE_CAD_FUNCTION_ROLE: '1', TRACE_PROJECT: 'acme/board' }, fetch: bridge.fetch, run: (deps = {}, given) => observedMain({ ...deps, echo: false }, given) })
        return { StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify(reply)), $metadata: { requestId: 'req-cad' } }
      },
    }
    const rows: Record<string, unknown>[] = []
    const r = await runFunction(scriptJob(), { lambda, s3, presign: bridge.presign, env: workerEnv, recordCost: async (x) => { rows.push(x as unknown as Record<string, unknown>) } })
    expect(r).toMatchObject({ exitCode: 0, where: 'function', jobId: 'req-cad' })
    expect(readFileSync(r.outputs['part-1.step'] as string, 'utf8')).toBe('def build(board, settings): ...')
    expect(readFileSync(r.outputs['claims.json'] as string, 'utf8')).toBe('{"parts":[]}\n')
    expect(r.outputs['part-2.step']).toBeUndefined()
    // the isolated script saw no credentials and no trace settings
    expect(r.stdout).toBe('built\n0\n')
    // the event: the cad function's name, urls and nothing else (no spec, no S3 address)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.FunctionName).toBe('trace-cad-0123abcd')
    expect(Object.keys(calls[0]?.event ?? {})).toEqual(['urls'])
    const urls = calls[0]?.event.urls as JobUrls
    expect(Object.keys(urls).sort()).toEqual(['exit', 'inputs', 'outputs', 'spec', 'stderr', 'stdout'])
    expect(Object.keys(urls.inputs).sort()).toEqual(['case.py', 'facts.json'])
    expect(Object.keys(urls.outputs).sort()).toEqual(['claims.json', 'part-1.step', 'part-2.step'])
    for (const u of [urls.spec, ...Object.values(urls.inputs)]) expect(u).toMatch(/m=GET$/)
    for (const u of [urls.stdout, urls.stderr, urls.exit, ...Object.values(urls.outputs)]) expect(u).toMatch(/m=PUT$/)
    expect(urls.spec).toMatch(/^https:\/\/central-bucket\.s3\.test\/jobs\/acme\/board\/cad-script-[\w-]+\/spec\?X-Amz-Expires=1200&m=GET$/)
    // every URL is 20 minutes, and every one is under the job's own prefix
    expect(bridge.signed).toHaveLength(9)
    for (const x of bridge.signed) {
      expect(x.expiresIn).toBe(1200)
      expect(x.key).toMatch(/^jobs\/acme\/board\/cad-script-[\w-]+\//)
    }
    // the spec in S3 is a cad-script spec with no shared inputs
    const key = [...s3.objects.keys()].find((k) => k.endsWith('/spec')) as string
    const spec = decodeSpecOf(s3, key)
    expect(spec.kind).toBe('cad-script')
    expect(spec.shared).toBeUndefined()
    expect(spec.isolate).toBe(true)
    // the call's cost row: priced with the cad function's memory
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'tools', agent: 'cad-script', memoryMb: 3072 })
  })

  it('needs the cad function, reports a function error with the script\'s stderr, and never takes another kind', async () => {
    const s3 = new FakeS3()
    const bridge = urlBridge(s3)
    const { TRACE_CAD_FUNCTION: _f, ...noCad } = workerEnv
    await expect(runFunction(scriptJob(), { lambda: { invoke: async () => ({}) }, s3, presign: bridge.presign, env: noCad })).rejects.toThrow(/TRACE_CAD_FUNCTION/)
    const failing: FunctionApi = { invoke: async () => ({ StatusCode: 200, FunctionError: 'Unhandled', Payload: new TextEncoder().encode(JSON.stringify({ errorType: 'Error', errorMessage: 'the cad function runs case scripts through URLs only' })), $metadata: { requestId: 'r' } }) }
    await expect(runFunction(scriptJob(), { lambda: failing, s3, presign: bridge.presign, env: workerEnv, recordCost: async () => undefined })).rejects.toThrow(/the cad function could not run cad-script-.*through URLs only/)
    const { runCadScript } = await import('../../src/gpu/function.js')
    await expect(runCadScript(Schema.parse({ kind: 'cad', argv: ['true'] }), { lambda: failing, s3, presign: bridge.presign, env: workerEnv })).rejects.toThrow(/case scripts only, not a cad job/)
  })

  it('signJobUrls: the keys under the bucket prefix, GET for what goes in and PUT for what comes out', async () => {
    const s3 = new FakeS3()
    const bridge = urlBridge(s3)
    const job = scriptJob()
    const staged = await stageJob(job, { env: workerEnv, s3, now: Date.now() })
    const urls = await signJobUrls(staged, job, bridge.presign, 60)
    expect(urls.inputs['case.py']).toBe(`https://central-bucket.s3.test/jobs/acme/board/${staged.id}/in/case.py?X-Amz-Expires=60&m=GET`)
    expect(urls.outputs['claims.json']).toBe(`https://central-bucket.s3.test/jobs/acme/board/${staged.id}/out/claims.json?X-Amz-Expires=60&m=PUT`)
    expect(urls.exit).toBe(`https://central-bucket.s3.test/jobs/acme/board/${staged.id}/exit?X-Amz-Expires=60&m=PUT`)
    expect(JobUrlsSchema.safeParse(urls).success).toBe(true)
  })
})

const decodeSpecOf = (s3: FakeS3, key: string): RemoteSpec => JSON.parse(new TextDecoder().decode(s3.objects.get(key)?.body)) as RemoteSpec
