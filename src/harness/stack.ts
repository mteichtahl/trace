/**
 * Stacked pull requests (docs/stacked-changes.md), on GitHub's own base branches: no other tool or account.
 *
 *   parentOf  a pushed branch that holds every commit of another open pull request's head, and is ahead of it, is
 *             stacked on it: its pull request targets that branch, so it shows only its own commits. The nearest such
 *             branch (fewest commits between them) wins. Nothing is recorded: git's history is the stack.
 *   restack   keeps the stacks in order, a few pushes a run: a pull request whose base merged is retargeted to where
 *             its base went (the default branch, as trace merges only there) and brought up to date; one whose base
 *             moved on (a revision, a fix) gets its base merged in; one whose base was closed unmerged is held and
 *             told why, since retargeting it would carry the abandoned commits along.
 *
 * Only a pull request to the default branch merges itself (prs.ts automerge), so a stack lands bottom first, one
 * change at a time, each with its own passing checks.
 */
import { commentOnce } from './util.js'
import { type GitHub, errorStatus, labelNames } from './types.js'

/** At most this many open pull requests are looked at as a branch's possible parent (newest first). */
export const PARENT_CANDIDATES = 30
/** At most this many stacked pull requests are pushed to (retargeted, or their base merged in) per run: each push
 * starts a build. */
export const RESTACK_PER_RUN = 3

export interface Parent { number: number; ref: string; title: string; ahead: number }

interface OpenPr {
  number: number
  title: string
  draft?: boolean | undefined
  head?: { ref: string; sha: string; repo?: { full_name?: string } | null }
  base?: { ref: string }
  labels?: Array<string | { name?: string }>
}

const sameRepo = (p: OpenPr, owner: string, repo: string): p is OpenPr & { head: NonNullable<OpenPr['head']> } => p.head?.repo?.full_name === `${owner}/${repo}`
/** A pull request's base; one listed without it (a list already filtered by base) is on the default branch. */
const sameRepoIn = (owner: string, repo: string) => (p: OpenPr): p is OpenPr & { head: NonNullable<OpenPr['head']> } => sameRepo(p, owner, repo)
const baseOf = (p: OpenPr, defaultBranch: string): string => p.base?.ref ?? defaultBranch

/**
 * The open pull request `branch` is stacked on, or null when it is stacked on nothing (its pull request targets the
 * default branch). `open` is the repository's open pull requests, when the caller has them already.
 */
export async function parentOf(github: GitHub, owner: string, repo: string, branch: string, defaultBranch: string, open?: OpenPr[]): Promise<Parent | null> {
  const prs = (open ?? await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 }) as OpenPr[])
    .filter(sameRepoIn(owner, repo)).filter((p) => p.head.ref !== branch && p.head.ref !== defaultBranch)
    .slice(0, PARENT_CANDIDATES)
  let best: Parent | null = null
  for (const p of prs) {
    // branch holds every commit of p's head and has more: p.head is an ancestor of branch
    const cmp = await github.rest.repos.compareCommits({ owner, repo, base: p.head.ref, head: branch }).catch(() => null)
    if (!cmp || cmp.data.behind_by !== 0 || cmp.data.ahead_by === 0) continue
    // and p's head is not already on the default branch (then it is not a stack, just history)
    const onDefault = await github.rest.repos.compareCommits({ owner, repo, base: defaultBranch, head: p.head.ref }).catch(() => null)
    if (!onDefault || onDefault.data.ahead_by === 0) continue
    if (!best || cmp.data.ahead_by < best.ahead) best = { number: p.number, ref: p.head.ref, title: p.title, ahead: cmp.data.ahead_by }
  }
  return best
}

export interface RestackDeps { github: GitHub; owner: string; repo: string; defaultBranch: string; hold: string; canPush: boolean }

/**
 * One pass over the stacked pull requests. Returns what it did, as lines for the run's summary. `open` is the
 * repository's open pull requests.
 */
