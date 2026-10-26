/**
 * Where overrides are kept: history and revert in either layer, the project database's merge rule, the installation
 * store on S3 (conditional writes), and loading the layers for a job.
 */
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Central } from '../../src/core/central.js'
import { merge } from '../../src/core/dbmerge.js'
import { openProject } from '../../src/core/store.js'
import { resolvePrompt } from '../../src/prompts/resolve.js'
import {
  InstallationPrompts, PromptError, applyWrite, diffLines, findVersion, loadLayers, projectHistory, projectOverrides, promptsHome, readHistory, writeProject,
} from '../../src/prompts/store.js'
import { TemplateError } from '../../src/prompts/template.js'
import { FakeS3 } from '../core/fake-s3.js'

const repo = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'trace-prompts-repo-'))
  mkdirSync(join(d, '.git'))
  return d
}
const db = (root: string): string => join(root, '.trace', 'project.db')
const ID = 'specialist.verify.workflow'

describe('history and revert', () => {
  it('records every set, reset and revert with its version, who and why; any version can be restored', () => {
    const r = repo()
    const v1 = writeProject({ op: 'set', id: ID, text: 'WORKFLOW:\n1. one', reason: 'first', by: 'marc' }, r)
    const v2 = writeProject({ op: 'set', id: ID, text: 'WORKFLOW:\n1. two', reason: 'second', by: 'kyra' }, r)
    expect([v1.version, v2.version]).toEqual([1, 2])
    expect(projectOverrides(db(r)).get(ID)).toMatchObject({ text: 'WORKFLOW:\n1. two', version: 2, by: 'kyra' })
    const v3 = writeProject({ op: 'revert', id: ID, to: 1, by: 'marc' }, r)
    expect(v3).toMatchObject({ version: 3, action: 'revert', text: 'WORKFLOW:\n1. one', reason: `revert to v1 (${v1.uid})` })
    const v4 = writeProject({ op: 'reset', id: ID, reason: 'back to the default', by: 'marc' }, r)
    expect(v4).toMatchObject({ version: 4, action: 'reset', text: null })
    expect(projectOverrides(db(r)).get(ID)).toMatchObject({ text: null, version: 4 })
    // a reset falls through to the default
    expect(resolvePrompt(ID, {}, { project: projectOverrides(db(r)) }).provenance.layer).toBe('default')
    const h = projectHistory(db(r), ID)
    expect(h.map((x) => [x.version, x.action, x.by, x.reason])).toEqual([[1, 'set', 'marc', 'first'], [2, 'set', 'kyra', 'second'], [3, 'revert', 'marc', `revert to v1 (${v1.uid})`], [4, 'reset', 'marc', 'back to the default']])
    // by uid too, and back to a reset
    writeProject({ op: 'revert', id: ID, to: v2.uid.slice(0, 8), reason: 'v2 again', by: 'marc' }, r)
    expect(projectOverrides(db(r)).get(ID)?.text).toBe('WORKFLOW:\n1. two')
    writeProject({ op: 'revert', id: ID, to: 'v4', reason: 'the reset again', by: 'marc' }, r)
    expect(projectOverrides(db(r)).get(ID)?.text).toBeNull()
    expect(() => findVersion(h, 99)).toThrow(PromptError)
  })

  it('refuses a locked id, an unknown id, a bad variable (by name), an empty reason, and a reset of nothing', () => {
    const r = repo()
    expect(() => writeProject({ op: 'set', id: 'specialist.guardrails', text: 'x', reason: 'r', by: null }, r)).toThrow(/locked/)
    expect(() => writeProject({ op: 'set', id: 'specialist.verify.nothing', text: 'x', reason: 'r', by: null }, r)).toThrow(/no prompt/)
    expect(() => writeProject({ op: 'set', id: ID, text: 'Use {{secret}}', reason: 'r', by: null }, r)).toThrow(TemplateError)
    expect(() => writeProject({ op: 'set', id: ID, text: 'Use {{secret}}', reason: 'r', by: null }, r)).toThrow(/\{\{secret\}\}/)
    expect(() => writeProject({ op: 'set', id: ID, text: 'x'.repeat(16_001), reason: 'r', by: null }, r)).toThrow(/at most 16000/)
    expect(() => writeProject({ op: 'set', id: ID, text: 'ok', reason: '  ', by: null }, r)).toThrow(/reason/)
    expect(() => writeProject({ op: 'reset', id: ID, reason: 'r', by: null }, r)).toThrow(/no override/)
    expect(projectHistory(db(r), ID)).toEqual([])
  })

  it('diffs two texts line by line', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc\nd')).toBe('  a\n- b\n+ B\n  c\n+ d')
  })
})

