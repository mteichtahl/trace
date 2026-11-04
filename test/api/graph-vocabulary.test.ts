/** The graph's one vocabulary: what graph.neighbourhood answers is what the app's graph reads (web/src/lib/graph.ts). */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LINK_KINDS, NODE_KINDS, NODE_STATUSES } from '../../src/api/actions-graph.js'
import { graphKinds, renderGraphKinds } from '../../src/ontology/graph-kinds.js'
import { readVocabulary } from '../../src/ontology/vocab.js'

const app = readFileSync(join(import.meta.dirname, '../../web/src/lib/graph.ts'), 'utf8')
const gen = (p: string): string => readFileSync(join(import.meta.dirname, '../..', p), 'utf8')
const list = (name: string, src: string): string[] => {
  const m = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src) ?? new RegExp(`type ${name} = ([^\\n]+)`).exec(src)
  return [...(m?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1] as string)
}

describe('the graph vocabulary', () => {
  it('node kinds are made from the ontology, and the API and the app read the same generated list (node scripts/graph-kinds.mjs)', () => {
    const want = renderGraphKinds(graphKinds(readVocabulary()))
    expect(gen('src/ontology/graph-kinds.gen.ts')).toBe(want)
    expect(gen('web/src/lib/graph-kinds.gen.ts')).toBe(want)
    expect(app).toMatch(/import \{ NODE_KINDS \} from '\.\/graph-kinds\.gen'/)
    expect([...NODE_KINDS]).toEqual(graphKinds(readVocabulary()).nodeKinds)
  })
  it('every kind the ontology names is a class the view draws, and link kinds are the app\'s, in the app\'s order', () => {
    const k = graphKinds(readVocabulary())
    expect(k.classKinds).toMatchObject({ Requirement: 'requirement', Gate: 'gate', Criterion: 'criterion', Component: 'component', RunArtifact: 'artifact' })
    expect([...LINK_KINDS]).toEqual(list('LINK_KINDS', app))
  })
  it('node statuses are the app\'s', () => {
    expect([...NODE_STATUSES].sort()).toEqual(list('NodeStatus', app).sort())
  })
})
