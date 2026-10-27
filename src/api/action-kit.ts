/**
 * What every API action is built from, shared by src/api/actions.ts and the per-area action files
 * (src/api/actions-<area>.ts), so neither imports the other: the dependencies an action may use, the context it runs
 * in, `def` (an action: the access it needs, its zod arguments, what it does), and the helpers that read and write a
 * project's database through GitHub.
 *
 * A project's database is read from GitHub, never from a clone: the default branch's .trace/project.db is fetched
 * into a temporary folder, read, and removed. Writes are commits made with GitHub's contents API (a temporary copy
 * changed, then PUT with the blob sha it was read at, so a write that raced another is refused and re-run):
 *
 *   settings, prompts   a new branch per change (trace/settings-…, trace/prompts-…): its pull request waits for a
 *                       person, because .trace/** is a protected path
 *   the journey record  one standing branch, trace/journey (JOURNEY_BRANCH): every signature, answer, waiver and
 *                       opened evidence is a commit on it, naming the person, and the journey is READ from it while it
 *                       exists. Its pull request is held for a person like the others; once merged (and the branch
 *                       deleted) the next write starts it again from the default branch. This keeps the record live
 *                       between a person's steps (open the evidence, then sign) without ever writing the default
 *                       branch. Before a project's onboarding pull request is merged (trace/onboard still open, and
 *                       no trace/journey), the journey is read from and written to trace/onboard itself, so the
 *                       first journey state travels with the onboarding and the two never both add the database.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { type AgentMemory, type ProjectMemories, actorIn, personHash } from '../agents/runtime/memory.js'
import type { TASK_AGENTS, ToolJob } from '../agents/runtime/schemas.js'
import { AccessDenied, type Principal, RepoSlug, isAdmin } from '../core/access.js'
import { type Backend, backendFor } from '../core/central.js'
import type { IntegrationStore, checkIntegration } from '../core/integrations.js'
import type { Registry } from '../core/registry.js'
import '../core/journey.js'
import { PROJECT_SCHEMA, open, projectTables, traceHome } from '../core/store.js'
import type { InstallationPrompts } from '../prompts/store.js'
import type { RetrieveClient } from '../tools/kb/search.js'
import type { ApiOnboardResult } from '../installer/onboard-api.js'
import type { CognitoAdmin } from './aws.js'
import { GitHubError, type GitHubApi } from './github.js'

export const PROJECT_DB_PATH = '.trace/project.db'
export const MAX_ARTIFACT = 8 * 1024 * 1024
/** The standing branch the journey record is written on (see the module comment). */
export const JOURNEY_BRANCH = 'trace/journey'

export class ActionError extends Error {
  override name = 'ActionError'
}

/** "no access": the one answer for a project that is not yours, whether or not it exists. */
export const NO_ACCESS = 'no access'

export interface JobsApi {
  /** The project a job id belongs to (read from the id itself), or null for an id that is not one of ours. */
  repositoryOf(jobId: string): string | null
  startJob(payload: { kind: 'task'; repository: string; request: string; requestedBy: string; agent?: (typeof TASK_AGENTS)[number] }): Promise<{ accepted: boolean; jobId: string; reason?: string | undefined }>
  jobStatus(jobId?: string): Promise<readonly JobView[]>
  /**
   * One job as jobStatus, with its worker's change counter and open waits; with afterVersion and waitS the worker
   * holds the answer until the job changes after that version (or waitS passes). Absent: `job` answers jobStatus only.
   */
  watchJob?(jobId: string, o: { afterVersion?: number | undefined; waitS?: number | undefined; signal?: AbortSignal | undefined }): Promise<{ jobs: readonly JobView[]; version: number | null; waits: readonly WaitView[] }>
  /** Wake one timer wait on the job's worker (invocation kind `check-now`). Absent: there is nothing to wake. */
  checkNow?(jobId: string, waitId: string): Promise<boolean>
  /**
   * What the project's tool calls are waiting on (the waits open outside any job in its tool session), with that
   * worker's change counter; with afterVersion and waitS the worker holds the answer until one changes. Absent: none.
   */
  watchTools?(repository: string, o: { afterVersion?: number | undefined; waitS?: number | undefined; signal?: AbortSignal | undefined }): Promise<{ version: number | null; waits: readonly WaitView[] }>
  /** Wake one of those timer waits (invocation kind `check-now` in the tool session). Absent: there is nothing to wake. */
  checkToolWait?(repository: string, waitId: string): Promise<boolean>
  /** One tool call on the project's own worker runtime (invocation kind `tool`): its result, or throws ActionError.
   * Absent: this installation runs no tools for the API. */
  runTool?(payload: Omit<ToolJob, 'trace'>): Promise<unknown>
}

