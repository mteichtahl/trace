/** The graph's one vocabulary: what graph.neighbourhood answers is what the app's graph reads (web/src/lib/graph.ts). */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LINK_KINDS, NODE_KINDS, NODE_STATUSES } from '../../src/api/actions-graph.js'

const app = readFileSync(join(import.meta.dirname, '../../web/src/lib/graph.ts'), 'utf8')
const list = (name: string, src: string): string[] => {
  const m = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src) ?? new RegExp(`type ${name} = ([^\\n]+)`).exec(src)
  return [...(m?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1] as string)
}

describe('the graph vocabulary', () => {
  it('node and link kinds are the app\'s, in the app\'s order', () => {
    expect([...NODE_KINDS]).toEqual(list('NODE_KINDS', app))
    expect([...LINK_KINDS]).toEqual(list('LINK_KINDS', app))
  })
  it('node statuses are the app\'s', () => {
    expect([...NODE_STATUSES].sort()).toEqual(list('NodeStatus', app).sort())
  })
})
