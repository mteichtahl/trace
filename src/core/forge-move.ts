/**
 * Moving a project's repository between GitHub and trace's GitLab, either way (docs/gitlab-projects.md "Moving a
 * project"). The same steps in both directions; each forge is a MoveSide (its adapters: githubSide, gitlabSide).
 *
 *   copy history       every branch and tag, pushed from the old home to the new as a mirror (git; the new home is
 *                      made first, or an archived one from an earlier move is un-archived and reused)
 *   recreate changes   every open change, bottom of each stack first, so a change built on another targets that one's
 *                      branch as before; its title, description, labels, and one comment carrying who opened it and its
 *                      discussion so far. Closed and merged changes are not recreated: their commits are in the history
 *   recreate issues    every open issue, with its labels
 *   archive old home   read-only, never deleted
 *
 * What it answers: the old number → new number of each change and issue (the journey keeps it, so old links still
 * open the right one), and a line per step for the progress view. The project is paused by the caller around it;
 * a failure before the old home is archived leaves the old home as it was, and is undone by the caller (the new home's
 * branches are left, unused, until a later move reuses or replaces them).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type Forge = 'github' | 'gitlab'

export interface OpenChange { number: number; title: string; body: string; head: string; base: string; labels: string[]; author: string | null; comments: { author: string; body: string; at: string }[] }
export interface OpenIssue { number: number; title: string; body: string; labels: string[]; author: string | null }

export interface MoveSide {
  forge: Forge
  /** how the project is named there (owner/name, or <prefix>/<name>) */
  where: string
  /** make the repository there if it is not, empty and private; un-archive it if an earlier move archived it */
  ensure: () => Promise<{ made: boolean }>
  /** its git address and the header that signs in to it (never a token in the URL) */
  git: () => Promise<{ url: string; header: string }>
  defaultBranch: () => Promise<string>
  openChanges: () => Promise<OpenChange[]>
  openIssues: () => Promise<OpenIssue[]>
  openChange: (c: { title: string; body: string; head: string; base: string; labels: string[] }) => Promise<number>
  openIssue: (i: { title: string; body: string; labels: string[] }) => Promise<number>
  archive: () => Promise<void>
}

export type Git = (args: readonly string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => void
const realGit: Git = (args, o) => { execFileSync('git', args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'] }) }

export interface MoveResult { changes: Record<number, number>; issues: Record<number, number>; lines: string[] }

/** Stacks bottom first: a change whose base is another open change's branch comes after that one. */
export function stackOrder(changes: readonly OpenChange[]): OpenChange[] {
  const byHead = new Map(changes.map((c) => [c.head, c]))
  const out: OpenChange[] = []
  const seen = new Set<number>()
  const visit = (c: OpenChange, depth = 0): void => {
    if (seen.has(c.number) || depth > changes.length) return
    const below = byHead.get(c.base)
    if (below && below.number !== c.number) visit(below, depth + 1)
    if (!seen.has(c.number)) { seen.add(c.number); out.push(c) }
  }
  for (const c of [...changes].sort((a, b) => a.number - b.number)) visit(c)
  return out
}

/** The one comment a recreated change carries: who opened it, where it came from, and its discussion so far. */
export function carriedComment(from: MoveSide, c: OpenChange): string {
  const lines = [`Moved from ${from.forge === 'github' ? 'GitHub' : 'trace\'s GitLab'} (${from.where}, #${c.number})${c.author ? `, opened by ${c.author}` : ''}.`]
  if (c.comments.length) {
    lines.push('', 'Its discussion there:')
    for (const m of c.comments) lines.push('', `**${m.author}** (${m.at}):`, '', ...m.body.split('\n').map((l) => `> ${l}`))
  }
  return lines.join('\n')
}

export async function moveRepository(from: MoveSide, to: MoveSide, o: { git?: Git; report?: (line: string) => void } = {}): Promise<MoveResult> {
  const git = o.git ?? realGit
  const lines: string[] = []
  const say = (l: string): void => { lines.push(l); o.report?.(l) }

  // ---- the new home
  const made = await to.ensure()
  say(made.made ? `made ${to.where}` : `${to.where} is there (reused)`)

  // ---- copy history: every branch and tag, as a mirror
  const dir = mkdtempSync(join(tmpdir(), 'trace-move-'))
  try {
    const a = await from.git()
    const b = await to.git()
    const env = (header: string): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: header })
    git(['clone', '-q', '--mirror', a.url, '.'], { cwd: dir, env: env(a.header) })
    // a forge's own refs (GitHub's pull/*, GitLab's merge-requests/*) are not the project's: only branches and tags
    git(['push', '-q', '--prune', b.url, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'], { cwd: dir, env: env(b.header) })
    say('copied every branch and tag')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- open changes, bottom of each stack first; issues
  const changes: Record<number, number> = {}
  for (const c of stackOrder(await from.openChanges())) {
    const n = await to.openChange({ title: c.title, body: `${c.body}\n\n---\n${carriedComment(from, c)}`.trim(), head: c.head, base: c.base, labels: c.labels })
    changes[c.number] = n
  }
  say(`recreated ${Object.keys(changes).length} open change${Object.keys(changes).length === 1 ? '' : 's'}`)
  const issues: Record<number, number> = {}
  for (const i of (await from.openIssues()).sort((x, y) => x.number - y.number)) {
    issues[i.number] = await to.openIssue({ title: i.title, body: `${i.body}\n\n---\nMoved from ${from.where}#${i.number}${i.author ? `, opened by ${i.author}` : ''}.`.trim(), labels: i.labels })
  }
  say(`recreated ${Object.keys(issues).length} open issue${Object.keys(issues).length === 1 ? '' : 's'}`)

  // ---- the old home: read-only, never deleted
  await from.archive()
  say(`archived ${from.where} (read-only, not deleted)`)
  return { changes, issues, lines }
}
