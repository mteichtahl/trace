/**
 * The traceability view's chain: which boxes and links light when one box is selected (upstream to the intent,
 * downstream to the evidence, never across to siblings), the links it draws, the box keys, and the drawing itself
 * rendering through React Flow with the chain lit and the rest faded.
 */
import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import type { CoverageRow, TraceView } from '@/lib/types-s1'
import { Traceability, chainOf, layoutTrace, nodeKey, parseKey, traceElements, traceLinks } from './traceability'

const row = (id: string, verdict: CoverageRow['verdict'], tests = 1): CoverageRow => ({
  id, verdict, kind: 'functional', text: `${id} text`, acceptance: null, status: 'accepted',
  tests: Array.from({ length: tests }, (_, n) => ({ id: `TST-${id}-${n}`, method: 'test', status: 'planned', last_run: null })),
})

// I-1 → R-1, R-2 ; I-2 → R-2, R-3 ; I-3 → nothing. R-2 comes from both lines.
const trace: TraceView = {
  intent: [{ id: 'I-1', topic: 'Power', text: 'runs a year' }, { id: 'I-2', topic: 'Radio', text: 'reports hourly' }, { id: 'I-3', topic: 'Build', text: 'cheap' }],
  links: [{ requirement: 'R-1', intent: 'I-1' }, { requirement: 'R-2', intent: 'I-1' }, { requirement: 'R-2', intent: 'I-2' }, { requirement: 'R-3', intent: 'I-2' }],
}
const rows = [row('R-1', 'verified'), row('R-2', 'failing'), row('R-3', 'untested', 0)]
const layout = layoutTrace(rows, trace)
const links = traceLinks(layout)
const sorted = (s: Set<string>) => [...s].sort()

describe('traceability links', () => {
  it('links each intent line to its requirements and each requirement to its evidence', () => {
    expect(links.map((l) => l.id).sort()).toEqual([
      'intent:I-1>req:R-1', 'intent:I-1>req:R-2', 'intent:I-2>req:R-2', 'intent:I-2>req:R-3',
      'req:R-1>ev:R-1', 'req:R-2>ev:R-2', 'req:R-3>ev:R-3',
    ])
  })
  it('dashes the link to evidence with no test planned, and marks a failing chain', () => {
    expect(links.find((l) => l.id === 'req:R-3>ev:R-3')!.dashed).toBe(true)
    expect(links.find((l) => l.id === 'req:R-1>ev:R-1')!.dashed).toBe(false)
    expect(links.filter((l) => l.failing).map((l) => l.id).sort()).toEqual(['intent:I-1>req:R-2', 'intent:I-2>req:R-2', 'req:R-2>ev:R-2'])
  })
  it('leaves out links to intent lines a filter hid', () => {
    const l = layoutTrace(rows, trace, (r) => r.id === 'R-1')
    expect(traceLinks(l).map((k) => k.id)).toEqual(['intent:I-1>req:R-1', 'req:R-1>ev:R-1'])
  })
})

describe('a selected box lights its whole chain', () => {
  it('an intent line: its requirements and their evidence, not the other lines that share a requirement', () => {
    const c = chainOf(links, 'intent:I-1')
    expect(sorted(c.nodes)).toEqual(['ev:R-1', 'ev:R-2', 'intent:I-1', 'req:R-1', 'req:R-2'])
    expect(sorted(c.links)).toEqual(['intent:I-1>req:R-1', 'intent:I-1>req:R-2', 'req:R-1>ev:R-1', 'req:R-2>ev:R-2'])
  })
  it('a requirement from two lines: both lines and its evidence, not its siblings', () => {
    const c = chainOf(links, 'req:R-2')
    expect(sorted(c.nodes)).toEqual(['ev:R-2', 'intent:I-1', 'intent:I-2', 'req:R-2'])
    expect(c.nodes.has('req:R-1')).toBe(false)
    expect(c.nodes.has('req:R-3')).toBe(false)
  })
  it('evidence: back through its requirement to every intent line behind it', () => {
    const c = chainOf(links, 'ev:R-3')
    expect(sorted(c.nodes)).toEqual(['ev:R-3', 'intent:I-2', 'req:R-3'])
    expect(sorted(c.links)).toEqual(['intent:I-2>req:R-3', 'req:R-3>ev:R-3'])
  })
  it('an intent line nothing covers lights only itself', () => {
    const c = chainOf(links, 'intent:I-3')
    expect(sorted(c.nodes)).toEqual(['intent:I-3'])
    expect(c.links.size).toBe(0)
  })
})

