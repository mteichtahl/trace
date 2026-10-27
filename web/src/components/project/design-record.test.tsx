/**
 * The design record on screen: the real requirements.trace and design.get answers (lib/api-answers.json, written by
 * the API's own test) drawn by the traceability layout and the architecture helpers; the option switcher's choice;
 * the Requirements review draft; the mock's design.decide.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import answers from '@/lib/api-answers.json'
import { READERS } from '@/lib/readers'
import type { ArchitectureRecord, CoverageRow, DesignView, TraceView } from '@/lib/types-s1'
import { handle } from '@/mock/handlers'
import { withDecision } from '@/components/skills/design-steps'
import { ArchitectureSummary, OptionsTable, drawn, optionToDraw, unmapped } from './architecture'
import { BlockDiagram } from './block-diagram'
import { layoutTrace } from './traceability'

const real = <T,>(action: 'requirements.trace' | 'design.get'): T => {
  const a = answers[action] as { args: Record<string, unknown>; result: unknown }
  const r = READERS[action]
  return (r ? r(a.result, a.args) : a.result) as T
}

describe('requirements.trace as the API answers it', () => {
  it('lays each requirement under the intent line it is derived from', () => {
    const t = real<TraceView>('requirements.trace')
    expect(t.intent[0]).toMatchObject({ id: 'INT-range', topic: 'Performance', state: 'proposed', covered: true })
    const rows: CoverageRow[] = [{ id: 'REQ-1', kind: 'functional', text: 'Range', acceptance: null, status: 'accepted', verdict: 'untested', tests: [] }]
    const l = layoutTrace(rows, t)
    expect(l.reqs[0]?.intent).toBe('INT-range')
    expect(l.intents[0]).toMatchObject({ id: 'INT-range', proposed: true, uncovered: false })
  })
})

describe('design.get as the API answers it', () => {
  const d = real<DesignView>('design.get')
  it('draws the recommended option\'s blocks with their key part and what they serve', () => {
    const a = d.architecture as ArchitectureRecord
    expect(optionToDraw(a, null)).toBe('A')
    render(<BlockDiagram {...drawn(a, 'A')} />)
    expect(screen.getByRole('button', { name: /MCU and radio/ })).toHaveTextContent('STM32WLE5JCI6')
    expect(screen.getByRole('button', { name: /MCU and radio/ })).toHaveTextContent('REQ-1')
  })
  it('names each sheet\'s requirements and lists the pin plan with its status', () => {
    expect(d.sheets[0]).toMatchObject({ id: 'hw/answers.kicad_sch', serves: ['REQ-1'] })
    expect(d.pins?.[0]).toMatchObject({ part: 'U1', pin: '30', fn: 'USART1_TX', status: 'ok' })
    expect(d.pin_plan?.parts).toEqual([{ part: 'U1', pins: 1, agreed: null }])
  })
})

describe('the architecture helpers', () => {
  const a: ArchitectureRecord = {
    option: 'Option B: One chip', id: 'B', state: 'proposed', blocks: [], connections: [], recommended: 'B', chosen: null, fixed: null,
    criteria: [{ id: 'cost', name: 'Cost', weight: 2, description: null }],
    scores: [{ option: 'A', criterion: 'cost', score: 3, reason: 'Two chips.', by: 'trace' }, { option: 'B', criterion: 'cost', score: 5, reason: 'One chip.', by: 'trace' }],
    options: [
      { id: 'A', name: 'Two chips', summary: 's', recommended: false, why: null, gives_up: null, risks: [], total: 6, blocks: [{ id: 'm', name: 'MCU', serves: ['R-1'], x: 0, y: 0 }], connections: [] },
      { id: 'B', name: 'One chip', summary: 's', recommended: true, why: 'Fewer parts.', gives_up: 'A second source.', risks: ['Low stock'], total: 10, blocks: [{ id: 'm', name: 'MCU', serves: ['R-1', 'R-2'], x: 0, y: 0 }], connections: [] },
    ],
  }
  it('holds the asked option, else the chosen, else the recommended', () => {
    expect(optionToDraw(a, 'A')).toBe('A')
    expect(optionToDraw(a, 'Z')).toBe('B')
    expect(optionToDraw({ ...a, chosen: { option: 'A', reason: 'r', deciding: [], by: 'p', at: '', against: true } }, null)).toBe('A')
  })
  it('says which requirements no block serves, and shows the recommendation with what it gives up', () => {
    expect(unmapped(a.options![0]!, ['R-1', 'R-2'])).toEqual(['R-2'])
    render(<><ArchitectureSummary a={a} current="A" requirements={['R-1', 'R-2']} /><OptionsTable a={a} current="A" /></>)
    expect(screen.getByText(/No block of option A serves R-2/)).toBeInTheDocument()
    expect(screen.getByText(/trace recommends option B/)).toBeInTheDocument()
    expect(screen.getByText(/a second source/)).toBeInTheDocument()
    expect(screen.getByRole('table', { name: /scored on each criterion/ })).toHaveTextContent('5 of 5')
  })
})

describe('Requirements review\'s draft', () => {
  it('keeps one decision per requirement, the newest', () => {
    let d = withDecision({}, 'R-1', 'accept')
    d = withDecision(d, 'R-1', 'strike', 'Not needed for the field trial.')
    d = withDecision(d, 'R-2', 'accept')
    expect(d.decisions).toEqual([{ requirement: 'R-1', choice: 'strike', reason: 'Not needed for the field trial.' }, { requirement: 'R-2', choice: 'accept' }])
    expect(withDecision(d, 'R-2', null).decisions).toHaveLength(1)
  })
})

describe('mock mode', () => {
  const callMock = async (action: string, args: Record<string, unknown>) => (await (await handle('/api/call', { method: 'POST', body: JSON.stringify({ action, ...args }) })).json()) as { ok: boolean; result: Record<string, unknown>; error?: string }
  it('answers the design record and records a choice for the session', async () => {
    const d = await callMock('design.get', { repo: 'acme/soil-sensor' })
    expect((d.result.architecture as ArchitectureRecord).state).toBe('proposed')
    expect((await callMock('design.decide', { repo: 'acme/soil-sensor', decision: { kind: 'architecture', option: 'A', reason: 'ok', deciding: [] } })).ok).toBe(false)
    expect((await callMock('design.decide', { repo: 'acme/soil-sensor', decision: { kind: 'architecture', option: 'B', reason: 'Fewer parts.', deciding: ['cost'] } })).ok).toBe(true)
    const after = await callMock('design.get', { repo: 'acme/soil-sensor' })
    expect((after.result.architecture as ArchitectureRecord)).toMatchObject({ state: 'chosen', chosen: { option: 'B' } })
    const t = await callMock('requirements.trace', { repo: 'acme/soil-sensor' })
    expect((t.result as unknown as TraceView).intent.some((i) => i.state === 'proposed')).toBe(true)
  })
})