export interface JobView { id: string; kind: string; repository?: string | undefined; state: string; [k: string]: unknown }

/** One wait open on a worker (src/core/wait.ts WaitNotice), with the line a person reads. */
export interface WaitView { id: string; what: string; source: string; text: string; nextCheckAt?: string | null | undefined; [k: string]: unknown }

/** What projects.create asks of onboarding (src/installer/onboard-api.ts, with the API's GitHub token). */
export interface OnboardRequest { create: { template: 'empty' | 'python' | 'kicad' | 'rust'; private: boolean } | null; apply: boolean }

export interface ActionDeps {
  github: () => Promise<GitHubApi>
  cognito: () => CognitoAdmin
  jobs: () => Promise<JobsApi>
  /** The tool registry: what tools.list shows and what `tool` may ask for (the call itself runs on the worker). */
  tools: () => Registry
  /** Where temporary files go. */
  scratch: string
  /** Each project's memory (TRACE_PROJECT_MEMORIES); absent or null: memory.* answer that there is none. */
  memory?: () => ProjectMemories | null
  /** The installation's prompt overrides (src/prompts/store.ts); absent: the store at promptsHome(). */
  prompts?: () => InstallationPrompts
  /** Each project's knowledge base (TRACE_PROJECT_KBS: slug → id), and the Retrieve client; absent or empty: kb.*
   * answer that there is none. */
  kbs?: () => ReadonlyMap<string, string>
  retrieve?: () => Promise<RetrieveClient>
  /** The installation's optional integrations (TRACE_INTEGRATIONS_PREFIX); absent: integrations.* answer that there are none. */
  integrations?: () => Promise<IntegrationStore>
  /** Checks a key with its service (tests replace it). */
  checkIntegration?: typeof checkIntegration
  /** The central bucket under one prefix (chats, pending projects); absent: bucketStore (beside TRACE_HOME). */
  store?: (prefix: string) => Backend
  /** Onboard a repository with the API's own GitHub token; absent: projects.create says this installation cannot. */
  onboard?: (repo: string, o: OnboardRequest) => Promise<ApiOnboardResult>
}

export interface Context {
  principal: Principal
  deps: ActionDeps
  /** Aborts when the caller goes away: a held call (job, tools.waits) stops holding the worker too. */
  signal?: AbortSignal | undefined
}

export type Need = 'signed-in' | 'read' | 'write' | 'admin' | 'tool' | 'job' | 'prompts'

export interface Action<S extends z.ZodType> {
  need: Need
  args: S
  run: (a: z.output<S>, ctx: Context) => Promise<unknown>
  /** need 'prompts': the check, which depends on the arguments (a scope, an optional repo). Runs before `run`. */
  authorize?: (a: z.output<S>, p: Principal) => Promise<void>
}

export const def = <S extends z.ZodType>(need: Need, args: S, run: (a: z.output<S>, ctx: Context) => Promise<unknown>, authorize?: (a: z.output<S>, p: Principal) => Promise<void>): Action<S> =>
  ({ need, args, run, ...(authorize ? { authorize } : {}) })

export const Repo = z.object({ repo: RepoSlug })

