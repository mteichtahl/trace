/**
 * The inbox's `review` kind: a pull request a trace job opened that is still open. A job's work (requirements, a
 * schematic change, a fix) reaches the project's record only when its pull request is merged, so until then it needs
 * a person, though nothing else says so: Home said "Nothing needs you" over a finished job's open pull request.
 *
 * A pull request is the job's when its head branch is the branch a job of the project's index worked on (the job
 * index's `branch`); a person's own pull requests are not listed. Not blocking: questions and gates come first.
 */
import type { JobRow } from '../core/job-index.js'
import { type InboxItem, type StageId, ago } from '../core/journey.js'
import type { PullSummary } from './github.js'

/** The words for a job's agent (actions-jobs.ts AGENT_WORDS), passed in so this stays a plain function. */
export function reviewItems(o: {
  repo: string; project: string; stage: StageId; pulls: readonly PullSummary[]; jobs: readonly JobRow[]
  agentWords: Readonly<Record<string, string>>; at?: number
}): InboxItem[] {
  const byBranch = new Map<string, JobRow>()
  // the newest job on a branch names it (a resumed task works on its paused one's branch)
  for (const j of [...o.jobs].sort((a, b) => (a.endedAt ?? a.updatedAt) - (b.endedAt ?? b.updatedAt))) if (j.branch) byBranch.set(j.branch, j)
  const out: InboxItem[] = []
  for (const p of o.pulls) {
    const j = byBranch.get(p.head)
    if (!j) continue
    const who = j.agent ? `The ${o.agentWords[j.agent] ?? j.agent} agent` : 'A trace job'
    const t = j.endedAt ?? (Date.parse(p.updated_at) / 1000 || j.updatedAt)
    out.push({
      id: `review:${p.number}`, kind: 'review', repo: o.repo, project: o.project, stage: o.stage,
      summary: `${o.project}: ${who} opened pull request #${p.number}, "${p.title}"${p.draft ? ' (a draft)' : ''}. Its work counts once it is merged.`,
      since: new Date(t * 1000).toISOString(), waited: ago(t, o.at), blocking: false, action: 'Review on GitHub',
      ref: { kind: 'pull', id: String(p.number), url: p.url },
    })
  }
  return out
}
