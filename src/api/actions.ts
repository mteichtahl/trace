/**
 * What a signed-in person can ask the API runtime to do. Each action names the access it needs, and that is checked
 * (access.require_ or admin) BEFORE anything else happens — before GitHub, Cognito, a clone or a job is touched — so
 * a project the person is not assigned to and a project that does not exist get the same answer: "no access".
 *
 *   action        needs                 does
 *   whoami        signed in             who you are: sub, email, groups, class
 *   projects      signed in             your projects and your role on each
 *   status        read                  open PRs, open agent-fix issues, recent trace workflow runs, the last deploy
 *   settings.get  read                  the project's settings (.trace/project.db on the default branch), resolved
 *   runs          read                  the project's run record (newest first; kind, limit)
 *   run           read                  one run: args, result, measurements, artifact list
 *   artifact      read                  one artifact's bytes (base64), at most 8 MB
 *   tools.list    read                  the tools (never the hardware ones), and which of them need write
 *   tool          read | write          run a tool on a fresh shallow clone; write for WRITE_TOOLS; hardware: never
 *   settings.set  write                 change (or unset) one setting: a commit on trace/settings-<slug>, pushed (the
 *                                       harness opens the PR); never the default branch
 *   task          write                 start a free-form task job (Claude, on a claude/ branch), requestedBy you
 *   job           read on its project   a job's state and log
 *   users.list    admin                 every person: email, status, class, assigned projects
 *   users.invite  admin                 create the person in Cognito (email, class) → sub
 *   users.class   admin                 change a person's class (their Cognito group: exactly one of the three)
 *   assign        admin                 assign a person (email or sub) to a project
 *   unassign      admin                 remove them from it
 *   assignments   admin                 every assignment, optionally for one project
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import {
  AccessDenied, CLASSES, GROUPS, type PersonClass, type Principal, RepoSlug, type Role,
  assign, assignments, classOf, isAdmin, projectsFor, require_, setClass, unassign,
} from '../core/access.js'
import { readSettings, resolve, setValue, unset } from '../core/config.js'
import { type AnyTool, Registry, ToolError } from '../core/registry.js'
import { Work } from '../core/store.js'
import type { CognitoAdmin, CognitoUser } from './aws.js'
import type { GitHubApi } from './github.js'

export const PROJECT_DB_PATH = '.trace/project.db'
const MAX_ARTIFACT = 8 * 1024 * 1024

/** Tools that change state outside their scratch clone (the shared datasheet library and parts links): write. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['datasheets.add', 'datasheets.acknowledge', 'parts.fetch_datasheet'])

/** Tool arguments that name files: they must stay inside the clone. `library` (another store) is refused outright. */
const PATH_KEYS = new Set(['path', 'file', 'files', 'schematic', 'project', 'board', 'pcb', 'out_dir', 'models', 'include_dirs', 'dir', 'root'])
const FORBIDDEN_KEYS = new Set(['library'])

export class ActionError extends Error {
  override name = 'ActionError'
}

/** "no access": the one answer for a project that is not yours, whether or not it exists. */
export const NO_ACCESS = 'no access'

export interface JobsApi {
  startJob(payload: { kind: 'task'; repository: string; request: string; requestedBy: string }): Promise<{ accepted: boolean; jobId: string; reason?: string | undefined }>
  jobStatus(jobId?: string): Promise<readonly { id: string; kind: string; repository?: string | undefined; [k: string]: unknown }[]>
}

export interface Checkout { dir: string; cleanup(): void }

export interface ActionDeps {
  github: () => Promise<GitHubApi>
  cognito: () => CognitoAdmin
  jobs: () => Promise<JobsApi>
  tools: () => Registry
  /** A fresh shallow clone of the repository's default branch. */
  checkout: (repo: string) => Promise<Checkout>
  /** Where temporary files go. */
  scratch: string
}

export interface Context { principal: Principal; deps: ActionDeps }

