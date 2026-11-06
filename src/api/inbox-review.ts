/**
 * The inbox's `review` kind: a change trace made (a pull request a trace job opened) that is still open. A job's work
 * (requirements, a schematic change, a fix) reaches the project's record only when it is accepted, so until then it
 * needs a person, though nothing else says so: Home said "Nothing needs you" over a finished job's open pull request.
 *
 * A pull request is the job's by the rule of src/api/changes.ts traceJob (its branch lives in the repository itself
 * and is one of trace's own, a task's or a hand-off's, opened by trace's login when that is known); a person's own
 * pull requests, and a fork's that borrows a trace branch's name, are not listed. Not blocking:
 * questions and gates come first. It is reviewed in the app (docs/guided-flow.md): the item links to the change's
 * review page (`to`); GitHub's link stays in `url` for the small "View on GitHub".
 */
import { type AppEdit, EDIT_WORDS } from '../core/app-edits.js'
import type { JobRow } from '../core/job-index.js'
import { type InboxItem, type StageId, ago } from '../core/journey.js'
import { type TraceRule, creditedAgent, editOf, editsByBranch, jobsByBranch, traceJob } from './changes.js'
import type { PullSummary } from './github.js'
import type { StuckChecks } from './stuck-checks.js'

/** The app's id of a project in its paths: owner~name (web/src/lib/api.ts projectId). */
export const projectPathId = (repo: string): string => repo.replace('/', '~')

/** The words for a job's agent (actions-jobs.ts AGENT_WORDS), passed in so this stays a plain function. */
export function reviewItems(o: {
  repo: string; project: string; stage: StageId; pulls: readonly PullSummary[]; jobs: readonly JobRow[]; rule: TraceRule
  agentWords: Readonly<Record<string, string>>; at?: number
  /** a change's checks that cannot start, by its head commit (src/api/stuck-checks.ts stuckFor): said instead of
   * "its work counts once you accept it", which no one can do while they wait (test-esp32 log #146) */
  stuck?: ((sha: string | undefined) => StuckChecks | null) | undefined
}): InboxItem[] {
  const byBranch = jobsByBranch(o.jobs, o.rule)
  const out: InboxItem[] = []
  for (const p of o.pulls) {
    const j = traceJob(p, byBranch, o.rule)
    if (!j) continue
    const a = creditedAgent(j)
    const who = a ? `The ${o.agentWords[a] ?? a} agent` : 'A trace job'
    const t = j.endedAt ?? (Date.parse(p.updated_at) / 1000 || j.updatedAt)
    const stuck = o.stuck?.(p.sha) ?? null
    out.push({
      id: `review:${p.number}`, kind: 'review', repo: o.repo, project: o.project, stage: o.stage,
      summary: stuck
        ? `${o.project}: the checks of "${p.title}" cannot start: ${stuck.why}. ${stuck.fix}`
        : `${o.project}: ${who} made a change, "${p.title}"${p.draft ? ' (a draft)' : ''}. Its work counts once you accept it.`,
      since: new Date(t * 1000).toISOString(), waited: ago(t, o.at), blocking: false, action: stuck ? 'See why' : 'Review the change',
      ref: { kind: 'pull', id: String(p.number), url: p.url, to: `/p/${projectPathId(o.repo)}/changes/${p.number}` },
    })
  }
  return out
}

/**
 * The inbox's `review` items for people's app edits (docs/stay-in-trace.md): only a `review` edit (someone who is not an
 * admin made it) waits on a person, an admin who did not make it, so only admins are shown it, and never its author. An
 * `auto` edit needs nobody: trace applies it.
 */
export function editReviewItems(o: {
  repo: string; project: string; stage: StageId; pulls: readonly PullSummary[]; edits: readonly AppEdit[]
  viewer: { admin: boolean; sub: string }; at?: number
}): InboxItem[] {
  if (!o.viewer.admin) return []
  const byBranch = editsByBranch(o.edits)
  const out: InboxItem[] = []
  for (const p of o.pulls) {
    const e = editOf(p, byBranch, o.repo)
    if (!e || e.applies !== 'review' || e.by_sub === o.viewer.sub) continue
    const t = Date.parse(e.at) / 1000 || Date.parse(p.updated_at) / 1000
    out.push({
      id: `review:${p.number}`, kind: 'review', repo: o.repo, project: o.project, stage: o.stage,
      summary: `${o.project}: ${e.by_name} made ${EDIT_WORDS[e.kind]}, "${e.title}". It applies once an admin accepts it.`,
      since: new Date(t * 1000).toISOString(), waited: ago(t, o.at), blocking: false, action: 'Review the change',
      ref: { kind: 'pull', id: String(p.number), url: p.url, to: `/p/${projectPathId(o.repo)}/changes/${p.number}` },
    })
  }
  return out
}
