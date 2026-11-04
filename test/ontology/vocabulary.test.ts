/**
 * The ontology's own checks (docs/ontology.md "Testing and CI"; docs/ontology-plan.md phase 1's exit check): every file
 * parses, every term has a plain-words label and comment with no acronyms, nothing is defined twice, every Si2 term
 * aligned to exists in the pinned Si2 commit, the committed JSON-LD context is what the ontology gives, and every class
 * is either stored by a mapped table or says where it is kept.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Parser } from 'n3'
import { describe, expect, it } from 'vitest'
import { ONTOLOGY_DIR, readVocabulary, turtleFiles } from '../../src/ontology/vocab.js'
import { jsonLdContext } from '../../src/ontology/jsonld.js'
import { TABLES, type ColumnRule, type FieldMap } from '../../src/ontology/mapping.js'
import { BOARD_CLASSES, BOARD_PROPERTIES } from '../../src/ontology/board.js'
import { ENGINE_CLASSES, ENGINE_PROPERTIES, MECH_CLASSES, MECH_PROPERTIES } from '../../src/ontology/mech.js'

const v = readVocabulary()

/** Words of two or more capitals people may see: proper names, never an acronym. */
const ALLOWED = new Set(['JLCPCB', 'JSON', 'SHA'])
const acronyms = (s: string): string[] => (s.match(/\b[A-Z]{2,}\b/g) ?? []).filter((w) => !ALLOWED.has(w))

/** Classes and properties the mapping names: a table's class, each column's property and link type, each object's. */
function mapped(): { classes: Set<string>; props: Set<string> } {
  const classes = new Set<string>(['Project', ...BOARD_CLASSES, ...ENGINE_CLASSES, ...MECH_CLASSES])
  const props = new Set<string>(['inProject', ...BOARD_PROPERTIES, ...ENGINE_PROPERTIES, ...MECH_PROPERTIES])
  const rule = (r: ColumnRule): void => {
    if ('ignore' in r) return
    props.add(r.prop)
    if (('ref' in r || 'refList' in r) && r.type) classes.add(r.type)
    if ('ref' in r && r.orLiteral) props.add(r.orLiteral)
    if ('objects' in r) obj(r.objects)
  }
  const obj = (m: FieldMap): void => {
    classes.add(m.class)
    if (m.typeIf) classes.add(m.typeIf.class)
    Object.values(m.fields).forEach(rule)
  }
  for (const t of TABLES) {
    classes.add(t.class)
    for (const c of Object.values(t.typeBy?.classes ?? {})) classes.add(c)
    Object.values(t.columns).forEach(rule)
    if (t.link) props.add(t.link[2])
  }
  return { classes, props }
}

/** Core properties lineage (phase 4) fills; nothing maps them yet. */
const FOR_LATER = new Set(['isInputTo', 'isOutputOf', 'derivedFromVersion', 'supersedes', 'versionOf', 'versionNumber'])

