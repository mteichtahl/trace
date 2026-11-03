/**
 * Deploy approvals given in the app (docs/stay-in-trace.md "2. Deploys", decision B): the record a person's Deploy or
 * Roll back writes, which the deploy workflow reads with its own AWS role before it touches anything.
 *
 *   where     the central bucket, projects/<slug>/journey/deploys/<sha>-<base36 time>.json: one plain JSON object per
 *             approval, written once (a conditional put, If-None-Match) and never changed. It is inside the journey's
 *             folder, one of PEOPLE_RECORDS (src/infra/project.ts): the API writes there with conditional puts only, and
 *             the agents' and the workflows' roles read it and are denied writing it, so an agent can never approve a
 *             deploy (it cannot write the record, and a name that has no record deploys nothing). No IAM change: a new
 *             prefix would push the roles' inline policies over their size
 *   name      what trace hands the workflow (workflow_dispatch input `approval`): the file name only, never a path, so
 *             the workflow reads under its own project's folder and nowhere else
 *   check     approvalRefusal: the record exists, names this repository and the commit the workflow was asked for, and
 *             has not expired (two hours after it was given). The workflow then runs today's checks too (the build
 *             passed, the commit is on the default branch, and for a deploy, it is the newest commit that passed)
 *
 * Both sides use this file: the API runtime (src/api/actions-deploys.ts) writes and lists records, and the harness
 * (src/harness/deploy.ts) reads one. It imports only the store and the project name rule, so the harness bundle stays
 * small.
 */
import { z } from 'zod'
import { type Backend, Conflict, backendFor } from './central.js'
import { PROJECTS_PREFIX, projectSlug } from './project.js'

/** The folder under a project's own prefix (projects/<slug>/journey/deploys): inside the journey's, one of PEOPLE_RECORDS. */
export const DEPLOYS = 'journey/deploys'

/** How long an approval stays good: long enough for a busy runner to pick the run up. It is also used once only, and
 * only while it is the project's newest (useApproval): an older one cannot be replayed. */
export const APPROVAL_TTL_MS = 30 * 60_000

/**
 * Where a used approval is marked: projects/<slug>/journey-agent/deploy-used/<name>, written once (If-None-Match) by the
 * workflow that deploys it. The workflows' role may write journey-agent/ with conditional puts only; an agent could
 * at most mark an approval used before it ran, which stops a deploy (the safe side) and never starts one.
 */
export const USED = 'journey-agent/deploy-used'
export const usedKey = (repo: string, name: string): string => `${projectSlug(repo)}/${USED}/${name}`

const Sha = z.string().regex(/^[0-9a-f]{40}$/)

export const DeployApproval = z.object({
  repo: z.string(),
  /** the exact commit the person was shown */
  sha: Sha,
  /** deploy: the open request's commit; rollback: a commit that ran before */
  action: z.enum(['deploy', 'rollback']),
  /** label(principal): the email, for the decisions log */
  by: z.string(),
  /** who gave it, matched only, never shown */
  by_sub: z.string(),
  /** their name in the user pool, else their initials: what reports show */
  by_name: z.string(),
  at: z.string(),
  expires: z.string(),
  /** the deploy request the approval answers (deploy), or the request that recorded what runs now (rollback) */
  issue: z.number().int().positive().nullable(),
}).loose()
export type DeployApproval = z.infer<typeof DeployApproval>

/** An approval's file name: the commit, then the time it was given in base 36 (sorts by commit, unique per moment). */
export const APPROVAL_NAME = /^([0-9a-f]{40})-([0-9a-z]{1,12})\.json$/
export const approvalName = (sha: string, at: Date): string => `${sha}-${at.getTime().toString(36)}.json`
/** When the approval named `name` was given (ms), or null for a name that is not one. */
export function approvalTime(name: string): number | null {
  const m = APPROVAL_NAME.exec(name)
  if (!m) return null
  const t = Number.parseInt(m[2]!, 36)
  return Number.isFinite(t) ? t : null
}

/** The object key of an approval, under the projects prefix. */
export const approvalKey = (repo: string, name: string): string => `${projectSlug(repo)}/${DEPLOYS}/${name}`

/**
 * Why this record may not deploy `sha` to `repo` now, or null when it may. Missing, another repository's, another
 * commit's, expired or unreadable: each refuses, in words the deploy request shows.
 */
