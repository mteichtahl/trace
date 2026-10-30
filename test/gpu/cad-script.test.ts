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

import { mkdtempSync, writeFileSync } from 'node:fs'
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
