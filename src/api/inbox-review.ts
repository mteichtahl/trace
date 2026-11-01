/**
 * The inbox's `review` kind: a change trace made (a pull request a trace job opened) that is still open. A job's work
 * (requirements, a schematic change, a fix) reaches the project's record only when it is accepted, so until then it
 * needs a person, though nothing else says so: Home said "Nothing needs you" over a finished job's open pull request.
 *
 * A pull request is the job's when its head branch is the branch a job of the project's index worked on (the job
 * index's `branch`, src/api/changes.ts traceChanges); a person's own pull requests are not listed. Not blocking:
 * questions and gates come first. It is reviewed in the app (docs/guided-flow.md): the item links to the change's
 * review page (`to`); GitHub's link stays in `url` for the small "View on GitHub".
 */
import type { JobRow } from '../core/job-index.js'
import { type InboxItem, type StageId, ago } from '../core/journey.js'
import { jobsByBranch } from './changes.js'
import type { PullSummary } from './github.js'

/** The app's id of a project in its paths: owner~name (web/src/lib/api.ts projectId). */
export const projectPathId = (repo: string): string => repo.replace('/', '~')

/** The words for a job's agent (actions-jobs.ts AGENT_WORDS), passed in so this stays a plain function. */
export function reviewItems(o: {
  repo: string; project: string; stage: StageId; pulls: readonly PullSummary[]; jobs: readonly JobRow[]
  agentWords: Readonly<Record<string, string>>; at?: number
}): InboxItem[] {
  const byBranch = jobsByBranch(o.jobs)
  const out: InboxItem[] = []
  for (const p of o.pulls) {
    const j = byBranch.get(p.head)
    if (!j) continue
    const who = j.agent ? `The ${o.agentWords[j.agent] ?? j.agent} agent` : 'A trace job'
    const t = j.endedAt ?? (Date.parse(p.updated_at) / 1000 || j.updatedAt)
    out.push({
      id: `review:${p.number}`, kind: 'review', repo: o.repo, project: o.project, stage: o.stage,
      summary: `${o.project}: ${who} made a change, "${p.title}"${p.draft ? ' (a draft)' : ''}. Its work counts once you accept it.`,
      since: new Date(t * 1000).toISOString(), waited: ago(t, o.at), blocking: false, action: 'Review the change',
      ref: { kind: 'pull', id: String(p.number), url: p.url, to: `/p/${projectPathId(o.repo)}/changes/${p.number}` },
    })
  }
  return out
}