export async function restack({ github, owner, repo, defaultBranch, hold, canPush }: RestackDeps, open: OpenPr[]): Promise<string[]> {
  const lines: string[] = []
  const mine = open.filter(sameRepoIn(owner, repo))
  const stacked = mine.filter((p) => baseOf(p, defaultBranch) !== defaultBranch).sort((a, b) => a.number - b.number)
  const openHeads = new Map(mine.map((p) => [p.head.ref, p]))
  let pushes = 0
  for (const pr of stacked) {
    const base = baseOf(pr, defaultBranch)
    if (pushes >= RESTACK_PER_RUN) { lines.push(`More stacked changes wait for the next run (at most ${RESTACK_PER_RUN} pushes a run).`); break }
    const below = openHeads.get(base)
    if (below) {
      // its base is open: bring it up to date with what its base has gained (a revision, a fix, a merged base of its own)
      const cmp = await github.rest.repos.compareCommits({ owner, repo, base, head: pr.head.ref }).catch(() => null)
      if (!cmp || cmp.data.behind_by === 0) continue
      if (labelNames(pr.labels).includes(hold)) { lines.push(`#${pr.number} is behind #${below.number} but held: left alone.`); continue }
      if (!canPush) { lines.push(`#${pr.number} would get #${below.number}'s new commits, but there is no TRACE_TOKEN secret.`); continue }
      const done = await update(github, owner, repo, pr)
      lines.push(done ? `#${pr.number}: merged ${base} (#${below.number}) in, so it builds on #${below.number}'s latest.` : `#${pr.number} has a conflict with #${below.number}: left for the worker.`)
      pushes++
      continue
    }
    // its base has no open pull request: merged, closed, or a branch a person targets by hand
    const last = (await github.rest.pulls.list({ owner, repo, state: 'closed', head: `${owner}:${base}`, per_page: 5 })).data
      .sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? ''))[0]
    if (!last) continue // a branch a person chose as the base: theirs to manage
    if (last.merged_at) {
      const to = last.base.ref
      if (!canPush) { lines.push(`#${pr.number}'s base #${last.number} merged: it would move onto ${to}, but there is no TRACE_TOKEN secret.`); continue }
      await github.rest.pulls.update({ owner, repo, pull_number: pr.number, base: to })
      const done = await update(github, owner, repo, pr)
      lines.push(`#${pr.number}: #${last.number} merged, so it now targets ${to}${done ? ' and is up to date' : ' (it has a conflict there: left for the worker)'}.`)
      pushes++
      continue
    }
    // closed without merging: its commits are still in this branch, so moving it on would carry them along
    if (labelNames(pr.labels).includes(hold)) continue
    await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: [hold] }).catch(() => undefined)
    await commentOnce(github, owner, repo, pr.number, '<!-- trace: stack-base-closed -->',
      `This change was built on #${last.number}, which was closed without merging, so it still carries #${last.number}'s work. ` +
      `It is held: ask for changes to rebuild it on ${defaultBranch} without that work, or close it.`)
    lines.push(`#${pr.number}: its base #${last.number} was closed unmerged: held.`)
  }
  return lines
}

/** Merge the pull request's base into its head (GitHub's "Update branch"). False when that conflicts. */
async function update(github: GitHub, owner: string, repo: string, pr: { number: number; head: { sha: string } }): Promise<boolean> {
  try {
    await github.rest.pulls.updateBranch({ owner, repo, pull_number: pr.number, expected_head_sha: pr.head.sha })
    return true
  } catch (e) {
    if (errorStatus(e) === 422) return false // merge conflict (or the head moved: the next run looks again)
    throw e
  }
}

export const stackLine = (p: Parent, defaultBranch: string): string =>
  `Stacked on #${p.number} (\`${p.ref}\`): it shows only its own commits, and moves onto \`${defaultBranch}\` and merges after #${p.number} does.`

