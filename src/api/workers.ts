/**
 * How the API runtime starts and follows work, and runs tools: on the project's own worker runtime (InvokeAgentRuntime),
 * never in its own process. The API runs no model and no tool, and gives nothing a shell; each worker's role reaches
 * only its project (and has its GPU and CPU queues).
 *
 *   TRACE_WORKER_RUNTIMES   `owner/repo=<runtime id> …` (space-separated), written by the stack
 *   TRACE_WORKER_BUILD      the workers' image content tag (src/infra/images.ts), written by the stack: part of the
 *                           tool session's id, so a deploy that changes the workers' code moves tool calls to a new session
 *
 * A task runs in an AgentCore session of the project's runtime, and its job lives in that session (one microVM), so
 * the job id the API hands out names both: `<session>.<job id>`, where the session is
 * `trace-api-<project hash>-<24 hex>`. The session is derived from the project, the agent and the request, so asking
 * twice for the same thing lands in the same session and is answered "already running" while it runs. The project
 * hash in the id lets the `job` action check access to that project before anything is invoked. A job the API did
 * not start (a workflow's) is named by the job index as `p<project hash>.<session>.<job id>` (indexedHandle).
 *
 * Following a job is event-driven on the worker: `job` with afterVersion + waitS is forwarded as a held status
 * invocation (the worker answers the moment the job changes), and `job.check_now` as a check-now invocation in the
 * job's session (the microVM whose waits the status answer listed); `job.control` cancel as a cancel invocation there. Tool calls have no job: `tools.waits` holds a
 * status invocation in the project's tool session (where kb.sync and the other tool calls run) and keeps the waits
 * opened outside any job; `tools.check_now` wakes one of them there.
 */
import { createHash } from 'node:crypto'
import { type AgentCoreLike, invoke } from '../agents/runtime/dispatch.js'
import { AcceptedSchema, type TaskJob } from '../agents/runtime/schemas.js'
import { indexedHandle } from '../core/job-index.js'
import { projectHash, projectSlug } from '../core/project.js'
import { ActionError, type JobView, type JobsApi, type WaitView } from './action-kit.js'
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
/**
 * A job the API did not start (a workflow's work item, a sweep's, or one whose session is not known) as the job index
 * lists it: `p<project hash>.<session>.<job id>`, or `p<project hash>..<job id>` without a session. The hash names the
 * project (access is checked on it); the session, when there is one, is where its worker is asked.
 */
const INDEXED = /^p([0-9a-f]{8})\.([A-Za-z0-9_-]{33,256})?\.([A-Za-z0-9_-]{1,64})$/

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
export function toolSession(repository: string, build = ''): string {
  const slug = projectSlug(repository)
  // The build is in the id because a session keeps the runtime version it started on (AgentCore moves only new
  // sessions to a new version), and the web app's held status calls keep this one session alive to its 8-hour limit:
  // without it, a fix to the workers reached tool calls only hours after its deploy. Waits open in the old session end
  // with it, and the new one clones the project afresh.
  return `trace-api-${projectHash(slug)}-${createHash('sha256').update(build ? `${slug}\ntool\n${build}` : `${slug}\ntool`).digest('hex').slice(0, 24)}`
}

export const jobHandle = (session: string, jobId: string): string => `${session}.${jobId}`

export function parseHandle(handle: string): { session: string; jobId: string; hash: string } | null {
  const m = HANDLE.exec(handle)
  const s = m?.[1] ? SESSION.exec(m[1]) : null
  if (m?.[1] && m[2] && s?.[1]) return { session: m[1], jobId: m[2], hash: s[1] }
  const i = INDEXED.exec(handle)
  return i?.[1] && i[3] ? { session: i[2] ?? '', jobId: i[3], hash: i[1] } : null
}

export { indexedHandle }

const StatusOut = z.object({
  jobs: z.array(z.object({ id: z.string(), kind: z.string(), state: z.string(), repository: z.string().optional() }).loose()),
  // a worker from before held status answers has neither
  version: z.number().optional(),
  waits: z.array(z.object({ id: z.string(), what: z.string(), source: z.string(), text: z.string() }).loose()).default([]),
}).loose()
const CheckNowOut = z.object({ ok: z.boolean() }).loose()
const CancelOut = z.object({ ok: z.boolean(), state: z.string().nullable().default(null), kept: z.string().optional(), reason: z.string().optional() }).loose()
const PauseOut = CancelOut
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
  /** the workers' image content tag (TRACE_WORKER_BUILD): part of the tool session's id (toolSession) */
  build?: string
  client?: AgentCoreLike
}

