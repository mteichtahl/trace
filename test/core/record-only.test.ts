/**
 * test-esp32 #141: two record-only changes (the docs and the EMC specialist's records) showed "1 check failing: build",
 * because their build checked the case of the change they were stacked on. A pull request of trace's records only has
 * nothing to build: `tracectl check` says so and passes.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { onlyRecords, pullBase, recordOnlyReason } from '../../src/core/record-only.js'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** A repository with a base commit and one more commit that writes `files`; gives its root and the base's sha. */
function repo(files: Record<string, string>): { root: string; base: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'record-only-'))
  dirs.push(root)
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 't')
  mkdirSync(join(root, '.trace'), { recursive: true })
  mkdirSync(join(root, 'mechanical'), { recursive: true })
  writeFileSync(join(root, '.trace/project.db'), 'one')
  writeFileSync(join(root, 'mechanical/case.json'), '{}')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  for (const [p, c] of Object.entries(files)) writeFileSync(join(root, p), c)
  git('add', '-A')
  git('commit', '-qm', 'change')
  const event = join(root, '..', `${root.split('/').pop()}-event.json`)
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base } } }))
  dirs.push(event)
  return { root, base, env: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event } }
}

describe('a pull request of trace\'s records only', () => {
  it('has nothing to check', () => {
    const r = repo({ '.trace/project.db': 'two' })
    expect(recordOnlyReason(r.root, r.env)).toMatch(/touches only trace's records \(\.trace\/project\.db\)/)
  })

  it('a change with a design file in it is checked in full', () => {
    const r = repo({ '.trace/project.db': 'two', 'mechanical/case.json': '{"wall":2}' })
    expect(recordOnlyReason(r.root, r.env)).toBeNull()
  })

  it('outside a pull request\'s run, or when the base cannot be read, everything is checked', () => {
    const r = repo({ '.trace/project.db': 'two' })
    expect(recordOnlyReason(r.root, { ...r.env, GITHUB_EVENT_NAME: 'push' })).toBeNull()
    expect(recordOnlyReason(r.root, {})).toBeNull()
    expect(recordOnlyReason(r.root, r.env, { git: () => { throw new Error('no git') } })).toBeNull()
    expect(pullBase(r.env, () => '{not json')).toBeNull()
    expect(pullBase(r.env, () => JSON.stringify({ pull_request: { base: { sha: 'abc' } } }))).toBeNull()
  })

  it('only every path under .trace/ is records', () => {
    expect(onlyRecords(['.trace/project.db', '.trace/rules.md'])).toBe(true)
    expect(onlyRecords(['.trace/project.db', 'hardware/x.kicad_pcb'])).toBe(false)
    expect(onlyRecords([])).toBe(false)
  })
})
