/**
 * What every API action is built from, shared by src/api/actions.ts and the per-area action files
 * (src/api/actions-<area>.ts), so neither imports the other: the dependencies an action may use, the context it runs
 * in, `def` (an action: the access it needs, its zod arguments, what it does), and the helpers that read and write a
 * project's database through GitHub.
 *
 * A project's database is read from GitHub, never from a clone: the default branch's .trace/project.db is fetched
 * into a temporary folder, read, and removed. Its writes (settings, prompts, a release's copy of the journey) are
 * commits on a new branch per change (trace/settings-…, trace/prompts-…, trace/release-…), made with GitHub's
 * contents API with the blob sha it was read at; their pull requests wait for a person, because .trace/** is a
 * protected path.
 *
 * The journey record is not in the repository while it is live: it is in the central bucket (src/core/journey-store.ts,
 * projects/<slug>/journey/journey.db, conditional puts), and copied into .trace/project.db when a release is cut. The
 * agents' facts (src/core/agent-facts.ts, projects/<slug>/journey-agent/facts.db) are read beside it and merged in.
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
import { AgentFactsStore, loadAgentFacts } from '../core/agent-facts.js'
import { type AgentFacts, copyJourneyTables } from '../core/journey.js'
import { JourneyStore } from '../core/journey-store.js'
import { PROJECTS_PREFIX } from '../core/project.js'
import { PROJECT_SCHEMA, open, projectTables, traceHome } from '../core/store.js'
import type { InstallationPrompts } from '../prompts/store.js'
import type { RetrieveClient } from '../tools/kb/search.js'
import type { ApiOnboardResult } from '../installer/onboard-api.js'
import type { CognitoAdmin } from './aws.js'
import type { GitHubApi } from './github.js'

export const PROJECT_DB_PATH = '.trace/project.db'
export const MAX_ARTIFACT = 8 * 1024 * 1024

export class ActionError extends Error {
  override name = 'ActionError'
}

/** "no access": the one answer for a project that is not yours, whether or not it exists. */
export const NO_ACCESS = 'no access'

