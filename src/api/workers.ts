/**
 * How the API runtime starts and follows work, and runs tools: on the project's own worker runtime (InvokeAgentRuntime),
 * never in its own process. The API runs no model and no tool, and gives nothing a shell; each worker's role reaches
 * only its project (and has its GPU and CPU queues).
 *
 *   TRACE_WORKER_RUNTIMES   `owner/repo=<runtime id> …` (space-separated), written by the stack
 *
 * A task runs in an AgentCore session of the project's runtime, and its job lives in that session (one microVM), so
 * the job id the API hands out names both: `<session>.<job id>`, where the session is
 * `trace-api-<project hash>-<24 hex>`. The session is derived from the project, the agent and the request, so asking
 * twice for the same thing lands in the same session and is answered "already running" while it runs. The project
 * hash in the id lets the `job` action check access to that project before anything is invoked.
 *
 * Following a job is event-driven on the worker: `job` with afterVersion + waitS is forwarded as a held status
 * invocation (the worker answers the moment the job changes), and `job.check_now` as a check-now invocation in the
 * job's session (the microVM whose waits the status answer listed).
 */
import { createHash } from 'node:crypto'
import { type AgentCoreLike, invoke } from '../agents/runtime/dispatch.js'
import { AcceptedSchema, type TaskJob } from '../agents/runtime/schemas.js'
import { projectHash, projectSlug } from '../core/project.js'
import { ActionError, type JobView, type JobsApi, type WaitView } from './actions.js'
import { z } from 'zod'

/** `owner/repo=<runtime id> …` → slug → runtime id. Malformed entries are refused (the stack writes this). */
export function parseWorkerRuntimes(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const entry of (text ?? '').split(/\s+/).filter(Boolean)) {
    const at = entry.lastIndexOf('=')
    const repo = entry.slice(0, at)
    const id = entry.slice(at + 1)
    if (at <= 0 || !/^[a-zA-Z][a-zA-Z0-9_]{0,47}-[A-Za-z0-9]{1,64}$/.test(id)) throw new Error(`TRACE_WORKER_RUNTIMES: not owner/repo=<runtime id>: ${JSON.stringify(entry)}`)
    out.set(projectSlug(repo), id)
  }
  return out
}

const SESSION = /^trace-api-([0-9a-f]{8})-[0-9a-f]{24}$/
const HANDLE = /^(trace-api-[0-9a-f]{8}-[0-9a-f]{24})\.([A-Za-z0-9_-]{1,64})$/

/** The AgentCore session a task runs in: one per project, agent and request. */
export function taskSession(t: Pick<TaskJob, 'repository' | 'request' | 'agent' | 'branch'>): string {
  const slug = projectSlug(t.repository)
  const h = createHash('sha256').update(`${slug}\n${t.agent ?? 'auto'}\n${t.branch ?? ''}\n${t.request}`).digest('hex').slice(0, 24)
  return `trace-api-${projectHash(slug)}-${h}`
}

/**
 * The AgentCore session the API's tool calls on one project run in: one per project, so they reuse a warm microVM and
 * its clone. (A tool call is answered in the response: it has no job and no handle.)
 */
export function toolSession(repository: string): string {
  const slug = projectSlug(repository)
  return `trace-api-${projectHash(slug)}-${createHash('sha256').update(`${slug}\ntool`).digest('hex').slice(0, 24)}`
}

export const jobHandle = (session: string, jobId: string): string => `${session}.${jobId}`

export function parseHandle(handle: string): { session: string; jobId: string; hash: string } | null {
  const m = HANDLE.exec(handle)
  const s = m?.[1] ? SESSION.exec(m[1]) : null
  return m?.[1] && m[2] && s?.[1] ? { session: m[1], jobId: m[2], hash: s[1] } : null
}

const StatusOut = z.object({
  jobs: z.array(z.object({ id: z.string(), kind: z.string(), state: z.string(), repository: z.string().optional() }).loose()),
  // a worker from before held status answers has neither
  version: z.number().optional(),
  waits: z.array(z.object({ id: z.string(), what: z.string(), source: z.string(), text: z.string() }).loose()).default([]),
}).loose()
const CheckNowOut = z.object({ ok: z.boolean() }).loose()
const ToolOut = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }).loose(),
  z.object({ ok: z.literal(false), error: z.string() }).loose(),
])

export interface RemoteJobsOptions {
  /** slug → runtime id (parseWorkerRuntimes) */
  runtimes: ReadonlyMap<string, string>
  region: string
  account: string
  partition?: string
  client?: AgentCoreLike
}

/** JobsApi on the projects' worker runtimes. */
export function remoteJobs(o: RemoteJobsOptions): JobsApi {
  const byHash = new Map([...o.runtimes.keys()].map((slug) => [projectHash(slug), slug] as const))
  const arnOf = (slug: string): string => {
    const id = o.runtimes.get(slug)
    if (!id) throw new ActionError(`${slug} has no worker runtime in this installation`)
    return `arn:${o.partition ?? 'aws'}:bedrock-agentcore:${o.region}:${o.account}:runtime/${id}`
  }
  const opts = (slug: string) => ({ runtimeArn: arnOf(slug), region: o.region, ...(o.client ? { client: o.client } : {}) })
  /** The job's status on its worker (held there with afterVersion + waitS), its change counter and open waits. */
  const watch = async (handle: string | undefined, w: { afterVersion?: number | undefined; waitS?: number | undefined }): Promise<{ jobs: JobView[]; version: number | null; waits: WaitView[] }> => {
    const h = handle ? parseHandle(handle) : null
    const slug = h ? byHash.get(h.hash) : undefined
    if (!h || !slug) return { jobs: [], version: null, waits: [] }
    const hold = w.afterVersion !== undefined && w.waitS ? { afterVersion: w.afterVersion, waitS: w.waitS } : {}
    const out = StatusOut.parse(await invoke({ kind: 'status', jobId: h.jobId, ...hold }, h.session, opts(slug)))
    // a session of one project's runtime only ever has that project's jobs; checked all the same
    const jobs = out.jobs.filter((j) => j.id === h.jobId && (j.repository ?? slug).toLowerCase() === slug)
      .map((j): JobView => ({ ...j, id: handle ?? j.id, workerJobId: j.id }))
    return { jobs, version: out.version ?? null, waits: out.waits }
  }
  return {
    repositoryOf: (handle) => {
      const h = parseHandle(handle)
      return h ? byHash.get(h.hash) ?? null : null
    },
    async startJob(payload) {
      const slug = projectSlug(payload.repository)
      const session = taskSession(payload)
      const r = AcceptedSchema.parse(await invoke(payload, session, opts(slug)))
      return { ...r, jobId: jobHandle(session, r.jobId) }
    },
    async runTool(payload) {
      const slug = projectSlug(payload.repository)
      const out = ToolOut.safeParse(await invoke({ ...payload }, toolSession(slug), opts(slug)))
      if (!out.success) throw new ActionError(`${payload.name}: the project's worker answered something unexpected`)
      if (!out.data.ok) throw new ActionError(out.data.error)
      return out.data.result
    },
    async jobStatus(handle) {
      return (await watch(handle, {})).jobs
    },
    watchJob: (handle, w) => watch(handle, w),
    async checkNow(handle, waitId) {
      const h = parseHandle(handle)
      const slug = h ? byHash.get(h.hash) : undefined
      if (!h || !slug) return false
      return CheckNowOut.parse(await invoke({ kind: 'check-now', waitId }, h.session, opts(slug))).ok
    },
  }
}
