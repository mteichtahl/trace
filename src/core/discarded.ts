/**
 * A change a person discarded stays discarded (test-esp32 log #75: change #12 was discarded with a reason; 15 minutes
 * later a Verification job pushed to the same branch, and the harness opened it again as #13, recommended for
 * accepting, with no word of the discard or its reason).
 *
 * Discarding (change.discard, src/api/actions-changes.ts) closes the pull request and comments the person's reason on it
 * with DISCARD_MARK. That comment on the closed pull request is what retires its branch, everywhere trace looks:
 *
 *   the harness's open-pr step (src/harness/prs.ts)    opens no pull request for a retired branch
 *   a job's runner (src/agents/runtime/job.ts)          a job that would work on a retired branch works on a new one
 *                                                       (afterBranch: `<branch>-after-<number>`) and is told the
 *                                                       person's reason, so it addresses it
 *   the open-pr step again, for that new branch         its pull request says it follows the discarded change, with
 *                                                       the reason
 *
 * GitHub is the record here because the harness runs in the project's own workflows and reads nothing else. A person's
 * words are posted neutralised (no `<!--`: src/api/actions-changes.ts neutralise), so the mark is only ever trace's.
 * Reopening the pull request on GitHub brings the branch back: an open pull request for it is never retired.
 */

/** Marks trace's comment on a discarded pull request. */
export const DISCARD_MARK = '<!-- trace: discarded -->'

/** A discarded change, as its pull request and trace's comment on it say. */
export interface Discarded {
  number: number
  branch: string
  /** the person's reason, as posted (already neutralised); empty when the comment could not be read */
  reason: string
  /** who discarded it, as the comment names them ("Ada Lovelace", "a person on the project (AL)") */
  by: string
}

/** trace's comment on a change it discards: who, their reason (quoted and neutralised by the caller), and what stopped. */
export function discardComment(o: { by: string; quoted: string; stopped?: readonly string[] | undefined }): string {
  return [
    `Discarded by ${o.by}:`, '', o.quoted, '',
    ...(o.stopped?.length ? [`${o.stopped.join(' ')}`, ''] : []),
    'trace will not open this branch again as a change. Work that is still wanted goes on a new branch, and its change links this one.',
    DISCARD_MARK,
  ].join('\n')
}

/**
 * The person's reason and name from trace's discard comment, or null when it is not one. A comment from before the mark
 * ("Discarded by …:" then the quote) is read the same way: those were trace's too.
 */
export function readDiscard(body: string): { by: string; reason: string } | null {
  const m = /^Discarded by (.{1,200}?):\r?\n/.exec(body)
  if (!m) return null
  if (!body.includes(DISCARD_MARK) && !/^Discarded by .{1,200}?:\r?\n\r?\n> /.test(body)) return null
  const quote: string[] = []
  for (const l of body.slice(m[0].length).split(/\r?\n/)) {
    if (l.startsWith('>')) quote.push(l.replace(/^> ?/, ''))
    else if (quote.length) break
  }
  return { by: m[1] ?? 'a person', reason: quote.join('\n').trim() }
}

/** How long a branch name may be (src/agents/runtime/schemas.ts BranchSchema). */
const BRANCH_MAX = 200

/**
 * The branch for work that follows discarded change `number` made on `branch`: `<branch>-after-<number>`. An earlier
 * "-after-<n>" is replaced, not stacked (x-after-12, discarded as #14, is followed by x-after-14).
 */
export function afterBranch(branch: string, number: number): string {
  const tail = `-after-${number}`
  return `${branch.replace(/-after-\d+$/, '').slice(0, BRANCH_MAX - tail.length).replace(/[./-]+$/, '')}${tail}`
}

/** The discarded change a branch made by afterBranch follows, or null. */
export function followsOf(branch: string): number | null {
  const m = /-after-(\d{1,9})$/.exec(branch)
  return m ? Number(m[1]) : null
}

/** The few GitHub calls the lookups need (an Octokit fits; tests pass a fake). */
export interface DiscardGitHub {
  rest: {
    pulls: {
      list(a: { owner: string; repo: string; state: 'all'; head: string; per_page: number }): Promise<{ data: unknown }>
      get(a: { owner: string; repo: string; pull_number: number }): Promise<{ data: unknown }>
    }
    issues: {
      listComments(a: { owner: string; repo: string; issue_number: number; per_page: number }): Promise<{ data: unknown }>
    }
  }
}

interface PullLike { number: number; state?: string; merged_at?: string | null; head?: { ref?: string; repo?: { full_name?: string } | null } }

const pullsOf = (d: unknown): PullLike[] => (Array.isArray(d) ? d.filter((p): p is PullLike => typeof p === 'object' && p !== null && typeof (p as PullLike).number === 'number') : [])

/** trace's discard comment on pull request `number`, read; null when it has none. */
async function discardOn(gh: DiscardGitHub, owner: string, repo: string, number: number): Promise<{ by: string; reason: string } | null> {
  // the newest comments are last: a reopened and discarded again change has its latest reason there
  const cs = (await gh.rest.issues.listComments({ owner, repo, issue_number: number, per_page: 100 })).data
  const bodies = (Array.isArray(cs) ? cs : []).map((c) => (typeof c === 'object' && c !== null ? String((c as { body?: unknown }).body ?? '') : ''))
  for (const b of bodies.reverse()) {
    const d = readDiscard(b)
    if (d) return d
  }
  return null
}

/**
 * Whether `branch` of `owner/repo` is retired: the newest pull request from it (the repository's own, not a fork's) was
 * closed without merging and trace's discard comment is on it. An open one means it was reopened: not retired. Throws
 * when GitHub cannot be read: each caller decides which side to fall on.
 */
export async function discardedBranch(gh: DiscardGitHub, owner: string, repo: string, branch: string): Promise<Discarded | null> {
  const own = `${owner}/${repo}`.toLowerCase()
  const pulls = pullsOf((await gh.rest.pulls.list({ owner, repo, state: 'all', head: `${owner}:${branch}`, per_page: 20 })).data)
    .filter((p) => !p.head?.repo?.full_name || p.head.repo.full_name.toLowerCase() === own)
    .sort((a, b) => b.number - a.number)
  const newest = pulls[0]
  if (!newest || newest.state !== 'closed' || newest.merged_at) return null
  const d = await discardOn(gh, owner, repo, newest.number)
  return d ? { number: newest.number, branch, ...d } : null
}

/** Discarded change `number` (one that `followsOf` named), or null when it is not one: open, merged, or not discarded. */
export async function discardedChange(gh: DiscardGitHub, owner: string, repo: string, number: number): Promise<Discarded | null> {
  const p = (await gh.rest.pulls.get({ owner, repo, pull_number: number })).data as PullLike
  if (!p || p.state !== 'closed' || p.merged_at) return null
  const d = await discardOn(gh, owner, repo, number)
  return d ? { number, branch: p.head?.ref ?? '', ...d } : null
}