/** JobsApi on the projects' worker runtimes. */
export function remoteJobs(o: RemoteJobsOptions): JobsApi {
  const byHash = new Map([...o.runtimes.keys()].map((slug) => [projectHash(slug), slug] as const))
  const arnOf = (slug: string): string => {
    const id = o.runtimes.get(slug)
    // a project created in the web app gets its runtime from the next update of the installation (projects.create)
    if (!id) throw new ActionError(`${slug}'s agent is not set up yet: a new project's agent arrives with the next update of the installation, usually within the hour of its creation. If it has been longer, an admin can run trace's ci workflow on its main branch by hand, or the installer.`)
    return `arn:${o.partition ?? 'aws'}:bedrock-agentcore:${o.region}:${o.account}:runtime/${id}`
  }
  const opts = (slug: string) => ({ runtimeArn: arnOf(slug), region: o.region, ...(o.client ? { client: o.client } : {}) })
  /** The job's status on its worker (held there with afterVersion + waitS), its change counter and open waits. */
  const watch = async (handle: string | undefined, w: { afterVersion?: number | undefined; waitS?: number | undefined; signal?: AbortSignal | undefined }): Promise<{ jobs: JobView[]; version: number | null; waits: WaitView[] }> => {
    const h = handle ? parseHandle(handle) : null
    const slug = h ? byHash.get(h.hash) : undefined
    if (!h || !slug || !h.session) return { jobs: [], version: null, waits: [] }
    const hold = w.afterVersion !== undefined && w.waitS ? { afterVersion: w.afterVersion, waitS: w.waitS } : {}
    const out = StatusOut.parse(await invoke({ kind: 'status', jobId: h.jobId, ...hold }, h.session, { ...opts(slug), signal: w.signal }))
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
      // a resumed task runs on the paused one's branch: a session of its own (branch is part of the session's hash)
      const session = taskSession(payload)
      const r = AcceptedSchema.parse(await invoke(payload, session, opts(slug)))
      return { ...r, jobId: jobHandle(session, r.jobId) }
    },
    async runTool(payload) {
      const slug = projectSlug(payload.repository)
      const out = ToolOut.safeParse(await invoke({ ...payload }, toolSession(slug, o.build), opts(slug)))
      if (!out.success) throw new ActionError(`${payload.name}: the project's worker answered something unexpected`)
      if (!out.data.ok) throw new ActionError(out.data.error)
      return out.data.result
    },
    async jobStatus(handle) {
      return (await watch(handle, {})).jobs
    },
    watchJob: (handle, w) => watch(handle, w),
    async watchTools(repository, w) {
      const slug = projectSlug(repository)
      const hold = w.afterVersion !== undefined && w.waitS ? { afterVersion: w.afterVersion, waitS: w.waitS } : {}
      const out = StatusOut.parse(await invoke({ kind: 'status', ...hold }, toolSession(slug, o.build), { ...opts(slug), signal: w.signal }))
      // the tool session's own waits: those open outside any job (a job's waits are on its own handle)
      return { version: out.version ?? null, waits: out.waits.filter((x) => x.jobId === null || x.jobId === undefined) }
    },
    async checkToolWait(repository, waitId) {
      const slug = projectSlug(repository)
      return CheckNowOut.parse(await invoke({ kind: 'check-now', waitId }, toolSession(slug, o.build), opts(slug))).ok
    },
    async pause(handle, by) {
      const h = parseHandle(handle)
      const slug = h ? byHash.get(h.hash) : undefined
      if (!h || !slug) return { ok: false, state: null, reason: 'There is no such job.' }
      if (!h.session) return { ok: false, state: null, reason: 'trace does not know where this job runs, so it cannot reach it.' }
      const out = PauseOut.parse(await invoke({ kind: 'pause', jobId: h.jobId, by }, h.session, opts(slug)))
      return { ok: out.ok, state: out.state, ...(out.kept ? { kept: out.kept } : {}), ...(out.reason ? { reason: out.reason } : {}) }
    },
    async cancel(handle, reason) {
      const h = parseHandle(handle)
      const slug = h ? byHash.get(h.hash) : undefined
      if (!h || !slug) return { ok: false, state: null, reason: 'There is no such job.' }
      if (!h.session) return { ok: false, state: null, reason: 'trace does not know where this job runs, so it cannot reach it.' }
      const out = CancelOut.parse(await invoke({ kind: 'cancel', jobId: h.jobId, reason }, h.session, opts(slug)))
      return { ok: out.ok, state: out.state, ...(out.kept ? { kept: out.kept } : {}), ...(out.reason ? { reason: out.reason } : {}) }
    },
    async checkNow(handle, waitId) {
      const h = parseHandle(handle)
      const slug = h ? byHash.get(h.hash) : undefined
      if (!h || !slug || !h.session) return false
      return CheckNowOut.parse(await invoke({ kind: 'check-now', waitId }, h.session, opts(slug))).ok
    },
  }
}