type Need = 'signed-in' | 'read' | 'write' | 'admin' | 'tool' | 'job'

interface Action<S extends z.ZodType> {
  need: Need
  args: S
  run: (a: z.output<S>, ctx: Context) => Promise<unknown>
}

const def = <S extends z.ZodType>(need: Need, args: S, run: (a: z.output<S>, ctx: Context) => Promise<unknown>): Action<S> => ({ need, args, run })

const Repo = z.object({ repo: RepoSlug })
const Who = z.string().min(1).max(320)
const Cls = z.enum(CLASSES)

// ------------------------------------------------------------------ helpers

function tempDb(scratch: string, bytes: Uint8Array | null): { root: string; db: string; cleanup(): void } {
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(join(scratch, 'trace-api-'))
  mkdirSync(join(root, '.trace'))
  const db = join(root, PROJECT_DB_PATH)
  if (bytes) writeFileSync(db, bytes)
  return { root, db, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

async function withProjectDb<T>(ctx: Context, repo: string, fn: (db: string, root: string) => T | Promise<T>): Promise<T> {
  const gh = await ctx.deps.github()
  const { branch } = await gh.defaultBranch(repo)
  const t = tempDb(ctx.deps.scratch, await gh.rawFile(repo, PROJECT_DB_PATH, branch))
  try {
    return await fn(t.db, t.root)
  } finally {
    t.cleanup()
  }
}

const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'change'

/** Resolve a person (email or sub) in Cognito; an unknown one is reported as such (admins only reach this). */
async function person(ctx: Context, who: string): Promise<CognitoUser> {
  const u = await ctx.deps.cognito().find(who)
  if (!u) throw new ActionError(`no such person: ${who}`)
  return u
}

function checkPaths(args: unknown, root: string, key = ''): void {
  if (Array.isArray(args)) { for (const v of args) checkPaths(v, root, key); return }
  if (args !== null && typeof args === 'object') {
    for (const [k, v] of Object.entries(args)) {
      if (FORBIDDEN_KEYS.has(k)) throw new ActionError(`${k}: not available through the API`)
      checkPaths(v, root, PATH_KEYS.has(k) ? k : key)
    }
    return
  }
  if (key && typeof args === 'string') {
    const full = resolvePath(root, args)
    const rel = relative(root, full)
    if (isAbsolute(args) || rel.startsWith('..') || isAbsolute(rel)) throw new ActionError(`${key}: must be a path inside the repository`)
  }
}

const toolNeed = (t: AnyTool): Role => (WRITE_TOOLS.has(t.name) ? 'write' : 'read')

/** One tool call at a time per process: tools resolve the project from the working directory. */
let toolQueue: Promise<unknown> = Promise.resolve()
function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const next = toolQueue.then(fn, fn)
  toolQueue = next.catch(() => undefined)
  return next
}

// ------------------------------------------------------------------ the actions

const ToolArgs = z.object({ repo: RepoSlug, name: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/), args: z.record(z.string(), z.unknown()).default({}) })

