/**
 * `call(action, args)`: the API runtime through POST /api/call, typed per action. Adds the bearer token (lib/auth)
 * and the body hash (lib/http); on a 401 it refreshes once and tries again. The API answers `{ ok, result }` or
 * `{ ok: false, error }`; `call` returns the result or throws an ApiError carrying the words to show.
 */
import { refresh, token } from './auth'
import { HttpError, request } from './http'
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

/** Every action the app calls: its arguments and its answer. */
export interface Actions {
  // existing (src/api/actions.ts)
  whoami: { args: Record<string, never>; result: { sub: string; email: string; groups: string[]; class: PersonClass | null } }
  projects: { args: Record<string, never>; result: ProjectRef[] }
  status: { args: Repo; result: { repo: string; default_branch: string; pulls: unknown[]; agent_fix_issues: unknown[]; runs: unknown[]; last_deploy: unknown } }
  'settings.get': { args: Repo; result: { repo: string; set: Record<string, unknown>; config: Record<string, unknown>; errors: string[] } }
  'settings.set': { args: Repo & { key: string; value?: unknown; unset?: boolean }; result: { branch: string; commit: string } }
  runs: { args: Repo & { kind?: string; limit?: number }; result: Record<string, unknown>[] }
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
  job: { args: { id: string; afterVersion?: number; waitS?: number }; result: JobView }
  'job.check_now': { args: { id: string; waitId: string }; result: { ok: boolean } }
  'tools.waits': { args: Repo & { afterVersion?: number; waitS?: number }; result: { repo: string; version: number | null; waits: Wait[] } }
  'tools.check_now': { args: Repo & { waitId: string }; result: { ok: boolean } }
  'users.list': { args: Record<string, never>; result: { email: string; sub: string; status: string; enabled: boolean; class: PersonClass | null; projects: string[] }[] }
  'users.invite': { args: { email: string; class?: PersonClass }; result: { sub: string; email: string; class: PersonClass } }
  'users.class': { args: { who: string; class: PersonClass }; result: { sub: string; class: PersonClass } }
  assign: { args: { who: string; repo: string; part?: Part }; result: unknown }
  unassign: { args: { who: string; repo: string }; result: { removed: boolean } }
  assignments: { args: { repo?: string }; result: { sub: string; email?: string; repo: string; part?: Part }[] }
  // new (docs/web-build.md)
  'project.members': { args: Repo; result: Member[] }
  'projects.create': { args: { name: string; description?: string; template: string; repository: { owner: string; name: string; existing?: boolean }; people?: { who: string; part: Part }[] } & Record<string, unknown>; result: { repo: string; done: string[]; waits: Wait[] } }
  'journey.get': { args: Repo; result: Journey }
  'journey.criterion.open': { args: Repo & { gate: string; criterion: string }; result: { ok: true } }
  'gate.sign': { args: Repo & { gate: string; notes?: string }; result: { ok: true; started?: string[] } }
  'gate.return': { args: Repo & { gate: string; reason: string }; result: { ok: true } }
  'question.answer': { args: Repo & { question: string; option?: string; answer?: string; reason?: string }; result: { ok: true } }
  'waiver.add': { args: Repo & { reason: string; risk: string; severity: string; caught: string; finding?: string }; result: { id: string } }
  inbox: { args: Record<string, never>; result: InboxItem[] }
  'chats.list': { args: Repo; result: ChatThread[] }
  'chats.get': { args: Repo & { id: string; before?: string; limit?: number }; result: { thread: ChatThread; messages: ChatMessage[]; more?: boolean } }
  'chats.append': { args: Repo & { id?: string; title?: string; message: Omit<ChatMessage, 'id' | 'at'> & { id?: string } }; result: { id: string; messageId: string } }
  'chats.rename': { args: Repo & { id: string; title: string }; result: { ok: true } }
  'chats.recall': { args: Repo & { limit?: number }; result: string[] }
  'me.get': { args: Record<string, never>; result: MeDoc }
  'me.set': { args: { key: string; value: unknown }; result: { ok: true } }
  'graph.neighbourhood': { args: Repo & { focus: string; depth?: 1 | 2 | 3 }; result: { nodes: unknown[]; links: unknown[] } }
  'files.list': { args: Repo; result: { path: string; kind: string; size: number; release?: string }[] }
  'files.url': { args: Repo & { path: string }; result: { url: string } }
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
  return env.result
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
