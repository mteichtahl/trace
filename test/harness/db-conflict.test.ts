/**
 * resolveDbConflict against real git: a PR branch and the default branch that each added runs to the project
 * database merge to one database holding both; any other conflicting file leaves the branch untouched.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { PROJECT_DB, resolveDbConflict } from '../../src/harness/db-conflict.js'
import { openProject } from '../../src/core/store.js'

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim()

const addRun = (dir: string, id: string): void => {
  const db = openProject(dir)
  db.prepare("INSERT INTO runs (id, kind, subject, started, status, summary) VALUES (?, 'kicad.erc', 'hw', ?, 'pass', 'ok')").run(id, Date.now() / 1000)
  db.close()
}

/** origin with main (one run) and claude/task-a branched from it; then each side adds its own run (and maybe a file). */
function setup(o: { alsoConflict?: boolean } = {}): { origin: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), 'trace-dbc-'))
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  mkdirSync(work)
  git(work, 'init', '-q', '-b', 'main')
  git(work, 'remote', 'add', 'origin', origin)
  mkdirSync(join(work, '.trace'))
  // what onboarding writes: the database merges with the trace-db driver (not configured in a fresh clone)
  writeFileSync(join(work, '.gitattributes'), '.trace/project.db binary merge=trace-db\n')
  writeFileSync(join(work, 'notes.txt'), 'base\n')
  addRun(work, 'run-base')
  git(work, 'add', '-A'); git(work, 'commit', '-qm', 'base'); git(work, 'push', '-q', 'origin', 'main')
  git(work, 'checkout', '-qb', 'claude/task-a')
  addRun(work, 'run-pr')
  writeFileSync(join(work, 'hw.txt'), 'the schematic change\n')
  if (o.alsoConflict) writeFileSync(join(work, 'notes.txt'), 'pr\n')
  git(work, 'add', '-A'); git(work, 'commit', '-qm', 'pr'); git(work, 'push', '-q', 'origin', 'claude/task-a')
  git(work, 'checkout', '-q', 'main')
  addRun(work, 'run-main')
  if (o.alsoConflict) writeFileSync(join(work, 'notes.txt'), 'main\n')
  git(work, 'add', '-A'); git(work, 'commit', '-qm', 'main moves on'); git(work, 'push', '-q', 'origin', 'main')
  return { origin, work }
}

const runsOn = (origin: string, branch: string): { runs: string[]; files: string } => {
  const c = mkdtempSync(join(tmpdir(), 'trace-dbc-check-'))
  execFileSync('git', ['clone', '-q', '-b', branch, origin, c])
  const db = new DatabaseSync(join(c, PROJECT_DB))
  const runs = (db.prepare('SELECT id FROM runs ORDER BY id').all() as { id: string }[]).map((r) => r.id)
  db.close()
  return { runs, files: git(c, 'ls-files') }
}

describe('resolveDbConflict', () => {
  it('merges the default branch in, with both sides\' runs in the database, and pushes a merge commit', async () => {
    const { origin } = setup()
    const before = execFileSync('git', ['--git-dir', origin, 'rev-parse', 'claude/task-a'], { encoding: 'utf8' }).trim()
    const r = await resolveDbConflict({ remote: origin, head: 'claude/task-a', base: 'main' })
    expect(r).toMatchObject({ ok: true })
    const after = runsOn(origin, 'claude/task-a')
    expect(after.runs).toEqual(['run-base', 'run-main', 'run-pr'])
    expect(after.files).toMatch(/hw\.txt/)
    // a merge commit on top of what was there: both parents kept, no force-push
    const parents = execFileSync('git', ['--git-dir', origin, 'rev-list', '--parents', '-n1', 'claude/task-a'], { encoding: 'utf8' }).trim().split(' ')
    expect(parents).toHaveLength(3)
    expect(parents).toContain(before)
    expect(execFileSync('git', ['--git-dir', origin, 'merge-base', '--is-ancestor', 'main', 'claude/task-a']).toString()).toBe('')
  })

  it('leaves the branch alone when another file conflicts too', async () => {
    const { origin } = setup({ alsoConflict: true })
    const before = execFileSync('git', ['--git-dir', origin, 'rev-parse', 'claude/task-a'], { encoding: 'utf8' }).trim()
    const r = await resolveDbConflict({ remote: origin, head: 'claude/task-a', base: 'main' })
    expect(r).toEqual({ ok: false, why: 'notes.txt conflicts too: a person or the worker merges it' })
    expect(execFileSync('git', ['--git-dir', origin, 'rev-parse', 'claude/task-a'], { encoding: 'utf8' }).trim()).toBe(before)
  })

  it('never puts the token in a URL or an error', async () => {
    const r = await resolveDbConflict({ remote: '/nowhere/at/all.git', head: 'claude/x', base: 'main', token: 'ghp_secret' })
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toMatch(/ghp_secret|Z2hwX3NlY3JldA/)
  })
})