describe('the ontology files', () => {
  it('every Turtle file parses', () => {
    const files = turtleFiles()
    expect(files).toEqual(expect.arrayContaining(['trace-core.ttl', 'trace-journey.ttl', 'trace-si2-align.ttl']))
    for (const f of files) expect(() => new Parser().parse(readFileSync(join(ONTOLOGY_DIR, f), 'utf8')), f).not.toThrow()
  })

  it('every module carries a version', () => {
    const semver = expect.stringMatching(/^\d+\.\d+\.\d+$/)
    expect(v.versions).toEqual({ 'trace-core.ttl': semver, 'trace-journey.ttl': semver, 'trace-board.ttl': semver, 'trace-mech.ttl': semver })
  })

  it('every term has a label and a comment in plain words, acronyms only as other names', () => {
    const terms = [...v.classes.values(), ...v.properties.values()]
    expect(terms.length).toBeGreaterThan(150)
    for (const t of terms) {
      expect(t.label, `${t.name} label`).toBeTruthy()
      expect(t.comment, `${t.name} comment`).toBeTruthy()
      expect(acronyms(t.label ?? ''), `${t.name} label`).toEqual([])
      expect(acronyms(t.comment ?? ''), `${t.name} comment`).toEqual([])
      expect((t.comment ?? '').length, `${t.name} comment`).toBeLessThan(300)
    }
  })

  it('names classes in UpperCamelCase and properties in lowerCamelCase, each defined once', () => {
    for (const c of v.classes.keys()) expect(c, c).toMatch(/^[A-Z][A-Za-z]+$/)
    for (const p of v.properties.keys()) expect(p, p).toMatch(/^[a-z][A-Za-z0-9]+$/)
    for (const [name, files] of v.definedIn) expect(files, name).toHaveLength(1)
  })

  it('every parent, domain and range names something defined', () => {
    for (const c of v.classes.values()) for (const p of c.parents) expect(v.classes.has(p), `${c.name} subClassOf ${p}`).toBe(true)
    for (const p of v.properties.values()) {
      for (const r of [p.domain, p.range]) if (r && !r.includes('/')) expect(v.classes.has(r), `${p.name}: ${r}`).toBe(true)
      if (p.kind === 'datatype' && p.range) expect(p.range, p.name).toMatch(/^http:\/\/www\.w3\.org\/(2001\/XMLSchema#|1999\/02\/22-rdf-syntax-ns#JSON)/)
    }
  })

  it('aligns only with terms the pinned Si2 commit defines', () => {
    const si2 = new Set(readFileSync(join(ONTOLOGY_DIR, 'si2', 'terms.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')))
    expect(readFileSync(join(ONTOLOGY_DIR, 'si2', 'terms.txt'), 'utf8')).toMatch(/664164c3d31d37486e50cbdc455d1f8e02ffb950/)
    expect(v.alignments.length).toBeGreaterThanOrEqual(10)
    for (const a of v.alignments) {
      expect(si2.has(a.si2), `eda:${a.si2}`).toBe(true)
      expect(a.relation === 'equivalentProperty' ? v.properties.has(a.term) : v.classes.has(a.term), a.term).toBe(true)
    }
  })

  it('the committed JSON-LD context is the one the ontology gives (node scripts/ontology-context.mjs)', () => {
    expect(JSON.parse(readFileSync(join(ONTOLOGY_DIR, 'context.jsonld'), 'utf8'))).toEqual(jsonLdContext(v))
  })
})

describe('the ontology against the code (phase 1\'s exit check)', () => {
  const m = mapped()

  it('every class the mapping names is defined, and every class is mapped or says where it is kept', () => {
    for (const c of m.classes) expect(v.classes.has(c), c).toBe(true)
    for (const c of v.classes.values()) {
      if (m.classes.has(c.name)) continue
      // a parent of a mapped class is mapped through it (an agent action, through the job and the criterion check)
      if ([...m.classes].some((x) => v.classes.get(x)?.parents.includes(c.name))) continue
      expect(c.keptIn ?? (c.derived ? 'derived' : null), `${c.name} is neither mapped nor kept anywhere`).toBeTruthy()
    }
  })

  it('every property the mapping names is defined with the right kind, and every journey property is mapped', () => {
    const kinds = new Map<string, 'object' | 'datatype'>()
    const rule = (r: ColumnRule): void => {
      if ('ignore' in r) return
      kinds.set(r.prop, 'ref' in r || 'refList' in r || 'objects' in r || 'pick' in r ? 'object' : 'datatype')
      if ('objects' in r) Object.values(r.objects.fields).forEach(rule)
    }
    for (const t of TABLES) Object.values(t.columns).forEach(rule)
    for (const [p, kind] of kinds) expect(v.properties.get(p)?.kind, p).toBe(kind)
    for (const p of v.properties.values()) {
      if (p.kind === 'annotation' || p.derived || FOR_LATER.has(p.name)) continue
      expect(m.props.has(p.name), `${p.name} (${p.file}) is defined but nothing maps to it`).toBe(true)
    }
  })
})