export const ACTIONS = {
  whoami: def('signed-in', z.object({}), async (_a, { principal: p }) => ({ sub: p.sub, email: p.email, groups: p.groups, class: classOf(p) })),

  projects: def('signed-in', z.object({}), async (_a, { principal }) => projectsFor(principal)),

  status: def('read', Repo, async ({ repo }, ctx) => {
    const gh = await ctx.deps.github()
    const { branch } = await gh.defaultBranch(repo)
    const t = tempDb(ctx.deps.scratch, await gh.rawFile(repo, PROJECT_DB_PATH, branch))
    let label = 'agent-fix'
    try {
      label = resolve(readSettings(t.db)).config.labels.agent_fix
    } finally {
      t.cleanup()
    }
    const [pulls, issues, runs, deploy] = await Promise.all([gh.openPulls(repo), gh.openIssues(repo, label), gh.workflowRuns(repo, 60), gh.lastDeploy(repo)])
    const trace = runs.filter((r) => /(^|\/)trace-[^/]*\.ya?ml$/.test(r.path) || /^trace\b/i.test(r.name)).slice(0, 20)
    return { repo, default_branch: branch, pulls, agent_fix_issues: issues, runs: trace, last_deploy: deploy }
  }),

  'settings.get': def('read', Repo, async ({ repo }, ctx) => withProjectDb(ctx, repo, (db) => {
    const own = readSettings(db)
    const { config, errors } = resolve(own)
    return { repo, set: own, config, errors }
  })),

  runs: def('read', Repo.extend({ kind: z.string().max(100).optional(), limit: z.number().int().min(1).max(500).default(20) }), async (a, ctx) =>
    withProjectDb(ctx, a.repo, (db) => { const w = new Work(db); try { return w.runs(a.kind, a.limit) } finally { w.close() } })),

  run: def('read', Repo.extend({ id: z.string().min(1).max(64) }), async (a, ctx) => withProjectDb(ctx, a.repo, (db) => {
    const w = new Work(db)
    try {
      const r = w.run(a.id)
      if (!r) throw new ActionError(`no run ${a.id}`)
      return r
    } finally { w.close() }
  })),

  artifact: def('read', Repo.extend({ id: z.string().min(1).max(64), name: z.string().min(1).max(300) }), async (a, ctx) => withProjectDb(ctx, a.repo, (db) => {
    const w = new Work(db)
    try {
      const row = w.db.prepare('SELECT mime, bytes FROM artifacts WHERE run_id=? AND name=?').get(a.id, a.name)
      if (!row) throw new ActionError(`no artifact ${a.name} on run ${a.id}`)
      const bytes = row.bytes as Uint8Array
      if (bytes.length > MAX_ARTIFACT) throw new ActionError(`${a.name} is ${bytes.length} bytes; the API returns at most ${MAX_ARTIFACT}`)
      return { id: a.id, name: a.name, mime: row.mime === null ? null : String(row.mime), size: bytes.length, base64: Buffer.from(bytes).toString('base64') }
    } finally { w.close() }
  })),

  'tools.list': def('read', Repo, async (_a, ctx) => ctx.deps.tools().list().filter((t) => !t.hardware).map((t) => ({
    name: t.name, description: t.description, needs: toolNeed(t), input: Registry.jsonSchema(t),
  }))),

  tool: def('tool', ToolArgs, async (a, ctx) => {
    const t = ctx.deps.tools().get(a.name)
    if (!t || t.hardware) throw new ActionError(`no tool ${a.name}`)
    const co = await ctx.deps.checkout(a.repo)
    try {
      checkPaths(a.args, co.dir)
      return await serialised(async () => {
        const cwd = process.cwd()
        const env = process.env.TRACE_PROJECT_DB
        process.chdir(co.dir)
        process.env.TRACE_PROJECT_DB = join(co.dir, PROJECT_DB_PATH)
        try {
          return await ctx.deps.tools().call(a.name, a.args, { hardware: false, via: 'mcp' })
        } finally {
          process.chdir(cwd)
          if (env === undefined) delete process.env.TRACE_PROJECT_DB
          else process.env.TRACE_PROJECT_DB = env
        }
      })
    } finally {
      co.cleanup()
    }
  }),

  'settings.set': def('write', Repo.extend({ key: z.string().min(1).max(200), value: z.unknown().optional(), unset: z.boolean().default(false) }), async (a, ctx) => {
    if (!a.unset && a.value === undefined) throw new ActionError('give a value, or unset: true')
    const gh = await ctx.deps.github()
    const { branch: base, sha } = await gh.defaultBranch(a.repo)
    const blob = await gh.fileSha(a.repo, PROJECT_DB_PATH, base)
    const t = tempDb(ctx.deps.scratch, await gh.rawFile(a.repo, PROJECT_DB_PATH, base))
    try {
      const by = ctx.principal.email ?? ctx.principal.sub
      if (a.unset) {
        if (!unset(a.key, t.root)) throw new ActionError(`${a.key} is not set`)
      } else {
        setValue(a.key, a.value, t.root, by)
      }
      const branch = `trace/settings-${slugify(a.key)}-${Date.now().toString(36)}`
      if (branch === base) throw new ActionError('refusing to write the default branch')
      await gh.createBranch(a.repo, branch, sha)
      const message = a.unset ? `settings: unset ${a.key}` : `settings: ${a.key} = ${JSON.stringify(a.value)}`.slice(0, 200)
      const { commit } = await gh.putFile(a.repo, { path: PROJECT_DB_PATH, branch, content: readFileSync(t.db), message: `${message}\n\nRequested by ${by} through the trace API.`, sha: blob })
      return { repo: a.repo, branch, commit, key: a.key, ...(a.unset ? { unset: true } : { value: a.value }) }
    } finally {
      t.cleanup()
    }
  }),

  task: def('write', Repo.extend({ request: z.string().min(1).max(20_000) }), async (a, ctx) =>
    (await ctx.deps.jobs()).startJob({ kind: 'task', repository: a.repo, request: a.request, requestedBy: ctx.principal.email ?? ctx.principal.sub })),

  job: def('job', z.object({ id: z.string().min(1).max(64) }), async (a, ctx) => {
    const j = (await (await ctx.deps.jobs()).jobStatus(a.id))[0]
    if (!j) throw new AccessDenied(NO_ACCESS)
    if (!isAdmin(ctx.principal)) {
      if (!j.repository) throw new AccessDenied(NO_ACCESS)
      await require_(ctx.principal, j.repository, 'read')
    }
    return j
  }),

  'users.list': def('admin', z.object({}), async (_a, ctx) => {
    const cog = ctx.deps.cognito()
    const [users, ...members] = await Promise.all([cog.listUsers(), ...CLASSES.map((c) => cog.usersInGroup(GROUPS[c]))])
    const classes = new Map<string, PersonClass>()
    CLASSES.forEach((c, i) => { for (const u of members[i] ?? []) if (!classes.has(u.sub)) classes.set(u.sub, c) })
    const all = await assignments(ctx.principal)
    return users.map((u) => ({
      email: u.email, sub: u.sub, status: u.status, enabled: u.enabled, class: classes.get(u.sub) ?? null,
      projects: all.filter((x) => x.sub === u.sub).map((x) => x.repo),
    })).sort((x, y) => (x.email ?? x.sub).localeCompare(y.email ?? y.sub))
  }),

  'users.invite': def('admin', z.object({ email: z.string().email(), class: Cls.default('user') }), async (a, ctx) => {
    const cog = ctx.deps.cognito()
    if (await cog.find(a.email)) throw new ActionError(`${a.email} already has an account; use users.class to change their class`)
    const u = await cog.createUser(a.email)
    await cog.addToGroup(u.username, GROUPS[a.class])
    await setClass(ctx.principal, { sub: u.sub, email: a.email }, a.class)
    return { sub: u.sub, email: a.email, class: a.class, note: 'Cognito has emailed them a temporary password; they sign in with `trace login`.' }
  }),

  'users.class': def('admin', z.object({ who: Who, class: Cls }), async (a, ctx) => {
    const cog = ctx.deps.cognito()
    const u = await person(ctx, a.who)
    const now = await cog.groupsFor(u.username)
    const want = GROUPS[a.class]
    if (!now.includes(want)) await cog.addToGroup(u.username, want)
    for (const c of CLASSES) if (GROUPS[c] !== want && now.includes(GROUPS[c])) await cog.removeFromGroup(u.username, GROUPS[c])
    await setClass(ctx.principal, { sub: u.sub, email: u.email }, a.class)
    return { sub: u.sub, email: u.email, class: a.class, note: 'Takes effect when their access token next refreshes (within an hour).' }
  }),

  assign: def('admin', z.object({ who: Who, repo: RepoSlug }), async (a, ctx) => {
    const u = await person(ctx, a.who)
    return assign(ctx.principal, { sub: u.sub, email: u.email }, a.repo)
  }),

  unassign: def('admin', z.object({ who: Who, repo: RepoSlug }), async (a, ctx) => {
    const u = await person(ctx, a.who)
    return { sub: u.sub, email: u.email, repo: a.repo, removed: await unassign(ctx.principal, u.sub, a.repo) }
  }),

  assignments: def('admin', z.object({ repo: RepoSlug.optional() }), async (a, ctx) => assignments(ctx.principal, a.repo ? { repo: a.repo } : {})),
} satisfies Record<string, Action<z.ZodType>>

