/**
 * JSON-LD at the edges (docs/ontology.md: "JSON-LD is produced only at the edges where another program reads it"):
 * the context that maps trace's JSON keys to the ontology's terms, and one record of a project's graph as JSON-LD.
 *
 *   jsonLdContext(v)        the context: @vocab is trace's namespace; links are typed @id, times xsd:dateTime, kept
 *                           JSON @json. ontology/context.jsonld is this, committed (the test keeps the two equal;
 *                           scripts/ontology-context.mjs writes it)
 *   CONTEXT_URL             where the context is named from records: https://trace-eda.com/ns/trace/context/<version>.jsonld
 *   recordJsonLd(store, id) one node as JSON-LD, with the nodes that belong to it (its evidence, its options: those
 *                           whose identifier extends its own) embedded, and every other link as an identifier
 */
import type { Store, Term as RdfTerm } from 'n3'
import { NS, RDF, XSD, type Vocabulary, local } from './vocab.js'

const TYPE = `${RDF}type`

/** The ontology's version: the newest of its modules' owl:versionInfo. */
export function ontologyVersion(v: Vocabulary): string {
  const parts = (s: string): number[] => s.split('.').map((x) => Number(x) || 0)
  return Object.values(v.versions).sort((a, b) => {
    const [x, y] = [parts(a), parts(b)]
    for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
    return 0
  }).at(-1) ?? '0.0.0'
}

export const contextUrl = (v: Vocabulary): string => `https://trace-eda.com/ns/trace/context/${ontologyVersion(v)}.jsonld`

/** The JSON-LD context for the vocabulary. */
export function jsonLdContext(v: Vocabulary): { '@context': Record<string, unknown> } {
  const ctx: Record<string, unknown> = { '@version': 1.1, '@vocab': NS, trace: NS, xsd: XSD }
  for (const [name, p] of [...v.properties].sort(([a], [b]) => a.localeCompare(b))) {
    if (p.kind === 'annotation') continue
    if (p.kind === 'object') ctx[name] = { '@id': `trace:${name}`, '@type': '@id' }
    else if (p.range === `${XSD}dateTime`) ctx[name] = { '@id': `trace:${name}`, '@type': 'xsd:dateTime' }
    else if (p.range === `${XSD}date`) ctx[name] = { '@id': `trace:${name}`, '@type': 'xsd:date' }
    else if (p.range === `${RDF}JSON`) ctx[name] = { '@id': `trace:${name}`, '@type': '@json' }
  }
  return { '@context': ctx }
}

function value(store: Store, o: RdfTerm, owner: string, seen: Set<string>): unknown {
  if (o.termType === 'NamedNode') return o.value.startsWith(`${owner}/`) && !seen.has(o.value) ? node(store, o.value, seen) : o.value
  if (o.termType !== 'Literal') return o.value
  const dt = o.datatype.value
  if (dt === `${RDF}JSON`) { try { return JSON.parse(o.value) } catch { return o.value } }
  if (dt === `${XSD}boolean`) return o.value === 'true'
  if (dt === `${XSD}integer` || dt === `${XSD}decimal`) return Number(o.value)
  return o.value
}

function node(store: Store, id: string, seen: Set<string>): Record<string, unknown> {
  seen.add(id)
  const out: Record<string, unknown> = { '@id': id }
  const types = store.getQuads(id, TYPE, null, null).map((q) => local(q.object.value) ?? q.object.value).sort()
  if (types.length) out['@type'] = types.length === 1 ? types[0] : types
  const props = new Map<string, unknown[]>()
  for (const q of store.getQuads(id, null, null, null)) {
    if (q.predicate.value === TYPE) continue
    const key = local(q.predicate.value) ?? q.predicate.value
    props.set(key, [...(props.get(key) ?? []), value(store, q.object, id, seen)])
  }
  for (const [k, vs] of [...props].sort(([a], [b]) => a.localeCompare(b))) out[k] = vs.length === 1 ? vs[0] : vs
  return out
}

/** One record of `store` as JSON-LD, or null when the graph has nothing about it. */
export function recordJsonLd(store: Store, id: string, v: Vocabulary): Record<string, unknown> | null {
  if (!store.getQuads(id, null, null, null).length) return null
  return { '@context': contextUrl(v), ...node(store, id, new Set()) }
}
