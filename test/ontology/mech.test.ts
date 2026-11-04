/**
 * The mechanical module (docs/ontology-plan.md P7.1, P7.6): a real build of the sample board (test/fixtures/case-build,
 * made by mech.build's engine with the template, and with a case script that lowers the lid 1.5 mm so parts clash) read
 * into the project's graph; the engine's records keep to the ontology and to the mechanical record shapes as they are;
 * and what a case depends on of a board: a part moved in the middle leaves the build current, an edge connector moved
 * makes it stale, saying which; and the layout gate's fit criterion (ontology/shapes/layout.fit.ttl) over it: met on the
 * good build, not met on the clashing one until each problem is waived on its own, and not met on a stale build.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataFactory, Store } from 'n3'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Bridge } from '../../src/core/bridge.js'
import { normalisedHash } from '../../src/core/normalise.js'
import { Work } from '../../src/core/store.js'
import { buildGraph, checkRecords, nodeIri } from '../../src/ontology/graph.js'
import { freshness, inputHash } from '../../src/ontology/lineage.js'
import { ENGINE_CLASSES, ENGINE_PROPERTIES, INTEGER_KEYS, JSON_KEYS, addCaseRecords, latestCaseBuild } from '../../src/ontology/mech.js'
import { RDF, XSD, readVocabulary, ONTOLOGY_DIR } from '../../src/ontology/vocab.js'
import { graphQuads, runShape, turtle, withWaivers } from '../../src/tools/shape/tools.js'
import { startJourney } from '../../src/core/journey.js'
import { applyJourneySchema } from '../../src/core/journey.js'
import { boardFacts } from '../../src/tools/mech/board.js'
import { caseFactHashes, caseViewHash, caseViewHashOf } from '../../src/tools/mech/case-facts.js'
import { staleReasons } from '../../src/tools/mech/stale.js'

const v = readVocabulary()
const O = { installation: 'test', project: 'acme/case' }
const T = 'https://trace-eda.com/ns/trace#'
const iri = (kind: string, key: string): string => nodeIri(O, kind, key)
const FIX = join(import.meta.dirname, '..', 'fixtures', 'case-build')
const SAMPLE = join(import.meta.dirname, '..', '..', 'templates', 'sample')
const BOARD = 'hardware/trace-sample.kicad_pcb'
const PCB = readFileSync(join(SAMPLE, BOARD), 'utf8')
const fixture = (k: 'good' | 'clash', f: string): string => readFileSync(join(FIX, k, f), 'utf8')

/** The sample board with footprint `ref` moved to (x, y). */
function moved(ref: string, x: number, y: number): Uint8Array {
  const at = PCB.indexOf(`(property "Reference" "${ref}"`)
  const start = PCB.lastIndexOf('(footprint ', at)
  const head = PCB.slice(start, at).replace(/\(at [-\d.]+ [-\d.]+/, `(at ${x} ${y}`)
  return new TextEncoder().encode(PCB.slice(0, start) + head + PCB.slice(at))
}

/** A project database with one mech.build run of fixture `k`, its inputs recorded as mech.build records them. */
function project(k: 'good' | 'clash'): { db: Work['db']; run: string } {
  const dir = mkdtempSync(join(tmpdir(), 'trace-mech-onto-'))
  mkdirSync(join(dir, '.git'))
  const w = new Work(join(dir, 'project.db'))
  const run = w.start('mech.build', { subject: BOARD, args: { formats: ['step'] } })
  for (const f of ['result.json', 'facts.json', 'fit.json', 'case.json']) w.artifact(run, f, fixture(k, f), 'application/json')
  const caseJson = fixture(k, 'case.json')
  w.inputs(run, [
    { kind: 'file', ref: `${BOARD}#case`, sha256: caseViewHash(BOARD, new TextEncoder().encode(PCB)) },
    { kind: 'file', ref: 'mechanical/case.json', sha256: normalisedHash('mechanical/case.json', new TextEncoder().encode(caseJson)) },
  ])
  w.finish(run, k === 'good' ? 'pass' : 'fail', 'built', { fit_status: k === 'good' ? 'pass' : 'fail' })
  return { db: w.db, run }
}

describe('the engine\'s case records and the ontology', () => {
  const recs = JSON.parse(fixture('good', 'case.jsonld')) as { '@graph': Record<string, unknown>[] }

  it('every key and type the engine writes is a term of the ontology, read with its range', () => {
    const keys = new Set(recs['@graph'].flatMap((n) => Object.keys(n).filter((k) => !k.startsWith('@'))))
    for (const k of keys) expect(ENGINE_PROPERTIES as readonly string[], k).toContain(k)
    for (const n of recs['@graph']) expect(ENGINE_CLASSES as readonly string[], String(n['@type'])).toContain(n['@type'])
    for (const p of ENGINE_PROPERTIES) expect(v.properties.has(p), p).toBe(true)
    for (const c of ENGINE_CLASSES) expect(v.classes.has(c), c).toBe(true)
    for (const [p, def] of v.properties) {
      expect(JSON_KEYS.has(p), `${p} is JSON`).toBe(ENGINE_PROPERTIES.includes(p as never) && def.range === `${RDF}JSON`)
      expect(INTEGER_KEYS.has(p), `${p} is a whole number`).toBe(ENGINE_PROPERTIES.includes(p as never) && def.range === `${XSD}integer`)
    }
  })

  it('a build in the run record becomes the case in the graph, keeping to the ontology', () => {
    const { db, run } = project('good')
    expect(latestCaseBuild(db)?.run).toBe(run)
    const { store } = buildGraph({ project: db }, O)
    const problems = checkRecords(store, v).filter((p) => /case|component|run/.test(p.subject))
    expect(problems).toEqual([])
    const one = (s: string, p: string): string | undefined => store.getQuads(s, `${T}${p}`, null, null)[0]?.object.value
    const fit = iri('case-check', 'fit')
    expect(one(fit, 'status')).toBe('pass')
    expect(one(fit, 'madeByRun')).toBe(iri('run', run))
    expect(one(fit, 'fitOf')).toBe(iri('case', 'enclosure'))
    expect(one(iri('case-opening', 'J1'), 'forComponent')).toBe(iri('component', 'J1'))
    expect(one(iri('case-board', BOARD), 'outlineOf')).toBe(iri('board-file', BOARD))
    expect(JSON.parse(one(iri('case', 'enclosure'), 'outerSize') as string)).toHaveLength(3)
    expect(one(iri('case-settings', 'case'), 'edgeClearance')).toBe('0.5')
    expect(one(iri('case-envelope', 'J1'), 'edgeSide')).toBe('west')
    expect(store.getSubjects(`${RDF}type`, `${T}ComponentEnvelope`, null)).toHaveLength(17)
    expect(store.getSubjects(`${RDF}type`, `${T}RuleResult`, null).length).toBeGreaterThan(5)
    expect(store.getSubjects(`${RDF}type`, `${T}FitFinding`, null)).toEqual([])
  })

  it('a clashing build names each problem by what it is about, so a waiver of it outlasts a rebuild', () => {
    const { db } = project('clash')
    const { store } = buildGraph({ project: db }, O)
    expect(checkRecords(store, v).filter((p) => /case/.test(p.subject))).toEqual([])
    const findings = store.getSubjects(`${RDF}type`, `${T}FitFinding`, null).map((s) => s.value.slice(s.value.lastIndexOf(':') + 1)).map(decodeURIComponent).sort()
    expect(findings).toEqual(['clash/J1/lid', 'clash/J2/lid', 'clash/J3/lid', 'clash/board/lid', 'gap/J1/above', 'gap/J2/above', 'gap/J3/above', 'opening/J1'])
    expect(store.getQuads(iri('case-finding', 'clash/J2/lid'), `${T}text`, null, null)[0]?.object.value).toBe('J2 clashes with the lid (37.74 mm³)')
    const rules = store.getSubjects(`${T}ruleOf`, null, null).filter((s) => store.getQuads(s, `${T}status`, DataFactory.literal('fail'), null).length)
    expect(rules.map((s) => store.getQuads(s, `${T}ruleName`, null, null)[0]?.object.value)).toEqual(['lid_top'])
  })
})

describe('what a case depends on of its board (P7.6)', () => {
  const was = caseFactHashes(boardFacts(join(SAMPLE, BOARD), SAMPLE))
  const now = (b: Uint8Array): ReturnType<typeof caseFactHashes> => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-case-'))
    const p = join(dir, 'trace-sample.kicad_pcb')
    writeFileSync(p, b)
    return caseFactHashes(boardFacts(p, dir))
  }
  const base = { board: BOARD, board_sha256: 'old', case_json_sha256: null, case_py_sha256: null, case_file: null, case_file_sha256: null }

  it('the hash from the board\'s bytes is the one mech.build records from the facts it read', () => {
    expect(caseViewHash(BOARD, new TextEncoder().encode(PCB))).toBe(caseViewHashOf(boardFacts(join(SAMPLE, BOARD), SAMPLE)))
  })

  it('a part moved in the middle leaves the case current; an edge connector moved makes it stale, naming it', () => {
    expect(staleReasons({ ...base, case_facts: was }, { ...base, board_sha256: 'new', case_facts: now(moved('R3', 118, 112)) })).toEqual([])
    expect(staleReasons({ ...base, case_facts: was }, { ...base, board_sha256: 'new', case_facts: now(moved('J1', 103, 113)) }))
      .toEqual([`J1 at the board's edge moved or changed since the build`])
    // a build from before the case's facts were recorded: any change to the board file
    expect(staleReasons(base, { ...base, board_sha256: 'new', case_facts: now(moved('R3', 118, 112)) })).toEqual([`${BOARD} changed since the build`])
  })

  it('lineage agrees: the build\'s board input is what the case depends on of it', () => {
    const { db, run } = project('good')
    const read = (board: Uint8Array) => (p: string): Uint8Array | null => (p === BOARD ? board : p === 'mechanical/case.json' ? new TextEncoder().encode(fixture('good', 'case.json')) : null)
    expect(freshness(db, run, read(moved('R3', 118, 112))).state).toBe('current')
    expect(freshness(db, run, read(moved('J1', 103, 113)))).toMatchObject({ state: 'stale', reasons: [`what the case depends on of ${BOARD} changed since mech.build ran`] })
    expect(inputHash(`${BOARD}#case`, moved('R3', 118, 112))).toBe(inputHash(`${BOARD}#case`, new TextEncoder().encode(PCB)))
    // and the graph says so, for the layout.fit shape
    const { store } = buildGraph({ project: db }, { ...O, derived: true, files: read(moved('J1', 103, 113)) })
    expect(store.getQuads(iri('case-check', 'fit'), `${T}isCurrentBuild`, null, null)[0]?.object.value).toBe('false')
    expect(store.getQuads(iri('case-check', 'fit'), `${T}staleBecause`, null, null)[0]?.object.value).toMatch(/^what the case depends on of/)
  })
})

