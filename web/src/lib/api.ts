/**
 * `call(action, args)`: the API runtime through POST /api/call, typed per action. Adds the bearer token (lib/auth)
 * and the body hash (lib/http); on a 401 it refreshes once and tries again. The API answers `{ ok, result }` or
 * `{ ok: false, error }`; `call` returns the result (read into the app's shape by lib/readers.ts where the API's differs)
 * or throws an ApiError carrying the words to show.
 */
import { refresh, token } from './auth'
import { HttpError, request } from './http'
import { READERS } from './readers'
import type {
  ChatMessage, ChatThread, InboxItem, Journey, JobView, Member, MeDoc, Part, PersonClass, ProjectRef, Wait,
} from './types'

export class ApiError extends Error {
  override name = 'ApiError'
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
  }
  /** the one answer for a project that is not yours, whether or not it exists */
  get noAccess(): boolean {
    return this.status === 403 || this.message === 'no access'
  }
}

type Repo = { repo: string }

/** What job.control can do; a job's view lists the ones the API can do for it now (`controls`). */
export type JobOp = 'pause' | 'resume' | 'cancel' | 'move_up'

/** Every action the app calls: its arguments and its answer. */
export interface Actions {
  // existing (src/api/actions.ts)
  whoami: { args: Record<string, never>; result: { sub: string; email: string; groups: string[]; class: PersonClass | null } }
  projects: { args: Record<string, never>; result: ProjectRef[] }
  status: { args: Repo; result: { repo: string; default_branch: string; pulls: unknown[]; agent_fix_issues: unknown[]; runs: unknown[]; last_deploy: unknown } }
  'settings.get': { args: Repo; result: { repo: string; set: Record<string, unknown>; config: Record<string, unknown>; errors: string[] } }
  'settings.set': { args: Repo & { key: string; value?: unknown; unset?: boolean }; result: { branch: string; commit: string } }
  runs: { args: Repo & { kind?: string; limit?: number; agent?: string }; result: Record<string, unknown>[] }
  run: { args: Repo & { id: string }; result: Record<string, unknown> }
  artifact: { args: Repo & { id: string; name: string }; result: { id: string; name: string; mime: string | null; size: number; base64: string } }
  'tools.list': { args: Repo; result: { name: string; description: string; needs: 'read' | 'write'; input: unknown }[] }
  tool: { args: Repo & { name: string; args?: Record<string, unknown> }; result: unknown }
  task: { args: Repo & { request: string; agent?: string }; result: { accepted: boolean; jobId: string; reason?: string } }
  'memory.list': { args: Repo & { agent?: string; limit?: number; includeInactive?: boolean }; result: { repo: string; enabled: boolean; records: Record<string, unknown>[] } }
  'memory.recall': { args: Repo & { query: string; top_k?: number }; result: { repo: string; enabled: boolean; records: Record<string, unknown>[] } }
  'memory.deactivate': { args: Repo & { recordId: string; reason: string }; result: Record<string, unknown> }
  'memory.reactivate': { args: Repo & { recordId: string }; result: Record<string, unknown> }
  'kb.search': { args: Repo & { query: string; top_k?: number }; result: { repo: string; enabled: boolean; results?: unknown[] } }
  'kb.sync': { args: Repo & { force?: boolean }; result: unknown }
  job: { args: { id: string; afterVersion?: number; waitS?: number }; result: JobView & { controls?: JobOp[] } }
  'job.check_now': { args: { id: string; waitId: string }; result: { ok: boolean } }
  'tools.waits': { args: Repo & { afterVersion?: number; waitS?: number }; result: { repo: string; version: number | null; waits: Wait[] } }
  'tools.check_now': { args: Repo & { waitId: string }; result: { ok: boolean } }
  'users.list': { args: Record<string, never>; result: import('./admin-types').UserRow[] }
  'users.invite': { args: { email: string; class?: PersonClass }; result: { sub: string; email: string; class: PersonClass } }
  'users.class': { args: { who: string; class: PersonClass }; result: { sub: string; class: PersonClass } }
  assign: { args: { who: string; repo: string; part?: Part }; result: unknown }
  unassign: { args: { who: string; repo: string }; result: { removed: boolean } }
  assignments: { args: { repo?: string }; result: { sub: string; email?: string; repo: string; part?: Part }[] }
  // new (docs/web-build.md)
  'project.members': { args: Repo; result: Member[] }
  'projects.create': {
    args: {
      repo: string; name: string; description?: string; icon?: string; start?: 'idea' | 'import'; template: 'board' | 'fpga' | 'firmware' | 'mixed'
      new?: { private: boolean; scaffold?: 'empty' | 'python' | 'kicad' | 'rust' }; people?: { who: string; part?: Part; class?: 'user' | 'guest' }[]
      build?: { quantity?: number; unit_cost?: number | null; budget?: number | null; currency?: string; fab?: string }; later?: ('certify' | 'produce' | 'sustain')[]; apply?: boolean
    }
    /** read from the API's steps (lib/readers.ts readCreated): what was done, what failed, what waits */
    result: { repo: string; ok: boolean; done: string[]; failed: string[]; waits: Wait[] }
  }
  /** admin: what the project is (Settings): written to the journey record, not the repository */
  'project.update': {
    args: Repo & { name?: string; description?: string; icon?: string; build?: { quantity?: number; unit_cost?: number | null; budget?: number | null }; later?: ('certify' | 'produce' | 'sustain')[] }
    result: { repo: string; version: number }
  }
  'journey.get': { args: Repo; result: Journey }
  'journey.criterion.open': { args: Repo & { gate?: string; criterion?: string; waiver?: string }; result: { repo: string; opened: string; at: string; version: number } }
  'gate.sign': { args: Repo & { gate: string; notes?: string; acknowledge?: string[] }; result: { ok: true; started?: string[]; advanced_to: string | null; released: boolean; summary: string; snapshot: unknown } }
  'gate.return': { args: Repo & { gate: string; reason: string; reopen?: string }; result: { repo: string; reopened: string | null; summary: string } }
  'question.answer': { args: Repo & { question: string; option?: string; answer?: string; reason?: string }; result: { repo: string; summary: string } }
  /** `job`: the stuck agent's job id, or the stuck item's own id (an inbox item's questionId) */
  'stuck.dismiss': { args: Repo & { job: string; reason: string }; result: { repo: string; dismissed: { id: string; job_id: string | null; reason: string; by: string; at: string }; summary: string } }
  'waiver.add': { args: Repo & { target: { kind: 'criterion' | 'requirement' | 'finding' | 'test'; id: string }; reason: string; risk: string; severity: 'cosmetic' | 'degraded' | 'failure' | 'safety'; caught_where: string | null; scope?: string }; result: { repo: string; waiver: { id: string } } }
  inbox: { args: Record<string, never>; result: InboxItem[] }
  // the API's own shapes are read by lib/readers.ts (readThreads, readThread, readAppended, readRecall)
  'chats.list': { args: Repo & { query?: string; limit?: number }; result: ChatThread[] }
  'chats.get': { args: Repo & { thread: string; before?: string; limit?: number }; result: { thread: ChatThread; messages: ChatMessage[]; more?: boolean } }
  /** the person's own messages only (the API stores them as theirs whatever is sent); trace's replies are kept by the
   * chat agent itself (chats.reply, never callable from the app) */
  'chats.append': { args: Repo & { thread?: string; title?: string; messages: { text: string }[] }; result: { id: string; messageId: string; created?: boolean } }
  'chats.rename': { args: Repo & { thread: string; title: string }; result: unknown }
  'chats.recall': { args: Repo & { limit?: number }; result: string[] }
  'me.get': { args: Record<string, never>; result: MeDoc & { locks: Record<string, string> } }
  'me.set': { args: { key: string; value?: unknown; unset?: boolean }; result: { changed: boolean } }
  'graph.neighbourhood': { args: Repo & { focus: string; depth?: 1 | 2 | 3; memory?: boolean }; result: { focus: string; nodes: unknown[]; links: unknown[]; groups: unknown[]; truncated: boolean } }
  'files.list': { args: Repo; result: import('@/components/files/data').ListedFile[] }
  'files.url': { args: Repo & { path: string; commit?: string }; result: { url: string; mime?: string | null; size?: number } }
  // Operations, Admin and Preferences (src/api/actions.ts: integrations.*, prompts.*; shapes in lib/admin-types.ts)
  'integrations.list': { args: Record<string, never>; result: import('./admin-types').IntegrationStatus[] }
  'integrations.set': { args: { name: import('./admin-types').IntegrationName; values: Record<string, string> }; result: { name: string; secret: string; check: { ok: boolean; detail: string }; note?: string } }
  'integrations.remove': { args: { name: import('./admin-types').IntegrationName }; result: { name: string; removed: boolean } }
  'prompts.list': { args: { repo?: string }; result: import('./admin-types').PromptList }
  'prompts.get': { args: { repo?: string; id: string }; result: import('./admin-types').PromptView }
  'prompts.preview': { args: Repo & { target: string; job?: import('./admin-types').PreviewJob }; result: import('./admin-types').PromptPreview }
  'prompts.set': { args: { id: string; scope: 'installation' | 'project'; repo?: string; text: string; reason: string }; result: import('./admin-types').PromptWriteResult }
  'prompts.reset': { args: { id: string; scope: 'installation' | 'project'; repo?: string; reason: string }; result: import('./admin-types').PromptWriteResult }
  'prompts.revert': { args: { id: string; scope: 'installation' | 'project'; repo?: string; version: number | string; reason?: string }; result: import('./admin-types').PromptWriteResult }
  'prompts.history': { args: { id: string; scope: 'installation' | 'project'; repo?: string }; result: { id: string; scope: string; repo?: string; history: import('./admin-types').PromptHistoryEntry[] } }
  // gates, guided skills, new project and project tabs (src/api/actions-record.ts, actions-skills.ts, actions-jobs.ts)
  /** a skill's state for this person: steps, the quality bar from the record, the draft, and what the skill reads */
  'skill.get': { args: Repo & { skill: string }; result: import('./types-s1').SkillView }
  /** keep (data) or discard (null) this person's draft of a skill, in the journey store */
  'skill.draft': { args: Repo & { skill: string; step: number; data: Record<string, unknown> | null }; result: { kept: boolean; saved: string | null } }
  /** this person's drafts on the project, newest first */
  'skill.drafts': { args: Repo; result: { drafts: { skill: string; name: string; step: number; steps: number; saved: string }[] } }
  /** submit a skill's result: refused with what is missing unless every check is met or waived */
  'skill.submit': { args: Repo & { skill: string; draft: unknown }; result: { ok: true; id?: string; ref?: string; jobId?: string; started?: string[] } }
  /** each requirement's evidence status and the intent lines it is derived from */
  'requirements.trace': { args: Repo; result: import('./types-s1').TraceView }
  /** the architecture, the sheets with their drawings and requirements, the pin plan, the board; what is not recorded, in notes */
  'design.get': { args: Repo; result: import('./types-s1').DesignView }
  /** a person's decision about the design record: accept, edit or reject intent; strike a requirement; fix the criteria; choose an architecture; agree a pin plan */
  'design.decide': { args: Repo & { decision: import('./types-s1').DesignDecisionInput }; result: { ok: true; decision: { id: string; kind: string; target: string; choice: string; by: string; at: string }; summary: string } }
  /** releases, orders, boards */
  'build.get': { args: Repo; result: import('./types-s1').BuildView }
  /** record a placed order (number, paid cost, ship date) */
  'order.record': { args: Repo & { order?: string; number: string; paid: number | null; ship: string | null }; result: { ok: true; wait?: Wait } }
  /** the stage timeline; money for admins (cloud estimates and actuals from the cost ledger, orders); notes */
  'cost.get': { args: Repo; result: import('./types-s1').CostView }
  // the build after payment and cloud cost (src/api/actions-build.ts, actions-cost.ts)
  'order.update': { args: Repo & { order: string; state?: 'shipped' | 'delivered' | 'cancelled'; carrier?: import('./types-s1').Carrier; tracking?: string; ship?: string | null; note?: string }; result: { ok: true; wait: Wait | null; note?: string } }
  'order.check_now': { args: Repo & { order: string }; result: { ok: boolean; reason?: string } }
  'board.record': { args: Repo & { serial: string; order?: string; status?: string; notes?: string; photos?: string[] }; result: { ok: true; created: boolean } }
  'board.check': { args: Repo & { serial: string; check: string; kind: 'count' | 'visual' | 'fault' | 'hand' | 'label'; result: 'pass' | 'fail' | 'marked'; ref?: string; note?: string; photo?: string }; result: { ok: true } }
  'usage.month': { args: { month?: string }; result: import('./types-s1').UsageMonth }
  /** pause (a running task stops at its next safe point; a queued one is held), resume, move up, cancel */
  'job.control': { args: { id: string; op: JobOp; reason?: string; repo?: string }; result: { ok: boolean; kept?: string; reason?: string; state?: string | null; pausing?: boolean; held?: boolean; jobId?: string; position?: number } }
  /** the project's jobs (its job index), each agent's status, the hand-offs between its specialists, the remote jobs running */
  'jobs.list': { args: Repo; result: import('./types').ProjectJobs }
  /** decline a pending hand-off between specialists, with a reason in one line (contributors and admins) */
  'handoff.decline': { args: Repo & { id: string; reason: string }; result: { repo: string; declined: { id: string; reason: string; by: string; at: string }; job?: { cancelled: boolean; note: string }; summary: string } }
  // installation policy and people (src/api/actions-me.ts, actions-people.ts)
  'policy.get': { args: Record<string, never>; result: { locks: Record<string, string>; updated: string | null; by: string | null } }
  'installation.layout': { args: Record<string, never>; result: import('@/components/installation/layout').LayoutView }
  'policy.set': { args: { key: string; reason: string | null }; result: { locks: Record<string, string>; changed: boolean } }
  'users.history': { args: { who: string; limit?: number }; result: { sub: string; email: string | null; entries: { at: string; by: string; repo: string | null; action: 'assign' | 'unassign' | 'class'; detail: string | null; text: string }[] } }
  // connected systems, admins only (docs/external-access.md "Managing connected systems"; shapes in lib/services.ts)
  'services.list': { args: Record<string, never>; result: import('./services').ServiceList }
  'services.create': { args: { name: string; description?: string; scopes: import('./services').Scope[]; projects?: { repo: string; part: Part }[] }; result: import('./services').ServiceCreated }
  'services.update': { args: { name: string; description?: string; scopes?: import('./services').Scope[]; disabled?: boolean }; result: { service: import('./services').Service } }
  'services.assign': { args: { name: string; repo: string; part?: Part }; result: { name?: string; repo: string; part: Part } }
  'services.unassign': { args: { name: string; repo: string }; result: { removed: boolean } }
  'services.rotate': { args: { name: string }; result: { secret: string; secret_id: string } & import('./services').ServiceAddresses }
  'services.retire_secret': { args: { name: string; secret_id: string }; result: { removed: boolean } }
  'services.delete': { args: { name: string }; result: { deleted: true } }
  'services.history': { args: { name: string }; result: { entries: import('./services').ServiceHistoryEntry[] } }
}

