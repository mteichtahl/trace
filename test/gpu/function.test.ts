/**
 * The tools function (src/gpu/function.ts, src/gpu/lambda.ts): where a job runs (backendFor), a job sent to the
 * function and back (a fake Lambda that runs the real runner against a fake S3, as a real invocation would), and the
 * custom runtime's loop against a fake Lambda Runtime API.
 */
import { createServer, type IncomingMessage } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runFunction, functionErrorMessage, type FunctionApi, type FunctionEvent } from '../../src/gpu/function.js'
import { FUNCTION_KINDS, FUNCTION_MAX_SECONDS, GpuJobSchema, backendFor } from '../../src/gpu/jobs.js'
import { handle, serve } from '../../src/gpu/lambda.js'
import { decodeSpec } from '../../src/gpu/protocol.js'
import { main, observedMain } from '../../src/gpu/runner.js'
import { FakeS3 } from '../core/fake-s3.js'

const FN = 'trace-tools-0123abcd'
const env = { TRACE_TOOLS_FUNCTION: FN, TRACE_GPU_BUCKET: 'central-bucket', TRACE_PROJECT: 'Acme/Board' }

describe('where a job runs', () => {
  const at = (e: Record<string, string>, j: Parameters<typeof backendFor>[0]) => backendFor(j, { TRACE_GPU: '0', ...e })
  it('on the tools function for the kinds it has, when the project has one', () => {
    for (const kind of ['kicad', 'ffmpeg', 'verilator', 'cocotb', 'formal', 'yosys', 'nextpnr', 'fpga-pack', 'calculix', 'cad'] as const) {
      expect(at(env, { kind, gpu: false })).toBe('function')
    }
    // a render with no GPU queue renders on its CPU; with one, on the queue
    expect(at(env, { kind: 'blender', gpu: true })).toBe('function')
    expect(at({ ...env, TRACE_GPU_QUEUE: 'q' }, { kind: 'blender', gpu: true })).toBe('batch')
    // a job marked remote (too big for here, or for the function's time limit) goes to the queue when there is one…
    expect(at({ ...env, TRACE_GPU_QUEUE: 'q' }, { kind: 'calculix', gpu: false, remote: true })).toBe('batch')
    // …and to the function, within its limit, when there is none
    expect(at(env, { kind: 'calculix', gpu: false, remote: true })).toBe('function')
    // kinds the tools image does not have stay where they were
    expect(at(env, { kind: 'openems', gpu: false })).toBe('local')
    expect(at(env, { kind: 'thermal', gpu: false, remote: true })).toBe('local')
    expect(at({ ...env, TRACE_GPU_QUEUE: 'q' }, { kind: 'freerouting', gpu: true })).toBe('batch')
    expect(FUNCTION_KINDS.has('openems')).toBe(false)
  })
  it('here on a laptop (no function), with a GPU of its own, or when told so', () => {
    expect(at({}, { kind: 'kicad', gpu: false })).toBe('local')
    expect(at({}, { kind: 'blender', gpu: true })).toBe('local')
    expect(backendFor({ kind: 'blender', gpu: true }, { ...env, TRACE_GPU: '1' })).toBe('local')
    expect(at({ ...env, TRACE_GPU_REMOTE: 'never' }, { kind: 'kicad' })).toBe('local')
    expect(at({ ...env, TRACE_GPU_QUEUE: 'q', TRACE_GPU_REMOTE: 'always' }, { kind: 'kicad' })).toBe('batch')
    // "always" with no queue: as before, not the queue
    expect(at({ ...env, TRACE_GPU_REMOTE: 'always' }, { kind: 'kicad' })).toBe('function')
    // the agent image (none of the tools) in a project without the function: the queue's image has them
    expect(at({ TRACE_TOOLS_ELSEWHERE: '1', TRACE_GPU_QUEUE: 'q' }, { kind: 'kicad' })).toBe('batch')
    expect(at({ TRACE_TOOLS_ELSEWHERE: '1', TRACE_GPU_QUEUE: 'q' }, { kind: 'openems' })).toBe('local')
    expect(at({ TRACE_TOOLS_ELSEWHERE: '1' }, { kind: 'kicad' })).toBe('local')
  })
})

/** A Lambda whose invocation runs the real runner on the event's spec, against the same fake S3. */
class FakeLambda implements FunctionApi {
  calls: { FunctionName: string; event: FunctionEvent }[] = []
  constructor(private readonly s3: FakeS3, private readonly fail?: string) {}
  async invoke(i: { FunctionName: string; Payload: Uint8Array }) {
    const event = JSON.parse(new TextDecoder().decode(i.Payload)) as FunctionEvent
    this.calls.push({ FunctionName: i.FunctionName, event })
    if (this.fail) return { StatusCode: 200, FunctionError: 'Unhandled', Payload: new TextEncoder().encode(JSON.stringify({ errorType: 'Error', errorMessage: this.fail })), $metadata: { requestId: 'req-1' } }
    const exitCode = await main({ s3: this.s3, env: { TRACE_GPU_JOB_URI: event.spec }, echo: false })
    return { StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify({ exitCode })), $metadata: { requestId: 'req-1' } }
  }
}