export function approvalRefusal(rec: DeployApproval | null, o: { repo: string; sha: string; now?: number }): string | null {
  const now = o.now ?? Date.now()
  if (!rec) return 'No approval was found for this deploy in trace'
  if (rec.repo.toLowerCase() !== o.repo.toLowerCase()) return 'The approval is for another project'
  if (!/^[0-9a-f]{40}$/.test(o.sha)) return 'The deploy names no commit'
  if (rec.sha !== o.sha) return `The approval is for ${rec.sha.slice(0, 12)}, not ${o.sha.slice(0, 12)}`
  const expires = Date.parse(rec.expires)
  if (!Number.isFinite(expires) || expires <= now) return 'The approval has expired: approve it again in trace'
  // a record dated ahead of now is not one the API wrote (its clock is the source of `at`)
  const at = Date.parse(rec.at)
  if (!Number.isFinite(at) || at > now + 5 * 60_000 || expires - at > APPROVAL_TTL_MS + 60_000) return 'The approval is not one trace wrote'
  return null
}

/**
 * The central bucket's `projects` prefix from TRACE_HOME: its sibling (s3://b/central → s3://b/projects; a local
 * TRACE_HOME → <TRACE_HOME>/projects), as src/core/agent-facts.ts projectsFromEnv finds it for the agents. Null when
 * TRACE_HOME is not set. (Kept here so the harness does not bundle the journey code agent-facts.ts brings.)
 */
export function projectsHome(traceHome: string | undefined): string | null {
  const central = traceHome?.trim().replace(/\/+$/, '')
  if (!central) return null
  const s3 = /^s3:\/\/([^/]+)(\/.*)?$/.exec(central)
  if (s3) {
    const parts = (s3[2] ?? '').split('/').filter(Boolean)
    parts.pop()
    return `s3://${s3[1]}/${[...parts, PROJECTS_PREFIX].join('/')}`
  }
  return `${central.replace(/^file:\/\//, '')}/${PROJECTS_PREFIX}`
}

/** The approvals of the projects, in the central bucket's projects prefix (storeAt(ctx, PROJECTS_PREFIX), or
 * backendFor(projectsHome(TRACE_HOME)) in the workflow). */
export class DeployApprovals {
  constructor(private readonly store: Backend) {}

  /** The store at TRACE_HOME's projects prefix, or null when TRACE_HOME is not set. */
  static fromHome(traceHome: string | undefined): DeployApprovals | null {
    const where = projectsHome(traceHome)
    return where ? new DeployApprovals(backendFor(where)) : null
  }

  /** Write a new approval and answer its name. Written once: a name already taken is a Conflict (the store's), never
   * an overwrite. */
  async put(a: DeployApproval): Promise<string> {
    const rec = DeployApproval.parse(a)
    const name = approvalName(rec.sha, new Date(rec.at))
    await this.store.put(approvalKey(rec.repo, name), new TextEncoder().encode(JSON.stringify(rec)), { ifNoneMatch: true, contentType: 'application/json' })
    return name
  }

  /** The approval `name` of `repo`, or null: no such record, a name that is not an approval's, or one that does not
   * read (never trusted). */
  async get(repo: string, name: string): Promise<DeployApproval | null> {
    if (!APPROVAL_NAME.test(name)) return null
    const got = await this.store.get(approvalKey(repo, name))
    if (!got) return null
    let raw: unknown
    try { raw = JSON.parse(new TextDecoder().decode(got.body)) } catch { return null }
    const p = DeployApproval.safeParse(raw)
    return p.success ? p.data : null
  }

  /**
   * Take approval `name` of `repo` for one deploy: refused (a reason) unless it is the project's newest approval and has
   * not been used. Marks it used before answering, so a replay (a second dispatch, a re-run) finds it taken.
   */
  async use(repo: string, name: string): Promise<string | null> {
    const newest = (await this.recent(repo, 1))[0]?.name
    if (newest !== name) return 'A newer approval was given in trace since this one: only the newest deploys'
    try {
      await this.store.put(usedKey(repo, name), new TextEncoder().encode(JSON.stringify({ used: new Date().toISOString() })), { ifNoneMatch: true, contentType: 'application/json' })
    } catch (e) {
      if (e instanceof Conflict) return 'This approval was used already: approve it again in trace'
      throw e
    }
    return null
  }

  /** The newest `max` approvals of `repo`, newest first, each with its name. */
  async recent(repo: string, max = 10): Promise<{ name: string; approval: DeployApproval }[]> {
    const prefix = `${projectSlug(repo)}/${DEPLOYS}/`
    const names = (await this.store.list(prefix)).map((k) => k.slice(k.lastIndexOf('/') + 1))
      .map((name) => ({ name, t: approvalTime(name) })).filter((x): x is { name: string; t: number } => x.t !== null)
      .sort((a, b) => b.t - a.t).slice(0, max)
    const out: { name: string; approval: DeployApproval }[] = []
    for (const { name } of names) {
      const a = await this.get(repo, name).catch(() => null)
      if (a && a.repo.toLowerCase() === repo.toLowerCase()) out.push({ name, approval: a })
    }
    return out
  }
}
