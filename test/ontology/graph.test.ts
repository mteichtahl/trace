/**
 * A project's graph from its databases (docs/ontology-plan.md P2.5, P2.6): the fixture's journey record, agents' facts
 * and job index load as one graph that keeps to the ontology (no undefined class or property, every link to the right
 * class, every value of the right type), and a record comes out as JSON-LD with what belongs to it embedded.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { Store } from 'n3'
import { buildGraph, checkRecords, nodeIri } from '../../src/ontology/graph.js'
import { contextUrl, recordJsonLd } from '../../src/ontology/jsonld.js'
import { NS, RDF, readVocabulary } from '../../src/ontology/vocab.js'
import { factsDb, jobsDb, journeyDb, partsDb, projectDb, sampleBoard } from './fixture.js'

const v = readVocabulary()
const O = { installation: 'acme', project: 'acme/soil-sensor' }
const id = (kind: string, key: string): string => nodeIri(O, kind, key)
const T = (n: string): string => `${NS}${n}`

let store: Store
let rows: Record<string, number>

beforeAll(async () => {
  ({ store, rows } = buildGraph({ journey: journeyDb(), facts: factsDb(), jobs: jobsDb(), project: await projectDb(), central: await partsDb(), boards: [await sampleBoard()] }, O))
})

const objects = (s: string, p: string): string[] => store.getQuads(s, T(p), null, null).map((q) => q.object.value)
const typesOf = (s: string): string[] => store.getQuads(s, `${RDF}type`, null, null).map((q) => q.object.value.replace(NS, ''))

describe('a project\'s graph', () => {
  it('reads every mapped table that has rows', () => {
    for (const t of ['journey.journey', 'journey.stages', 'journey.gates', 'journey.gate_criteria', 'journey.gate_signatures', 'journey.questions', 'journey.waivers',
      'journey.decisions', 'journey.orders', 'journey.job_controls', 'journey.criterion_history', 'journey.stage_history', 'journey.journey_history',
      'facts.agent_questions', 'facts.criterion_checks', 'facts.stuck', 'facts.handoffs', 'jobs.jobs',
      'project.runs', 'project.measurements', 'project.artifacts', 'project.settings', 'project.intent_statements', 'project.requirement_intent',
      'project.arch_options', 'project.arch_criteria', 'project.arch_scores', 'project.arch_blocks', 'project.arch_connections', 'project.pin_plan',
      'project.sheet_requirements', 'project.requirements', 'project.test_items', 'project.test_results', 'project.coverage_points',
      'project.coverage_hits', 'project.bringup_readings', 'central.parts', 'central.part_offers']) {
      expect(rows[t], t).toBeGreaterThan(0)
    }
  })

  it('keeps to the ontology: every class and property defined, every link and value of the right kind', () => {
    expect(checkRecords(store, v)).toEqual([])
    expect(store.size).toBeGreaterThan(500)
  })

  it('links the journey to its project, template, revision, stages and current stage', () => {
    const j = id('journey', 'current')
    expect(typesOf(j)).toEqual(['Journey'])
    expect(objects(j, 'inProject')).toEqual([id('project', 'acme/soil-sensor')])
    expect(objects(j, 'fromTemplate')).toEqual([id('template', 'board')])
    expect(typesOf(id('template', 'board'))).toEqual(['JourneyTemplate'])
    expect(objects(j, 'currentRevision')).toEqual([id('revision', 'A')])
    expect(typesOf(id('revision', 'A'))).toEqual(['Revision'])
    expect(objects(j, 'hasStage')).toHaveLength(9)
    expect(objects(j, 'currentStage')).toEqual([id('stage', 'architect')])
    expect(objects(id('gate', 'capture'), 'ofStage')).toEqual([id('stage', 'capture')])
  })

  it('makes each piece of evidence and each option a node of its own, and links the option chosen', () => {
    const crit = id('criterion', 'define.accepted')
    const [ev] = objects(crit, 'hasEvidence')
    expect(ev).toBe(`${crit}/hasEvidence/0`)
    expect(typesOf(ev as string)).toEqual(['Evidence'])
    expect(objects(ev as string, 'evidenceRef')).toEqual(['run-define.accepted'])
    const q = store.getQuads(null, `${RDF}type`, T('Question'), null).map((x) => x.subject.value).find((s) => s.includes(':question:')) as string
    const opts = objects(q, 'hasOption')
    expect(opts).toHaveLength(2)
    expect(typesOf(`${q}/hasOption/0`).sort()).toEqual(['Option', 'Recommendation'])
    expect(objects(q, 'chose')).toEqual([`${q}/hasOption/1`])
    expect(objects(`${q}/hasOption/1`, 'givesUp')).toEqual(['more noise'])
  })

  it('names specialists by kind and links the agents\' facts to jobs, criteria and each other', () => {
    expect(objects(id('criterion-check', 'cc-1'), 'checks')).toEqual([id('criterion', 'capture.erc')])
    expect(objects(id('criterion-check', 'cc-1'), 'performedBy')).toEqual([id('specialist', 'impl')])
    expect(typesOf(id('specialist', 'impl'))).toEqual(['Specialist'])
    expect(objects(id('handoff', 'ho-1'), 'startsJob')).toEqual([id('job', 'job-2')])
    expect(objects(id('job', 'job-2'), 'answersHandOff')).toEqual([id('handoff', 'ho-1')])
    expect(objects(id('job', 'job-2'), 'parentJob')).toEqual([id('job', 'job-1')])
    expect(objects(id('job-control', 'job-2'), 'controlsJob')).toEqual([id('job', 'job-2')])
  })

  it('carries the history of the return and reopening', () => {
    const events = store.getQuads(null, T('event'), null, null).map((q) => q.object.value)
    expect(events).toEqual(expect.arrayContaining(['started', 'finished', 'reopened']))
    const renamed = store.getQuads(null, T('field'), null, null).filter((q) => q.object.value === 'name').map((q) => q.subject.value)
    expect(renamed).toHaveLength(1)
    expect(objects(renamed[0] as string, 'newValue')).toEqual(['Soil sensor, outdoor'])
    expect(objects(renamed[0] as string, 'recordedBy')).toEqual(['admin@example.com'])
  })

  it('links the design record from intent to the parts it is built from, and the tests to their runs', () => {
    expect(objects(id('intent-link', 'REQ-PWR-001/INT-1a2b3c'), 'fromIntent')).toEqual([id('intent', 'INT-1a2b3c')])
    expect(typesOf(id('arch-option', 'A')).sort()).toEqual(['ArchitectureOption'])
    const power = id('block', 'A/power')
    expect(objects(power, 'servesRequirement')).toEqual([id('requirement', 'REQ-PWR-001')])
    const [part] = objects(power, 'usesPart')
    expect(typesOf(part as string).sort()).toEqual(['BlockPart', 'KeyPart'])
    expect(objects(part as string, 'refersToPart')).toEqual([id('part', 'TPS7A02')])
    expect(typesOf(id('part', 'TPS7A02'))).toEqual(['Part'])
    expect(objects(id('offer', 'TPS7A02/jlcpcb/JLCPCB/C2862740'), 'offerFor')).toEqual([id('part', 'TPS7A02')])
    expect(objects(id('connection', 'A/c1'), 'toBlock')).toEqual([id('block', 'A/mcu')])
    expect(typesOf(id('run', 'run-drc')).sort()).toEqual(['DesignRuleCheckReport', 'Run'])
    expect(objects(id('test-result', 'run-verify'), 'restsOn')).toEqual([id('run', 'run-drc')])
    expect(objects(id('reading', 'rd-1'), 'ofBoardUnit')).toEqual([id('board', 'SN-001')])
  })

  it('reads the board from its file: the placed parts, their pads and nets, the layers, and links the pin plan to them', () => {
    const b = id('board-file', 'hardware/sensor-node.kicad_pcb')
    expect(typesOf(b)).toEqual(['Board'])
    expect(Number(objects(b, 'copperLayers')[0])).toBeGreaterThanOrEqual(2)
    const comps = store.getQuads(null, T('onBoard'), b, null).map((q) => q.subject.value).filter((s) => s.includes(':component:'))
    expect(comps.length).toBeGreaterThan(5)
    const j1 = id('component', 'J1')
    expect(typesOf(j1)).toEqual(['Component'])
    const pads = store.getQuads(null, T('ofComponent'), j1, null).map((q) => q.subject.value)
    expect(pads.length).toBeGreaterThan(1)
    expect(pads.some((p) => objects(p, 'onNet').length > 0)).toBe(true)
    // the pin plan's J1 is the board's J1
    expect(objects(id('pin-plan', 'J1/1'), 'onComponent')).toEqual([j1])
    expect(typesOf(id('net', 'GND'))).toEqual(['Net'])
  })

  it('gives a record as JSON-LD, with its evidence embedded and its links as identifiers', () => {
    const r = recordJsonLd(store, id('criterion', 'define.accepted'), v)
    expect(r).toMatchObject({
      '@context': contextUrl(v), '@id': id('criterion', 'define.accepted'), '@type': 'Criterion', ofGate: id('gate', 'define'), status: 'met',
      hasEvidence: { '@type': 'Evidence', evidenceKind: 'run', evidenceRef: 'run-define.accepted' },
    })
    expect(contextUrl(v)).toBe('https://trace-eda.com/ns/trace/context/0.1.0.jsonld')
    expect(recordJsonLd(store, id('journey', 'current'), v)).toMatchObject({ buildPlan: { quantity: 5 } })
    expect(recordJsonLd(store, id('criterion', 'nope'), v)).toBeNull()
  })

  it('finds what breaks the ontology', () => {
    const { store: bad } = buildGraph({ jobs: jobsDb() }, O)
    bad.addQuad(bad.getQuads(id('job', 'job-1'), `${RDF}type`, null, null)[0]!.subject as never, { termType: 'NamedNode', value: T('nonsense') } as never, { termType: 'Literal', value: 'x' } as never)
    expect(checkRecords(bad, v)).toEqual([expect.objectContaining({ message: 'not a property of the ontology' })])
  })
})