const python = process.env.TRACE_PYTHON || 'python3'
const shacl = spawnSync(python, ['-c', 'import pyshacl'], { stdio: 'ignore' }).status === 0

describe.skipIf(!shacl)('the mechanical record shapes (pySHACL)', () => {
  const bridge = new Bridge(python)
  afterAll(() => bridge.close())
  const shapes = readFileSync(join(ONTOLOGY_DIR, 'shapes', 'records', 'mech.ttl'), 'utf8')
  const check = async (records: unknown) => {
    const store = new Store()
    addCaseRecords(store, O, records)
    return bridge.call('shapes.check', { data: await turtle(store.getQuads(null, null, null, null)), shapes: [shapes] }, z.object({ conforms: z.boolean(), findings: z.array(z.object({ message: z.string() })) }))
  }

  it('case.jsonld from a build of the sample board keeps to them as it is, clashing or not', async () => {
    expect(await check(JSON.parse(fixture('good', 'case.jsonld')))).toMatchObject({ conforms: true })
    expect(await check(JSON.parse(fixture('clash', 'case.jsonld')))).toMatchObject({ conforms: true })
  })

  it('a broken record is named', async () => {
    const recs = JSON.parse(fixture('good', 'case.jsonld')) as { '@graph': Record<string, unknown>[] }
    const enc = recs['@graph'].find((n) => n['@type'] === 'Enclosure') as Record<string, unknown>
    delete enc.material
    ;(recs['@graph'].find((n) => n['@type'] === 'Joint') as Record<string, unknown>).jointKind = 'glued'
    const r = await check(recs)
    expect(r.conforms).toBe(false)
    expect(r.findings.map((f) => f.message).sort()).toEqual(['A joint is fixed, fastened, snap-fit, press-fit, bonded, hinged, sliding or ball.', 'The case record needs exactly one material.'])
  })
})

