/**
 * Stacked pull requests (docs/stacked-changes.md), on GitHub's own base branches: no other tool or account.
 *
 *   parentOf  a pushed branch that holds commits of another open pull request is stacked on it: its pull request
 *             targets that branch, so it shows only its own commits. Nothing is recorded: git's history is the
 *             stack. In any doubt no pull request is opened (StackUnclear), so unaccepted work never reaches the
 *             default branch inside another change.
 *   restack   keeps the stacks in order, a few pushes a run: a pull request whose base merged is retargeted to where
 *             its base went (the default branch, as trace merges only there) and brought up to date; one whose base
 *             moved on (a revision, a fix) gets its base merged in; one whose base was closed unmerged is held and
 *             told why, since retargeting it would carry the abandoned commits along.
 *
 * Only a pull request to the default branch merges itself (prs.ts automerge), so a stack lands bottom first, one
 * change at a time, each with its own passing checks.
 */
import { commentOnce } from './util.js'
import { type GitHub, errorMessage, errorStatus, labelNames } from './types.js'

/** At most this many stacked pull requests are pushed to (retargeted, or their base merged in) per run: each push
 * starts a build. */
export const RESTACK_PER_RUN = 3

export interface Parent { number: number; ref: string; title: string }

interface OpenPr {
  number: number
  title: string
  draft?: boolean | undefined
  created_at?: string
  head?: { ref: string; sha: string; repo?: { full_name?: string } | null }
  base?: { ref: string; sha?: string }
  labels?: Array<string | { name?: string }>
}

const sameRepo = (p: OpenPr, owner: string, repo: string): p is OpenPr & { head: NonNullable<OpenPr['head']> } => p.head?.repo?.full_name === `${owner}/${repo}`
/** A pull request's base; one listed without it (a list already filtered by base) is on the default branch. */
const sameRepoIn = (owner: string, repo: string) => (p: OpenPr): p is OpenPr & { head: NonNullable<OpenPr['head']> } => sameRepo(p, owner, repo)
const baseOf = (p: OpenPr, defaultBranch: string): string => p.base?.ref ?? defaultBranch

/** Why no pull request could be opened safely: the run says so, and none is opened rather than one that might carry
 * another change's unaccepted commits onto the default branch. */
export class StackUnclear extends Error {}

/**
 * The open pull request `branch` is stacked on, or null when it is stacked on nothing (its pull request targets the
 * default branch). `commits`: every commit of `branch` that the default branch lacks.
 *
 * Decided by commit membership, not by an open branch's tip (which moves: the queue merges the default branch into it,
 * a revision pushes to it): an open pull request is built on when one of its own commits is among `commits`. Of
 * several, the nearest: one that another candidate is not stacked on. Any doubt fails closed (StackUnclear): a lookup
 * that failed, more commits than GitHub lists, or two unrelated open changes in one branch.
 */
export async function parentOf(github: GitHub, owner: string, repo: string, branch: string, defaultBranch: string, commits: ReadonlySet<string>): Promise<Parent | null> {
  const open = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 }) as OpenPr[]
  const candidates = open.filter(sameRepoIn(owner, repo)).filter((p) => p.head.ref !== branch && p.head.ref !== defaultBranch)
  const built: OpenPr[] = []
  for (const p of candidates) {
    // its tip is in the branch: no call needed
    if (commits.has(p.head.sha)) { built.push(p); continue }
    // else any of its own commits (those its base lacks) is: its tip moved on after the branch was made from it
    const own = (await github.rest.pulls.listCommits({ owner, repo, pull_number: p.number, per_page: 100 })).data
    if (own.some((c) => commits.has(c.sha))) built.push(p)
  }
  // the nearest: drop any that another one found is stacked on (A ← B ← branch: B, not A)
  const nearest = built.filter((p) => !built.some((q) => q !== p && baseOf(q, defaultBranch) === p.head!.ref))
  if (nearest.length > 1) {
    throw new StackUnclear(`\`${branch}\` holds commits of ${nearest.map((p) => `#${p.number}`).join(' and ')}, which are not stacked on each other, so no pull request was opened: one would carry the other's unaccepted work. Open it by hand against the one it builds on.`)
  }
  const p = nearest[0]
  return p ? { number: p.number, ref: p.head!.ref, title: p.title } : null
}

export interface RestackDeps { github: GitHub; owner: string; repo: string; defaultBranch: string; hold: string; canPush: boolean }

/** What a pass did: lines for the run's summary, and the pull requests it pushed to (each push starts a build). */
export interface Restacked { lines: string[]; pushed: Set<number> }

/**
 * One pass over the stacked pull requests, at most `budget` pushes. `open` is the repository's open pull requests.
 * With no TRACE_TOKEN it only says what it would do: it writes nothing (the job's own token may only read).
 */
