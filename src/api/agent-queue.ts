/**
 * Work asked for on a project whose own agent is not set up yet, kept until it is (test-esp32 log #2, #80).
 *
 * Why a new project waits at all: its agent is its own worker runtime, with an execution role scoped to that project's
 * data, and its memory, knowledge base, token secret and build runner (src/infra/project.ts). That role is the line
 * between projects, and it is made only by a deploy of the installation's stack (src/installer/pending.ts), which the
 * API starts at once (projects.create) and which takes this installation's usual update time. The API cannot make
 * those resources itself without being allowed to create roles and runtimes, which would move the line between
 * projects out of reviewed infrastructure code (see #294's design note); the update stays the way it arrives.
 *
 * What changes is what the person waits for. Asking trace for work while the agent is being set up (Intent builder's
 * Submit, a chat's "Confirm and start", a change request, any `task`) no longer fails or waits on a disabled button:
 * the start is recorded here and the person carries on. When the project has its agent (the API's own list of worker
 * runtimes, TRACE_WORKER_RUNTIMES, names it after the update's deploy), the next look at the project (journey.get,
 * project.agent; the update's `record.changed { what: 'agent' }` event makes every open app look at once) starts
 * them, oldest first, as the person asked them.
 *
 *   where     projects/<slug>/journey/queued-starts.json in the central bucket (the API may read it and write it only
 *             with conditional puts: the journey prefix's grant, src/infra/api-grants.ts); the project's worker may
 *             read it and never write it
 *   handle    a queued start is followed as `queued~<owner>~<repo>~<12 hex>` (`~` is in no GitHub name): the project is
 *             read from the handle itself, as a worker's is, and access is checked on it before anything is shown.
 *             Once started, the handle answers the real job's state
 *   cancel    job.control cancel takes a queued start out before it starts
 *
 * The same request asked twice while queued (the same agent, branch and words) is the one queued start.
 */
import { createHash } from 'node:crypto'
import { type Backend, Conflict } from '../core/central.js'
import { JOURNEY_FOLDER } from '../core/journey-store.js'
import { jobHeadline } from '../core/plain-words.js'
import { projectSlug } from '../core/project.js'
import type { JobView, JobsApi } from './action-kit.js'

export type StartPayload = Parameters<JobsApi['startJob']>[0]
export type StartAnswer = Awaited<ReturnType<JobsApi['startJob']>>

export const QUEUED_FILE = 'queued-starts.json'

/** Where a project's queued starts are, under the central bucket's projects/ prefix. */
export const queuedKey = (repo: string): string => `${projectSlug(repo)}/${JOURNEY_FOLDER}/${QUEUED_FILE}`

/** What a person reads about a queued start: what it waits for. */
export const WAITS_FOR_AGENT = 'starts once this project\'s agent is set up'

/** How long a started (or failed) start is kept, so a screen following its queued handle reaches the job. */
const KEEP_STARTED_MS = 24 * 3600 * 1000

export interface QueuedStart {
  id: string
  payload: StartPayload
  queued_at: string
  /** the request in one line, as the job index titles a job */
  title: string
}
export interface StartedStart {
  id: string
  title: string
  agent: string | null
  queued_at: string
  started_at: string
  /** the job it became (the API's handle), or null when it could not start (`error` says why) */
  job: string | null
  error?: string
}
export interface QueueFile { queued: QueuedStart[]; started: StartedStart[] }

const EMPTY: QueueFile = { queued: [], started: [] }

/** The job's title, as the job index gives it (its headline, else the request's first plain sentence). Pure. */
export const titleOf = (request: string, headline?: string): string => jobHeadline({ request, headline })

/** The id of a queued start: the same request (agent, branch, words, attempt) is the same id. Pure. */
export function queuedId(p: StartPayload): string {
  const key = [projectSlug(p.repository), p.agent ?? 'auto', p.branch ?? '', p.stackOn ?? '', String(p.attempt ?? 1), p.request].join('\n')
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}

/** The handle a queued start is followed by. Pure. */
export function queuedHandle(repo: string, id: string): string {
  const [owner, name] = projectSlug(repo).split('/') as [string, string]
  return `queued~${owner}~${name}~${id}`
}

const HANDLE = /^queued~([A-Za-z0-9-]+)~([A-Za-z0-9._-]+)~([0-9a-f]{12})$/