export type ActionName = keyof typeof ACTIONS
export const ACTION_NAMES = Object.keys(ACTIONS) as ActionName[]

/** The access an action needs, as published (`tool` depends on the tool). */
export const needOf = (name: ActionName): Need => ACTIONS[name].need

export interface Outcome { ok: true; result: unknown }

/**
 * Parse, authorise, then run. Throws AccessDenied (→ 403 "no access"), ActionError/ToolError/ZodError (→ ok:false).
 */
export async function perform(name: string, raw: Record<string, unknown>, ctx: Context): Promise<{ repo: string | null; result: unknown }> {
  if (!Object.hasOwn(ACTIONS, name)) throw new ActionError(`unknown action ${JSON.stringify(name)}`)
  const action = ACTIONS[name as ActionName] as Action<z.ZodType>
  const parsed = action.args.safeParse(raw)
  if (!parsed.success) throw new ActionError(`${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ')}`)
  const args = parsed.data as Record<string, unknown>
  const repo = typeof args.repo === 'string' ? args.repo : null
  const p = ctx.principal
  switch (action.need) {
    case 'signed-in': case 'job': break
    case 'admin': if (!isAdmin(p)) throw new AccessDenied('admins only'); break
    case 'read': case 'write': await require_(p, repo ?? '', action.need); break
    case 'tool': {
      await require_(p, repo ?? '', 'read')
      const t = ctx.deps.tools().get(String(args.name))
      if (t && toolNeed(t) === 'write') await require_(p, repo ?? '', 'write')
      break
    }
  }
  return { repo, result: await action.run(args, ctx) }
}

