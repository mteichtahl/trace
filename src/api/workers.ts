/**
 * How the API runtime starts and follows work: on the project's own worker runtime (InvokeAgentRuntime), never in
 * its own process. The API runs no model and gives nothing a shell; each worker's role reaches only its project.
 *
 *   TRACE_WORKER_RUNTIMES   `owner/repo=<runtime id> …` (space-separated), written by the stack
 *
 * A task runs in an AgentCore session of the project's runtime, and its job lives in that session (one microVM), so
 * the job id the API hands out names both: `<session>.<job id>`, where the session is
 * `trace-api-<project hash>-<24 hex>`. The session is derived from the project, the agent and the request, so asking
 * twice for the same thing lands in the same session and is answered "already running" while it runs. The project
 * hash in the id lets the `job` action check access to that project before anything is invoked.
 */
import { createHash } from 'node:crypto'
import { type AgentCoreLike, invoke } from '../agent/dispatch.js'
import { AcceptedSchema, type TaskJob } from '../agent/schemas.js'
import { projectHash, projectSlug } from '../core/project.js'
import { ActionError, type JobView, type JobsApi } from './actions.js'
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
  const h = createHash('sha256').update(`${slug}\n${t.agent ?? 'worker'}\n${t.branch ?? ''}\n${t.request}`).digest('hex').slice(0, 24)
  return `trace-api-${projectHash(slug)}-${h}`
}

export const jobHandle = (session: string, jobId: string): string => `${session}.${jobId}`

export function parseHandle(handle: string): { session: string; jobId: string; hash: string } | null {
  const m = HANDLE.exec(handle)
  const s = m?.[1] ? SESSION.exec(m[1]) : null
  return m?.[1] && m[2] && s?.[1] ? { session: m[1], jobId: m[2], hash: s[1] } : null
}

const StatusOut = z.object({ jobs: z.array(z.object({ id: z.string(), kind: z.string(), state: z.string(), repository: z.string().optional() }).loose()) }).loose()

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
    async jobStatus(handle) {
      const h = handle ? parseHandle(handle) : null
      const slug = h ? byHash.get(h.hash) : undefined
      if (!h || !slug) return []
      const out = StatusOut.parse(await invoke({ kind: 'status', jobId: h.jobId }, h.session, opts(slug)))
      // a session of one project's runtime only ever has that project's jobs; checked all the same
      return out.jobs.filter((j) => j.id === h.jobId && (j.repository ?? slug).toLowerCase() === slug)
        .map((j): JobView => ({ ...j, id: handle ?? j.id, workerJobId: j.id }))
    },
  }
}