const job = (over: Record<string, unknown> = {}) => {
  const d = mkdtempSync(join(tmpdir(), 'fn-in-'))
  writeFileSync(join(d, 'a.txt'), 'hello function')
  return GpuJobSchema.parse({
    kind: 'kicad', timeoutSeconds: 60,
    argv: ['sh', '-c', 'cat "$0" > "$1"; echo made; echo warn >&2', '{in:a.txt}', '{out:b.txt}'],
    inputs: { 'a.txt': join(d, 'a.txt') }, outputs: ['b.txt', 'never.txt'], ...over,
  })
}

describe('a job on the tools function', () => {
  it('stages it in the project\'s prefix, invokes the project\'s function once, and brings the outputs back', async () => {
    const s3 = new FakeS3()
    const lambda = new FakeLambda(s3)
    const r = await runFunction(job(), { lambda, s3, env })
    expect(r).toMatchObject({ exitCode: 0, where: 'function', jobId: 'req-1' })
    expect(readFileSync(r.outputs['b.txt'] as string, 'utf8')).toBe('hello function')
    expect(r.outputs['never.txt']).toBeUndefined()
    expect(r.stdout).toBe('made\n')
    expect(r.stderr).toBe('warn\n')
    expect(lambda.calls).toHaveLength(1)
    expect(lambda.calls[0]?.FunctionName).toBe(FN)
    // the event names only the spec, which is in the project's own prefix
    expect(Object.keys(lambda.calls[0]?.event ?? {})).toEqual(['spec'])
    expect(lambda.calls[0]?.event.spec).toMatch(/^s3:\/\/central-bucket\/jobs\/acme\/board\/kicad-[\w-]+\/spec$/)
  })

  it('limits a job to the function\'s time, and says so', async () => {
    const s3 = new FakeS3()
    const lines: string[] = []
    await runFunction(job({ timeoutSeconds: 3600 }), { lambda: new FakeLambda(s3), s3, env, log: (l) => lines.push(l) })
    const key = [...s3.objects.keys()].find((k) => k.endsWith('/spec')) as string
    expect(decodeSpec(new TextDecoder().decode(s3.objects.get(key)?.body)).timeoutSeconds).toBe(FUNCTION_MAX_SECONDS)
    expect(lines.join('\n')).toMatch(new RegExp(`at most ${FUNCTION_MAX_SECONDS} s.*asked for 3600 s`))
  })

  it('reports a function that could not run the job, and a program that is not in the image', async () => {
    const s3 = new FakeS3()
    await expect(runFunction(job(), { lambda: new FakeLambda(s3, 'the event names no job spec'), s3, env })).rejects.toThrow(/could not run kicad-.*Error: the event names no job spec/)
    await expect(runFunction(job({ argv: ['no-such-program-here'] }), { lambda: new FakeLambda(s3), s3, env })).rejects.toThrow(/no-such-program-here is not installed/)
    await expect(runFunction(job(), { lambda: new FakeLambda(s3), s3, env: { TRACE_GPU_BUCKET: 'b' } })).rejects.toThrow(/TRACE_TOOLS_FUNCTION/)
    expect(functionErrorMessage(new TextEncoder().encode('{"errorType":"Runtime.ExitError","errorMessage":"exited"}'))).toBe('Runtime.ExitError: exited')
    expect(functionErrorMessage(new TextEncoder().encode('plain'))).toBe('plain')
  })
})

/** A Lambda Runtime API serving `events`, recording the replies. */
async function fakeRuntimeApi(events: unknown[]): Promise<{ api: string; replies: { path: string; body: string; headers: IncomingMessage['headers'] }[]; close: () => void }> {
  const replies: { path: string; body: string; headers: IncomingMessage['headers'] }[] = []
  let n = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString() })
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/2018-06-01/runtime/invocation/next') {
        const ev = events[n++]
        res.writeHead(200, { 'lambda-runtime-aws-request-id': `req-${n}`, 'content-type': 'application/json' })
        return res.end(JSON.stringify(ev))
      }
      replies.push({ path: req.url ?? '', body, headers: req.headers })
      res.writeHead(202).end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  return { api: `127.0.0.1:${port}`, replies, close: () => server.close() }
}

describe('the tools function\'s runtime', () => {
  it('runs each event\'s job with the runner and replies with its exit code, or an error when it names no job', async () => {
    const s3 = new FakeS3()
    // a staged job, as runFunction leaves it
    const staged = await import('../../src/gpu/staging.js').then((m) => m.stageJob(job(), { env, s3, now: Date.now() }))
    const rt = await fakeRuntimeApi([{ spec: staged.specUri }, { nothing: true }])
    try {
      await serve({ api: rt.api, max: 2, handler: (ev) => handle(ev, { run: (deps) => observedMain({ ...deps, s3, echo: false }) }) })
    } finally {
      rt.close()
    }
    expect(rt.replies.map((r) => r.path)).toEqual(['/2018-06-01/runtime/invocation/req-1/response', '/2018-06-01/runtime/invocation/req-2/error'])
    expect(JSON.parse(rt.replies[0]?.body ?? '')).toEqual({ exitCode: 0 })
    expect(JSON.parse(rt.replies[1]?.body ?? '')).toMatchObject({ errorMessage: expect.stringMatching(/names no job spec/) })
    expect(rt.replies[1]?.headers['lambda-runtime-function-error-type']).toBe('Runtime.HandlerError')
    // the job's output is in S3, where runFunction reads it
    expect([...s3.objects.keys()].some((k) => k.endsWith(`${staged.id}/out/b.txt`))).toBe(true)
  })
})