describe('the project database merge rule', () => {
  it('keeps, per id, the row changed last (resets included), and the union of both histories', () => {
    const base = repo()
    writeProject({ op: 'set', id: ID, text: 'base', reason: 'r', by: 'a' }, base)
    const ours = repo()
    const theirs = repo()
    for (const d of [ours, theirs]) { mkdirSync(join(d, '.trace'), { recursive: true }); copyFileSync(db(base), db(d)) }
    writeProject({ op: 'set', id: ID, text: 'ours', reason: 'ours', by: 'o' }, ours)
    writeProject({ op: 'set', id: 'specialist.verify.done', text: 'our done', reason: 'r', by: 'o' }, ours)
    // theirs changed the workflow later, and reset nothing else; theirs also overrode the router
    writeProject({ op: 'set', id: ID, text: 'theirs', reason: 'theirs', by: 't' }, theirs)
    writeProject({ op: 'set', id: 'router.classify', text: 'Pick one.', reason: 'r', by: 't' }, theirs)
    writeProject({ op: 'reset', id: 'router.classify', reason: 'undo', by: 't' }, theirs)
    expect(merge(db(base), db(ours), db(theirs))).toEqual([])
    const o = projectOverrides(db(ours))
    expect(o.get(ID)?.text).toBe('theirs')
    expect(o.get('specialist.verify.done')?.text).toBe('our done')
    expect(o.get('router.classify')?.text).toBeNull()
    const h = projectHistory(db(ours), ID)
    expect(h.map((x) => x.text).sort()).toEqual(['base', 'ours', 'theirs'])
    // both made v2: the history keeps both, told apart by uid
    expect(h.filter((x) => x.version === 2)).toHaveLength(2)
    // a later local change on top of the merge wins the next merge the other way
    writeProject({ op: 'set', id: ID, text: 'ours again', reason: 'r', by: 'o' }, ours)
    expect(merge(db(base), db(theirs), db(ours))).toEqual([])
    expect(projectOverrides(db(theirs)).get(ID)?.text).toBe('ours again')
  })
})

describe('the installation store', () => {
  it('lives beside TRACE_HOME (s3://b/central → s3://b/prompts), or under it locally', () => {
    expect(promptsHome({ TRACE_HOME: 's3://bucket/central' })).toBe('s3://bucket/prompts')
    expect(promptsHome({ TRACE_HOME: 's3://bucket/a/central' })).toBe('s3://bucket/a/prompts')
    expect(promptsHome({ TRACE_HOME: '/home/x/.trace' })).toBe(join('/home/x/.trace', 'prompts'))
    expect(promptsHome({ TRACE_HOME: 's3://bucket/central', TRACE_PROMPTS_HOME: '/elsewhere' })).toBe('/elsewhere')
  })

  it('writes on S3 with conditional puts, re-run on a conflict, and keeps the history', async () => {
    const s3 = new FakeS3()
    const store = new InstallationPrompts({ store: new Central({ home: 's3://bucket/prompts', s3 }) })
    await store.write({ op: 'set', id: 'router.classify', text: 'Pick the specialist.', reason: 'clearer', by: 'hash1' })
    // another writer gets in between: the update is re-run on a fresh copy, and both changes survive
    const other = new InstallationPrompts({ store: new Central({ home: 's3://bucket/prompts', s3 }) })
    s3.interleave = async () => { s3.interleave = null; await other.write({ op: 'set', id: 'specialist.report', text: 'Short.', reason: 'tone', by: 'hash2' }) }
    await store.write({ op: 'set', id: 'router.classify', text: 'Pick one specialist.', reason: 'again', by: 'hash1' })
    expect(s3.conflicts).toBeGreaterThan(0)
    const o = await store.overrides()
    expect(o.get('router.classify')).toMatchObject({ text: 'Pick one specialist.', version: 2 })
    expect(o.get('specialist.report')).toMatchObject({ text: 'Short.', version: 1 })
    expect((await store.history('router.classify')).map((h) => h.reason)).toEqual(['clearer', 'again'])
    expect([...s3.objects.keys()]).toEqual(['bucket/prompts/central.db'])
  })

  it('a job loads both layers; a layer that cannot be read is left out and said so', async () => {
    const r = repo()
    writeProject({ op: 'set', id: ID, text: 'project', reason: 'r', by: null }, r)
    const home = mkdtempSync(join(tmpdir(), 'trace-prompts-home-'))
    const inst = new InstallationPrompts({ home })
    await inst.write({ op: 'set', id: ID, text: 'installation', reason: 'r', by: null })
    const l = await loadLayers({ projectDb: db(r), installation: inst })
    expect(resolvePrompt(ID, {}, l).text).toBe('project')
    expect(l.installation?.get(ID)?.text).toBe('installation')
    const broken = { overrides: async () => { throw new Error('AccessDenied') } } as unknown as InstallationPrompts
    const l2 = await loadLayers({ projectDb: db(r), installation: broken })
    expect(l2.unavailable).toEqual([{ layer: 'installation', reason: 'AccessDenied' }])
    expect(l2.installation).toBeUndefined()
    expect(resolvePrompt(ID, {}, l2).text).toBe('project')
    // no database yet: nothing overridden
    expect((await loadLayers({ projectDb: join(r, 'nope.db') })).project?.size).toBe(0)
  })

  it('applyWrite works on any database with the tables made on first write', () => {
    const r = repo()
    const d = openProject(r)
    try {
      expect(readHistory(d, ID)).toEqual([])
      applyWrite(d, { op: 'set', id: ID, text: 'x', reason: 'r', by: null })
      expect(readHistory(d, ID)).toHaveLength(1)
    } finally {
      d.close()
    }
  })
})
