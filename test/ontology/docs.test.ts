/**
 * The project's documents in its graph (ontology/trace-docs.ttl, src/ontology/docs.ts; docs/scribe.md): a document
 * read through its markers gives its sections, figures and stated values, linked to the runs they came from, and keeps
 * to the ontology.
 */
import { describe, expect, it } from 'vitest'
import { skeleton } from '../../src/docs/catalog.js'
import { replaceSection } from '../../src/docs/markers.js'
import { buildGraph, checkRecords, nodeIri } from '../../src/ontology/graph.js'
import { addDocuments, documentKindOf } from '../../src/ontology/docs.js'
import { NS, RDF, readVocabulary } from '../../src/ontology/vocab.js'
import { Store } from 'n3'

const v = readVocabulary()
const O = { installation: 'acme', project: 'acme/test-esp32' }
const id = (kind: string, key: string): string => nodeIri(O, kind, key)
const T = (n: string): string => `${NS}${n}`
const LLD = 'docs/design/low-level-design.md'

const lld = replaceSection(
  replaceSection(skeleton('lld', { project: 'test-esp32', revision: 'A', commit: 'abc1234', date: '2026-11-04' }), 'power-budget', [
    '## Power budget', '',
    '<!-- scribe:values kind="power" -->',
    '| Quantity | Value | Limit | Margin | Basis | Source |', '|---|---|---|---|---|---|',
    '| 3.3 V rail current | 182 mA | 500 mA | 64 % | simulated | run:r-91aa |',
    '| Battery life | pending | | | pending | |',
  ].join('\n')),
  'board', '## Board\n\n<!-- scribe:figure kind="render-top" source="run:r-8f2c" -->\n![Top of the board](figures/render-top.png)\n_The top of the board._',
)

describe('documents in the graph', () => {
  const { store } = buildGraph({ documents: [{ path: LLD, text: lld }, { path: 'README.md', text: '# not a document' }] }, O)
  const objects = (s: string, p: string): string[] => store.getQuads(s, T(p), null, null).map((q) => q.object.value)

  it('reads only the four documents\' paths', () => {
    expect(documentKindOf(LLD)).toBe('lld')
    expect(documentKindOf('README.md')).toBeNull()
    expect(store.getQuads(null, `${RDF}type`, T('Document'), null).map((q) => q.subject.value)).toEqual([id('document', LLD)])
  })

  it('gives each section, its due stage, what it is written from and whether it is pending', () => {
    const doc = id('document', LLD)
    expect(objects(doc, 'documentKind')).toEqual(['lld'])
    expect(objects(doc, 'documentRevision')).toEqual(['A'])
    expect(objects(doc, 'inProject')).toEqual([id('project', O.project)])
    const power = id('document-section', `${LLD}#power-budget`)
    expect(objects(doc, 'hasSection')).toContain(power)
    expect(objects(power, 'isPending')).toEqual(['false'])
    expect(objects(power, 'dueStage')).toEqual(['prove'])
    expect(objects(power, 'writtenFrom')).toEqual(['power'])
    expect(objects(id('document-section', `${LLD}#modules`), 'isPending')).toEqual(['true'])
  })

  it('links figures and stated values to the runs they came from; a pending value links none', () => {
    const fig = id('figure', `${LLD}#board/1`)
    expect(objects(fig, 'figureKind')).toEqual(['render-top'])
    expect(objects(fig, 'caption')).toEqual(['The top of the board.'])
    expect(objects(fig, 'figureFromRun')).toEqual([id('run', 'r-8f2c')])
    const rail = id('document-value', `${LLD}#power-budget/1/1`)
    expect(objects(rail, 'valueBasis')).toEqual(['simulated'])
    expect(objects(rail, 'statedValue')).toEqual(['182 mA'])
    expect(objects(rail, 'valueFromRun')).toEqual([id('run', 'r-91aa')])
    expect(objects(id('document-value', `${LLD}#power-budget/1/2`), 'valueFromRun')).toEqual([])
  })

  it('keeps to the ontology', () => {
    expect(checkRecords(store, v)).toEqual([])
  })

  it('reads nothing from a store with no documents', () => {
    expect(addDocuments(new Store(), O, [])).toBe(0)
  })
})
