/**
 * trace's ontology as data (docs/ontology.md): the Turtle files under ontology/ read into one vocabulary of classes and
 * properties, each with its label, comment, other names, parents, domain and range and the file (module) it is in.
 *
 *   loadVocabulary()   the vocabulary, read once per process from ONTOLOGY_DIR
 *   NS                 the one namespace every module shares, https://trace-eda.com/ns/trace#
 *   iri(term)          a term's full IRI from its local name
 *   isA(v, cls, of)    whether `cls` is `of` or one of its subclasses (rdfs:subClassOf, transitively)
 *
 * Only what the code needs is read: rdf:type of owl:Class and the three property kinds, rdfs:label, rdfs:comment,
 * skos:altLabel, rdfs:subClassOf, rdfs:domain, rdfs:range, owl:versionInfo and trace's own annotations (trace:keptIn,
 * trace:derived). No reasoning beyond subclass lookups (docs/ontology.md, non-goals).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Parser, type Quad } from 'n3'

/** The ontology's files: the repository's (and the image's) ontology/, beside src/ and dist/. */
export const ONTOLOGY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ontology')

export const NS = 'https://trace-eda.com/ns/trace#'
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#'
export const OWL = 'http://www.w3.org/2002/07/owl#'
export const XSD = 'http://www.w3.org/2001/XMLSchema#'
export const SKOS = 'http://www.w3.org/2004/02/skos/core#'
export const EDA = 'http://example.org/eda#'

export const iri = (term: string): string => `${NS}${term}`
export const local = (full: string): string | null => (full.startsWith(NS) ? full.slice(NS.length) : null)

/** The module files, in the order they build on each other. trace-si2-align.ttl is read for its alignments only. */
export const MODULE_FILES = ['trace-core.ttl', 'trace-journey.ttl'] as const
export const ALIGN_FILE = 'trace-si2-align.ttl'

export interface Term {
  /** the local name, such as Gate or ofStage */
  name: string
  label: string | null
  comment: string | null
  altLabels: string[]
  /** the file it is defined in (its module) */
  file: string
}
export interface ClassTerm extends Term {
  kind: 'class'
  parents: string[]
  /** where instances come from when no mapped table stores them (trace:keptIn) */
  keptIn: string | null
  /** computed when read, never stored (trace:derived) */
  derived: boolean
}
export interface PropertyTerm extends Term {
  kind: 'object' | 'datatype' | 'annotation'
  /** local names of trace classes, or full IRIs for anything else (xsd:string, rdf:JSON) */
  domain: string | null
  range: string | null
  derived: boolean
}
export interface Alignment { term: string; relation: 'subClassOf' | 'equivalentClass' | 'equivalentProperty'; si2: string }

export interface Vocabulary {
  classes: Map<string, ClassTerm>
  properties: Map<string, PropertyTerm>
  versions: Record<string, string>
  alignments: Alignment[]
  /** every name defined, with every file that defines it (a name in two files is a mistake the lint reports) */
  definedIn: Map<string, string[]>
}

const short = (v: string): string => local(v) ?? v

function readFile(dir: string, file: string): Quad[] {
  return new Parser({ baseIRI: NS }).parse(readFileSync(join(dir, file), 'utf8'))
}

/** Read the vocabulary from `dir` (default ONTOLOGY_DIR). */
export function readVocabulary(dir: string = ONTOLOGY_DIR): Vocabulary {
  const v: Vocabulary = { classes: new Map(), properties: new Map(), versions: {}, alignments: [], definedIn: new Map() }
  for (const file of MODULE_FILES) {
    const quads = readFile(dir, file)
    const of = (s: string, p: string): string[] => quads.filter((q) => q.subject.value === s && q.predicate.value === p).map((q) => q.object.value)
    const one = (s: string, p: string): string | null => of(s, p)[0] ?? null
    for (const q of quads) {
      if (q.predicate.value !== `${RDF}type` || q.subject.termType !== 'NamedNode') continue
      const s = q.subject.value
      if (q.object.value === `${OWL}Ontology`) { v.versions[file] = one(s, `${OWL}versionInfo`) ?? ''; continue }
      const name = local(s)
      if (!name) continue
      const base = { name, label: one(s, `${RDFS}label`), comment: one(s, `${RDFS}comment`), altLabels: of(s, `${SKOS}altLabel`), file }
      const derived = one(s, `${NS}derived`) === 'true'
      const kind = q.object.value === `${OWL}Class` ? 'class'
        : q.object.value === `${OWL}ObjectProperty` ? 'object'
          : q.object.value === `${OWL}DatatypeProperty` ? 'datatype'
            : q.object.value === `${OWL}AnnotationProperty` ? 'annotation' : null
      if (!kind) continue
      v.definedIn.set(name, [...(v.definedIn.get(name) ?? []), file])
      if (kind === 'class') {
        v.classes.set(name, { ...base, kind, parents: of(s, `${RDFS}subClassOf`).map(short), keptIn: one(s, `${NS}keptIn`), derived })
      } else {
        const dom = one(s, `${RDFS}domain`)
        const rng = one(s, `${RDFS}range`)
        v.properties.set(name, { ...base, kind, domain: dom ? short(dom) : null, range: rng ? short(rng) : null, derived })
      }
    }
  }
  for (const q of readFile(dir, ALIGN_FILE)) {
    const term = local(q.subject.value)
    const rel = q.predicate.value === `${RDFS}subClassOf` ? 'subClassOf'
      : q.predicate.value === `${OWL}equivalentClass` ? 'equivalentClass'
        : q.predicate.value === `${OWL}equivalentProperty` ? 'equivalentProperty' : null
    if (term && rel && q.object.value.startsWith(EDA)) v.alignments.push({ term, relation: rel, si2: q.object.value.slice(EDA.length) })
  }
  return v
}

let cached: Vocabulary | null = null
/** The vocabulary of ONTOLOGY_DIR, read once. */
export function loadVocabulary(): Vocabulary {
  cached ??= readVocabulary()
  return cached
}

/** Whether class `cls` is `of`, or a subclass of it. */
export function isA(v: Vocabulary, cls: string, of: string): boolean {
  const seen = new Set<string>()
  const walk = (c: string): boolean => {
    if (c === of) return true
    if (seen.has(c)) return false
    seen.add(c)
    return (v.classes.get(c)?.parents ?? []).some(walk)
  }
  return walk(cls)
}

/** Every Turtle file under `dir` (the lint parses them all, shapes included once they exist). */
export function turtleFiles(dir: string = ONTOLOGY_DIR): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.ttl')).sort()
}