describe.skipIf(!shacl)('layout.fit over the newest case build (pySHACL)', () => {
  const bridge = new Bridge(python)
  afterAll(() => bridge.close())
  const board = (b: Uint8Array) => (p: string): Uint8Array | null => (p === BOARD ? b : p === 'mechanical/case.json' ? null : null)
  const files = (k: 'good' | 'clash', b: Uint8Array = new TextEncoder().encode(PCB)) => (p: string): Uint8Array | null => (p === 'mechanical/case.json' ? new TextEncoder().encode(fixture(k, 'case.json')) : board(b)(p))
  const check = async (db: Work['db'], f?: (p: string) => Uint8Array | null) => runShape('layout.fit', await turtle(graphQuads({ journey: db, project: db }, { ...O, ...(f ? { files: f } : {}) })), (m, p) => bridge.call(m, p, z.any())) as Promise<{ conforms: boolean; findings: { focus: string | null; message: string }[] }>

  it('is met on a build that fits and still stands', async () => {
    const { db } = project('good')
    expect(await check(db, files('good'))).toEqual({ conforms: true, findings: [] })
  }, 60_000)

  it('names each clash, gap, missing opening and failing rule by its part; each waived on its own meets it', async () => {
    const { db } = project('clash')
    const r = await check(db, files('clash'))
    expect(r.conforms).toBe(false)
    expect(r.findings).toHaveLength(9)
    expect(r.findings.map((f) => f.message)).toContain('J2 clashes with the lid (37.74 mm³). Fix it with the case settings or the case script and build again, or waive this one problem.')
    expect(r.findings.map((f) => f.message)).toContain('J1 to the lid: 0 mm, needs 1 mm. Fix it with the case settings or the case script and build again, or waive this one problem.')
    expect(r.findings.find((f) => f.focus === iri('case-rule', 'lid_top'))?.message).toMatch(/^Outside the process's rules: .*waive this rule\.$/)
    // a waiver of each one problem (a waiver of kind finding on its id) meets the criterion; one left open does not
    const ids = r.findings.map((f) => `layout.fit@${f.focus}`)
    expect(withWaivers('layout.fit', r.findings as never, new Set(ids)).every((f) => f.waived)).toBe(true)
    expect(withWaivers('layout.fit', r.findings as never, new Set(ids.slice(1))).filter((f) => !f.waived).map((f) => f.focus)).toEqual([r.findings[0]!.focus])
    expect(ids).toContain(`layout.fit@${iri('case-finding', 'clash/J2/lid')}`)
  }, 60_000)

  it('is not met when the build no longer stands, or when trace cannot tell', async () => {
    const { db } = project('good')
    expect((await check(db, files('good', moved('R3', 118, 112)))).conforms).toBe(true)
    expect((await check(db, files('good', moved('J1', 103, 113)))).findings.map((f) => f.message))
      .toEqual([`The case build is out of date: what the case depends on of ${BOARD} changed since mech.build ran. Run mech.build again.`])
    expect((await check(db)).findings.map((f) => f.message)).toEqual(['trace could not tell whether the case build still stands: check layout.fit where the project\'s files are.'])
  }, 60_000)

  it('nothing built is not met', async () => {
    const { db } = project('good')
    applyJourneySchema(db)
    startJourney(db, { template: 'board', by: 'seed', name: 'Cased' })
    db.exec("DELETE FROM runs WHERE kind = 'mech.build'")
    expect((await check(db, files('good'))).findings.map((f) => f.message)).toEqual(['No case is built yet: run mech.build, then check layout.fit again.'])
  }, 60_000)
})
