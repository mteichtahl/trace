/**
 * The installer's sample, end to end against a fake GitHub (an in-memory repository behind the REST and Git data
 * APIs): its files are pushed, it is put under trace with its seeded project database, and its tour is opened, each
 * step once however often the installer runs.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/** One repository: files on its default branch, commits made, issues opened. */
class FakeGithub {
  files = new Map<string, Buffer>([['README.md', Buffer.from('# created by GitHub\n')]])
  commits = 0
  blobs = new Map<string, Buffer>()
  trees = new Map<string, Map<string, Buffer>>()
  head = 'c0'
  issues: { number: number; title: string; labels: string[]; body: string }[] = []
  readonly fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = url.replace('https://api.github.com', '').split('?')[0] ?? ''
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status })
    const base = '/repos/marc/trace-sample'
    if (path === `${base}/git/ref/heads/main`) return json({ object: { sha: this.head } })
    if (path === `${base}/git/commits/${this.head}`) return json({ sha: this.head, tree: { sha: this.treeSha(this.files) } })
    if (path === `${base}/git/blobs`) {
      const sha = `b${this.blobs.size}`
      this.blobs.set(sha, Buffer.from(String(body.content), 'base64'))
      return json({ sha }, 201)
    }
    if (path === `${base}/git/trees`) {
      const next = new Map(this.files)
      for (const e of body.tree as { path: string; sha: string }[]) next.set(e.path, this.blobs.get(e.sha) ?? Buffer.alloc(0))
      const sha = this.treeSha(next)
      this.trees.set(sha, next)
      return json({ sha }, 201)
    }
    if (path === `${base}/git/commits` && method === 'POST') {
      this.commits++
      const sha = `c${this.commits}`
      this.files = this.trees.get(String(body.tree)) ?? this.files
      return json({ sha }, 201)
    }
    if (path === `${base}/git/refs/heads/main` && method === 'PATCH') { this.head = String(body.sha); return json({}) }
    if (path.startsWith(`${base}/contents/`)) {
      const f = decodeURIComponent(path.slice(`${base}/contents/`.length))
      return this.files.has(f) ? json({ path: f }) : json({ message: 'Not Found' }, 404)
    }
    if (path === `${base}/issues` && method === 'GET') return json(this.issues.map((i) => ({ number: i.number, html_url: `https://github.com/marc/trace-sample/issues/${i.number}`, title: i.title, labels: i.labels.map((name) => ({ name })) })))
    if (path === `${base}/issues` && method === 'POST') {
      const i = { number: this.issues.length + 1, title: String(body.title), labels: body.labels as string[], body: String(body.body) }
      this.issues.push(i)
      return json({ number: i.number, html_url: `https://github.com/marc/trace-sample/issues/${i.number}`, title: i.title, labels: [] }, 201)
    }
    return json({ message: `unexpected ${method} ${path}` }, 500)
  }) as typeof fetch

  /** a content hash of a tree, so an unchanged tree keeps its sha (the API's behaviour) */
  private treeSha(files: Map<string, Buffer>): string {
    let h = 0
    for (const [k, v] of [...files].sort(([a], [b]) => a.localeCompare(b))) for (const c of `${k}:${v.toString('base64')};`) h = (h * 31 + c.charCodeAt(0)) | 0
    return `t${h >>> 0}`
  }
}

let gh: FakeGithub
const realFetch = globalThis.fetch

beforeAll(() => {
  gh = new FakeGithub()
  globalThis.fetch = gh.fetch
})
afterAll(() => { globalThis.fetch = realFetch })

describe('the sample, against a fake GitHub', () => {
  it('pushes the design, puts it under trace with its seeded database, and opens the tour once', async () => {
    const { pushSample, onboardSample, startTour, sampleFiles, tour } = await import('../../src/installer/sample.js')
    const { DatabaseSync } = await import('node:sqlite')

    expect(await pushSample('t', 'marc/trace-sample', 'main')).toBe('c1')
    for (const f of sampleFiles()) expect(gh.files.has(f.path), f.path).toBe(true)
    expect(gh.files.has('tour.json')).toBe(false)
    expect(gh.files.has('settings.json')).toBe(false)
    expect(gh.files.has('.gitignore')).toBe(true)
    expect(gh.files.get('README.md')?.toString()).not.toContain('created by GitHub')
    // a second push changes nothing
    expect(await pushSample('t', 'marc/trace-sample', 'main')).toBeNull()

    const r = await onboardSample('t', 'marc/trace-sample', 'main', { escalateTo: '', applySettings: false })
    expect(r.commit).toBe('c2')
    expect(r.seeded?.length).toBeGreaterThan(0)
    for (const f of ['.trace/project.db', '.github/workflows/trace-worker.yml', '.github/workflows/trace-build.yml', '.gitattributes', 'CLAUDE.md']) expect(gh.files.has(f), f).toBe(true)
    // its own rules, not onboarding's empty ones
    expect(gh.files.get('.trace/rules.md')?.toString().trim().length).toBeGreaterThan(0)
    // the database carries the sample's settings and seeded tables
    const dbFile = join(mkdtempSync(join(tmpdir(), 'trace-sample-db-')), 'project.db')
    writeFileSync(dbFile, gh.files.get('.trace/project.db') ?? Buffer.alloc(0))
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
    // a second run sees it is under trace already and commits nothing
    expect((await onboardSample('t', 'marc/trace-sample', 'main', { escalateTo: '', applySettings: false })).commit).toBeNull()

    const t = await startTour('t', 'marc/trace-sample', { gpu: true })
    expect(t.opened).toBe(tour().length)
    expect(gh.issues.every((i) => i.labels.includes('agent-fix') && i.labels.some((l) => l.startsWith('agent:')))).toBe(true)
    expect(gh.issues[0]?.body).toMatch(/<!-- trace-sample-tour:[a-z0-9-]+ -->/)
    const again = await startTour('t', 'marc/trace-sample', { gpu: true })
    expect(again).toMatchObject({ opened: 0, existing: tour().length })
  }, 60_000)

  it('leaves the GPU and CPU tasks out when GPU jobs are off', async () => {
    const { startTour, tour } = await import('../../src/installer/sample.js')
    const fresh = new FakeGithub()
    globalThis.fetch = fresh.fetch
    try {
      const t = await startTour('t', 'marc/trace-sample', { gpu: false })
      const remote = tour().filter((x) => x.remote).length
      expect(remote).toBeGreaterThan(0)
      expect(t.opened).toBe(tour().length - remote)
      expect(t.skipped).toHaveLength(remote)
    } finally {
      globalThis.fetch = gh.fetch
    }
  })
})