export async function restack({ github, owner, repo, defaultBranch, hold, canPush }: RestackDeps, open: OpenPr[], budget = RESTACK_PER_RUN): Promise<Restacked> {
  const lines: string[] = []
  const pushed = new Set<number>()
  const mine = open.filter(sameRepoIn(owner, repo))
  const stacked = mine.filter((p) => baseOf(p, defaultBranch) !== defaultBranch).sort((a, b) => a.number - b.number)
  const openHeads = new Map(mine.map((p) => [p.head.ref, p]))
  for (const pr of stacked) {
    const base = baseOf(pr, defaultBranch)
    if (pushed.size >= budget) { lines.push(`More stacked changes wait for the next run (at most ${budget} pushes a run).`); break }
    const below = openHeads.get(base)
    if (below) {
      // its base is open: bring it up to date with what its base has gained (a revision, a fix, a merged base of its
      // own). The listing says where the base was when this PR last moved: unchanged, nothing to ask GitHub
      if (pr.base?.sha && pr.base.sha === below.head.sha) continue
      const cmp = await github.rest.repos.compareCommits({ owner, repo, base, head: pr.head.ref }).catch(() => null)
      if (!cmp || cmp.data.behind_by === 0) continue
      if (labelNames(pr.labels).includes(hold)) { lines.push(`#${pr.number} is behind #${below.number} but held: left alone.`); continue }
      if (!canPush) { lines.push(`#${pr.number} would get #${below.number}'s new commits, but there is no TRACE_TOKEN secret.`); continue }
      const r = await update(github, owner, repo, pr)
      lines.push(r === 'done' ? `#${pr.number}: merged ${base} (#${below.number}) in, so it builds on #${below.number}'s latest.`
        : r === 'conflict' ? `#${pr.number} has a conflict with #${below.number}: left for the worker.` : `#${pr.number} moved while it was looked at: the next run looks again.`)
      if (r === 'done') pushed.add(pr.number)
      continue
    }
    // its base has no open pull request: merged, closed, or a branch a person targets by hand
    const last = await closedBase(github, owner, repo, base, pr.created_at)
    if (!last) continue // a branch a person chose as the base, or one whose history says nothing sure: theirs to manage
    if (last.merged_at) {
      const to = last.base.ref
      if (!canPush) { lines.push(`#${pr.number}'s base #${last.number} merged: it would move onto ${to}, but there is no TRACE_TOKEN secret.`); continue }
      // held while it moves: the retarget alone would let it merge itself on checks of a tree without ${to}'s latest
      const wasHeld = labelNames(pr.labels).includes(hold)
      if (!wasHeld) await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: [hold] })
      await github.rest.pulls.update({ owner, repo, pull_number: pr.number, base: to })
      const r = await update(github, owner, repo, pr)
      if (!wasHeld) await github.rest.issues.removeLabel({ owner, repo, issue_number: pr.number, name: hold }).catch(() => undefined)
      lines.push(`#${pr.number}: #${last.number} merged, so it now targets ${to}${r === 'done' ? ' and is up to date' : r === 'conflict' ? ' (it has a conflict there: left for the worker)' : ' (it moved meanwhile: the next run brings it up to date)'}.`)
      pushed.add(pr.number)
      continue
    }
    // closed without merging: its commits are still in this branch, so moving it on would carry them along
    if (labelNames(pr.labels).includes(hold)) continue
    if (!canPush) { lines.push(`#${pr.number}'s base #${last.number} was closed unmerged: it would be held, but there is no TRACE_TOKEN secret.`); continue }
    await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: [hold] }).catch(() => undefined)
    await commentOnce(github, owner, repo, pr.number, '<!-- trace: stack-base-closed -->',
      `This change was built on #${last.number}, which was closed without merging, so it still carries #${last.number}'s work. ` +
      `It is held so that work never reaches ${defaultBranch} with it. Discard it, and ask trace for the work again on ${defaultBranch} if it is still wanted.`).catch(() => false)
    lines.push(`#${pr.number}: its base #${last.number} was closed unmerged: held.`)
  }
  return { lines, pushed }
}

/**
 * The pull request whose branch `base` was, when that is sure: closed after the stacked PR was opened (an old PR of a
 * reused branch name says nothing), and either the branch is gone or its tip is still that PR's head (a branch pushed
 * to since is someone's again). Null otherwise.
 */
async function closedBase(github: GitHub, owner: string, repo: string, base: string, openedAt: string | undefined) {
  const last = (await github.rest.pulls.list({ owner, repo, state: 'closed', head: `${owner}:${base}`, per_page: 5 })).data
    .sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? ''))[0]
  if (!last?.closed_at || (openedAt && last.closed_at < openedAt)) return null
  const tip = await github.rest.repos.getBranch({ owner, repo, branch: base }).then((r) => r.data.commit.sha, (e) => (errorStatus(e) === 404 ? null : Promise.reject(e)))
  return tip === null || tip === last.head.sha ? last : null
}

/** Merge the pull request's base into its head (GitHub's "Update branch"). */
async function update(github: GitHub, owner: string, repo: string, pr: { number: number; head: { sha: string } }): Promise<'done' | 'conflict' | 'moved'> {
  try {
    await github.rest.pulls.updateBranch({ owner, repo, pull_number: pr.number, expected_head_sha: pr.head.sha })
    return 'done'
  } catch (e) {
    if (errorStatus(e) !== 422) throw e
    // GitHub answers 422 both for a conflict and for a head that moved since it was listed
    return /expected head sha|head ref/i.test(errorMessage(e)) ? 'moved' : 'conflict'
  }
}

export const stackLine = (p: Parent, defaultBranch: string): string =>
  `Stacked on #${p.number} (\`${p.ref}\`): it shows only its own commits, and moves onto \`${defaultBranch}\` and merges after #${p.number} does.`

