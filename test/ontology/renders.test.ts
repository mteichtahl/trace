/**
 * Revision renders in the ontology (docs/revision-renders.md): a render.showcase run is a RenderSet with its revision,
 * the day it was cut, the colours it used (from the logo, or neutral) and each picture as a Render with its shot; the
 * records keep to the ontology; a run whose result is not a showcase record adds nothing beyond the run itself.
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataFactory } from 'n3'
import { describe, expect, it } from 'vitest'
import { Work } from '../../src/core/store.js'
import { buildGraph, checkRecords, nodeIri } from '../../src/ontology/graph.js'
import { showcaseRecord } from '../../src/ontology/renders.js'
import { RDF, readVocabulary } from '../../src/ontology/vocab.js'

const v = readVocabulary()
const O = { installation: 'test', project: 'acme/esp' }
const T = 'https://trace-eda.com/ns/trace#'
const iri = (kind: string, key: string): string => nodeIri(O, kind, key)

const RESULT = {
  revision: 'B',
  date: '2026-11-05',
  palette: {
    source: 'logo', logo: { path: '.trace/brand/logo.png', sha256: 'ab'.repeat(32) },
    base: '#1d3557', accent: '#e63946', neutral: '#a8b0ba', background: ['#4a6489', '#0e1a2b'],
  },
  shots: {
    'test-esp32_rev-B_2026-11-05_board.png': 'board',
    'test-esp32_rev-B_2026-11-05_exploded.png': 'exploded',
    'notes.txt': 'not-a-shot',
  },
}

function project(result: unknown, status: 'pass' | 'fail' = 'pass'): { db: Work['db']; run: string } {
  const dir = mkdtempSync(join(tmpdir(), 'trace-renders-onto-'))
  mkdirSync(join(dir, '.git'))
  const w = new Work(join(dir, 'project.db'))
  const run = w.start('render.showcase', { subject: 'hardware/esp.kicad_pcb', args: { revision: 'B' } })
  w.artifact(run, 'test-esp32_rev-B_2026-11-05_board.png', new Uint8Array([137, 80, 78, 71]), 'image/png')
  w.artifact(run, 'test-esp32_rev-B_2026-11-05_exploded.png', new Uint8Array([137, 80, 78, 71]), 'image/png')
  w.finish(run, status, 'rendered', result as Record<string, unknown>)
  return { db: w.db, run }
}

describe('revision renders in the ontology', () => {
  it('reads a showcase run as revision renders: revision, day, colours from the logo and each shot', () => {
    const { db, run } = project(RESULT)
    const { store } = buildGraph({ project: db }, O)
    const set = iri('run', run)
    const one = (s: string, p: string): string | undefined => store.getQuads(s, `${T}${p}`, null, null)[0]?.object.value
    expect(store.has(DataFactory.quad(DataFactory.namedNode(set), DataFactory.namedNode(`${RDF}type`), DataFactory.namedNode(`${T}RenderSet`)))).toBe(true)
    expect(one(set, 'ofRevision')).toBe(iri('revision', 'B'))
    expect(one(set, 'revisionDate')).toBe('2026-11-05')
    const pal = one(set, 'usedPalette') as string
    expect(one(pal, 'paletteSource')).toBe('logo')
    expect(one(pal, 'baseColour')).toBe('#1d3557')
    expect(one(pal, 'accentColour')).toBe('#e63946')
    expect(one(pal, 'backgroundColours')).toBe('#4a6489 #0e1a2b')
    expect(one(one(pal, 'paletteFromLogo') as string, 'path')).toBe('.trace/brand/logo.png')
    const pics = store.getSubjects(`${RDF}type`, `${T}Render`, null).map((s) => s.value).sort()
    expect(pics).toEqual([iri('artifact', `${run}/test-esp32_rev-B_2026-11-05_board.png`), iri('artifact', `${run}/test-esp32_rev-B_2026-11-05_exploded.png`)].sort())
    expect(one(pics.find((p) => p.includes('exploded')) as string, 'shotKind')).toBe('exploded')
    expect(one(pics[0] as string, 'inRenderSet')).toBe(set)
    expect(checkRecords(store, v).filter((p) => /run|artifact|palette|file/.test(p.subject))).toEqual([])
  })

  it('records neutral colours with no logo', () => {
    const neutral = { ...RESULT, palette: { source: 'neutral', base: '#eceef1', accent: '#ffffff', neutral: '#c8ccd2', background: ['#eceef1', '#c8ccd2'] } }
    const { db, run } = project(neutral)
    const { store } = buildGraph({ project: db }, O)
    const pal = store.getQuads(iri('run', run), `${T}usedPalette`, null, null)[0]?.object.value as string
    expect(store.getQuads(pal, `${T}paletteSource`, null, null)[0]?.object.value).toBe('neutral')
    expect(store.getQuads(pal, `${T}paletteFromLogo`, null, null)).toEqual([])
  })

  it('adds nothing of its own for a failed run or a result that is not a showcase record', () => {
    for (const [result, status] of [[RESULT, 'fail'], [{ revision: 'b', date: 'yesterday' }, 'pass']] as const) {
      const { db } = project(result, status)
      const { store } = buildGraph({ project: db }, O)
      expect(store.getSubjects(`${RDF}type`, `${T}Render`, null)).toEqual([])
      expect(store.getSubjects(`${RDF}type`, `${T}BrandPalette`, null)).toEqual([])
    }
  })

  it('keeps only known shots and well-formed colours', () => {
    expect(showcaseRecord({ ...RESULT, palette: { ...RESULT.palette, base: 'navy' } })).toBeNull()
    expect(Object.values(showcaseRecord(RESULT)?.shots ?? {})).toEqual(['board', 'exploded'])
  })
})

