/**
 * Project templates in installation settings (docs/ontology-plan.md P5.6): the code's catalog is the default, an admin
 * changes a template within it, a saved template can always start a journey, a journey keeps the definition it started
 * from, and a criterion an admin added is signed off by a person saying what they checked.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Bridge } from '../../src/core/bridge.js'
import { central } from '../../src/core/central.js'
import {
  JourneyError, LATER_STAGES, TEMPLATES, applyJourneySchema, confirmCriterion, journeyView, loadJourney, setCriterion, signGate, startJourney, templateStages, updateAbout, recordOpen,
} from '../../src/core/journey.js'
import { TemplateStore } from '../../src/core/template-store.js'
import { type TemplateDoc, catalogTemplate, docStages, templateProblems } from '../../src/core/templates.js'
import { ONTOLOGY_DIR } from '../../src/ontology/vocab.js'
import { templateTurtle } from '../../src/ontology/template-graph.js'
import { tempDb } from '../ontology/fixture.js'

const ADMIN = { hash: 'a'.repeat(16), label: 'admin@example.com' }
const copy = (d: TemplateDoc): TemplateDoc => structuredClone(d)

/** A board template an admin changed: Prove dropped, a criterion dropped and one reworded, the mixed template's pin
 *  check borrowed, a person's own criterion added, and Define's guide reworded. */
function edited(): TemplateDoc {
  const d = copy(catalogTemplate('board'))
  d.name = 'Sensor board'
  d.stages = d.stages.filter((s) => s.id !== 'prove')
  const capture = d.stages.find((s) => s.id === 'capture')!.gates[0]!
  capture.criteria = capture.criteria.filter((c) => c.id !== 'capture.datasheets')
  capture.criteria.find((c) => c.id === 'capture.erc')!.text = 'The schematic rule check is clean, or each finding is waived.'
  capture.criteria.push({ id: 'capture.alternates', text: 'No two functions claim one pin.' })
  d.stages.find((s) => s.id === 'architect')!.gates[0]!.criteria.push({ id: 'architect.safety', text: 'The safety review is done.', custom: true, evidence: 'the safety review notes' })
  d.stages[0]!.guide.purpose = 'Agree what the sensor must do, as requirements that can each be measured.'
  return d
}

describe('the catalog as the default', () => {
  it('every template\'s code definition is sound, and gives the stages the code gives', () => {
    for (const t of TEMPLATES) {
      expect(templateProblems(catalogTemplate(t)), t).toEqual([])
      expect(docStages(catalogTemplate(t), LATER_STAGES), t).toEqual(templateStages(t, LATER_STAGES))
      expect(docStages(catalogTemplate(t)), t).toEqual(templateStages(t))
    }
  })
})

