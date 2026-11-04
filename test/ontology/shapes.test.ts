/**
 * Gates as SHACL shapes (docs/ontology-plan.md phase 5): the facts a shape needs that no column stores are worked out
 * as the app reads them, every shape names a criterion trace owns and speaks in plain words, and, with pySHACL on the
 * Python bridge (TRACE_PYTHON; CI installs it), architect.mapped passes a mapped project and fails each way a project
 * can break it, naming the requirement.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { Parser } from 'n3'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Bridge } from '../../src/core/bridge.js'
import { GATES, applyJourneySchema, startJourney } from '../../src/core/journey.js'
import { recordDesignDecision } from '../../src/tools/design/decisions.js'
import { buildGraph, nodeIri } from '../../src/ontology/graph.js'
import { shapedCriteria } from '../../src/ontology/shapes.js'
import { SHAPES_DIR, graphQuads, runShape, turtle } from '../../src/tools/shape/tools.js'
import { ADMIN, projectDb } from './fixture.js'

const O = { installation: 'test', project: 'acme/sensor' }
const T = 'https://trace-eda.com/ns/trace#'
const iri = (kind: string, key: string): string => nodeIri(O, kind, key)
const ALLOWED = new Set(['JLCPCB', 'JSON', 'SHA'])
const acronyms = (s: string): string[] => (s.match(/\b[A-Z]{2,}\b/g) ?? []).filter((w) => !ALLOWED.has(w))

let db: DatabaseSync
beforeEach(async () => {
  db = await projectDb()
  applyJourneySchema(db) // the record copy carries the journey's tables, people's design decisions among them
})

const value = (subject: string, prop: string): string | undefined => {
  const { store } = buildGraph({ journey: db, project: db }, { ...O, derived: true })
  return store.getQuads(subject, `${T}${prop}`, null, null)[0]?.object.value
}
const req = (id: string, text: string, status = 'accepted'): void => {
  const t = Date.now() / 1000
  db.prepare('INSERT INTO requirements (id, text, kind, acceptance, status, tags, created, updated, by) VALUES (?,?,?,?,?,?,?,?,?)').run(id, text, 'electrical', null, status, '[]', t, t, 'impl')
}

describe('facts worked out for the shapes', () => {
  it('a requirement is live until a person strikes it, or the agents reject it', () => {
    const subject = (id: string): string => buildGraph({ project: db }, O).store.getSubjects(`${T}text`, null, null).map((s) => s.value).find((s) => s.endsWith(`:requirement:${id}`)) as string
    expect(value(subject('REQ-PWR-001'), 'isLive')).toBe('true')
    req('REQ-OLD', 'An old need.', 'obsolete')
    expect(value(subject('REQ-OLD'), 'isLive')).toBe('false')
    recordDesignDecision(db, { kind: 'requirement', target: 'REQ-PWR-001', choice: 'struck', detail: { reason: 'Out of scope.' } }, ADMIN)
    expect(value(subject('REQ-PWR-001'), 'isLive')).toBe('false')
  })

  it('the current option is the chosen one, else the recommended one', () => {
    const t = Date.now() / 1000
    db.prepare('INSERT INTO arch_options (id, name, summary, recommended, why, gives_up, risks, status, created, updated, by) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('B', 'Buck supply', 'A buck converter', 0, null, null, '[]', 'proposed', t, t, 'impl')
    const opt = (id: string): string => buildGraph({ project: db }, O).store.getSubjects(`${T}name`, null, null).map((s) => s.value).find((s) => s.endsWith(`:arch-option:${id}`)) as string
    expect([value(opt('A'), 'isCurrentOption'), value(opt('B'), 'isCurrentOption')]).toEqual(['true', 'false'])
    recordDesignDecision(db, { kind: 'architecture.choice', target: 'architecture', choice: 'chosen', detail: { option: 'B', reason: 'efficient', deciding: [] } }, ADMIN)
    expect([value(opt('A'), 'isCurrentOption'), value(opt('B'), 'isCurrentOption')]).toEqual(['false', 'true'])
  })
})

describe('the shape files', () => {
  it('a criterion with no shape is refused, naming the ones that have one', async () => {
    await expect(runShape('capture.erc', '')).rejects.toThrow(/no shape backs capture\.erc; shapes back .*architect\.mapped/)
  })

  const criteria = new Set(GATES.flatMap((g) => g.criteria.filter((c) => c.owner === 'trace').map((c) => `${g.id}.${c.key}`)))

  it('the list the prompts name is the folder\'s', () => {
    expect(shapedCriteria()).toEqual(readdirSync(SHAPES_DIR).filter((f) => f.endsWith('.ttl')).map((f) => f.slice(0, -4)).sort())
  })

  it('each parses, backs a criterion trace owns, and speaks in plain words', () => {
    expect(shapedCriteria()).toContain('architect.mapped')
    for (const c of shapedCriteria()) {
      expect(criteria.has(c), `${c} is a criterion trace owns`).toBe(true)
      const quads = new Parser().parse(readFileSync(join(SHAPES_DIR, `${c}.ttl`), 'utf8'))
      const named = quads.filter((q) => q.predicate.value.endsWith('/shapes#criterion')).map((q) => q.object.value)
      expect(named.length, c).toBeGreaterThan(0)
      expect(new Set(named), c).toEqual(new Set([c]))
      for (const q of quads.filter((x) => /shacl#message$|rdf-schema#(label|comment)$/.test(x.predicate.value))) expect(acronyms(q.object.value), `${c}: ${q.object.value}`).toEqual([])
    }
  })
})

const python = process.env.TRACE_PYTHON || 'python3'
const shacl = spawnSync(python, ['-c', 'import pyshacl'], { stdio: 'ignore' }).status === 0

describe.skipIf(!shacl)('architect.mapped over the project\'s graph (pySHACL)', () => {
  const bridge = new Bridge(python)
  afterAll(() => bridge.close())
  const check = async () => runShape('architect.mapped', await turtle(graphQuads({ journey: db, project: db }, O)), (m, p) => bridge.call(m, p, z.any()))

  it('passes when every live requirement is served by a block of the current option', async () => {
    expect(await check()).toEqual({ conforms: true, findings: [] })
  }, 60_000)

  it('names a requirement no block serves, and passes again once it is struck', async () => {
    req('REQ-RF-002', 'The radio reaches 100 m.')
    const r = await check()
    expect(r.conforms).toBe(false)
    expect(r.findings).toEqual([expect.objectContaining({ focus: iri('requirement', 'REQ-RF-002'), severity: 'violation', message: 'No block of the chosen architecture serves "The radio reaches 100 m.". Add it to a block, or strike it with a reason.' })])
    recordDesignDecision(db, { kind: 'requirement', target: 'REQ-RF-002', choice: 'struck', detail: { reason: 'No radio on this revision.' } }, ADMIN)
    expect((await check()).conforms).toBe(true)
  }, 60_000)

  it('follows the chosen option: a choice of one whose blocks serve nothing fails, and a withdrawn block serves nothing', async () => {
    const t = Date.now() / 1000
    db.prepare('INSERT INTO arch_options (id, name, summary, recommended, why, gives_up, risks, status, created, updated, by) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('B', 'Buck supply', 'A buck converter', 0, null, null, '[]', 'proposed', t, t, 'impl')
    recordDesignDecision(db, { kind: 'architecture.choice', target: 'architecture', choice: 'chosen', detail: { option: 'B', reason: 'efficient', deciding: [] } }, ADMIN)
    expect((await check()).findings.map((f) => f.focus)).toEqual([iri('requirement', 'REQ-PWR-001')])
    recordDesignDecision(db, { kind: 'architecture.choice', target: 'architecture', choice: 'chosen', detail: { option: 'A', reason: 'quiet', deciding: [] } }, ADMIN)
    db.prepare("UPDATE arch_blocks SET status='withdrawn' WHERE option='A' AND id='power'").run()
    expect((await check()).findings.map((f) => f.focus)).toEqual([iri('requirement', 'REQ-PWR-001')])
  }, 60_000)

  it('nothing to map is not met: no requirements, or no architecture', async () => {
    startJourney(db, { template: 'board', by: ADMIN.label, name: 'Soil sensor' })
    db.exec('DELETE FROM arch_blocks; DELETE FROM arch_scores; DELETE FROM arch_connections; DELETE FROM arch_options')
    expect((await check()).findings.map((f) => f.message)).toEqual(['No architecture is proposed yet: propose one, with its blocks, before mapping the requirements to it.'])
    db.exec('DELETE FROM requirement_intent; DELETE FROM requirements')
    expect((await check()).findings.map((f) => f.message).sort()).toEqual([
      'No architecture is proposed yet: propose one, with its blocks, before mapping the requirements to it.',
      'No requirements are recorded yet: record them before the architecture is mapped to them.',
    ])
  }, 60_000)
})