/** The project and id a queued handle names, or null for any other id. Pure. */
export function parseQueued(handle: string): { repo: string; id: string } | null {
  const m = HANDLE.exec(handle)
  return m?.[1] && m[2] && m[3] ? { repo: `${m[1]}/${m[2]}`.toLowerCase(), id: m[3] } : null
}

/** Parse the file; anything unreadable is an empty queue (it only ever holds what the API wrote). Pure. */
export function parseQueue(text: string | null): QueueFile {
  if (!text) return { ...EMPTY }
  try {
    const j = JSON.parse(text) as Partial<QueueFile>
    return { queued: Array.isArray(j.queued) ? j.queued : [], started: Array.isArray(j.started) ? j.started : [] }
  } catch {
    return { ...EMPTY }
  }
}

async function read(store: Backend, repo: string): Promise<{ file: QueueFile; etag: string | null }> {
  const got = await store.get(queuedKey(repo))
  return { file: parseQueue(got ? new TextDecoder().decode(got.body) : null), etag: got?.etag ?? null }
}

/** Change the file with a conditional put, read again and retried when someone else wrote it first. */
async function change<T>(store: Backend, repo: string, fn: (f: QueueFile) => { file: QueueFile | null; result: T }): Promise<T> {
  for (let i = 0; i < 5; i++) {
    const { file, etag } = await read(store, repo)
    const out = fn(file)
    if (!out.file) return out.result
    try {
      await store.put(queuedKey(repo), new TextEncoder().encode(JSON.stringify(out.file, null, 2)), { ...(etag === null ? { ifNoneMatch: true } : { ifMatch: etag }), contentType: 'application/json' })
      return out.result
    } catch (e) {
      if (!(e instanceof Conflict)) throw e
    }
  }
  throw new Error('the project\'s queued work kept changing; try again')
}

/** Keep a start until the project's agent is set up; the same request queued already is that one. */
export async function queueStart(store: Backend, p: StartPayload, now = new Date()): Promise<QueuedStart> {
  const id = queuedId(p)
  return change(store, p.repository, (f) => {
    const there = f.queued.find((q) => q.id === id)
    if (there) return { file: null, result: there }
    const q: QueuedStart = { id, payload: p, queued_at: now.toISOString(), title: titleOf(p.request, p.headline) }
    return { file: { ...f, queued: [...f.queued, q] }, result: q }
  })
}

/** The project's queued starts and the ones started in the last day. */
export const readQueue = async (store: Backend, repo: string): Promise<QueueFile> => (await read(store, repo)).file

/** A queued start's view as `job` and jobs.list show it: queued, and what it waits for. Pure. */
export function queuedView(repo: string, q: QueuedStart, position: number, of: number): JobView & { title: string; queue: { position: number; of: number; startsWhen: string } } {
  return {
    id: queuedHandle(repo, q.id), workerJobId: q.id, kind: 'task', repository: projectSlug(repo), agent: q.payload.agent ?? null, title: q.title,
    state: 'queued', step: `queued: ${WAITS_FOR_AGENT}`, startedBy: q.payload.requestedBy, queuedAt: q.queued_at,
    queue: { position, of, startsWhen: WAITS_FOR_AGENT }, waitsForAgent: true, controls: ['cancel'],
  }
}

/**
 * Start what was queued, now that the project has its agent (`jobs.hasAgent`): claimed first (moved to `started` with
 * no job yet, in one conditional write), so two looks at once start each one once; then each is started as it was
 * asked and its job (or why it could not start) recorded. Answers what was started. Nothing while there is no agent.
 */
export async function startQueued(jobs: JobsApi, store: Backend, repo: string, now = new Date()): Promise<StartedStart[]> {
  if (jobs.hasAgent && !jobs.hasAgent(repo)) return []
  const { file } = await read(store, repo)
  if (!file.queued.length) return []
  const claimed = await change(store, repo, (f) => {
    if (!f.queued.length) return { file: null, result: [] as QueuedStart[] }
    const at = now.toISOString()
    const keep = f.started.filter((s) => now.getTime() - Date.parse(s.started_at) < KEEP_STARTED_MS)
    const moved = f.queued.map((q): StartedStart => ({ id: q.id, title: q.title, agent: q.payload.agent ?? null, queued_at: q.queued_at, started_at: at, job: null }))
    return { file: { queued: [], started: [...keep, ...moved] }, result: f.queued }
  })
  const out: StartedStart[] = []
  for (const q of claimed) {
    const r = await jobs.startJob(q.payload).catch((e: unknown) => ({ accepted: false, jobId: '', reason: e instanceof Error ? e.message : String(e) }))
    out.push({
      id: q.id, title: q.title, agent: q.payload.agent ?? null, queued_at: q.queued_at, started_at: now.toISOString(),
      // "already running" (the same session) is that job: followed as it
      job: r.jobId || null, ...(r.accepted || r.jobId ? {} : { error: (r.reason ?? 'trace did not accept the job').slice(0, 300) }),
    })
  }
  await change(store, repo, (f) => ({ file: { ...f, started: f.started.map((s) => out.find((o) => o.id === s.id && s.job === null) ?? s) }, result: null }))
  return out
}

