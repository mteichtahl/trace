/**
 * The ontology to other systems (docs/ontology-plan.md P6.1): ontology.describe, record.get, artifact.lineage and
 * artifact.stale through the API, as a person and as a connected system with the read scope, and the MCP endpoint's
 * list offering them. A project with a journey, a requirement, and a netlist run with a layout check made from its
 * output, whose schematic then changes on the default branch.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { SERVICE_ACTIONS, offeredTo } from '../../src/api/service-policy.js'
import { assign } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { startJourney } from '../../src/core/journey.js'
import { normalisedHash } from '../../src/core/normalise.js'
import { Registry } from '../../src/core/registry.js'
import { Work, openProject } from '../../src/core/store.js'
import '../../src/tools/design/db.js'
import { DESCRIPTIONS } from '../../src/mcp-remote/descriptions.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'a-admin', email: 'admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'a-user', email: 'user@example.com', groups: ['trace-users'] }
const OTHER = { sub: 'a-other', email: 'other@example.com', groups: ['trace-users'] }
const SYSTEM: Context['principal'] = { sub: 'o-svc', email: null, groups: ['trace-users'], kind: 'service', name: 'bench', scopes: ['read'] }
const REPO = 'acme/onto'
const github = new FakeGitHub([REPO])
const scratch = mkdtempSync(join(tmpdir(), 'trace-onto-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-onto-bucket-'))
const deps: ActionDeps = { github: async () => github, cognito: () => new FakeCognito(), jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [], cancel: async () => ({ ok: true, state: 'aborted' }), pause: async () => ({ ok: true, state: 'running' }) }), tools: () => new Registry([]), scratch, store: (p) => backendFor(join(bucket, p)) }
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<unknown> => (await perform(action, args, { principal: who, deps })).result
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const SCH = '(kicad_sch (version 20250114) (generator "eeschema")\n  (symbol (lib_id "Device:LM1117"))\n)\n'
let netRun = ''
let layoutRun = ''

beforeAll(async () => {
  await assign(ADMIN, USER, REPO, { class: 'user' })
  await assign(ADMIN, { sub: SYSTEM.sub }, REPO, { part: 'reviewer', class: 'user' })
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed', name: 'Onto' })
  const t = Date.now() / 1000
  db.prepare('INSERT INTO requirements (id, text, kind, acceptance, status, tags, created, updated, by) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('REQ-001', 'Runs from 2.0 V to 3.3 V.', 'electrical', 'The rail holds.', 'accepted', '[]', t, t, 'seed')
  db.close()
  const work = new Work(join(dir, '.trace', 'project.db'))
  netRun = work.start('kicad.netlist', { subject: 'hw/board.kicad_sch' })
  work.inputs(netRun, [{ kind: 'file', ref: 'hw/board.kicad_sch', sha256: normalisedHash('hw/board.kicad_sch', enc(SCH)) }])
  work.artifact(netRun, 'netlist.net', '(export (components (comp (ref "U1"))))')
  work.finish(netRun, 'pass', 'netlist')
  layoutRun = work.start('layout.check', { subject: 'hw/board.kicad_sch' })
  const h = (work.db.prepare('SELECT sha256 FROM artifact_hashes WHERE run_id=?').get(netRun) as { sha256: string }).sha256
  work.inputs(layoutRun, [{ kind: 'artifact', ref: netRun, name: 'netlist.net', sha256: h }])
  work.finish(layoutRun, 'pass', 'checked')
  work.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  github.files.set(`${REPO}:main:hw/board.kicad_sch`, enc(SCH))
})
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })

describe('open to connected systems with the read scope', () => {
  it('the four actions are read actions, offered on the MCP endpoint with a description', () => {
    for (const a of ['ontology.describe', 'record.get', 'artifact.lineage', 'artifact.stale']) {
      expect(SERVICE_ACTIONS[a], a).toBe('read')
      expect(offeredTo(a, ['read']), a).toBe(true)
      expect(DESCRIPTIONS[a], a).toMatch(/\w/)
    }
  })
})

describe('ontology.describe', () => {
  it('lists every term in plain words, and one term with where it is stored and its subclasses', async () => {
    const all = await run(USER, 'ontology.describe') as { version: string; classes: { name: string; label: string }[]; properties: { name: string }[]; alignments: unknown[] }
    expect(all.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(all.classes.map((c) => c.name)).toEqual(expect.arrayContaining(['Requirement', 'Gate', 'Criterion', 'PartsListLine']))
    expect(all.alignments.length).toBeGreaterThan(5)
    const req = await run(SYSTEM, 'ontology.describe', { term: 'Requirement' }) as { term: { label: string }; stored_in: string[] }
    expect(req).toMatchObject({ term: { label: 'Requirement' }, stored_in: ['project.requirements'] })
    const run_ = await run(USER, 'ontology.describe', { term: 'Run' }) as { subclasses: string[] }
    expect(run_.subclasses).toEqual(expect.arrayContaining(['DesignRuleCheckReport']))
    await expect(run(USER, 'ontology.describe', { term: 'Spaceship' })).rejects.toThrow(/no term called Spaceship/)
  })
})

describe('record.get', () => {
  it('gives a record as JSON-LD by kind and key, or by its identifier; and only to whom the project is shared', async () => {
    const r = await run(SYSTEM, 'record.get', { repo: REPO, id: 'requirement:REQ-001' }) as { id: string; record: Record<string, unknown> }
    expect(r.id).toBe('urn:trace:trace:acme%2Fonto:requirement:REQ-001')
    expect(r.record).toMatchObject({ '@context': expect.stringMatching(/context\/\d+\.\d+\.\d+\.jsonld$/), '@type': 'Requirement', text: 'Runs from 2.0 V to 3.3 V.' })
    const gate = await run(USER, 'record.get', { repo: REPO, id: r.id.replace(':requirement:REQ-001', ':gate:capture') }) as { record: Record<string, unknown> }
    expect(gate.record).toMatchObject({ '@type': 'Gate', ofStage: expect.stringMatching(/:stage:capture$/) })
    await expect(run(USER, 'record.get', { repo: REPO, id: 'requirement:REQ-404' })).rejects.toThrow(/has no record requirement:REQ-404/)
    await expect(run(USER, 'record.get', { repo: REPO, id: 'spaceship:1' })).rejects.toThrow(/no kind of record called spaceship/)
    await expect(run(OTHER, 'record.get', { repo: REPO, id: 'requirement:REQ-001' })).rejects.toThrow()
  })
})

describe('artifact.lineage and artifact.stale', () => {
  it('a run\'s inputs, outputs and the runs made from them', async () => {
    const l = await run(SYSTEM, 'artifact.lineage', { repo: REPO, run: netRun }) as { run: { kind: string }; made_from: unknown[]; made: { name: string }[]; made_into: { run: string }[] }
    expect(l.run.kind).toBe('kicad.netlist')
    expect(l.made_from).toEqual([{ file: 'hw/board.kicad_sch', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }])
    expect(l.made.map((m) => m.name)).toEqual(['netlist.net'])
    expect(l.made_into.map((m) => m.run)).toEqual([layoutRun])
    await expect(run(USER, 'artifact.lineage', { repo: REPO, run: 'nope-nope' })).rejects.toThrow(/no run nope-nope/)
  })

  it('says each newest run is current, and stale with why once the default branch\'s schematic changes', async () => {
    const before = await run(SYSTEM, 'artifact.stale', { repo: REPO }) as { stale: number; runs: { run: string; state: string }[] }
    expect(before.stale).toBe(0)
    expect(before.runs.map((r) => r.state)).toEqual(['current', 'current'])
    github.files.set(`${REPO}:main:hw/board.kicad_sch`, enc(SCH.replace('LM1117', 'TPS7A02')))
    const after = await run(SYSTEM, 'artifact.stale', { repo: REPO, runs: [layoutRun] }) as { stale: number; runs: { state: string; why: string[] }[] }
    expect(after).toMatchObject({ stale: 1, runs: [{ state: 'stale', why: ['netlist.net from kicad.netlist is out of date: hw/board.kicad_sch changed since kicad.netlist ran'] }] })
  })
})
