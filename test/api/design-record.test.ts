/**
 * The design record through the API: requirements.trace's intent and links, design.get's architecture, pin plan,
 * sheet drawings and sheet → requirements, graph.neighbourhood's intent, block and part nodes, people's decisions
 * (design.decide, and skill.submit for the design skills), and the quality-bar checks that read them.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { baselineCriteria } from '../../src/api/actions-skills.js'
import { assign, seen } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { setCriterion, startJourney } from '../../src/core/journey.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { DesignDb } from '../../src/tools/design/db.js'
import '../../src/tools/verify/db.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'd-admin', email: 'd-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'd-user', email: 'd-user@example.com', groups: ['trace-users'] }
const REVIEWER = { sub: 'd-rev', email: 'd-rev@example.com', groups: ['trace-users'] }
const OUTSIDER = { sub: 'd-out', email: 'd-out@example.com', groups: ['trace-users'] }
const REPO = 'acme/design'
const github = new FakeGitHub([REPO])
const cognito = new FakeCognito()
const scratch = mkdtempSync(join(tmpdir(), 'trace-design-api-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-design-bucket-'))
const deps: ActionDeps = {
  github: async () => github, cognito: () => cognito, jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [] }),
  tools: () => new Registry([]), scratch, store: (p) => backendFor(join(bucket, p)),
}
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<unknown> => (await perform(action, args, { principal: who, deps })).result
type Check = { id: string; status: string; detail?: string; unavailable?: string; confirmable?: boolean; confirmed?: boolean }
const checks = async (skill: string, who: Context['principal'] = USER): Promise<Record<string, Check>> =>
  Object.fromEntries(((await run(who, 'skill.get', { repo: REPO, skill })) as { checks: Check[] }).checks.map((c) => [c.id, c]))

const page = (w: number, h: number): Uint8Array => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm"></svg>`)
const ERC = JSON.stringify({ kicad_version: '10.0.7', coordinate_units: 'mm', sheets: [{ path: '/Power/', violations: [{ type: 'pin_not_connected', severity: 'error', description: 'Pin not connected', items: [{ description: 'Symbol U2 Pin 3', pos: { x: 148.5, y: 105 } }] }] }] })

function seed(fn: (db: DatabaseSync, dir: string) => void): void {
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  fn(db, dir)
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  rmSync(dir, { recursive: true, force: true })
}

beforeAll(async () => {
  cognito.add(ADMIN.email, ADMIN.sub, 'trace-admins')
  for (const p of [USER, REVIEWER, OUTSIDER]) cognito.add(p.email, p.sub, 'trace-users')
  await assign(ADMIN, USER, REPO, { class: 'user' })
  await assign(ADMIN, REVIEWER, REPO, { part: 'reviewer', class: 'user' })
  await seen(USER)
  seed((db, dir) => {
    startJourney(db, { template: 'mixed', by: 'seed', name: 'Design' })
    // the parts check, a checker tool of its own, found every key part in stock
    setCriterion(db, 'architect.stock', 'met', [{ kind: 'run', ref: 'run-stock', label: 'the stock check' }], 'trace')
    const t = Date.now() / 1000
    const req = db.prepare('INSERT INTO requirements (id, text, kind, acceptance, source, status, created, updated) VALUES (?,?,?,?,?,?,?,?)')
    req.run('REQ-1', 'Range of 2 km line of sight', 'functional', 'at least 2 km at 1% packet loss', 'intent', 'proposed', t, t)
    req.run('REQ-2', 'Runs 2 years on one cell', 'electrical', 'at least 2 years at 1 reading per 15 minutes', 'intent', 'proposed', t, t)
    req.run('REQ-3', 'Has a display', 'functional', null, 'intent', 'rejected', t, t)
    db.prepare("INSERT INTO test_items (id, title, requirements, method, status, created, updated) VALUES ('TST-1', 'Range test', '[\"REQ-1\"]', 'hil', 'fail', ?, ?)").run(t, t)
    const d = new DesignDb(dir)
    d.addIntent([
      { id: 'INT-purpose', topic: 'purpose', text: 'Reports soil moisture to a LoRa gateway.', source: { kind: 'person', ref: 'Priya' } },
      { id: 'INT-range', topic: 'performance', text: 'Reaches a gateway 2 km away, line of sight.', source: { kind: 'brief' } },
      { id: 'INT-life', topic: 'power', text: 'Runs 2 years on one 2,000 mAh cell.' },
      { id: 'INT-board', topic: 'physical', text: 'The board is at most 50 × 30 mm.', limits: [{ name: 'board_width', max: 50, unit: 'mm' }, { name: 'board_height', max: 30, unit: 'mm' }] },
    ])
    d.link('REQ-1', ['INT-range'])
    d.link('REQ-2', ['INT-life'])
    d.setOption({ id: 'A', name: 'Separate radio', summary: 'An STM32L0 with an SX1262 module.' })
    d.setOption({ id: 'B', name: 'STM32WL', summary: 'One chip with the radio inside.', recommended: true, why: 'Fewer parts and a lower sleep current.' })
    d.setCriteria([{ id: 'cost', name: 'Cost', weight: 2 }, { id: 'risk', name: 'Risk' }])
    d.setScores([{ option: 'A', criterion: 'cost', score: 3, reason: 'Two chips.' }, { option: 'B', criterion: 'cost', score: 5, reason: 'One chip.' }, { option: 'A', criterion: 'risk', score: 4, reason: 'Known parts.' }])
    d.setBlocks('B', [
      { id: 'pwr', name: 'Power', parts: [{ mpn: 'TLV75533PDBVR', key: true }], requirements: ['REQ-2'], x: 0.1, y: 0.5 },
      { id: 'mcu', name: 'MCU and radio', parts: [{ mpn: 'STM32WLE5JCI6', key: true }], requirements: ['REQ-1'], x: 0.7, y: 0.5 },
    ])
    d.setConnections('B', [{ from: 'pwr', to: 'mcu', kind: 'rail', label: '3.3 V, 50 mA' }])
    d.setPins([
      { part: 'U1', pin: '30', name: 'PA9', function: 'USART1_TX', peripheral: 'USART1', use: 'GPS', net: '/GPS_RX', alternates: ['USART1_TX', 'GPIO'] },
      { part: 'U1', pin: '34', name: 'PA13', function: 'SWDIO', kind: 'debug', reserved: 'debug', net: '/SWDIO', alternates: ['SWDIO', 'GPIO'] },
    ])
    d.setSheet({ sheet: 'hw/power.kicad_sch', block: 'pwr', requirements: ['REQ-2'] })
    d.close()
    const runRow = db.prepare('INSERT INTO runs (id, kind, subject, started, status, summary, result) VALUES (?,?,?,?,?,?,?)')
    const art = db.prepare('INSERT INTO artifacts VALUES (?,?,?,?)')
    runRow.run('run-erc', 'kicad.erc', 'hw/design.kicad_pro', t - 30, 'fail', 'ERC: 1 errors', null)
    art.run('run-erc', 'erc-report.json', 'application/json', new TextEncoder().encode(ERC))
    runRow.run('run-board', 'kicad.board', 'hw/design.kicad_pro', t - 20, 'pass', '12 footprints', JSON.stringify({ outline: { width_mm: 60, height_mm: 30 } }))
    runRow.run('run-net', 'kicad.netlist', 'hw/design.kicad_pro', t - 10, 'pass', '3 nets', null)
    art.run('run-net', 'nets.tsv', 'text/plain', new TextEncoder().encode('/GPS_RX\tU1.30 U3.4\n/SWDIO\tU1.34 J1.2\n/EXTRA\tU1.40 R1.1'))
    runRow.run('run-exp', 'kicad.export', 'hw/design.kicad_pro', t - 5, 'pass', 'sch_svg', null)
    art.run('run-exp', 'sheets/hw/power.kicad_sch.svg', 'image/svg+xml', page(297, 210))
    art.run('run-exp', 'board/design-board.svg', 'image/svg+xml', page(60, 30))
    art.run('run-exp', 'drawings.json', 'application/json', new TextEncoder().encode(JSON.stringify({ project: 'design', drawings: [
      { artifact: 'sheets/hw/power.kicad_sch.svg', kind: 'sheet', file: 'hw/power.kicad_sch', sheet: '/Power/', width_mm: 297, height_mm: 210, bytes: 80 },
      { artifact: 'board/design-board.svg', kind: 'board', width_mm: 60, height_mm: 30, origin_mm: { x_mm: 100, y_mm: 100 }, bytes: 80 },
    ] })))
  })
  const text = (s: string): Uint8Array => new TextEncoder().encode(s)
  github.files.set(`${REPO}:main:hw/design.kicad_pro`, text('{}'))
  github.files.set(`${REPO}:main:hw/design.kicad_sch`, text('(kicad_sch)'))
  github.files.set(`${REPO}:main:hw/power.kicad_sch`, text('(kicad_sch)'))
  github.files.set(`${REPO}:main:hw/design.kicad_pcb`, text('(kicad_pcb)'))
})
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })

describe('requirements.trace', () => {
  it('answers the intent statements, each requirement\'s derived_from links, and what no requirement covers', async () => {
    const r = await run(REVIEWER, 'requirements.trace', { repo: REPO }) as {
      intent: { id: string; topic: string; state: string; covered: boolean; source: unknown }[]; links: unknown[]; intent_note?: string
      requirements: { id: string; derived_from: string[] }[]; summary: Record<string, number>
    }
    expect(r.intent_note).toBeUndefined()
    expect(r.intent.map((s) => [s.id, s.topic, s.state, s.covered])).toEqual([
      ['INT-purpose', 'Purpose', 'proposed', false], ['INT-range', 'Performance', 'proposed', true], ['INT-life', 'Power', 'proposed', true], ['INT-board', 'Physical', 'proposed', false],
    ])
    expect(r.intent[0]?.source).toEqual({ kind: 'person', ref: 'Priya' })
    expect(r.links).toEqual([{ requirement: 'REQ-1', intent: 'INT-range' }, { requirement: 'REQ-2', intent: 'INT-life' }])
    expect(r.requirements.map((q) => [q.id, q.derived_from])).toEqual([['REQ-1', ['INT-range']], ['REQ-2', ['INT-life']]])
    expect(r.summary).toMatchObject({ intent: 4, accepted: 0, uncovered: 2, unlinked: 0 })
  })
})

describe('design.get', () => {
  it('draws the recommended architecture until a person chooses, the pin plan with its findings, and each sheet with its drawing, findings placed, and what it serves', async () => {
    const d = await run(USER, 'design.get', { repo: REPO }) as {
      architecture: { option: string; state: string; blocks: { id: string; part: string; serves: string[] }[]; connections: unknown[]; options: { id: string; total: number }[]; recommended: string; chosen: null }
      pins: { pin: string; status: string; note?: string }[]; pin_plan: { checked: { run: string }; parts: { part: string; agreed: null }[]; findings: { kind: string }[] }
      sheets: { id: string; path?: string; serves?: string[]; block?: string; findings: { at?: { x: number; y: number } }[] }[]
      board: { path: string; findings: unknown[] }; drawings: { run: string }; notes: string[]
    }
    expect(d.architecture).toMatchObject({ option: 'Option B: STM32WL', state: 'proposed', recommended: 'B', chosen: null })
    expect(d.architecture.blocks.map((b) => [b.id, b.part, b.serves])).toEqual([['mcu', 'STM32WLE5JCI6', ['REQ-1']], ['pwr', 'TLV75533PDBVR', ['REQ-2']]])
    expect(d.architecture.connections).toEqual([{ from: 'pwr', to: 'mcu', label: '3.3 V, 50 mA', kind: 'rail' }])
    expect(d.architecture.options.map((o) => [o.id, o.total])).toEqual([['A', 10], ['B', 10]])
    expect(d.notes.join(' ')).toMatch(/No architecture is chosen yet/)
    expect(d.pins.map((p) => [p.pin, p.status])).toEqual([['30', 'ok'], ['34', 'ok']])
    expect(d.pin_plan.checked.run).toBe('run-net')
    expect(d.pin_plan.findings.map((f) => f.kind)).toEqual(['missing_pin'])
    expect(d.pin_plan.parts).toEqual([{ part: 'U1', pins: 2, agreed: null }])
    const power = d.sheets.find((s) => s.id === 'hw/power.kicad_sch')
    expect(power).toMatchObject({ path: 'runs/run-exp/sheets/hw/power.kicad_sch.svg', serves: ['REQ-2'], block: 'pwr' })
    expect(power?.findings[0]?.at).toEqual({ x: 0.5, y: 0.5 })
    expect(d.sheets.find((s) => s.id === 'hw/design.kicad_sch')?.serves).toBeUndefined()
    expect(d.board.path).toBe('runs/run-exp/board/design-board.svg')
    expect(d.drawings.run).toBe('run-exp')
    expect(d.notes.join(' ')).toMatch(/1 of 2 sheets do not name the requirements/)
    // the drawing opens through files.url like any evidence
    const f = await run(USER, 'files.url', { repo: REPO, path: 'runs/run-exp/sheets/hw/power.kicad_sch.svg' }) as { mime?: string; base64?: string }
    expect(f).toMatchObject({ mime: 'image/svg+xml' })
  })
})

describe('graph.neighbourhood', () => {
  it('has intent nodes with derived_from links, and the architecture\'s blocks with serves and uses links', async () => {
    const g = await run(USER, 'graph.neighbourhood', { repo: REPO, focus: 'REQ-2', depth: 2 }) as { nodes: { id: string; kind: string; status?: string }[]; links: { source: string; target: string; kind: string }[] }
    const kinds = Object.fromEntries(g.nodes.map((n) => [n.id, n.kind]))
    expect(kinds['intent:INT-life']).toBe('intent')
    expect(kinds['block:pwr']).toBe('block')
    expect(kinds['part:TLV75533PDBVR']).toBe('part')
    expect(kinds['sheet:hw/power.kicad_sch']).toBe('document')
    expect(g.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'requirement:REQ-2', target: 'intent:INT-life', kind: 'derived_from' }),
      expect.objectContaining({ source: 'block:pwr', target: 'requirement:REQ-2', kind: 'serves' }),
      expect.objectContaining({ source: 'block:pwr', target: 'part:TLV75533PDBVR', kind: 'uses' }),
      expect.objectContaining({ source: 'sheet:hw/power.kicad_sch', target: 'requirement:REQ-2', kind: 'serves' }),
    ]))
    // a failing requirement colours its intent
    const i = await run(USER, 'graph.neighbourhood', { repo: REPO, focus: 'intent:INT-range', depth: 1 }) as { nodes: { id: string; status?: string }[] }
    expect(i.nodes.find((n) => n.id === 'intent:INT-range')?.status).toBe('failing')
  })
})

describe('the guided skills read the design record', () => {
  it('Intent builder: topics, numbers, vague words, interfaces, conflicts, testable, owners', async () => {
    const c = await checks('intent-builder')
    expect(c.answered).toMatchObject({ status: 'not_met', detail: expect.stringMatching(/^6 topics not answered or marked: Environment, Interfaces, Compliance, Build, Constraints, References\.$/) })
    expect(c.quantities).toMatchObject({ status: 'met' })
    expect(c.vague).toMatchObject({ status: 'met' })
    expect(c.interfaces).toMatchObject({ status: 'not_met', detail: expect.stringMatching(/No interface is stated/) })
    expect(c.conflicts?.status).toBe('met')
    expect(c.owners?.status).toBe('met')
    for (const x of Object.values(c)) expect(x.unavailable, x.id).toBeUndefined()
    const v = await run(USER, 'skill.get', { repo: REPO, skill: 'intent-builder' }) as { intent: { answered: string[]; statements: { id: string; topic: string; state: string }[] } }
    expect(v.intent.answered).toEqual(['purpose', 'power', 'performance', 'physical'])
    expect(v.intent.statements[0]).toMatchObject({ id: 'INT-purpose', topic: 'Purpose', state: 'draft' })
  })

  it('Requirements review: coverage of the intent and struck reasons are checked; a pending strike in the draft counts', async () => {
    let c = await checks('requirements-review')
    expect(c.covered).toMatchObject({ status: 'not_met', detail: '2 intent statements no requirement covers, and not left out with a reason: INT-purpose, INT-board.' })
    expect(c.struck).toMatchObject({ status: 'not_met', detail: expect.stringMatching(/1 struck requirement without a reason: REQ-3/) })
    await run(USER, 'skill.draft', { repo: REPO, skill: 'requirements-review', step: 5, data: {
      decisions: [{ requirement: 'REQ-3', choice: 'strike', reason: 'The farm manager reads it on the phone app.' }],
      uncovered: [{ statement: 'INT-purpose', reason: 'The purpose is covered by the requirements as a whole.' }, { statement: 'INT-board', reason: 'Checked by Board setup against the outline.' }],
    } })
    c = await checks('requirements-review')
    expect(c.covered?.status).toBe('met')
    expect(c.struck?.status).toBe('met')
    // the draft is only laid over a copy: the record is unchanged until Submit
    const t = await run(USER, 'requirements.trace', { repo: REPO }) as { intent: { id: string; uncovered?: string }[] }
    expect(t.intent.find((s) => s.id === 'INT-purpose')?.uncovered).toBeUndefined()
  })

  it('Architecture choice: two options; criteria fixed before the choice; scored with reasons; every requirement on a block', async () => {
    let c = await checks('architecture-choice')
    expect(c.two?.status).toBe('met')
    expect(c.fixed).toMatchObject({ status: 'not_met', detail: expect.stringMatching(/Fix the criteria/) })
    expect(c.scored).toMatchObject({ status: 'not_met', detail: '1 score missing or without a reason: B on Risk.' })
    expect(c.mapped).toMatchObject({ status: 'met' })
    // a reviewer may not decide
    await expect(run(REVIEWER, 'design.decide', { repo: REPO, decision: { kind: 'criteria', criteria: [{ id: 'cost', name: 'Cost', weight: 2 }] } })).rejects.toMatchObject({ name: 'AccessDenied' })
    expect(await run(USER, 'design.decide', { repo: REPO, decision: { kind: 'criteria', criteria: [{ id: 'cost', name: 'Cost', weight: 2 }] } })).toMatchObject({ ok: true, decision: { kind: 'architecture.criteria', choice: 'fixed' } })
    c = await checks('architecture-choice')
    expect(c.fixed?.status).toBe('met')
    expect(c.scored).toMatchObject({ status: 'not_met', detail: 'Choose an option and name the criteria that decided it.' })
    // against the recommendation needs a reason of its own
    await expect(run(USER, 'skill.submit', { repo: REPO, skill: 'architecture-choice', draft: { choice: { option: 'A', reason: 'ok' }, deciding: ['cost'] } })).rejects.toThrow(/cannot be submitted yet/)
    // taking the recommendation as the decision card sends it (no reason of the person's own): trace's why stands for it
    await run(USER, 'skill.draft', { repo: REPO, skill: 'architecture-choice', step: 3, data: { choice: { option: 'B' }, deciding: ['cost'] } })
    expect((await checks('architecture-choice')).scored?.status).toBe('met')
    await run(USER, 'skill.draft', { repo: REPO, skill: 'architecture-choice', step: 3, data: null })
    const s = await run(USER, 'skill.submit', { repo: REPO, skill: 'architecture-choice', draft: { choice: { option: 'B', reason: 'Fewer parts for the same cost.' }, deciding: ['cost'] } }) as { ok: boolean }
    expect(s.ok).toBe(true)
    const d = await run(USER, 'design.get', { repo: REPO }) as { architecture: { state: string; chosen: { option: string; by: string } } }
    expect(d.architecture).toMatchObject({ state: 'chosen', chosen: { option: 'B', by: USER.email } })
    const j = await run(USER, 'journey.get', { repo: REPO }) as { decisions: { kind: string }[] }
    expect(j.decisions.slice(0, 2).map((x) => x.kind)).toEqual(['skill.submitted', 'design.architecture.choice'])
    // the person's approval of the blocks and key parts, which the architecture review gate waits for
    const g = await run(USER, 'journey.get', { repo: REPO }) as { gates: { id: string; criteria: { id: string; status: string; evidence: { ref: string }[] }[] }[] }
    expect(g.gates.find((x) => x.id === 'architect')?.criteria.find((x) => x.id === 'architect.blocks')).toMatchObject({ status: 'met', evidence: [{ ref: 'architecture-choice' }] })
  })

  it('Pin plan review: functions, instances, reserved pins, and the match with the schematic\'s netlist', async () => {
    const c = await checks('pin-plan-review')
    expect(c.functions?.status).toBe('met')
    expect(c.instances?.status).toBe('met')
    expect(c.boot?.status).toBe('met')
    expect(c.match).toMatchObject({ status: 'not_met', detail: 'U1 pin 40 is on /EXTRA in the schematic but is not in the pin plan.' })
    for (const x of Object.values(c)) expect(x.unavailable, x.id).toBeUndefined()
    // a waiver on the finding lets it through
    await run(USER, 'waiver.add', { repo: REPO, target: { kind: 'finding', id: 'pin:U1.40:missing_pin' }, reason: 'Pin 40 is a test point the firmware never drives.', risk: 'None at bring-up.', severity: 'cosmetic', caught_where: null })
    expect((await checks('pin-plan-review')).match?.status).toBe('waived')
    expect(await run(USER, 'skill.submit', { repo: REPO, skill: 'pin-plan-review', draft: {} })).toMatchObject({ ok: true })
    const d = await run(USER, 'design.get', { repo: REPO }) as { pin_plan: { parts: { part: string; agreed: { by: string; stale: boolean } }[] } }
    expect(d.pin_plan.parts[0]).toMatchObject({ part: 'U1', agreed: { by: USER.email, stale: false } })
  })

  it('Schematic finish: every sheet names its requirements; Board setup: the outline against the intent\'s limits', async () => {
    expect((await checks('schematic-finish')).serves).toMatchObject({ status: 'not_met', detail: '1 sheet without the requirements it serves: hw/design.kicad_sch.' })
    expect((await checks('board-setup')).outline).toMatchObject({ status: 'not_met', detail: 'The board is 60 mm wide (at most 50).' })
  })

  it('a check no tool can make yet is the person\'s to confirm; one waiting on a run or a file is not', async () => {
    let c = await checks('schematic-finish')
    expect(c.notes).toMatchObject({ status: 'not_met', unavailable: expect.any(String), confirmable: true })
    await run(USER, 'skill.draft', { repo: REPO, skill: 'schematic-finish', step: 1, data: { confirmed: { notes: true, serves: true } } })
    c = await checks('schematic-finish')
    expect(c.notes).toMatchObject({ status: 'met', confirmed: true, detail: expect.stringMatching(/^You confirmed it/) })
    expect(c.notes?.unavailable).toBeUndefined()
    expect(c.changes).toMatchObject({ status: 'not_met', confirmable: true })
    // serves is checked from the record: a confirmation does not stand in for it
    expect(c.serves).toMatchObject({ status: 'not_met' })
    expect(c.serves?.confirmed).toBeUndefined()
    await run(USER, 'skill.draft', { repo: REPO, skill: 'schematic-finish', step: 1, data: null })
  })

  it('Intent builder Submit accepts every proposed statement as worded, and records an edit; requirements.trace shows them accepted', async () => {
    await expect(run(USER, 'skill.submit', { repo: REPO, skill: 'intent-builder', draft: {} })).rejects.toThrow(/Every topic answered or marked/)
    const r = await run(USER, 'design.decide', { repo: REPO, decision: { kind: 'intent', statement: 'INT-life', choice: 'edit', text: 'Runs 2 years on one 2,000 mAh lithium cell at one reading every 15 minutes.' } }) as { decision: { choice: string } }
    expect(r.decision.choice).toBe('edited')
    await expect(run(USER, 'design.decide', { repo: REPO, decision: { kind: 'intent', statement: 'INT-nope', choice: 'accept' } })).rejects.toThrow(/no intent statement INT-nope/)
    await expect(run(USER, 'design.decide', { repo: REPO, decision: { kind: 'requirement', requirement: 'REQ-1', choice: 'strike' } })).rejects.toThrow(/why the requirement is struck/)
    await run(USER, 'design.decide', { repo: REPO, decision: { kind: 'intent', statement: 'INT-purpose', choice: 'accept' } })
    const t = await run(USER, 'requirements.trace', { repo: REPO }) as { intent: { id: string; state: string; text: string; decided?: { by: string } }[] }
    expect(t.intent.find((s) => s.id === 'INT-life')).toMatchObject({ state: 'edited', text: expect.stringMatching(/lithium cell/) })
    expect(t.intent.find((s) => s.id === 'INT-purpose')).toMatchObject({ state: 'accepted', decided: { by: USER.email } })
  })

  it('an outsider is refused alike for design.decide on a project that is not theirs and on one that does not exist, before GitHub is read', async () => {
    const d = { kind: 'pins', part: 'U1' }
    github.calls = []
    const a = await run(OUTSIDER, 'design.decide', { repo: REPO, decision: d }).catch((e: Error) => [e.name, e.message.replace(REPO, '<repo>')])
    const b = await run(OUTSIDER, 'design.decide', { repo: 'acme/nope', decision: d }).catch((e: Error) => [e.name, e.message.replace('acme/nope', '<repo>')])
    expect(a).toEqual(['AccessDenied', expect.any(String)])
    expect(b).toEqual(a)
    expect(github.calls).toEqual([])
  })

  it('Requirements review: the person confirms no conflicts; Submit records the baseline gate\'s criteria from the record', async () => {
    const draft = {
      decisions: [{ requirement: 'REQ-1', choice: 'accept' }, { requirement: 'REQ-2', choice: 'accept' }, { requirement: 'REQ-3', choice: 'strike', reason: 'The farm manager reads it on the phone app.' }],
      uncovered: [{ statement: 'INT-purpose', reason: 'The purpose is covered by the requirements as a whole.' }, { statement: 'INT-board', reason: 'Checked by Board setup against the outline.' }],
    }
    await run(USER, 'skill.draft', { repo: REPO, skill: 'requirements-review', step: 4, data: draft })
    let c = await checks('requirements-review')
    // duplicates and conflicting intent are checked; the numbers are the person's to confirm, so it is not met, and
    // says what to do, rather than "cannot be checked yet" for ever
    expect(c.conflicts).toMatchObject({ status: 'not_met', detail: expect.stringMatching(/Confirm in Resolve conflicts/) })
    expect(c.conflicts?.unavailable).toBeUndefined()
    await expect(run(USER, 'skill.submit', { repo: REPO, skill: 'requirements-review', draft })).rejects.toThrow(/No conflicts or duplicates/)
    await run(USER, 'skill.draft', { repo: REPO, skill: 'requirements-review', step: 4, data: { ...draft, no_conflicts: true } })
    c = await checks('requirements-review')
    expect(c.conflicts).toMatchObject({ status: 'met', detail: expect.stringMatching(/you confirmed/) })
    const before = await run(USER, 'journey.get', { repo: REPO }) as { gates: { id: string; criteria: { id: string; status: string }[] }[] }
    expect(before.gates.find((g) => g.id === 'define')?.criteria.filter((x) => x.status === 'met').map((x) => x.id) ?? []).not.toContain('define.accepted')
    expect(await run(USER, 'skill.submit', { repo: REPO, skill: 'requirements-review', draft: { ...draft, no_conflicts: true } })).toMatchObject({ ok: true })
    const after = await run(USER, 'journey.get', { repo: REPO }) as { gates: { id: string; criteria: { id: string; status: string; evidence: { kind: string }[] }[] }[] }
    const define = after.gates.find((g) => g.id === 'define')!.criteria
    expect(define.find((x) => x.id === 'define.accepted')).toMatchObject({ status: 'met', evidence: [{ kind: 'skill' }] })
    expect(define.find((x) => x.id === 'define.measurable')).toMatchObject({ status: 'met' })
  })
})

describe('the requirements baseline from the record', () => {
  it('is met when every requirement is accepted, and measurable when each accepted criterion has a number and a unit', () => {
    expect(baselineCriteria([])).toEqual([['define.accepted', false], ['define.measurable', false], ['define.firmware', false]])
    expect(baselineCriteria([{ status: 'accepted', acceptance: 'exactly 2 copper layers' }, { status: 'proposed', acceptance: '5 mA' }]).map(([, ok]) => ok)).toEqual([false, false, false])
    expect(baselineCriteria([{ status: 'accepted', acceptance: '0.45-0.55 Hz' }, { status: 'accepted', acceptance: 'each 5.1 kΩ ± 1 %' }]).map(([, ok]) => ok)).toEqual([true, true, true])
    expect(baselineCriteria([{ status: 'accepted', acceptance: 'clearly visible' }])).toEqual([['define.accepted', true], ['define.measurable', false], ['define.firmware', true]])
  })
})
