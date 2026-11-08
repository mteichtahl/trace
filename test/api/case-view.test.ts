/**
 * The case through the API (plan P7.7, P6.4): design.get's `case` (the newest case build with each problem by its part,
 * a waived one waived, and why it is out of date once the board's edge connector moves on the default branch), and the
 * graph's case node made by its build and failing each part that clashes. A real build of the sample board
 * (test/fixtures/case-build/clash: a case script that lowers the lid). And the Case design skill's process step: the
 * designs mech.options found could work, recommended first, and each one not offered with why (P7.5).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { unwaivedCaseFindings } from '../../src/api/case-read.js'
import { assign } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { addWaiver, loadJourney, startJourney } from '../../src/core/journey.js'
import { normalisedHash } from '../../src/core/normalise.js'
import { Registry } from '../../src/core/registry.js'
import { Work, openProject } from '../../src/core/store.js'
import { nodeIri } from '../../src/ontology/graph.js'
import { boardFacts } from '../../src/tools/mech/board.js'
import { caseFactHashes, caseViewHashOf } from '../../src/tools/mech/case-facts.js'
import { CAPABILITIES, capabilitiesStamp } from '../../src/tools/mech/capabilities.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'a-admin', email: 'admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'a-user', email: 'user@example.com', groups: ['trace-users'] }
const REPO = 'acme/cased'
const BOARD = 'hardware/trace-sample.kicad_pcb'
const SAMPLE = join(import.meta.dirname, '../../templates/sample')
const FIX = join(import.meta.dirname, '../fixtures/case-build/clash')
const PCB = readFileSync(join(SAMPLE, BOARD), 'utf8')
const github = new FakeGitHub([REPO])
const scratch = mkdtempSync(join(tmpdir(), 'trace-case-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-case-bucket-'))
const deps: ActionDeps = { github: async () => github, cognito: () => new FakeCognito(), jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [], cancel: async () => ({ ok: true, state: 'aborted' }), pause: async () => ({ ok: true, state: 'running' }) }), tools: () => new Registry([]), scratch, store: (p) => backendFor(join(bucket, p)) }
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<unknown> => (await perform(action, args, { principal: who, deps })).result
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const finding = (key: string): string => `layout.fit@${nodeIri({ installation: process.env.TRACE_PREFIX ?? 'trace', project: REPO }, 'case-finding', key)}`
let build = ''
let seed = ''

beforeAll(async () => {
  await assign(ADMIN, USER, REPO, { class: 'user' })
  const dir = mkdtempSync(join(scratch, 'seed-'))
  seed = dir
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed', name: 'Cased' })
  // a person waived the one problem J2 clashing with the lid
  addWaiver(db, { target: { kind: 'finding', id: finding('clash/J2/lid') }, reason: 'J2 is fitted after the lid closes.', risk: 'The lid will not close if it is fitted first.', severity: 'cosmetic', caught_where: null, scope: 'this revision only' }, { hash: 'h'.repeat(16), label: 'admin@example.com' })
  db.close()
  const facts = boardFacts(join(SAMPLE, BOARD), SAMPLE)
  const caseJson = readFileSync(join(FIX, 'case.json'), 'utf8')
  const w = new Work(join(dir, '.trace', 'project.db'))
  build = w.start('mech.build', { subject: BOARD, args: {} })
  for (const f of ['result.json', 'facts.json', 'fit.json', 'case.json']) w.artifact(build, f, readFileSync(join(FIX, f), 'utf8'), 'application/json')
  // the case options, as mech.options records them (the sample board with a connector past its south edge)
  const opt = w.start('mech.options', { subject: BOARD, args: {} })
  w.artifact(opt, 'options.json', readFileSync(join(FIX, '..', 'options.json'), 'utf8'), 'application/json')
  w.finish(opt, 'pass', '6 case designs could work')
  w.inputs(build, [{ kind: 'file', ref: `${BOARD}#case`, sha256: caseViewHashOf(facts) }, { kind: 'file', ref: 'mechanical/case.json', sha256: normalisedHash('mechanical/case.json', enc(caseJson)) }])
  const r = JSON.parse(readFileSync(join(FIX, 'result.json'), 'utf8')) as { fit: { summary: string } }
  w.finish(build, 'fail', 'fit fail', {
    fit_status: 'fail', fit_summary: r.fit.summary, process: { service: 'jlc3dp', process: 'MJF', material: 'PA12-HP' },
    inputs: { board: BOARD, board_sha256: 'x', case_facts: caseFactHashes(facts), case_json_sha256: null, case_py_sha256: null, case_file: null, case_file_sha256: null, capabilities_checked: CAPABILITIES.checked, capabilities_sha256: capabilitiesStamp() },
  })
  w.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  github.files.set(`${REPO}:main:${BOARD}`, enc(PCB))
})
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })

type Case = { run: string; status: string; summary: string; board: string; findings: { id: string; kind: string; severity: string; where?: string; x_mm?: number; text: string }[]; stale: string[] | null }

describe('the case in design.get', () => {
  it('names each problem by its part, where it is on the board, a waived one waived; current while the board stands', async () => {
    const c = (await run(USER, 'design.get', { repo: REPO }) as { case: Case }).case
    expect(c).toMatchObject({ run: build, status: 'fail', board: BOARD, stale: [] })
    expect(c.findings.map((f) => [f.kind, f.where ?? null, f.severity])).toEqual([
      ['clash', null, 'blocks'], ['clash', 'J1', 'blocks'], ['clash', 'J2', 'waived'], ['clash', 'J3', 'blocks'],
      ['gap', 'J1', 'blocks'], ['gap', 'J2', 'blocks'], ['gap', 'J3', 'blocks'], ['opening', 'J1', 'blocks'], ['rule', null, 'blocks'],
    ])
    expect(c.findings.find((f) => f.where === 'J2' && f.kind === 'clash')).toMatchObject({ id: finding('clash/J2/lid'), x_mm: 156, text: 'J2 clashes with the lid (37.74 mm³)' })
    expect(c.findings[0]?.text).toBe('The board clashes with the lid (294 mm³)')
  })

  it('says why in plain words once an edge connector moves on the default branch; a middle part moving does not', async () => {
    const move = (ref: string, x: number, y: number): string => {
      const at = PCB.indexOf(`(property "Reference" "${ref}"`)
      const start = PCB.lastIndexOf('(footprint ', at)
      return PCB.slice(0, start) + PCB.slice(start, at).replace(/\(at [-\d.]+ [-\d.]+/, `(at ${x} ${y}`) + PCB.slice(at)
    }
    github.files.set(`${REPO}:main:${BOARD}`, enc(move('R3', 118, 112)))
    expect((await run(USER, 'design.get', { repo: REPO }) as { case: Case }).case.stale).toEqual([])
    github.files.set(`${REPO}:main:${BOARD}`, enc(move('J1', 103, 113)))
    expect((await run(USER, 'design.get', { repo: REPO }) as { case: Case }).case.stale).toEqual([`J1 at the board's edge moved or changed since the build`])
    // the graph: the case, made by its build, stale with it, failing each part that clashes
    const g = await run(USER, 'graph.neighbourhood', { repo: REPO, focus: 'case:enclosure', depth: 1 }) as { nodes: { id: string; kind: string; status?: string }[]; links: { source: string; target: string; kind: string }[] }
    expect(g.nodes[0]).toMatchObject({ id: 'case:enclosure', kind: 'case', status: 'stale' })
    expect(g.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: `run:${build}`, target: 'case:enclosure', kind: 'made' }),
      expect.objectContaining({ source: 'case:enclosure', target: 'component:J2', kind: 'fails' }),
    ]))
    github.files.set(`${REPO}:main:${BOARD}`, enc(PCB))
  })
})

describe('the case in tracectl check', () => {
  it('counts a problem waived in the app, whatever installation named it; passes only when every one is (R54)', () => {
    const w = new Work(join(seed, '.trace', 'project.db'))
    try {
      const left = unwaivedCaseFindings(w.db, loadJourney(w.db))
      expect(left).toMatchObject({ all: 9 })
      expect(left!.open.map((f) => f.id)).not.toContain(finding('clash/J2/lid'))
      expect(left!.open).toHaveLength(8)
      // the rest waived under another installation's name: the check runs under the repository's
      for (const f of left!.open) {
        const tail = f.id.slice(f.id.search(/:case-(?:finding|rule):/))
        addWaiver(w.db, { target: { kind: 'finding', id: `layout.fit@urn:trace:elsewhere:${encodeURIComponent(REPO)}${tail}` }, reason: 'Checked by hand on the printed case.', risk: 'A part may touch the case.', severity: 'cosmetic', caught_where: null, scope: 'this revision only' }, { hash: 'h'.repeat(16), label: 'admin@example.com' })
      }
      expect(unwaivedCaseFindings(w.db, loadJourney(w.db))).toEqual({ all: 9, open: [] })
    } finally { w.close() }
  })
})

describe('the Case design skill\'s process step', () => {
  it('asks which case to build: the designs that could work recommended first, with why, and why the rest were dropped', async () => {
    const v = await run(USER, 'skill.get', { repo: REPO, skill: 'case-design' }) as { recommendation: { question: string; recommended: string; options: { id: string; label: string; detail: string }[]; why: string }; items: { title: string; detail: string; status: string }[] }
    expect(v.recommendation.question).toBe('Which case should trace build?')
    expect(v.recommendation.recommended).toBe(v.recommendation.options[0]!.id)
    expect(v.recommendation.options.length).toBeGreaterThanOrEqual(2)
    expect(v.recommendation.options[0]!.label).toMatch(/^DIN rail enclosure, MJF PA12-HP at JLC3DP/)
    expect(v.recommendation.why).toMatch(/the requirements ask for a DIN rail mount/)
    expect(v.recommendation.options.every((o) => /Gives up: /.test(o.detail))).toBe(true)
    expect(v.items).toEqual(expect.arrayContaining([{ id: 'not-offered:extruded-box/mjf', title: 'Extruded box with end plates, MJF PA12-HP at JLC3DP', detail: "J9 sticks out past the board's long edge, so the board cannot slide into the tube", status: 'waived', label: 'Not offered' }]))
  })
})
