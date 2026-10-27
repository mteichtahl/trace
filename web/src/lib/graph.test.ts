import { describe, expect, it } from 'vitest'
import { GRAPH_EXTRA, GRAPH_LINKS, GRAPH_NODES } from '@/mock/fixtures-knowledge'
import { LINK_KINDS, NODE_KINDS, distances, failingChains, filterGraph, groupBeyond, listRows, pathWords, readGraph, shortestPath, tabOrder } from './graph'

const g = readGraph({ nodes: GRAPH_NODES, links: GRAPH_LINKS })
const all = { nodeKinds: new Set(NODE_KINDS), linkKinds: new Set(LINK_KINDS), meaning: true, hidden: new Set<string>() }

describe('graph', () => {
  it('reads nodes and links, dropping links to missing nodes and unknown kinds', () => {
    const r = readGraph({ nodes: [{ id: 'a', kind: 'part', label: 'A' }, { id: 'b', kind: 'nonsense' }], links: [{ from: 'a', to: 'a', kind: 'uses' }, { source: 'a', target: 'b', kind: 'uses' }] })
    expect(r.nodes.map((n) => n.id)).toEqual(['a'])
    expect(r.links).toHaveLength(1)
  })

  it('orders Tab by distance from the focus', () => {
    const order = tabOrder(g, 'R-006')
    expect(order[0]).toBe('R-006')
    const d = distances(g, 'R-006')
    for (let i = 1; i < order.length; i++) expect(d.get(order[i]!) ?? 99).toBeGreaterThanOrEqual(d.get(order[i - 1]!) ?? 99)
  })

  it('finds the shortest path and words it', () => {
    const p = shortestPath(g, 'run_8e14', 'P-ufl')!
    expect(pathWords(p)).toBe('Bench range test → Reaches a gateway 2 km away → Antenna block → u.FL connector')
  })

  it('prefers recorded links over "related by meaning"', () => {
    const p = shortestPath(g, 'doc-rf', 'R-006')!
    expect(p.map((s) => s.node.id)).toEqual(['doc-rf', 'run_8e14', 'R-006'])
    const noMeaning = filterGraph(g, { ...all, meaning: false })
    expect(shortestPath(noMeaning, 'doc-rf', 'R-006')).toBeNull()
  })

  it('colours a failing chain back to the intent, not sideways to other requirements', () => {
    const c = failingChains(g)
    expect([...c.nodes].sort()).toEqual(['I-3', 'R-006', 'run_8e14'].sort())
  })

  it('filters by kind but always keeps the focus', () => {
    const f = filterGraph(g, { ...all, nodeKinds: new Set(['part']) }, 'R-006')
    expect(f.nodes.map((n) => n.kind).sort()).toEqual(['part', 'part', 'requirement'])
    expect(f.links).toHaveLength(0)
  })

  it('groups beyond the limit into "+N more", most numerous kind first', () => {
    const big = readGraph({ nodes: [...GRAPH_NODES, ...GRAPH_EXTRA.nodes], links: [...GRAPH_LINKS, ...GRAPH_EXTRA.links] })
    const { graph, groups } = groupBeyond(big, 'R-006', 150)
    expect(graph.nodes.length + groups.length).toBeLessThanOrEqual(150)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.kind).toBe('part')
    expect(groups[0]!.label).toMatch(/^\+\d+ more parts$/)
    expect(graph.nodes.some((n) => n.id === 'R-006')).toBe(true)
    expect(groupBeyond(g, 'R-006', 150).groups).toHaveLength(0)
  })

  it('lists one row per link for the List switch', () => {
    const rows = listRows(g, 'R-006')
    expect(rows).toHaveLength(GRAPH_LINKS.length)
    expect(rows.find((r) => r.link === 'fails')).toMatchObject({ kind: 'Run or evidence', status: 'Failing' })
  })
})