/** Who did it, for people to read in a commit or a record: the email (else the sub). */
export const label = (p: Principal): string => p.email ?? p.sub
/** Who did it, where only a match is needed: the agents' memory hash of the email (else the sub). Never the email. */
export const hashOf = (p: Principal): string => personHash(p.email ?? p.sub)

// ------------------------------------------------------------------ the project database through GitHub

export function tempDb(scratch: string, bytes: Uint8Array | null): { root: string; db: string; cleanup(): void } {
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(join(scratch, 'trace-api-'))
  mkdirSync(join(root, '.trace'))
  // A .git marker makes this folder the project root for config.setValue/unset (store.findRoot), even when the
  // repository has no database yet — never a database somewhere above it.
  mkdirSync(join(root, '.git'))
  const db = join(root, PROJECT_DB_PATH)
  if (bytes) writeFileSync(db, bytes)
  return { root, db, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

export async function withProjectDb<T>(ctx: Context, repo: string, fn: (db: string, root: string) => T | Promise<T>): Promise<T> {
  const gh = await ctx.deps.github()
  const { branch } = await gh.defaultBranch(repo)
  const t = tempDb(ctx.deps.scratch, await gh.rawFile(repo, PROJECT_DB_PATH, branch))
  try {
    return await fn(t.db, t.root)
  } finally {
    t.cleanup()
  }
}

export const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'change'

/** The onboarding pull request's branch (src/core/onboard.ts ONBOARD_BRANCH). */
export const ONBOARDING_BRANCH = 'trace/onboard'

/**
 * Where the journey record is read and written: trace/journey while it exists; else trace/onboard while the
 * onboarding is not merged; else read from the default branch and written to a new trace/journey.
 */
export async function journeyRef(gh: GitHubApi, repo: string): Promise<{ ref: string; write: string; create: boolean; base: string; baseSha: string }> {
  const [{ branch: base, sha: baseSha }, journey, onboarding] = await Promise.all([
    gh.defaultBranch(repo), gh.branchSha(repo, JOURNEY_BRANCH), gh.branchSha(repo, ONBOARDING_BRANCH),
  ])
  if (journey) return { ref: JOURNEY_BRANCH, write: JOURNEY_BRANCH, create: false, base, baseSha }
  if (onboarding && base !== ONBOARDING_BRANCH) return { ref: ONBOARDING_BRANCH, write: ONBOARDING_BRANCH, create: false, base, baseSha }
  return { ref: base, write: JOURNEY_BRANCH, create: true, base, baseSha }
}

/** Run fn on the project's database as the journey sees it (read only: nothing is written back). */
export async function withJourneyDb<T>(ctx: Context, repo: string, fn: (db: DatabaseSync) => T): Promise<T> {
  const gh = await ctx.deps.github()
  const { ref } = await journeyRef(gh, repo)
  const t = tempDb(ctx.deps.scratch, await gh.rawFile(repo, PROJECT_DB_PATH, ref))
  try {
    const db = openProjectDb(t.db)
    try {
      return fn(db)
    } finally {
      db.close()
    }
  } finally {
    t.cleanup()
  }
}

/** The project database at `path` with every registered table (the journey's among them). */
export function openProjectDb(path: string): DatabaseSync {
  const db = open(path, { wal: false })
  db.exec(PROJECT_SCHEMA)
  for (const t of projectTables()) db.exec(t.sql)
  return db
}

/** A record's own refusal (a gate not ready, a vague answer, a guest as a contributor), as the person's error. */
export async function plainly<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof Error && ['JourneyError', 'PreferenceError', 'PartRefused', 'ChatError'].includes(e.name)) throw new ActionError(e.message)
    throw e
  }
}

const conflict = (e: unknown): boolean => e instanceof GitHubError && (e.status === 409 || e.status === 422)