describe('what an admin may not change', () => {
  const problem = (f: (d: TemplateDoc) => void): string[] => { const d = copy(catalogTemplate('board')); f(d); return templateProblems(d) }

  it('says each problem in words', () => {
    expect(problem((d) => { d.stages = d.stages.filter((s) => s.id !== 'define') })).toContain('Every template starts at Define.')
    expect(problem((d) => { d.stages = d.stages.filter((s) => s.id !== 'sustain') })).toContain('Sustain stays in every template: each project chooses whether to use it.')
    expect(problem((d) => { d.stages.reverse() }).join(' ')).toMatch(/not in order/)
    expect(problem((d) => { d.stages[2] = copy(d.stages[1]!) })).toContain('A stage is listed twice.')
    expect(problem((d) => { d.stages = d.stages.filter((s) => s.id === 'define' || (LATER_STAGES as readonly string[]).includes(s.id)) })).toContain('A template needs at least one stage after Define.')
    expect(problem((d) => { d.stages.find((s) => s.id === 'fabricate')!.gates.pop() }).join(' ')).toMatch(/Fabricate ends at its gates fabricate\.order and fabricate\.received/)
    expect(problem((d) => { d.stages[0]!.gates[0]!.criteria = [] })).toContain('The gate define needs at least one criterion.')
    expect(problem((d) => { d.stages[0]!.gates[0]!.criteria.push({ id: 'define.made-up', text: 'Something.' }) }).join(' ')).toMatch(/not one of trace's criteria/)
    expect(problem((d) => { d.stages[0]!.gates[0]!.criteria.push({ id: 'define.accepted', text: 'Again.', custom: true, evidence: 'x y z' }) }).join(' ')).toMatch(/listed twice|one of trace's own/)
    expect(problem((d) => { d.stages[0]!.gates[0]!.criteria.push({ id: 'define.review', text: 'Reviewed.', custom: true }) })).toContain('define.review needs the evidence a person looks at to sign it off.')
    expect(problem((d) => { d.stages[0]!.gates[0]!.criteria.push({ id: 'capture.erc', text: 'Borrowed from another gate.' }) }).join(' ')).toMatch(/does not belong to the gate define/)
    expect(problem((d) => { d.stages[0]!.gates[0]!.criteria[0]!.evidence = 'my own evidence' }).join(' ')).toMatch(/its evidence is trace's/)
    expect(templateProblems({ id: 'rocket' }).length).toBeGreaterThan(0)
  })

  it('accepts what it may change', () => {
    expect(templateProblems(edited())).toEqual([])
  })
})

describe('a journey from an installation\'s template', () => {
  it('starts from the definition, keeps it and its version, and reads its guides from it', () => {
    const db = tempDb('journey.db')
    applyJourneySchema(db, { store: true })
    const r = startJourney(db, { template: 'board', by: ADMIN.label, name: 'Sensor', definition: { version: 3, doc: edited() } })
    expect(r.stages.map((s) => s.id)).not.toContain('prove')
    expect(r.criteria.map((c) => c.id)).toEqual(expect.arrayContaining(['capture.alternates', 'architect.safety']))
    expect(r.criteria.map((c) => c.id)).not.toContain('capture.datasheets')
    expect(r.criteria.find((c) => c.id === 'capture.erc')!.text).toBe('The schematic rule check is clean, or each finding is waived.')
    expect(r.criteria.find((c) => c.id === 'architect.safety')).toMatchObject({ owner: 'person', evidenceLabel: 'the safety review notes' })
    expect(loadJourney(db)!.definition).toMatchObject({ version: 3, doc: { name: 'Sensor board' } })
    expect(r.decisions[0]!.summary).toMatch(/Sensor board \(Board\) template, version 3/)
    const v = journeyView(loadJourney(db)!, { hash: ADMIN.hash, label: ADMIN.label, admin: true, part: 'contributor' })
    expect(v.stages[0]!.guide?.purpose).toBe('Agree what the sensor must do, as requirements that can each be measured.')
    // a later stage turned on afterwards comes from the same definition
    updateAbout(db, { later: ['certify'] }, ADMIN.label)
    expect(loadJourney(db)!.stages.map((s) => s.id).at(-1)).toBe('certify')
  })

  it('refuses a definition with a problem, or of another template, and an older journey reads without one', () => {
    const db = tempDb('journey.db')
    applyJourneySchema(db, { store: true })
    const bad = copy(catalogTemplate('board'))
    bad.stages[0]!.gates[0]!.criteria = []
    expect(() => startJourney(db, { template: 'board', by: ADMIN.label, definition: { version: 1, doc: bad } })).toThrow(/cannot start a project: The gate define needs at least one criterion/)
    expect(() => startJourney(db, { template: 'fpga', by: ADMIN.label, definition: { version: 1, doc: catalogTemplate('board') } })).toThrow(/not FPGA/)
    startJourney(db, { template: 'board', by: ADMIN.label })
    expect(loadJourney(db)!.definition).toMatchObject({ version: 0, doc: { id: 'board' } })
    db.exec('DROP TABLE journey_template')
    expect(loadJourney(db)!.definition).toBeNull()
  })
})

describe('a criterion an admin added', () => {
  it('is signed off by a person saying what they checked, and only that kind', () => {
    const db = tempDb('journey.db')
    applyJourneySchema(db, { store: true })
    startJourney(db, { template: 'board', by: ADMIN.label, definition: { version: 1, doc: edited() } })
    expect(() => confirmCriterion(db, 'architect.safety', { met: true, note: '' }, ADMIN)).toThrow(/Say what you checked/)
    const r = confirmCriterion(db, 'architect.safety', { met: true, note: 'Read the review of 3 November.' }, ADMIN)
    expect(r.criteria.find((c) => c.id === 'architect.safety')).toMatchObject({ status: 'met', evidence: [{ kind: 'note', ref: 'architect.safety', label: 'Read the review of 3 November.' }] })
    expect(r.decisions[0]).toMatchObject({ kind: 'criterion.confirmed', ref: 'architect.safety' })
    const view = journeyView(r, { hash: ADMIN.hash, label: ADMIN.label, admin: true, part: 'contributor' })
    const crit = view.gates.find((g) => g.id === 'architect')!.criteria
    expect(crit.find((c) => c.id === 'architect.safety')!.added).toBe(true)
    expect(crit.find((c) => c.id === 'architect.blocks')!.added).toBeUndefined()
    expect(confirmCriterion(db, 'architect.safety', { met: false, note: '' }, ADMIN).criteria.find((c) => c.id === 'architect.safety')!.status).toBe('not_met')
    expect(() => confirmCriterion(db, 'architect.mapped', { met: true, note: 'looked' }, ADMIN)).toThrow(JourneyError)
    expect(() => confirmCriterion(db, 'architect.blocks', { met: true, note: 'looked' }, ADMIN)).toThrow(/guided step/)
    expect(() => confirmCriterion(db, 'nope.nothing', { met: true, note: 'looked' }, ADMIN)).toThrow(/no criterion/)
  })

  it('cannot change once its gate is signed', () => {
    const db = tempDb('journey.db')
    applyJourneySchema(db, { store: true })
    const doc = copy(catalogTemplate('firmware'))
    doc.stages[0]!.gates[0]!.criteria.push({ id: 'define.legal', text: 'Legal has read the requirements.', custom: true, evidence: 'the legal review' })
    startJourney(db, { template: 'firmware', by: ADMIN.label, definition: { version: 1, doc } })
    confirmCriterion(db, 'define.legal', { met: true, note: 'Email from legal, 2 November.' }, ADMIN)
    for (const c of loadJourney(db)!.criteria.filter((x) => x.gate === 'define')) {
      if (c.id !== 'define.legal') setCriterion(db, c.id, 'met', [{ kind: 'run', ref: 'r1', label: 'x' }], ADMIN.label)
      recordOpen(db, { criterion: c.id }, ADMIN.hash)
    }
    signGate(db, 'define', ADMIN)
    expect(() => confirmCriterion(db, 'define.legal', { met: false, note: '' }, ADMIN)).toThrow(/is signed: return it/)
  })
})

describe('the installation\'s templates', () => {
  const store = (): TemplateStore => new TemplateStore(central(mkdtempSync(join(tmpdir(), 'trace-templates-'))))

  it('start as the code\'s, and each save and reset is the next version, kept with its reason', async () => {
    const s = store()
    expect((await s.list()).map((t) => [t.id, t.version, t.changed])).toEqual(TEMPLATES.map((t) => [t, 0, false]))
    const saved = await s.save(edited(), { by: ADMIN.label, reason: 'Our sensor boards skip Prove.' })
    expect(saved).toMatchObject({ id: 'board', version: 1, changed: true, saved: true, name: 'Sensor board', by: ADMIN.label })
    expect(await s.definition('board')).toMatchObject({ version: 1, doc: { name: 'Sensor board' } })
    expect((await s.save(edited(), { by: ADMIN.label, reason: 'again' })).saved).toBe(false)
    await expect(s.save({ ...edited(), stages: [] }, { by: ADMIN.label, reason: 'broken' })).rejects.toThrow(/stages/)
    await expect(s.save(edited(), { by: ADMIN.label, reason: '' })).rejects.toThrow()
    const d2 = edited()
    d2.name = 'Sensor board, two'
    await expect(s.save(d2, { by: ADMIN.label, reason: 'shape says no', check: async () => ['The stage define is listed twice: keep one.'] })).rejects.toThrow(/listed twice/)
    expect((await s.get('board')).version).toBe(1)
    const reset = await s.reset('board', { by: ADMIN.label, reason: 'Back to trace\'s own.' })
    expect(reset).toMatchObject({ version: 2, changed: false, doc: catalogTemplate('board') })
    expect((await s.history('board')).map((h) => [h.version, h.action, h.reason])).toEqual([[2, 'reset', 'Back to trace\'s own.'], [1, 'save', 'Our sensor boards skip Prove.']])
    expect((await s.get('fpga')).version).toBe(0)
  })
})

const python = process.env.TRACE_PYTHON || 'python3'
const shacl = spawnSync(python, ['-c', 'import pyshacl'], { stdio: 'ignore' }).status === 0

describe.skipIf(!shacl)('the template\'s shape (pySHACL)', () => {
  const shape = readFileSync(join(ONTOLOGY_DIR, 'shapes', 'templates', 'journey-template.ttl'), 'utf8')
  const check = async (doc: TemplateDoc) => {
    const b = new Bridge(python)
    try {
      const r = await b.call('shapes.check', { data: await templateTurtle(doc, { installation: 'test', version: 1 }), shapes: [shape] }, z.object({ conforms: z.boolean(), findings: z.array(z.object({ message: z.string() }).loose()) }))
      return r.findings.map((f) => f.message)
    } finally {
      b.close()
    }
  }

  it('every template the code defines keeps to it, and so does one an admin changed', async () => {
    for (const t of TEMPLATES) expect(await check(catalogTemplate(t)), t).toEqual([])
    expect(await check(edited())).toEqual([])
  }, 60_000)

  it('names a gate with no criteria and a template that does not start at Define', async () => {
    const d = copy(catalogTemplate('board'))
    d.stages.find((s) => s.id === 'layout')!.gates[0]!.criteria = []
    expect(await check(d)).toEqual(['The layout review gate has no criteria: keep or add at least one.'])
    const e = copy(catalogTemplate('board'))
    e.stages = e.stages.filter((s) => s.id !== 'define')
    expect(await check(e)).toEqual(['The template must start at Define.'])
  }, 60_000)
})
