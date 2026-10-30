/**
 * A job's files over presigned URLs (docs/enclosure-build.md "Trust"): how a `cad-script` job reaches the cad function,
 * which has no S3 access of its own. The worker stages the job under jobs/<slug>/<id>/ as for every job (./staging.ts),
 * then signs with its own credentials (./function.ts runCadScript, 20 minutes) one GET URL for the spec and for each
 * input, and one PUT URL for each output, for stdout, for stderr and for the exit record. The event the function gets is
 *
 *   {"urls": {"spec": …, "inputs": {name: url}, "outputs": {name: url}, "stdout": …, "stderr": …, "exit": …}, "traceparent"?}
 *
 * and the runner (./runner.ts main) moves the files through a UrlStore, which maps the job's keys (./protocol.ts
 * jobKeys: <id>/spec, <id>/in/<name>, <id>/out/<name>, <id>/log/stdout.txt, <id>/log/stderr.txt, <id>/exit) to those
 * URLs and uses fetch. A key with no URL is an error, never a guess: the function holds nothing that reaches any other
 * object. A PUT sends no content-type header (the URL is signed without one, so the header is not part of the
 * signature); S3 keeps the object as binary/octet-stream, and the worker reads it back by key as for any job.
 */
import { z } from 'zod'
import { ToolError } from '../core/registry.js'
import type { PutOptions } from '../core/central.js'
import { InputName, OutputName } from './jobs.js'
import { decodeSpec, jobKeys, type RemoteSpec } from './protocol.js'

const Url = z.string().url().refine((u) => u.startsWith('https://'), { message: 'a job URL is https' })

export const JobUrlsSchema = z.object({
  spec: Url,
  inputs: z.record(InputName, Url).default({}),
  outputs: z.record(OutputName, Url).default({}),
  stdout: Url,
  stderr: Url,
  exit: Url,
}).strict()
export type JobUrls = z.output<typeof JobUrlsSchema>

/** What a `cad-script` job's Invoke sends (./function.ts). */
export interface UrlsEvent { urls: JobUrls; traceparent?: string }

/** How long the URLs are good for (seconds): the function's 15 minutes, and the worker's own staging and reading. */
export const URL_EXPIRES_SECONDS = 1200

/** The store the runner writes through: what it uses of S3Backend (src/core/central.ts). */
export interface JobStore {
  readonly url: string
  get(key: string): Promise<{ body: Uint8Array; etag: string } | null>
  put(key: string, body: Uint8Array, opts?: PutOptions): Promise<string>
}

export type FetchLike = (url: string, init: { method: 'GET' | 'PUT'; body?: Uint8Array; headers?: Record<string, string> }) => Promise<{ status: number; ok: boolean; arrayBuffer(): Promise<ArrayBuffer>; headers: { get(name: string): string | null } }>

export class UrlStore implements JobStore {
  readonly url: string
  private readonly keys: ReturnType<typeof jobKeys>
  private readonly byKey: Map<string, string>

  constructor(readonly id: string, readonly urls: JobUrls, private readonly fetchFn: FetchLike = (u, i) => fetch(u, i)) {
    this.url = `urls:${id}`
    this.keys = jobKeys(id)
    this.byKey = new Map<string, string>([
      [this.keys.spec, urls.spec], [this.keys.stdout, urls.stdout], [this.keys.stderr, urls.stderr], [this.keys.exit, urls.exit],
      ...Object.entries(urls.inputs).map(([n, u]) => [this.keys.input(n), u] as [string, string]),
      ...Object.entries(urls.outputs).map(([n, u]) => [this.keys.output(n), u] as [string, string]),
    ])
  }

  private urlFor(key: string): string {
    const u = this.byKey.get(key)
    if (!u) throw new ToolError(`${key} is not one of this job's URLs (the cad function reaches only the files it was given)`)
    return u
  }

  /** The spec at urls.spec, decoded and checked to be this id's (when the id is known). */
  static async readSpec(urls: JobUrls, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<RemoteSpec> {
    const r = await fetchFn(urls.spec, { method: 'GET' })
    if (!r.ok) throw new ToolError(`the job's spec could not be read (HTTP ${r.status})`)
    return decodeSpec(new TextDecoder().decode(new Uint8Array(await r.arrayBuffer())))
  }

  async get(key: string): Promise<{ body: Uint8Array; etag: string } | null> {
    const r = await this.fetchFn(this.urlFor(key), { method: 'GET' })
    if (r.status === 404) return null
    if (!r.ok) throw new ToolError(`${key}: HTTP ${r.status} reading it`)
    return { body: new Uint8Array(await r.arrayBuffer()), etag: r.headers.get('etag') ?? '' }
  }

  async put(key: string, body: Uint8Array, _opts: PutOptions = {}): Promise<string> {
    // no content-type (see the header): the URL was signed without one
    const r = await this.fetchFn(this.urlFor(key), { method: 'PUT', body })
    if (!r.ok) throw new ToolError(`${key}: HTTP ${r.status} writing it`)
    return r.headers.get('etag') ?? ''
  }
}
