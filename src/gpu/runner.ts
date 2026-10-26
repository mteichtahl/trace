/**
 * The job runner inside the GPU image (agent/Dockerfile.gpu runs `node /app/dist/gpu/runner.js` as the Batch job's
 * command). It reads the spec that ./batch.ts put in TRACE_GPU_JOB (or TRACE_GPU_JOB_URI), downloads the inputs,
 * substitutes the argv placeholders exactly as a local run does (`substitute` from ./jobs.ts), runs the program with
 * its output streamed both to the container log (CloudWatch) and to files, then uploads the outputs, the two logs
 * and, last, the exit record. It exits with the program's code, so a failed program also shows as FAILED in Batch.
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { S3Backend, type S3Api } from '../core/central.js'
import { ATTR, SpanKind, continueFromEnv, envContext, fail, flush, setAttrs, span, startSdkIfConfigured } from '../core/telemetry.js'
import { substitute } from './jobs.js'
import { decodeSpec, jobKeys, type ExitRecord, type RemoteSpec } from './protocol.js'

export interface RunnerDeps {
  s3?: S3Api
  env?: NodeJS.ProcessEnv
  /** where the job's folder is made (default: the OS temp dir) */
  workRoot?: string
  /** echo the program's output to this process's stdout/stderr (default true: it is the container log) */
  echo?: boolean
}

async function readSpec(env: NodeJS.ProcessEnv, s3?: S3Api): Promise<RemoteSpec> {
  if (env.TRACE_GPU_JOB) return decodeSpec(env.TRACE_GPU_JOB)
  const uri = env.TRACE_GPU_JOB_URI
  if (!uri) throw new Error('neither TRACE_GPU_JOB nor TRACE_GPU_JOB_URI is set: this runs only as a trace GPU job')
  const u = new URL(uri)
  const path = decodeURIComponent(u.pathname).replace(/^\/+/, '')
  const r = await new S3Backend(u.hostname, '', s3).get(path)
  if (!r) throw new Error(`${uri} does not exist`)
  return decodeSpec(new TextDecoder().decode(r.body))
}

/** Run one job. Returns the program's exit code (127 when it could not be started). */
export async function main(deps: RunnerDeps = {}): Promise<number> {
  const env = deps.env ?? process.env
  const spec = await readSpec(env, deps.s3)
  const store = new S3Backend(spec.bucket, spec.prefix, deps.s3)
  const keys = jobKeys(spec.id)
  const dir = mkdtempSync(join(deps.workRoot ?? tmpdir(), `${spec.kind}-`))
  const echo = deps.echo ?? true
  const t0 = Date.now()
  const finish = async (rec: ExitRecord): Promise<number> => {
    for (const [k, f] of [[keys.stdout, join(dir, 'stdout.txt')], [keys.stderr, join(dir, 'stderr.txt')]] as const) {
      await store.put(k, existsSync(f) ? readFileSync(f) : new Uint8Array(), { contentType: 'text/plain; charset=utf-8' })
    }
    await store.put(keys.exit, new TextEncoder().encode(JSON.stringify(rec)), { contentType: 'application/json' })
    return rec.exitCode
  }

  mkdirSync(join(dir, 'in'), { recursive: true })
  mkdirSync(join(dir, 'out'), { recursive: true })
  const ins: Record<string, string> = {}
  for (const n of spec.inputs) {
    const o = await store.get(keys.input(n))
    if (!o) return finish({ exitCode: 127, seconds: 0, error: `input ${n} is missing from ${store.url}/${keys.input(n)}`, outputs: [] })
    ins[n] = join(dir, 'in', n)
    writeFileSync(ins[n], o.body)
  }
  const outs = Object.fromEntries(spec.outputs.map((n) => [n, join(dir, 'out', n)]))
  let argv: string[]
  try {
    argv = substitute(spec.argv, ins, outs, dir)
  } catch (e) {
    return finish({ exitCode: 127, seconds: 0, error: e instanceof Error ? e.message : String(e), outputs: [] })
  }

  const out = createWriteStream(join(dir, 'stdout.txt'))
  const err = createWriteStream(join(dir, 'stderr.txt'))
  const [cmd, ...args] = argv as [string, ...string[]]
  const result = await new Promise<{ code: number; error?: string }>((resolve) => {
    const p = spawn(cmd, args, { cwd: dir, env: { ...process.env, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    p.stdout.on('data', (d: Buffer) => { out.write(d); if (echo) process.stdout.write(d) })
    p.stderr.on('data', (d: Buffer) => { err.write(d); if (echo) process.stderr.write(d) })
    let killed = false
    const timer = setTimeout(() => { killed = true; p.kill('SIGKILL') }, spec.timeoutSeconds * 1000)
    p.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve({ code: 127, error: e.code === 'ENOENT' ? `${cmd} is not installed in the GPU image` : e.message })
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      resolve(killed ? { code: code ?? 137, error: `killed after ${spec.timeoutSeconds} s (the job's time limit)` } : { code: code ?? 1 })
    })
  })
  await Promise.all([new Promise((r) => out.end(r)), new Promise((r) => err.end(r))])

  const written: string[] = []
  for (const [n, f] of Object.entries(outs)) {
    if (!existsSync(f)) continue
    await store.put(keys.output(n), readFileSync(f))
    written.push(n)
  }
  return finish({ exitCode: result.code, seconds: (Date.now() - t0) / 1000, ...(result.error ? { error: result.error } : {}), outputs: written })
}

/**
 * main() as a span (`trace.gpu.run <kind>`), continuing the submitter's trace from TRACEPARENT/BAGGAGE (set by
 * ./batch.ts). With no SDK registered it is just main().
 */
export async function observedMain(deps: RunnerDeps = {}): Promise<number> {
  const env = deps.env ?? process.env
  const parent = envContext(env)
  const kind = (() => { try { return env.TRACE_GPU_JOB ? decodeSpec(env.TRACE_GPU_JOB).kind : 'job' } catch { return 'job' } })()
  return span(`trace.gpu.run ${kind}`, { [ATTR.gpuKind]: kind, [ATTR.gpuBackend]: 'batch' }, async (s) => {
    const code = await main(deps)
    setAttrs(s, { [ATTR.gpuExitCode]: code, [ATTR.outcome]: code === 0 ? 'ok' : 'error' })
    if (code !== 0) fail(s, new Error(`exit code ${code}`), 'exit_code')
    return code
  }, { kind: SpanKind.CONSUMER, ...(parent ? { parent } : {}) })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // ADOT starts only when the job definition names an OTLP endpoint (the stack does, with observability on).
  continueFromEnv()
  void startSdkIfConfigured()
    .then(() => observedMain())
    .then(async (code) => { await flush(); process.exit(code) }, async (e: unknown) => {
      console.error(`trace gpu runner: ${e instanceof Error ? e.message : String(e)}`)
      await flush()
      process.exit(2)
    })
}
