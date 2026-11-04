/**
 * A template definition (src/core/templates.ts) as a graph, for its shape (ontology/shapes/templates/journey-template.ttl)
 * to check on save: the template, its stages in order, each stage's gates, each gate's criteria with their words,
 * owner and evidence. The same classes and properties a journey's own stages, gates and criteria have.
 */
import { DataFactory, Writer } from 'n3'
import { GATES, STAGE_IDS } from '../core/journey-catalog.js'
import { type TemplateDoc, docStages } from '../core/templates.js'
import { LATER_STAGES } from '../core/journey-catalog.js'
import { NS } from './vocab.js'

const { namedNode, literal, quad } = DataFactory
const XSD = 'http://www.w3.org/2001/XMLSchema#'
const RDF_TYPE = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type')
const T = (n: string) => namedNode(`${NS}${n}`)

/** The definition as Turtle, its nodes under urn:trace:<installation>:template:<id>. */
export function templateTurtle(doc: TemplateDoc, o: { installation: string; version: number }): Promise<string> {
  const base = `urn:trace:${encodeURIComponent(o.installation)}:template:${doc.id}`
  const w = new Writer({ prefixes: { trace: NS } })
  const tpl = namedNode(base)
  w.addQuad(quad(tpl, RDF_TYPE, T('JourneyTemplate')))
  w.addQuad(quad(tpl, T('name'), literal(doc.name)))
  w.addQuad(quad(tpl, T('versionNumber'), literal(String(o.version), namedNode(`${XSD}integer`))))
  const stages = docStages(doc, LATER_STAGES)
  for (const s of stages) {
    const sn = namedNode(`${base}/stage/${s.id}`)
    w.addQuad(quad(tpl, T('hasStage'), sn))
    w.addQuad(quad(sn, RDF_TYPE, T('Stage')))
    w.addQuad(quad(sn, T('stageKind'), literal(s.id)))
    w.addQuad(quad(sn, T('order'), literal(String(STAGE_IDS.indexOf(s.id)), namedNode(`${XSD}decimal`))))
    for (const g of s.gates) {
      const gn = namedNode(`${base}/gate/${g.id}`)
      w.addQuad(quad(gn, RDF_TYPE, T('Gate')))
      w.addQuad(quad(gn, T('ofStage'), sn))
      w.addQuad(quad(gn, T('name'), literal(GATES.find((x) => x.id === g.id)?.name ?? g.id)))
      g.criteria.forEach((c, i) => {
        const cn = namedNode(`${base}/criterion/${c.id}`)
        w.addQuad(quad(cn, RDF_TYPE, T('Criterion')))
        w.addQuad(quad(cn, T('ofGate'), gn))
        w.addQuad(quad(cn, T('order'), literal(String(i), namedNode(`${XSD}decimal`))))
        w.addQuad(quad(cn, T('text'), literal(c.text)))
        w.addQuad(quad(cn, T('ownedBy'), literal(c.owner)))
        w.addQuad(quad(cn, T('evidenceLabel'), literal(c.evidence)))
      })
    }
  }
  return new Promise((res, rej) => w.end((e, out) => (e ? rej(e) : res(out as string))))
}