export interface JobsApi {
  /** The project a job id belongs to (read from the id itself), or null for an id that is not one of ours. */
  repositoryOf(jobId: string): string | null
  startJob(payload: { kind: 'task'; repository: string; request: string; requestedBy: string; requestedBySub?: string; agent?: (typeof TASK_AGENTS)[number] }): Promise<{ accepted: boolean; jobId: string; reason?: string | undefined }>
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
  /**
   * Cancel one running job on its worker (invocation kind `cancel`): its answer once the job has stopped (or a short
   * grace passed). Absent: this installation cannot cancel from the API.
   */
  cancel?(jobId: string, reason: string): Promise<{ ok: boolean; state: string | null; kept?: string | undefined; reason?: string | undefined }>
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
  /** Ask the order watch (src/infra/lambda/order-watch.ts) to check one order now; absent: there is none to ask. */
  orderWatch?: (repo: string, orderId: string) => Promise<void>
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

/** Who did it, for people to read in a commit or a record: the email (else the sub). Display only: never matched on,
 * because a person's email can change and the sub cannot. */
export const label = (p: Principal): string => p.email ?? p.sub
/** Who did it, where only a match is needed: the agents' memory hash of the person's sub (Cognito's immutable id).
 * Never the email. */
export const hashOf = (p: Principal): string => personHash(p.sub)
/**
 * Every hash a person's own marks may be recorded under: the sub's (now), and the email's, which records written
 * before identity was keyed on the sub carry (journey opens, questions asked of them, chat authorship, memory marks
 * and person memory). Read-side only: nothing new is written under the email's hash.
 */
export const hashesOf = (p: Principal): string[] => [...new Set([personHash(p.sub), ...(p.email ? [personHash(p.email)] : [])])]

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

/**
 * One project's journey store (src/core/journey-store.ts) in the central bucket, importing an older repository's
 * record (its .trace/project.db on the default branch) the first time it is read.
 */
export function journeyStore(ctx: Context, repo: string): JourneyStore {
  return new JourneyStore(storeAt(ctx, PROJECTS_PREFIX), repo, {
    scratch: ctx.deps.scratch,
    legacy: async () => {
      const gh = await ctx.deps.github()
      const { branch } = await gh.defaultBranch(repo)
      return gh.rawFile(repo, PROJECT_DB_PATH, branch)
    },
  })
}

/**
 * One project's agent facts (src/core/agent-facts.ts: projects/<slug>/journey-agent/facts.db): what its agents asked,
 * checked and got stuck on. The API only reads them (its role may not write there), and merges them into every view
 * of the journey.
 */
export const agentFactsStore = (ctx: Context, repo: string): AgentFactsStore => new AgentFactsStore(storeAt(ctx, PROJECTS_PREFIX), repo, { scratch: ctx.deps.scratch })

/** The agents' facts of one project as they are now (none yet: empty). */
export async function agentFacts(ctx: Context, repo: string): Promise<AgentFacts> {
  return (await agentFactsStore(ctx, repo).read((db) => loadAgentFacts(db))).result
}

/** Run fn on the journey as it is now (read only), with the record's version. */
export async function withJourneyDb<T>(ctx: Context, repo: string, fn: (db: DatabaseSync) => T): Promise<T> {
  return (await journeyStore(ctx, repo).read(fn)).result
}

/**
 * Change the journey record in its store: fn runs on a fresh copy and must be replayable (a lost race runs it again on
 * a fresh copy). `changed: false` (nothing to do): nothing is written. Answers fn's result with the record's version.
 */
export async function writeJourney<T>(ctx: Context, repo: string, fn: (db: DatabaseSync) => { result: T; changed?: boolean }): Promise<T & { version: number }> {
  const r = await plainly(() => journeyStore(ctx, repo).update(fn))
  return { ...r.result, version: r.version }
}

/**
 * The project's database from the default branch with its journey tables replaced by the live record (read only):
 * what the graph draws from, the requirements and runs of the repository beside the journey of the store.
 */
export async function withRecordDb<T>(ctx: Context, repo: string, fn: (db: DatabaseSync) => T): Promise<T> {
  const live = await journeyStore(ctx, repo).bytes()
  return withProjectDb(ctx, repo, (path, root) => {
    const db = openProjectDb(path)
    try {
      if (live) {
        const src = join(root, 'journey.db')
        writeFileSync(src, live)
        copyJourneyTables(db, src)
      }
      return fn(db)
    } finally {
      db.close()
    }
  })
}

/**
 * Copy the journey record into the repository: the default branch's .trace/project.db with its journey tables
 * replaced by the store's, committed on a new branch trace/release-<revision>-<time> (held for a person like every
 * change to .trace/**), the way settings.set writes. Returns the branch and commit.
 */
export async function snapshotJourney(ctx: Context, repo: string, why: string): Promise<{ branch: string; commit: string; revision: string }> {
  const bytes = await journeyStore(ctx, repo).bytes()
  if (!bytes) throw new ActionError('This project has no journey to copy yet.')
  const gh = await ctx.deps.github()
  const { branch: base, sha } = await gh.defaultBranch(repo)
  const blob = await gh.fileSha(repo, PROJECT_DB_PATH, base)
  const t = tempDb(ctx.deps.scratch, await gh.rawFile(repo, PROJECT_DB_PATH, base))
  const src = join(t.root, 'journey.db')
  writeFileSync(src, bytes)
  try {
    const db = openProjectDb(t.db)
    let revision = 'A'
    try {
      copyJourneyTables(db, src)
      revision = String((db.prepare("SELECT revision FROM journey WHERE id='current'").get() as { revision?: unknown } | undefined)?.revision ?? 'A')
    } finally {
      db.close()
    }
    const branch = `trace/release-${slugify(revision)}-${Date.now().toString(36)}`
    if (branch === base) throw new ActionError('refusing to write the default branch')
    await gh.createBranch(repo, branch, sha)
    const { commit } = await gh.putFile(repo, {
      path: PROJECT_DB_PATH, branch, content: readFileSync(t.db), sha: blob,
      message: `journey: the record of revision ${revision} (${why})\n\nRequested by ${label(ctx.principal)} through the trace API.`,
    })
    return { branch, commit, revision }
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
    if (e instanceof Error && ['JourneyError', 'JourneyStoreError', 'AgentFactError', 'PreferenceError', 'PartRefused', 'ChatError'].includes(e.name)) throw new ActionError(e.message)
    throw e
  }
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
  const own = new Set(hashesOf(ctx.principal).map((h) => `person/${h}`))
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