/** Take a queued start out before it starts: true when it was there. */
export async function unqueue(store: Backend, repo: string, id: string): Promise<boolean> {
  return change(store, repo, (f) => (f.queued.some((q) => q.id === id) ? { file: { ...f, queued: f.queued.filter((q) => q.id !== id) }, result: true } : { file: null, result: false }))
}

/**
 * The jobs API with this queue in front of it: a start on a project with no agent yet is queued (answered accepted,
 * `queued`, with its queued handle), and a queued handle is followed and cancelled here. An installation whose jobs API
 * cannot tell (no hasAgent) is left as it is. `store`: the central bucket under projects/.
 */
export function withAgentQueue(inner: JobsApi, store: () => Backend, o: { holdS?: number } = {}): JobsApi {
  const has = inner.hasAgent?.bind(inner)
  if (!has) return inner
  const hold = o.holdS ?? 20
  /** A queued handle's view: the queued start, or the job it became (its own view), or a failed one. */
  const view = async (handle: string): Promise<JobView[]> => {
    const h = parseQueued(handle)
    if (!h) return [...await inner.jobStatus(handle)]
    const f = await readQueue(store(), h.repo)
    const i = f.queued.findIndex((q) => q.id === h.id)
    if (i >= 0) return [queuedView(h.repo, f.queued[i]!, i + 1, f.queued.length)]
    const s = f.started.find((x) => x.id === h.id)
    if (s?.job) {
      const real = await inner.jobStatus(s.job).catch(() => [] as JobView[])
      // the started job's own view, under the handle the screen follows (and the job it became)
      if (real[0]) return [{ ...real[0], id: handle, startedAs: s.job }]
      return [{ id: handle, kind: 'task', repository: h.repo, state: 'queued', title: s.title, startedAs: s.job, step: 'starting' }]
    }
    if (s) return [{ id: handle, kind: 'task', repository: h.repo, state: s.error ? 'failed' : 'queued', title: s.title, error: s.error ?? null, step: s.error ? null : 'starting' }]
    return []
  }
  return {
    ...inner,
    repositoryOf: (id) => parseQueued(id)?.repo ?? inner.repositoryOf(id),
    hasAgent: has,
    async startJob(p): Promise<StartAnswer> {
      if (has(p.repository)) return inner.startJob(p)
      const q = await queueStart(store(), p)
      return { accepted: true, jobId: queuedHandle(p.repository, q.id), queued: true, reason: `Queued: it ${WAITS_FOR_AGENT}.` }
    },
    jobStatus: (id) => (id && parseQueued(id) ? view(id) : inner.jobStatus(id)),
    async watchJob(id, w) {
      if (!parseQueued(id)) {
        if (inner.watchJob) return inner.watchJob(id, w)
        return { jobs: await inner.jobStatus(id), version: null, waits: [] }
      }
      // nothing announces the agent's arrival here: a held look waits a while (as a worker holds one), then answers
      const first = await view(id)
      if (w.waitS && first[0]?.state === 'queued' && !first[0].startedAs) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, Math.min(w.waitS ?? 0, hold) * 1000)
          w.signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
        })
        return { jobs: await view(id), version: null, waits: [] }
      }
      return { jobs: first, version: null, waits: [] }
    },
    async cancel(id, reason) {
      const h = parseQueued(id)
      if (!h) {
        if (!inner.cancel) return { ok: false, state: null, reason: 'this installation cannot cancel from the API' }
        return inner.cancel(id, reason)
      }
      if (await unqueue(store(), h.repo, h.id)) return { ok: true, state: 'aborted', kept: 'It had not started, so nothing was done.' }
      const s = (await readQueue(store(), h.repo)).started.find((x) => x.id === h.id)
      if (s?.job && inner.cancel) return inner.cancel(s.job, reason)
      return { ok: false, state: null, reason: 'It is no longer queued.' }
    },
  }
}