/**
 * Change the journey record: fn runs on a fresh copy of the database (from trace/journey, or the default branch when
 * there is none yet), and the result is committed on trace/journey with a message naming the person. fn must be
 * replayable: when another write got in first, GitHub refuses the stale sha and the whole change runs again.
 * `changed` false (fn decided there was nothing to do): no commit.
 */
export async function writeJourney<T>(ctx: Context, repo: string, message: string, fn: (db: DatabaseSync) => { result: T; changed?: boolean }): Promise<T & { commit: string | null; branch: string }> {
  const gh = await ctx.deps.github()
  let last: unknown = null
  for (let attempt = 0; attempt < 4; attempt++) {
    const at = await journeyRef(gh, repo)
    if (at.write === at.base) throw new ActionError('refusing to write the default branch')
    // the blob sha the change starts from: GitHub refuses the write when the file moved on since (a new trace/journey
    // starts at the default branch's commit, so its file is the one read here)
    const blob = await gh.fileSha(repo, PROJECT_DB_PATH, at.ref)
    const t = tempDb(ctx.deps.scratch, await gh.rawFile(repo, PROJECT_DB_PATH, at.ref))
    try {
      const db = openProjectDb(t.db)
      let out: { result: T; changed?: boolean }
      try {
        out = fn(db)
      } finally {
        db.close()
      }
      if (out.changed === false) return { ...out.result, commit: null, branch: at.ref }
      try {
        if (at.create) await gh.createBranch(repo, at.write, at.baseSha)
        const { commit } = await gh.putFile(repo, {
          path: PROJECT_DB_PATH, branch: at.write, content: readFileSync(t.db), sha: blob,
          message: `${message.slice(0, 200)}\n\nRequested by ${label(ctx.principal)} through the trace API.`,
        })
        return { ...out.result, commit, branch: at.write }
      } catch (e) {
        if (!conflict(e)) throw e
        last = e
      }
    } finally {
      t.cleanup()
    }
  }
  throw new ActionError(`The journey record kept changing while this was being saved; try again. (${last instanceof Error ? last.message : String(last)})`)
}

// ------------------------------------------------------------------ the central bucket

/**
 * The central bucket under `prefix`, beside TRACE_HOME: s3://b/central → s3://b/<prefix>; a local TRACE_HOME →
 * <TRACE_HOME>/<prefix>.
 */
export function bucketStore(prefix: string, home: string = traceHome()): Backend {
  const s3 = /^s3:\/\/([^/]+)(\/.*)?$/.exec(home)
  if (s3) {
    const parts = (s3[2] ?? '').split('/').filter(Boolean)
    parts.pop()
    return backendFor(`s3://${s3[1]}/${[...parts, prefix].join('/')}`)
  }
  return backendFor(join(home.replace(/^file:\/\//, ''), prefix))
}

export const storeAt = (ctx: Context, prefix: string): Backend => (ctx.deps.store ?? bucketStore)(prefix)

// ------------------------------------------------------------------ memory

/**
 * Which of a project's memory a person may see (they passed the read check on `repo`): every agent's, and the
 * person-scoped preferences only when they are their own. An admin sees everyone's.
 */
export function memoryInclude(ctx: Context, repo: string): (ns: string) => boolean {
  if (isAdmin(ctx.principal)) return () => true
  const own = new Set([ctx.principal.email, ctx.principal.sub].filter((x): x is string => Boolean(x)).map((w) => `person/${personHash(w)}`))
  return (ns) => { const a = actorIn(ns, repo); return a !== null && (!a.startsWith('person/') || own.has(a)) }
}

/**
 * The project's own memory, after the access check: null when the installation has no memory at all; a project with
 * none here (not one of this installation's) gets the same "no access" as one the person is not assigned to.
 */
export function projectMemory(ctx: Context, repo: string): AgentMemory | null {
  const all = ctx.deps.memory?.() ?? null
  if (!all) return null
  const mem = all.forProject(repo)
  if (!mem) throw new AccessDenied(NO_ACCESS)
  return mem
}
