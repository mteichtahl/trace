/**
 * Scribe's tools (src/tools/docs/scribe.ts, src/docs/stale.ts; docs/scribe.md "How it stays current"): the documents a
 * stage needs started as skeletons, one section written between its markers only when it passes the quality bar,
 * and the sections a change touched worked out from its files and its project database, table by table.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openProject } from '../../../src/core/store.js'
import { sourcesOfPaths, staleSections } from '../../../src/docs/stale.js'
import { allTools } from '../../../src/tools/index.js'

type Dict = Record<string, any>
const reg = allTools()
const call = async (name: string, args: Dict): Promise<Dict> => (await reg.call(name, args, { hardware: false, via: 'test' })) as Dict
const dir = mkdtempSync(join(tmpdir(), 'trace-scribe-'))
const repo = join(dir, 'repo')
const cwd = process.cwd()
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const commit = (msg: string): void => { git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', msg) }

// the project database in the repository, as in a project's checkout (the tests' own setting points elsewhere)
const before = process.env.TRACE_PROJECT_DB
beforeAll(() => {
  mkdirSync(join(repo, 'hardware'), { recursive: true })
  git('init', '-q')
  process.chdir(repo)
  process.env.TRACE_PROJECT_DB = join(repo, '.trace', 'project.db')
  openProject().close()
  writeFileSync(join(repo, 'hardware', 'board.kicad_sch'), '(kicad_sch (version 1))')
  commit('start')
})
afterAll(() => {
  process.chdir(cwd)
  if (before === undefined) delete process.env.TRACE_PROJECT_DB
  else process.env.TRACE_PROJECT_DB = before
  rmSync(dir, { recursive: true, force: true })
})

describe('what a change touched, pure', () => {
  it('maps paths to the records they hold, and records to the sections written from them', () => {
    expect([...sourcesOfPaths(['hardware/a.kicad_sch', 'mechanical/case.py', 'README.md'])].sort()).toEqual(['enclosure', 'schematic'])
    const hld = staleSections(new Set(['requirements']), ['hld'])[0]!
    expect(hld.sections.map((s) => s.id)).toEqual(['requirements', 'risks'])
  })
})

describe('Scribe\'s tools', () => {
  it('docs.init starts the documents the stage needs, and never replaces one', async () => {
    const r = await call('docs.init', { stage: 'capture', project: 'test-esp32' })
    expect(r.created).toEqual(['docs/design/high-level-design.md', 'docs/design/low-level-design.md'])
    expect(readFileSync('docs/design/high-level-design.md', 'utf8')).toMatch(/^---\nproject: test-esp32\ndocument: High level design\nrevision: A\ncommit: [0-9a-f]{12}/)
    expect((await call('docs.init', { stage: 'capture', project: 'test-esp32' })).created).toEqual([])
    commit('docs')
  })

  it('docs.write_section writes a section that passes, keeping text outside its markers', async () => {
    writeFileSync('docs/design/high-level-design.md', `${readFileSync('docs/design/high-level-design.md', 'utf8')}\nA note a person wrote.\n`)
    const r = await call('docs.write_section', { doc: 'hld', section: 'overview', stage: 'capture',
      body: '## Overview\n\nA board with an `ESP32` controller and an organic light-emitting diode (OLED) display, powered over USB (Universal Serial Bus).' })
    expect(r).toMatchObject({ written: true, pending: false })
    const md = readFileSync('docs/design/high-level-design.md', 'utf8')
    expect(md).toMatch(/powered over USB \(Universal Serial Bus\)/)
    expect(md.trimEnd().endsWith('A note a person wrote.')).toBe(true)
  })

  it('refuses a section that fails the bar, saying why, and writes nothing', async () => {
    const before = readFileSync('docs/design/high-level-design.md', 'utf8')
    const r = await call('docs.write_section', { doc: 'hld', section: 'data-flow', stage: 'capture',
      body: '## Data flow\n\nThe MCU talks to the display.\n\n<!-- scribe:figure kind="data-flow" source="ontology:architecture" -->\n```mermaid\nsequenceDiagram\n  A->>B: x\n```' })
    expect(r.written).toBe(false)
    expect(r.errors.map((e: Dict) => e.code).sort()).toEqual(['acronym', 'caption', 'mermaid'])
    expect(readFileSync('docs/design/high-level-design.md', 'utf8')).toBe(before)
    await expect(call('docs.write_section', { doc: 'hld', section: 'nope', stage: 'capture', body: '## X' })).rejects.toThrow(/not a section/)
    await expect(call('docs.write_section', { doc: 'guide', section: 'about', stage: 'capture', body: '## About' })).rejects.toThrow(/docs\.init/)
  })

  it('docs.stale names the sections a change touched, from its files and its database tables', async () => {
    commit('overview')
    await call('verify.requirements', { action: 'add', requirements: [{ text: 'The display shows the reading within 1 s', kind: 'functional', source: 'intent' }] })
    writeFileSync(join(repo, 'hardware', 'board.kicad_sch'), '(kicad_sch (version 2))')
    commit('a requirement and a schematic change')
    const r = await call('docs.stale', { stage: 'capture' })
    expect(r.changed).toEqual(['.trace/project.db', 'hardware/board.kicad_sch'])
    expect(r.records).toEqual(expect.arrayContaining(['requirements', 'schematic']))
    expect(r.records).not.toContain('thermal')
    const hld = r.documents.find((d: Dict) => d.kind === 'hld')
    expect(hld.sections.map((s: Dict) => s.id)).toEqual(expect.arrayContaining(['requirements', 'risks']))
    expect(hld.sections.map((s: Dict) => s.id)).not.toContain('power-summary')
    const lld = r.documents.find((d: Dict) => d.kind === 'lld')
    expect(lld.sections.find((s: Dict) => s.id === 'modules').because).toEqual(['schematic'])
    expect(r.missing).toEqual([])
    // a gate signed changes the journey, which is not in the repository: the request names it, and the Journey
    // section is written again (the test-esp32 proof run found it left at the stage before)
    const signed = await call('docs.stale', { stage: 'capture', also: ['journey'] })
    expect(signed.documents.find((d: Dict) => d.kind === 'hld').sections.find((s: Dict) => s.id === 'journey').because).toEqual(['journey'])
    expect(hld.sections.map((s: Dict) => s.id)).not.toContain('journey')
  })
})
