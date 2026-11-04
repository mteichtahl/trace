/**
 * The journey as the ontology has it (docs/ontology-plan.md P2.7): its gates, criteria, signatures, waivers, questions
 * and decisions read from the project's graph (./graph.ts buildGraph, through the mapping), not from the journey's
 * tables. graph.neighbourhood (src/api/actions-graph.ts) draws the journey's kinds from this, so what the graph view
 * shows of the journey is what the ontology says the record holds.
 *
 *   journeyGraph(db, o)   the journey's records, or null when there is no journey; `o.asOf` gives them as they stood
 *                         at a moment (./as-of.ts), like buildGraph
 *
 * The record's own identifiers come back from each node's IRI (nodeIri: urn:trace:<installation>:<project>:<kind>:<id>),
 * times from xsd:dateTime as seconds since 1970, and lists (a criterion's evidence) in the record's order.
 */
import type { DatabaseSync } from 'node:sqlite'
import { DataFactory, type Store, type Term } from 'n3'
import { type GraphOptions, buildGraph, nodeIri } from './graph.js'
import { NS, RDF } from './vocab.js'

const { namedNode } = DataFactory
const T = (name: string) => namedNode(`${NS}${name}`)
const TYPE = namedNode(`${RDF}type`)

export interface GraphEvidence { kind: string; ref: string; label?: string }
export interface JourneyGraph {
  /** the journey's current revision */
  revision: string | null
  gates: { id: string; stage: string; ord: number; name: string }[]
  criteria: { id: string; gate: string; ord: number; text: string; owner: 'trace' | 'person'; status: 'met' | 'not_met'; evidence: GraphEvidence[]; checkedBy: string | null }[]
  signatures: { id: string; gate: string; revision: string | null; by: string; at: number; supersededAt: number | null }[]
  waivers: { id: string; targetKind: string; target: string; reason: string; severity: string; scope: string; by: string; at: number; closedAt: number | null }[]
  questions: { id: string; text: string; askedBy: string; askedAt: number; answer: string | null; answeredBy: string | null; answeredAt: number | null }[]
  /** newest first, as the decisions log reads */
  decisions: { id: string; at: number; kind: string; ref: string | null; summary: string }[]
}

/** The record's own key from a node's IRI (its last segment). */
const keyOf = (iri: string): string => decodeURIComponent(iri.slice(iri.lastIndexOf(':') + 1))
const seconds = (v: string | null): number | null => {
  if (v === null) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t / 1000 : null
}

export function journeyGraph(db: DatabaseSync, o: Omit<GraphOptions, 'derived' | 'files'>): JourneyGraph | null {
  const { store } = buildGraph({ journey: db }, o)
  const journey = namedNode(nodeIri(o, 'journey', 'current'))
  if (!store.has(DataFactory.quad(journey, TYPE, T('Journey')))) return null
  const g = new Reader(store)
  const of = (cls: string) => store.getSubjects(TYPE, T(cls), null)
  const ref = (s: Term, p: string): string | null => { const v = g.one(s, p); return v === null ? null : keyOf(v) }

  const gates = of('Gate').map((s) => ({ id: keyOf(s.value), stage: ref(s, 'ofStage') ?? '', ord: g.num(s, 'order') ?? 0, name: g.one(s, 'name') ?? keyOf(s.value) }))
  gates.sort((a, b) => a.ord - b.ord)

  const criteria = of('Criterion').map((s) => {
    const evidence = store.getObjects(s, T('hasEvidence'), null)
      .map((e) => ({ n: Number(e.value.slice(e.value.lastIndexOf('/') + 1)), kind: g.one(e, 'evidenceKind') ?? '', ref: g.one(e, 'evidenceRef') ?? '', label: g.one(e, 'label') }))
      .sort((a, b) => a.n - b.n)
      .map(({ kind, ref: r, label }) => ({ kind, ref: r, ...(label === null ? {} : { label }) }))
    return {
      id: keyOf(s.value), gate: ref(s, 'ofGate') ?? '', ord: g.num(s, 'order') ?? 0, text: g.one(s, 'text') ?? '',
      owner: g.one(s, 'ownedBy') === 'person' ? 'person' as const : 'trace' as const, status: g.one(s, 'status') === 'met' ? 'met' as const : 'not_met' as const,
      evidence, checkedBy: g.one(s, 'checkedBy'),
    }
  })
  criteria.sort((a, b) => (a.gate < b.gate ? -1 : a.gate > b.gate ? 1 : a.ord - b.ord))

  const signatures = of('Signature').map((s) => ({
    id: keyOf(s.value), gate: ref(s, 'signs') ?? '', revision: ref(s, 'inRevision'), by: g.one(s, 'recordedBy') ?? '',
    at: g.time(s, 'recordedAt') ?? 0, supersededAt: g.time(s, 'supersededAt'),
  })).sort((a, b) => a.at - b.at)

  const waivers = of('Waiver').map((s) => ({
    id: keyOf(s.value), targetKind: g.one(s, 'targetKind') ?? '', target: g.one(s, 'waivesTarget') ?? '', reason: g.one(s, 'reason') ?? '',
    severity: g.one(s, 'severity') ?? '', scope: g.one(s, 'scope') ?? '', by: g.one(s, 'recordedBy') ?? '', at: g.time(s, 'recordedAt') ?? 0, closedAt: g.time(s, 'closedAt'),
  })).sort((a, b) => a.at - b.at)

  // the journey's questions only (the agents' questions are facts.db's, not given here)
  const questions = of('Question').filter((s) => s.value.includes(':question:')).map((s) => ({
    id: keyOf(s.value), text: g.one(s, 'text') ?? '', askedBy: g.one(s, 'askedBy') ?? '', askedAt: g.time(s, 'askedAt') ?? 0,
    answer: g.one(s, 'answer'), answeredBy: g.one(s, 'answeredBy'), answeredAt: g.time(s, 'answeredAt'),
  })).sort((a, b) => a.askedAt - b.askedAt)

  const decisions = of('DecisionEntry').map((s) => ({
    id: keyOf(s.value), at: g.time(s, 'recordedAt') ?? 0, kind: g.one(s, 'entryKind') ?? '', ref: g.one(s, 'about'), summary: g.one(s, 'summary') ?? '',
  })).sort((a, b) => b.at - a.at)

  return { revision: ref(journey, 'currentRevision'), gates, criteria, signatures, waivers, questions, decisions }
}

class Reader {
  constructor(private readonly store: Store) {}
  one(s: Term, p: string): string | null {
    const o = this.store.getObjects(s, T(p), null)[0]
    return o ? o.value : null
  }
  num(s: Term, p: string): number | null {
    const v = this.one(s, p)
    return v === null || !Number.isFinite(Number(v)) ? null : Number(v)
  }
  time(s: Term, p: string): number | null {
    return seconds(this.one(s, p))
  }
}
