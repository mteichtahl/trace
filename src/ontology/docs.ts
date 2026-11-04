/**
 * The project's documents as the ontology reads them (ontology/trace-docs.ttl; docs/scribe.md): each of the
 * repository's docs/design files Scribe keeps, read through its markers (src/docs/markers.ts) when the graph is built,
 * like the board (./board.ts). Nothing of it is a table: the files are the record.
 *
 *   Document         urn:trace:…:document:<path>, its kind, title, revision and commit from the front matter
 *   DocumentSection  urn:trace:…:document-section:<path>#<id>, its due stage and the kinds of record it is written from
 *                    (src/docs/catalog.ts), and whether it is still pending
 *   Figure           urn:trace:…:figure:<path>#<section>/<n>, its kind, caption and source; a source run:<id> links the run
 *   DocumentValue    urn:trace:…:document-value:<path>#<section>/<table>/<row>, as the values table states it; a
 *                    source run:<id> links the run
 *
 * A file that is not one of the four documents' paths is left out.
 */
import { DataFactory, type NamedNode, type Quad_Object, type Store } from 'n3'
import { DOC_KINDS, DOCS, type DocKind } from '../docs/catalog.js'
import { parseDoc } from '../docs/markers.js'
import { type GraphOptions, nodeIri } from './graph.js'
import { NS, RDF, XSD } from './vocab.js'

const { namedNode, literal, quad } = DataFactory
const T = (n: string): NamedNode => namedNode(`${NS}${n}`)
const TYPE = namedNode(`${RDF}type`)
const bool = (v: boolean): Quad_Object => literal(String(v), namedNode(`${XSD}boolean`))
const dec = (v: number): Quad_Object => literal(String(v), namedNode(`${XSD}decimal`))

/** The classes and properties this reader writes, for the ontology's tests. */
export const DOCS_CLASSES = ['Document', 'DocumentSection', 'Figure', 'DocumentValue'] as const
export const DOCS_PROPERTIES = [
  'path', 'name', 'documentKind', 'documentRevision', 'gitCommit', 'inProject', 'hasSection', 'sectionId', 'dueStage', 'writtenFrom',
  'isPending', 'order', 'hasFigure', 'figureKind', 'caption', 'figureSource', 'figureFromRun', 'statesValue', 'valueKind', 'statedQuantity',
  'statedValue', 'statedLimit', 'statedMargin', 'valueBasis', 'valueFromRun',
] as const

/** Which document a repository path is, or null. */
export function documentKindOf(path: string): DocKind | null {
  return DOC_KINDS.find((k) => DOCS[k].file === path) ?? null
}

const RUN = /^run:(.+)$/

/** Adds the documents among `files` (repository path and text) to `store`; returns how many it read. */
export function addDocuments(store: Store, o: GraphOptions, files: readonly { path: string; text: string }[]): number {
  const id = (kind: string, key: string): NamedNode => namedNode(nodeIri(o, kind, key))
  const add = (s: NamedNode, p: string, v: Quad_Object): void => { store.addQuad(quad(s, T(p), v)) }
  const text = (s: NamedNode, p: string, v: string | undefined): void => { if (v) add(s, p, literal(v)) }
  let n = 0
  for (const f of files) {
    const kind = documentKindOf(f.path)
    if (!kind) continue
    n++
    const def = DOCS[kind]
    const parsed = parseDoc(f.text)
    const d = id('document', f.path)
    store.addQuad(quad(d, TYPE, T('Document')))
    add(d, 'path', literal(f.path))
    add(d, 'name', literal(def.title))
    add(d, 'documentKind', literal(kind))
    add(d, 'inProject', id('project', o.project))
    text(d, 'documentRevision', parsed.front?.revision)
    text(d, 'gitCommit', parsed.front?.commit)
    for (const s of parsed.sections) {
      const sec = def.sections.find((x) => x.id === s.id)
      const sn = id('document-section', `${f.path}#${s.id}`)
      store.addQuad(quad(sn, TYPE, T('DocumentSection')))
      add(d, 'hasSection', sn)
      add(sn, 'sectionId', literal(s.id))
      text(sn, 'name', s.title)
      add(sn, 'isPending', bool(s.pending))
      if (sec) {
        add(sn, 'order', dec(def.sections.indexOf(sec)))
        add(sn, 'dueStage', literal(sec.due))
        for (const w of sec.sources) add(sn, 'writtenFrom', literal(w))
      }
      s.figures.forEach((g, i) => {
        const fn = id('figure', `${f.path}#${s.id}/${i + 1}`)
        store.addQuad(quad(fn, TYPE, T('Figure')))
        add(sn, 'hasFigure', fn)
        text(fn, 'figureKind', g.kind)
        text(fn, 'caption', g.caption)
        text(fn, 'figureSource', g.source)
        text(fn, 'path', g.image)
        const run = RUN.exec(g.source)?.[1]
        if (run) add(fn, 'figureFromRun', id('run', run))
      })
      s.values.forEach((t, ti) => t.rows.forEach((r, ri) => {
        const vn = id('document-value', `${f.path}#${s.id}/${ti + 1}/${ri + 1}`)
        store.addQuad(quad(vn, TYPE, T('DocumentValue')))
        add(sn, 'statesValue', vn)
        text(vn, 'valueKind', t.kind)
        text(vn, 'statedQuantity', r.quantity)
        text(vn, 'statedValue', r.value)
        text(vn, 'statedLimit', r.limit)
        text(vn, 'statedMargin', r.margin)
        text(vn, 'valueBasis', r.basis)
        const run = RUN.exec(r.source)?.[1]
        if (run) add(vn, 'valueFromRun', id('run', run))
      }))
    }
  }
  return n
}
