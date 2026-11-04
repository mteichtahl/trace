import { describe, expect, it } from 'vitest'
import { replayAction } from '@/mock/replay'
import { type ReplayPage, chapterAt, chapterIndex, graphAt, joinPages, step } from './replay'

const pages = (limit: number): ReplayPage[] => {
  const out: ReplayPage[] = []
  let after: string | undefined
  for (;;) {
    const p = replayAction({ repo: 'acme/soil-sensor', limit, after }) as ReplayPage
    out.push(p)
    if (!p.next) return out
    after = p.next
  }
}

describe('replay', () => {
  const r = joinPages(pages(7))

  it('joins pages into the whole record, in order, with every node named', () => {
    expect(r.events.map((e) => e.id)).toEqual(joinPages(pages(1000)).events.map((e) => e.id))
    expect(r.nodes.get('gate:define')).toMatchObject({ kind: 'gate', label: 'Define gate' })
  })

  it('grows the graph event by event, each node with the status its last event gave it', () => {
    expect(graphAt(r, 0).nodes).toEqual([])
    const signedDefine = r.events.findIndex((e) => e.kind === 'gate.signed') + 1
    const g = graphAt(r, signedDefine)
    expect(g.nodes.find((n) => n.id === 'gate:define')?.status).toBe('verified')
    expect(g.nodes.some((n) => n.id === 'run:run_8e14')).toBe(false)
    expect(g.links).toContainEqual(expect.objectContaining({ source: 'gate:define', target: 'criterion:define.intent', kind: 'contains' }))
    // R-006: untested, then failing, then verified
    const failed = r.events.findIndex((e) => e.kind === 'test.failing') + 1
    expect(graphAt(r, failed - 1).nodes.find((n) => n.id === 'requirement:R-006')?.status).toBe('untested')
    expect(graphAt(r, failed).nodes.find((n) => n.id === 'requirement:R-006')?.status).toBe('failing')
    expect(graphAt(r, r.events.length).nodes.find((n) => n.id === 'requirement:R-006')?.status).toBe('verified')
    // a gate returned shows failing until it is signed again
    const returned = r.events.findIndex((e) => e.kind === 'gate.returned') + 1
    expect(graphAt(r, returned).nodes.find((n) => n.id === 'gate:architect')?.status).toBe('failing')
    expect(graphAt(r, r.events.length).nodes.find((n) => n.id === 'gate:architect')?.status).toBe('verified')
  })

  it('keeps one person\'s or specialist\'s records, and steps over the others when playing', () => {
    const who = 'verification specialist'
    const g = graphAt(r, r.events.length, who)
    expect(g.nodes.some((n) => n.id === 'run:run_8e14')).toBe(true)
    expect(g.nodes.some((n) => n.id === 'gate:define')).toBe(false)
    const first = r.events.findIndex((e) => e.who === who)
    expect(step(r, 0, who)).toBe(first + 1)
    expect(step(r, r.events.length, who)).toBe(r.events.length)
  })

  it('knows its chapter, and where each starts', () => {
    const design = r.chapters.find((c) => c.stage === 'design')!
    const i = chapterIndex(r, design)
    expect(r.events[i]?.kind).toBe('stage.started')
    expect(chapterAt(r, i)?.stage).toBe('design')
    expect(chapterAt(r, 0)?.stage).toBe('define')
  })
})
