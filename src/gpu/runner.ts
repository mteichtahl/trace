/**
 * The job runner inside the GPU image (agent/Dockerfile.gpu runs `node /app/dist/gpu/runner.js` as the Batch job's
 * command). It reads the spec that ./batch.ts put at TRACE_GPU_JOB_URI (the job's own `spec` object in S3; nothing
 * else about the job is in its environment or command), downloads the inputs into their tree under in/,
 * substitutes the argv placeholders exactly as a local run does (`substitute` from ./jobs.ts), runs the program with
 * its output streamed both to the container log (CloudWatch) and to files, then uploads the outputs, the two logs
 * and, last, the exit record. It exits with the program's code, so a failed program also shows as FAILED in Batch.
 *
 * An isolated job (spec.isolate: a `cad` job's case script is a project's own code) runs with isolatedEnv: none of this
 * process's credentials or tokens (the runner keeps them, in its own process, for the S3 uploads), HOME and TMPDIR in
 * the job's folder, and in a process group of its own that is killed when the program ends, so nothing it started
 * survives into the next job of a warm function.
 *
 * On the cad function (a `cad-script` job: ./lambda.ts, docs/enclosure-build.md "Trust") the same runner moves the
 * files through presigned URLs instead (RunnerDeps.store, a UrlStore: ./urls.ts): that function has no S3 access, and
 * the runner's process holds nothing but this job's own URLs.
 */
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { S3Backend, type S3Api } from '../core/central.js'
import { ATTR, SpanKind, continueFromEnv, envContext, fail, flush, setAttrs, span, startSdkIfConfigured } from '../core/telemetry.js'
import { isolatedEnv, spawnJob, substitute } from './jobs.js'
import { decodeSpec, jobKeys, type ExitRecord, type RemoteSpec } from './protocol.js'
import type { JobStore } from './urls.js'

export interface RunnerDeps {
  s3?: S3Api
  /** the job's files through this store instead of S3 (the cad function: a UrlStore of presigned URLs, ./urls.ts);
   * the caller then reads the spec itself (UrlStore.readSpec) and hands it to main as `given` */
  store?: JobStore
  env?: NodeJS.ProcessEnv
  /** where the job's folder is made (default: the OS temp dir) */
  workRoot?: string
  /** echo the program's output to this process's stdout/stderr (default true: it is the container log) */
  echo?: boolean
  /** a folder kept between jobs (a warm tools function's /tmp) where shared inputs are kept by their key, so a job
   * sending the same bytes again reads them from here instead of S3; at most SHARED_CACHE_BYTES */
  sharedCache?: string
}

/** The most a sharedCache folder keeps: the oldest-used go first. */
export const SHARED_CACHE_BYTES = 3 * 1024 ** 3

/** A shared input from the cache folder, else from S3 into it (the folder then trimmed to SHARED_CACHE_BYTES). */
async function sharedInput(store: JobStore, key: string, cache: string | undefined): Promise<Uint8Array | null> {
  const local = cache ? join(cache, key.replaceAll('/', '_')) : null
  if (local && existsSync(local)) {
    const now = new Date()
    utimesSync(local, now, now)
    return readFileSync(local)
  }
  const o = await store.get(key)
  if (!o) return null
  if (local && cache) {
    mkdirSync(cache, { recursive: true })
    writeFileSync(`${local}.part`, o.body)
    renameSync(`${local}.part`, local)
    const files = readdirSync(cache).filter((f) => !f.endsWith('.part')).map((f) => ({ f, st: statSync(join(cache, f)) })).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
    let total = 0
    for (const { f, st } of files) {
      total += st.size
      if (total > SHARED_CACHE_BYTES && join(cache, f) !== local) rmSync(join(cache, f), { force: true })
    }
  }
  return o.body
}

/** The job's spec, from TRACE_GPU_JOB_URI. It must be the `spec` object of the job it describes. */
export async function readSpec(env: NodeJS.ProcessEnv, s3?: S3Api): Promise<RemoteSpec> {
  const uri = env.TRACE_GPU_JOB_URI
  if (!uri) throw new Error('TRACE_GPU_JOB_URI is not set: this runs only as a trace GPU job')
  const u = new URL(uri)
  if (u.protocol !== 's3:') throw new Error(`TRACE_GPU_JOB_URI ${uri} is not an s3:// URL`)
  const path = decodeURIComponent(u.pathname).replace(/^\/+/, '')
  const r = await new S3Backend(u.hostname, '', s3).get(path)
  if (!r) throw new Error(`${uri} does not exist`)
  const spec = decodeSpec(new TextDecoder().decode(r.body))
  if (spec.bucket !== u.hostname || path !== `${spec.prefix}/${jobKeys(spec.id).spec}`) throw new Error(`${uri} holds the spec of another job (${spec.id})`)
  return spec
}

/** Run one job. Returns the program's exit code (127 when it could not be started). */
export async function main(deps: RunnerDeps = {}, given?: RemoteSpec): Promise<number> {
  const env = deps.env ?? process.env
  if (!given && deps.store) throw new Error('a runner on a URL store needs the spec given (read it with UrlStore.readSpec)')
  const spec = given ?? await readSpec(env, deps.s3)
  // a case script (user code) runs only on the cad function, which holds no credentials: a runner with S3 (the tools
  // function, a Batch job) refuses it, whoever staged the spec
  if (spec.kind === 'cad-script' && !deps.store) throw new Error('a cad-script job (a case script) runs on the cad function only, through URLs: this runner has S3 credentials and refuses it')
  const store: JobStore = deps.store ?? new S3Backend(spec.bucket, spec.prefix, deps.s3)
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
    const sharedAt = spec.shared?.[n]
    const body = sharedAt ? await sharedInput(store, sharedAt, deps.sharedCache) : (await store.get(keys.input(n)))?.body
    if (!body) return finish({ exitCode: 127, seconds: 0, error: `input ${n} is missing from ${store.url}/${sharedAt ?? keys.input(n)}`, outputs: [] })
    ins[n] = join(dir, 'in', ...n.split('/')) // a relative path (checked by the spec's schema): the tree is kept
    mkdirSync(dirname(ins[n]), { recursive: true })
    writeFileSync(ins[n], body)
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
  const childEnv = spec.isolate ? isolatedEnv(process.env, spec.env, join(dir, 'home')) : { ...process.env, ...spec.env }
  const r = await spawnJob(cmd, args, {
    cwd: dir, env: childEnv, isolate: spec.isolate, timeoutSeconds: spec.timeoutSeconds,
    onStdout: (d) => { out.write(d); if (echo) process.stdout.write(d) },
    onStderr: (d) => { err.write(d); if (echo) process.stderr.write(d) },
  })
  const result: { code: number; error?: string } = r.error
    ? { code: 127, error: r.error.code === 'ENOENT' ? `${cmd} is not installed in the GPU image` : r.error.message }
    : r.killed ? { code: r.code ?? 137, error: `killed after ${spec.timeoutSeconds} s (the job's time limit)` } : { code: r.code ?? 1 }
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
export async function observedMain(deps: RunnerDeps = {}, given?: RemoteSpec): Promise<number> {
  const env = deps.env ?? process.env
  const parent = envContext(env)
  const spec = given ?? await readSpec(env, deps.s3)
  const kind = spec.kind
  return span(`trace.gpu.run ${kind}`, { [ATTR.gpuKind]: kind, [ATTR.gpuBackend]: env.TRACE_JOB_BACKEND === 'function' ? 'function' : 'batch' }, async (s) => {
    const code = await main(deps, spec)
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
