/**
 * The installer's sample, end to end: onboard-api.ts creates it from the 'sample' template with real git (the push
 * goes to a local bare repository instead of GitHub), and its tour is opened against a fake GitHub issues API, once
 * however often the installer runs.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { Runner } from '../../src/core/onboard.js'
import { onboardViaApi } from '../../src/installer/onboard-api.js'
import { sampleFiles, startTour, tour } from '../../src/installer/sample.js'

const git = (args: string[], cwd?: string): string => {
  const p = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } })
  if (p.status !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr}`)
  return p.stdout
}

/** git as the installer runs it, with every push to github.com sent to `bare` instead. */
const localGit = (bare: string): Runner => (cmd, opts = {}) => {
  const args = cmd.slice(1).map((a) => (a.startsWith('https://github.com/') ? bare : a))
  const p = spawnSync('git', args, { cwd: opts.cwd, input: opts.input, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } })
  if ((opts.check ?? true) && p.status !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr}`)
  return p.stdout
}

/** GitHub as createRepo sees it: the repository does not exist, then it is created. */
const fakeCreate = (async (url: string, init?: RequestInit) => {
  const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status })
  if ((init?.method ?? 'GET') === 'GET' && url.endsWith('/repos/marc/trace-sample')) return json({ message: 'Not Found' }, 404)
  if (url.endsWith('/user')) return json({ login: 'marc', type: 'User' })
  if (url.endsWith('/user/repos')) return json({ full_name: 'marc/trace-sample', default_branch: 'main' }, 201)
  return json({ message: `unexpected ${init?.method} ${url}` }, 500)
}) as typeof fetch

/** The issues API of one repository. */
function fakeIssues(): { fetch: typeof fetch; issues: { title: string; labels: string[]; body: string }[] } {
  const issues: { title: string; labels: string[]; body: string }[] = []
  const f = (async (url: string, init?: RequestInit) => {
    const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status })
    if (!url.includes('/repos/marc/trace-sample/issues')) return json({ message: 'unexpected' }, 500)
    if ((init?.method ?? 'GET') === 'GET') return json(issues.map((x, i) => ({ number: i + 1, html_url: `https://github.com/marc/trace-sample/issues/${i + 1}`, title: x.title, labels: x.labels.map((name) => ({ name })) })))
    const b = JSON.parse(String(init?.body)) as { title: string; labels: string[]; body: string }
    issues.push(b)
    return json({ number: issues.length, html_url: `https://github.com/marc/trace-sample/issues/${issues.length}`, title: b.title, labels: [] }, 201)
  }) as typeof fetch
  return { fetch: f, issues }
}

describe('the sample, created by the installer', () => {
  it('is created from the sample template: its files, the trace files and its seeded database, in one push to main', async () => {
    const bare = join(mkdtempSync(join(tmpdir(), 'trace-sample-remote-')), 'repo.git')
    git(['init', '-q', '--bare', '-b', 'main', bare])
    const r = await onboardViaApi('marc/trace-sample', { token: 't', login: 'marc', apply: false, create: { template: 'sample', private: true }, git: localGit(bare), fetchImpl: fakeCreate })
    expect(r.state).toBe('created')
    expect(r.notes.length).toBeGreaterThan(0)
    const files = new Set(git(['ls-tree', '-r', '--name-only', 'main'], bare).trim().split('\n'))
    for (const f of sampleFiles()) expect(files, f.path).toContain(f.path)
    for (const f of ['.trace/project.db', '.trace/rules.md', '.github/workflows/trace-worker.yml', '.github/workflows/trace-build.yml', '.gitattributes', 'CLAUDE.md', '.gitignore']) expect(files, f).toContain(f)
    for (const f of ['tour.json', 'settings.json']) expect(files, f).not.toContain(f)
    expect(git(['rev-list', '--count', 'main'], bare).trim()).toBe('1')
    // binary files survive byte for byte
    const pdf = sampleFiles().find((f) => f.path.endsWith('.pdf'))
    if (pdf) expect(spawnSync('git', ['show', `main:${pdf.path}`], { cwd: bare }).stdout.equals(pdf.content)).toBe(true)
    // its own rules, not onboarding's empty ones; its build is the KiCad one
    expect(git(['show', 'main:.trace/rules.md'], bare).trim().length).toBeGreaterThan(0)
    expect(git(['show', 'main:.github/workflows/trace-build.yml'], bare)).toMatch(/kicad/i)
    // the database carries the sample's settings and seeded tables
    const dbFile = join(mkdtempSync(join(tmpdir(), 'trace-sample-db-')), 'project.db')
    writeFileSync(dbFile, spawnSync('git', ['show', 'main:.trace/project.db'], { cwd: bare }).stdout)
    const db = new DatabaseSync(dbFile, { readOnly: true })
    try {
      const keys = (db.prepare('SELECT key FROM settings').all() as { key: string }[]).map((x) => x.key)
      for (const k of ['electronics.projects', 'electronics.models', 'firmware.targets', 'hil.instruments']) expect(keys, k).toContain(k)
      const count = (t: string): number => Number((db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n)
      expect(count('requirements')).toBeGreaterThan(10)
      expect(count('test_items')).toBeGreaterThan(10)
    } finally {
      db.close()
    }
  }, 120_000)

  it('opens the tour once, routed to each task\'s agent, and leaves out the remote tasks when GPU jobs are off', async () => {
    const real = globalThis.fetch
    const gh = fakeIssues()
    globalThis.fetch = gh.fetch
    try {
      const t = await startTour('t', 'marc/trace-sample', { gpu: true })
      expect(t.opened).toBe(tour().length)
      expect(gh.issues.every((i) => i.labels.includes('agent-fix') && i.labels.some((l) => l.startsWith('agent:')))).toBe(true)
      expect(gh.issues[0]?.body).toMatch(/<!-- trace-sample-tour:[a-z0-9-]+ -->/)
      expect(await startTour('t', 'marc/trace-sample', { gpu: true })).toMatchObject({ opened: 0, existing: tour().length })
      const off = fakeIssues()
      globalThis.fetch = off.fetch
      const remote = tour().filter((x) => x.remote).length
      expect(remote).toBeGreaterThan(0)
      const t2 = await startTour('t', 'marc/trace-sample', { gpu: false })
      expect(t2.opened).toBe(tour().length - remote)
      expect(t2.skipped).toHaveLength(remote)
    } finally {
      globalThis.fetch = real
    }
  })
})
