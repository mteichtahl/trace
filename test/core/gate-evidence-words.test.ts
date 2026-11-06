/**
 * What the gate page says about its waivers and evidence, from the test-esp32 run:
 *   #155  a waiver read "A waiver was taken on finding layout.fit@urn:trace:…%2Ftest-esp32-e2e:requirement:REQ-8fc402"
 *   #156  "Every connection is routed. Met (4 waived)": the stage's waivers put on the first criterion
 *   #70   re-signing a reopened stage showed the evidence "Opened" from the first signing
 *   #52   capture.datasheets was met on a netlist run that named no datasheet
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentFactError, addCriterionCheck, applyAgentFactsSchema } from '../../src/core/agent-facts.js'
import { type JourneyRecord, type Viewer, addWaiver, gateView, journeyView, loadJourney, recordOpen, returnGate, setCriterion, signGate, startJourney } from '../../src/core/journey.js'
import { openProject } from '../../src/core/store.js'
import { waiverCriterion, waiverTargetWords } from '../../src/core/waiver-words.js'

const ADMIN: Viewer = { hash: 'a'.repeat(16), label: 'admin@example.com', admin: true, part: 'contributor' }
const SIGNER = { hash: ADMIN.hash, label: ADMIN.label, admin: true }
const FIT = 'layout.fit@urn:trace:trace:mteichtahl%2Ftest-esp32-e2e:requirement:REQ-8fc402'

let db: DatabaseSync
let t = Date.parse('2026-11-05T06:00:00Z')
const tick = (): void => { t += 60_000; vi.setSystemTime(t) }
const rec = (): JourneyRecord => loadJourney(db) as JourneyRecord
const meetAll = (gate: string): void => { for (const c of rec().criteria.filter((x) => x.gate === gate)) setCriterion(db, c.id, 'met', [{ kind: 'run', ref: `run-${c.id}` }], 'trace') }
const openAll = (gate: string): void => { for (const c of rec().criteria.filter((x) => x.gate === gate)) recordOpen(db, { criterion: c.id }, ADMIN.hash) }
const opened = (gate: string): Record<string, boolean> => Object.fromEntries(gateView(rec(), gate, ADMIN).criteria.map((c) => [c.id, c.opened_by_you]))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(t)
  const dir = mkdtempSync(join(tmpdir(), 'trace-gate-words-'))
  mkdirSync(join(dir, '.git'))
  db = openProject(dir)
  startJourney(db, { template: 'board', by: ADMIN.label })
})
afterEach(() => { vi.useRealTimers() })

describe('a waiver says what it is on in plain words (#155)', () => {
  const text = (id: string) => ({ 'layout.fit': 'The board fits its enclosure.', 'layout.drc': 'The design rule check is clean, or each finding is waived.' } as Record<string, string>)[id]

  it('names the criterion and the record a shape finding is about, unescaped', () => {
    expect(waiverTargetWords({ kind: 'finding', id: FIT }, text)).toBe('the finding of “The board fits its enclosure” on requirement REQ-8fc402')
    expect(waiverTargetWords({ kind: 'finding', id: 'layout.fit@urn:trace:acme:acme%2Fpanel:case-finding:clash/J1/lid' }, text)).toBe('the finding of “The board fits its enclosure” on case finding clash/J1/lid')
    expect(waiverTargetWords({ kind: 'finding', id: 'architect.mapped@project' }, () => undefined)).toBe('the finding of architect.mapped on the project')
  })

  it('names a rule check finding by its check, its kind and where it is', () => {
    expect(waiverTargetWords({ kind: 'finding', id: 'drc:lib_footprint_mismatch:J1' }, text)).toBe("the design rule check's lib footprint mismatch finding on J1")
    expect(waiverTargetWords({ kind: 'finding', id: 'erc:pin_not_driven:12.5,30#2' }, text)).toBe("the electrical rule check's pin not driven finding at 12.5,30 mm")
    expect(waiverTargetWords({ kind: 'criterion', id: 'layout.fit' }, text)).toBe('the criterion “The board fits its enclosure”')
    expect(waiverTargetWords({ kind: 'requirement', id: 'REQ-8fc402' }, text)).toBe('requirement REQ-8fc402')
  })

  it('the decisions log and the journey view say it so', () => {
    addWaiver(db, { target: { kind: 'finding', id: FIT }, reason: 'The module glass covers the window.', risk: 'A part could touch the glass.', severity: 'cosmetic', caught_where: 'Test-fit of the first printed case', scope: 'this revision only' }, SIGNER)
    const summary = rec().decisions.find((d) => d.kind === 'waiver.added')?.summary ?? ''
    expect(summary).toMatch(/^A waiver was taken on the finding of “The board fits its enclosure, or each clash is waived” on requirement REQ-8fc402 \(rated cosmetic\)/)
    expect(summary).not.toMatch(/urn:|%2F/)
    expect(journeyView(rec(), ADMIN).waivers[0]).toMatchObject({ about: 'the finding of “The board fits its enclosure, or each clash is waived” on requirement REQ-8fc402', criterion: 'layout.fit', severity: 'cosmetic' })
  })
})

describe('a waiver counts for its own criterion only (#156)', () => {
  it('a shape finding counts for its criterion, a rule check finding for the rule check, a requirement for none', () => {
    expect(waiverCriterion({ kind: 'finding', id: FIT })).toBe('layout.fit')
    expect(waiverCriterion({ kind: 'finding', id: 'drc:lib_footprint_mismatch:J1' })).toBe('layout.drc')
    expect(waiverCriterion({ kind: 'finding', id: 'erc:pin_not_driven:U2' })).toBe('capture.erc')
    expect(waiverCriterion({ kind: 'criterion', id: 'layout.route' })).toBe('layout.route')
    expect(waiverCriterion({ kind: 'requirement', id: 'REQ-1' })).toBeNull()
    expect(waiverCriterion({ kind: 'test', id: 'T-1' })).toBeNull()
  })
})

describe('evidence opened for one signing does not carry over to the next (#70)', () => {
  it('a reopened stage is signed again only once each piece of evidence is opened again', () => {
    meetAll('define'); tick(); openAll('define'); tick()
    expect(Object.values(opened('define')).every(Boolean)).toBe(true)
    signGate(db, 'define', SIGNER); tick()
    returnGate(db, 'architect', SIGNER, { reason: 'A requirement limit changed: REQ-39855b.', reopen: 'define' }); tick()
    expect(Object.values(opened('define')).some(Boolean)).toBe(false)
    expect(() => signGate(db, 'define', SIGNER)).toThrow(/Open the evidence/)
    openAll('define'); tick()
    expect(Object.values(opened('define')).every(Boolean)).toBe(true)
    expect(signGate(db, 'define', SIGNER)).toBeTruthy()
  })

  it('evidence checked again after it was opened needs opening again', () => {
    meetAll('define'); tick(); openAll('define'); tick()
    const [first] = rec().criteria.filter((c) => c.gate === 'define')
    setCriterion(db, first!.id, 'met', [{ kind: 'run', ref: 'run-newer' }], 'trace')
    expect(opened('define')[first!.id]).toBe(false)
    expect(Object.entries(opened('define')).filter(([id]) => id !== first!.id).every(([, v]) => v)).toBe(true)
  })
})

describe('the datasheet criterion is met on the datasheets compared (#52)', () => {
  const by = { agent: 'impl', label: 'Implementation', jobId: null } as never
  it('refuses a netlist run alone, and takes it with each part datasheet named', () => {
    const r = rec()
    applyAgentFactsSchema(db)
    expect(() => addCriterionCheck(db, by, { criterion: 'capture.datasheets', status: 'met', evidence: [{ kind: 'run', ref: 'run-net', label: '54 nets, 23 components' }] }, r)).toThrow(AgentFactError)
    expect(() => addCriterionCheck(db, by, { criterion: 'capture.datasheets', status: 'met', evidence: [{ kind: 'run', ref: 'run-net' }] }, r)).toThrow(/evidence of kind datasheet/)
    const ok = addCriterionCheck(db, by, { criterion: 'capture.datasheets', status: 'met', evidence: [{ kind: 'run', ref: 'run-net' }, { kind: 'datasheet', ref: 'AMS1117-3.3', label: 'U1 AMS1117-3.3 p.2: input 5 V within the 15 V maximum' }] }, r)
    expect(ok.status).toBe('met')
    // not met needs no datasheet: there is nothing it was met on
    expect(addCriterionCheck(db, by, { criterion: 'capture.datasheets', status: 'not_met', evidence: [] }, r).status).toBe('not_met')
  })
})