export { ToolError }

// ------------------------------------------------------------------ the real checkout

const run = promisify(execFile)

/** A shallow clone of `repo`'s default branch under `workspace`; the token reaches git only through the environment. */
export function gitCheckout(token: () => Promise<string>, workspace: string): (repo: string) => Promise<Checkout> {
  return async (repo) => {
    const slug = RepoSlug.parse(repo)
    mkdirSync(workspace, { recursive: true })
    const dir = mkdtempSync(join(workspace, 'api-clone-'))
    const cleanup = (): void => rmSync(dir, { recursive: true, force: true })
    try {
      const auth = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${await token()}`).toString('base64')}`
      await run('git', ['clone', '--depth', '1', '--quiet', '--', `https://github.com/${slug}.git`, dir], {
        env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: auth, GIT_TERMINAL_PROMPT: '0' },
        timeout: 300_000, maxBuffer: 4 * 1024 * 1024,
      })
      return { dir, cleanup }
    } catch (e) {
      cleanup()
      // git's message may name the URL; never the token, which is only in the environment.
      throw new ActionError(`cannot clone ${slug}: ${e instanceof Error ? e.message.split('\n')[0] ?? 'git failed' : 'git failed'}`)
    }
  }
}

export const defaultScratch = (): string => process.env.TRACE_WORKSPACE ? join(process.env.TRACE_WORKSPACE, 'api') : join(tmpdir(), 'trace-api')