export type ActionName = keyof Actions
export type ArgsOf<A extends ActionName> = Actions[A]['args']
export type ResultOf<A extends ActionName> = Actions[A]['result']

type Envelope<T> = { ok: true; result: T } | { ok: false; error: string; code?: string }

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const go = () => request<T>(path, { method: 'POST', body, token: token(), signal })
  try {
    return await go()
  } catch (e) {
    if (e instanceof HttpError && e.status === 401 && (await refresh())) return go()
    throw e
  }
}

/** Call one API action. */
export async function call<A extends ActionName>(action: A, args: ArgsOf<A>, o: { signal?: AbortSignal } = {}): Promise<ResultOf<A>> {
  let env: Envelope<ResultOf<A>>
  try {
    env = await post<Envelope<ResultOf<A>>>('/api/call', { action, ...args }, o.signal)
  } catch (e) {
    if (e instanceof HttpError) throw new ApiError(e.message, e.status, e.code)
    throw e
  }
  if (!env || typeof env !== 'object' || !('ok' in env)) return env as ResultOf<A>
  if (!env.ok) throw new ApiError(env.error, 200, env.code)
  const read = READERS[action]
  if (!read) return env.result
  try {
    return read(env.result, args as Record<string, unknown>) as ResultOf<A>
  } catch (e) {
    throw e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : String(e), 200)
  }
}

/** Any other authenticated /api endpoint (voice, ops, passkeys): JSON, with the same token and retry. */
export async function api<T>(path: string, o: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const go = () => request<T>(path, { ...o, token: token() })
  try {
    return await go()
  } catch (e) {
    if (e instanceof HttpError && e.status === 401 && (await refresh())) return go()
    if (e instanceof HttpError) throw new ApiError(e.message, e.status, e.code)
    throw e
  }
}

/** A project's display name from its repo slug (owner/soil-sensor → Soil sensor). */
export function projectName(repo: string): string {
  const name = repo.split('/').pop() ?? repo
  const words = name.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The project id used in addresses (/p/:id): the repo with its slash encoded as `~`. */
export const projectId = (repo: string): string => repo.replace('/', '~')
export const repoOf = (id: string): string => id.replace('~', '/')