describe('box keys', () => {
  it('round-trips each kind, ids with colons included', () => {
    for (const n of [{ kind: 'intent', id: 'I-1' }, { kind: 'requirement', id: 'R-2' }, { kind: 'evidence', id: 'R:odd' }] as const) expect(parseKey(nodeKey(n))).toEqual(n)
    expect(parseKey('head:req')).toBeNull()
  })
})

describe('the drawing', () => {
  it('marks the chain lit, the selected box selected, and fades the rest', () => {
    const { nodes, edges } = traceElements(layout, links, 'req:R-1')
    const lit = (id: string) => (nodes.find((n) => n.id === id)!.data as { lit: string }).lit
    expect(lit('req:R-1')).toBe('selected')
    expect(lit('intent:I-1')).toBe('lit')
    expect(lit('ev:R-1')).toBe('lit')
    expect(lit('req:R-2')).toBe('dim')
    expect(lit('intent:I-2')).toBe('dim')
    expect(edges.find((e) => e.id === 'intent:I-2>req:R-3')!.style!.opacity).toBe(0.15)
    expect(edges.find((e) => e.id === 'intent:I-1>req:R-1')!.style!.opacity).toBe(1)
  })
  it('with nothing selected nothing is faded', () => {
    const { nodes, edges } = traceElements(layout, links, null)
    expect(nodes.filter((n) => n.type === 'box').every((n) => (n.data as { lit: string }).lit === 'none')).toBe(true)
    expect(edges.every((e) => e.style!.opacity === 1)).toBe(true)
  })
  it('renders through React Flow with a labelled box for each intent line, requirement and evidence', () => {
    render(
      <ReactFlowProvider>
        <div style={{ width: 900, height: 400 }}>
          <Traceability rows={rows} trace={trace} />
        </div>
      </ReactFlowProvider>,
    )
    expect(screen.getByRole('group', { name: /Traceability/ })).toBeTruthy()
    expect(screen.getByText('runs a year')).toBeTruthy()
    expect(screen.getByText('R-2 text')).toBeTruthy()
    expect(screen.getByText('no test planned')).toBeTruthy()
  })
})

describe('block diagram', () => {
  it('a block lights the blocks it connects to in either direction, and only those connections', async () => {
    const { linkedTo } = await import('./block-diagram')
    const c = [{ from: 'pwr', to: 'mcu' }, { from: 'mcu', to: 'radio' }, { from: 'sensor', to: 'mcu' }, { from: 'pwr', to: 'sensor' }]
    const r = linkedTo(c, 'mcu')
    expect(sorted(r.blocks)).toEqual(['mcu', 'pwr', 'radio', 'sensor'])
    expect(sorted(r.connections)).toEqual(['mcu>radio', 'pwr>mcu', 'sensor>mcu'])
    expect(sorted(linkedTo(c, 'radio').blocks)).toEqual(['mcu', 'radio'])
  })
  it('leaves and enters by the facing sides', async () => {
    const { sidesFor } = await import('./block-diagram')
    expect(sidesFor({ x: 0, y: 0 }, { x: 400, y: 20 })).toEqual({ from: 'right', to: 'left' })
    expect(sidesFor({ x: 400, y: 0 }, { x: 0, y: 0 })).toEqual({ from: 'left', to: 'right' })
    expect(sidesFor({ x: 0, y: 0 }, { x: 40, y: 280 })).toEqual({ from: 'bottom', to: 'top' })
  })
})