describe('what a call on the tools function cost', () => {
  it('is read from Lambda\'s REPORT line, else from the call\'s own time, and recorded once per call', async () => {
    const { billedFromLog, functionCostRow } = await import('../../src/gpu/function.js')
    const { DEFAULT_PRICES } = await import('../../src/core/prices.js')
    const tail = 'START RequestId: x\nmade\nEND RequestId: x\nREPORT RequestId: x\tDuration: 2190.32 ms\tBilled Duration: 7311 ms\tMemory Size: 4096 MB\tMax Memory Used: 600 MB\tInit Duration: 5120.01 ms\n'
    expect(billedFromLog(tail)).toEqual({ seconds: 7.311, memoryMb: 4096 })
    expect(billedFromLog('no report')).toBeNull()
    const r = functionCostRow({ tail: '', wallSeconds: 9, id: 'kicad-1', kind: 'kicad', env: { TRACE_TOOLS_FUNCTION_MEMORY_MB: '2048' }, at: 1, prices: DEFAULT_PRICES })
    expect(r).toMatchObject({ kind: 'tools', seconds: 9, memoryMb: 2048 })
    // runFunction records the call's row, even for a job that failed
    const s3 = new FakeS3()
    const rows: unknown[] = []
    const lambda = new FakeLambda(s3)
    const orig = lambda.invoke.bind(lambda)
    lambda.invoke = async (i) => ({ ...(await orig(i)), LogResult: Buffer.from(tail).toString('base64') })
    await runFunction(job(), { lambda, s3, env, prices: DEFAULT_PRICES, recordCost: async (x) => { rows.push(x) } })
    await runFunction(job({ argv: ['sh', '-c', 'exit 3'] }), { lambda, s3, env, prices: DEFAULT_PRICES, recordCost: async (x) => { rows.push(x) } })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ kind: 'tools', agent: 'kicad', seconds: 7.311, memoryMb: 4096 })
  })
})

describe('a large input sent again', () => {
  it('is uploaded once a week by its content, and a warm function reads it from its /tmp', async () => {
    const { randomBytes } = await import('node:crypto')
    const { SHARE_MIN_BYTES } = await import('../../src/gpu/protocol.js')
    const s3 = new FakeS3()
    const big = join(mkdtempSync(join(tmpdir(), 'fn-big-')), 'project.tar')
    writeFileSync(big, randomBytes(SHARE_MIN_BYTES + 10))
    const cache = mkdtempSync(join(tmpdir(), 'fn-cache-'))
    // a function whose runner keeps a shared cache, as src/gpu/lambda.ts gives it
    const lambda: FunctionApi = {
      invoke: async (i) => {
        const ev = JSON.parse(new TextDecoder().decode(i.Payload)) as FunctionEvent
        const exitCode = await main({ s3, env: { TRACE_GPU_JOB_URI: ev.spec }, echo: false, sharedCache: cache })
        return { StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify({ exitCode })), $metadata: { requestId: 'r' } }
      },
    }
    const run = () => runFunction(GpuJobSchema.parse({
      kind: 'kicad', timeoutSeconds: 60, argv: ['sh', '-c', 'cp "$0" "$1"', '{in:project.tar}', '{out:copy.tar}'], inputs: { 'project.tar': big }, outputs: ['copy.tar'],
    }), { lambda, s3, env, recordCost: async () => undefined })
    const first = await run()
    expect(readFileSync(first.outputs['copy.tar'] as string)).toEqual(readFileSync(big))
    const cached = () => [...s3.objects.keys()].filter((k) => /\/cache\/w\d+\/[0-9a-f]{64}$/.test(k))
    expect(cached()).toHaveLength(1)
    // not under the job's own in/
    expect([...s3.objects.keys()].some((k) => k.endsWith('/in/project.tar'))).toBe(false)
    // gone from S3 (expired): sent again, and the job still runs
    s3.objects.delete(cached()[0] as string)
    const second = await run()
    expect(readFileSync(second.outputs['copy.tar'] as string)).toEqual(readFileSync(big))
    expect(cached()).toHaveLength(1)
    // the warm function's copy: the job runs even with the object gone after staging (its reads come from /tmp)
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(cache)).toHaveLength(1)
    // the third: the spec, logs, exit record and output are written; the archive itself is not sent again
    const written: string[] = []
    const put = s3.putObject.bind(s3)
    s3.putObject = async (i) => { written.push(i.Key); return put(i) }
    await run()
    expect(written.length).toBeGreaterThan(0)
    expect(written.filter((k) => k.includes('/cache/'))).toEqual([])
    expect(cached()).toHaveLength(1)
  })
})
