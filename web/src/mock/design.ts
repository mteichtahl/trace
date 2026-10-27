/**
 * Mock handlers for the design record (src/api/actions-design.ts and the shapes requirements.trace, design.get and
 * the design skills answer): the soil sensor's intent with accepted and proposed lines, two architecture options with
 * scores, a pin plan with one conflict, sheets that name their requirements, and design.decide recording a person's
 * decision in memory for the session. handlers.ts asks this first and falls through when it answers undefined.
 */
import { DESIGN, TRACE } from './fixtures-s1'
import { s1Action } from './s1'
import type { ArchOption, ArchitectureRecord, DesignView, SkillView, TraceView } from '@/lib/types-s1'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown) => json({ ok: true, result })
const fail = (error: string) => json({ ok: false, error })
const SOIL = 'acme/soil-sensor'
const at = '2026-10-24T09:12:00.000Z'

const OPTIONS: ArchOption[] = [
  {
    id: 'A', name: 'STM32L0 with an SX1262 radio', summary: 'A low-power microcontroller and a separate LoRa radio chip on SPI.', recommended: false, why: null, gives_up: null,
    risks: ['Two chips to source', 'The radio\'s matching network is ours to tune'], total: 19,
    blocks: [
      { id: 'b-power', name: 'Power', part: 'TLV75533', parts: [{ mpn: 'TLV75533PDBVR', key: true }], serves: ['R-004', 'R-011', 'R-014'], x: 0.06, y: 0.38 },
      { id: 'b-mcu', name: 'MCU', part: 'STM32L072CZ', parts: [{ mpn: 'STM32L072CZT6', key: true }], serves: ['R-011'], x: 0.4, y: 0.12 },
      { id: 'b-radio', name: 'Radio', part: 'SX1262', parts: [{ mpn: 'SX1262IMLTRT', key: true }], serves: ['R-006'], x: 0.4, y: 0.64 },
      { id: 'b-sensor', name: 'Moisture sensor', part: 'Capacitive probe', serves: ['R-001', 'R-003'], x: 0.74, y: 0.12 },
      { id: 'b-usb', name: 'USB-C and charger', part: 'MCP73831', parts: [{ mpn: 'MCP73831T-2ACI/OT' }], serves: ['R-008'], x: 0.06, y: 0.74 },
      { id: 'b-antenna', name: 'Antenna', part: 'u.FL connector', serves: ['R-017'], x: 0.74, y: 0.64 },
    ],
    connections: [
      { from: 'b-power', to: 'b-mcu', label: '3V3 rail', kind: 'rail' }, { from: 'b-mcu', to: 'b-radio', label: 'SPI 8 MHz', kind: 'bus' },
      { from: 'b-mcu', to: 'b-sensor', label: 'ADC + excite', kind: 'signal' }, { from: 'b-radio', to: 'b-antenna', label: 'RF 915 MHz', kind: 'rf' }, { from: 'b-usb', to: 'b-power', label: 'VBAT 4.2 V', kind: 'rail' },
    ],
  },
  {
    id: 'B', name: 'STM32WL with integrated radio', summary: 'One chip with the LoRa radio inside: fewer parts and a lower sleep current.', recommended: true,
    why: 'One chip instead of two saves US$1.40 a board and 4 µA asleep, which is two months of battery; the reference design covers the RF matching.', gives_up: 'A second source for the radio, and the SX1262\'s longer track record.',
    risks: ['The STM32WLE5JC is low in stock at LCSC'], total: 23,
    blocks: DESIGN.architecture!.blocks.map((b) => ({ ...b })), connections: DESIGN.architecture!.connections.map((c) => ({ ...c })),
  },
]

let chosen: ArchitectureRecord['chosen'] = null
let fixed: ArchitectureRecord['fixed'] = null
const decided: Record<string, { state: 'accepted' | 'edited'; text?: string; by: string }> = {}
const agreed: Record<string, { by: string; at: string; stale: boolean }> = {}

function architecture(): ArchitectureRecord {
  const current = chosen?.option ?? 'B'
  const o = OPTIONS.find((x) => x.id === current)!
  return {
    option: `Option ${o.id}: ${o.name}`, id: o.id, state: chosen ? 'chosen' : 'proposed', blocks: o.blocks, connections: o.connections, options: OPTIONS,
    criteria: [{ id: 'cost', name: 'Cost', weight: 2, description: null }, { id: 'power', name: 'Power', weight: 2, description: null }, { id: 'risk', name: 'Risk', weight: 1, description: null }, { id: 'availability', name: 'Part availability', weight: 1, description: null }],
    fixed, recommended: 'B', chosen,
    scores: [
      { option: 'A', criterion: 'cost', score: 3, reason: 'Two chips cost US$1.40 more.', by: 'trace' }, { option: 'B', criterion: 'cost', score: 5, reason: 'One chip.', by: 'trace' },
      { option: 'A', criterion: 'power', score: 3, reason: '6 µA asleep with both chips.', by: 'trace' }, { option: 'B', criterion: 'power', score: 4, reason: '2 µA asleep.', by: 'trace' },
      { option: 'A', criterion: 'risk', score: 4, reason: 'Well known parts and layout.', by: 'trace' }, { option: 'B', criterion: 'risk', score: 3, reason: 'Newer part; RF from the reference design.', by: 'trace' },
      { option: 'A', criterion: 'availability', score: 3, reason: 'Both in stock, one source each.', by: 'trace' }, { option: 'B', criterion: 'availability', score: 2, reason: 'Low stock at LCSC.', by: 'trace' },
    ],
  }
}

const SHEET_SERVES: Record<string, { serves?: string[]; block?: string; serves_none?: string }> = {
  power: { serves: ['R-004', 'R-014'], block: 'b-power' }, mcu: { serves: ['R-006', 'R-011'], block: 'b-mcu' }, radio: { serves: ['R-006'], block: 'b-antenna' }, sensor: { serves: ['R-001'], block: 'b-sensor' },
}

function design(): DesignView {
  const pins = (DESIGN.pins ?? []).map((p) => ({ ...p, part: 'U1' }))
  pins.splice(4, 0, { part: 'U1', pin: 'PA9', name: 'PA9', net: 'GPS_RX', fn: 'USART2_TX', peripheral: 'USART2', use: 'GPS', status: 'conflict', note: "U1's USART2 is claimed by 2 uses: debug console, gps." })
  return {
    ...DESIGN, architecture: architecture(),
    sheets: DESIGN.sheets.map((s) => ({ ...s, ...SHEET_SERVES[s.id] })),
    pins,
    pin_plan: {
      checked: { run: '7c1d2e3f4a5b6c7d', at }, parts: [{ part: 'U1', pins: pins.length, agreed: agreed.U1 ?? null }],
      findings: [{ id: 'peripheral:U1:USART2:claimed_twice', target: 'peripheral:U1.USART2', kind: 'claimed_twice', severity: 'blocks', text: "U1's USART2 is claimed by 2 uses: debug console, gps." }],
    },
    drawings: { run: '9f8e7d6c5b4a3210', at },
    notes: [
      ...(chosen ? [] : ['No architecture is chosen yet: the diagram shows trace\'s recommendation, until a person chooses in Architecture choice.']),
      'Stock per key part is not in the record: the parts check (parts.search) answers it when asked, and the architecture gate\'s stock criterion records it.',
    ],
  }
}

function trace(): TraceView {
  const state = (id: string): 'accepted' | 'edited' | 'proposed' => decided[id]?.state ?? (id === 'I-4' || id === 'I-6' ? 'proposed' : 'accepted')
  const intent = [
    ...TRACE.intent.map((i) => ({ ...i, text: decided[i.id]?.text ?? i.text, state: state(i.id), kind: 'statement' as const, source: { kind: 'person' as const, ref: 'Marc' }, covered: TRACE.links.some((l) => l.intent === i.id) })),
    { id: 'I-6', topic: 'Physical', text: 'Fits a 50 × 30 mm board in the IP67 probe housing.', state: state('I-6'), kind: 'statement' as const, flags: [], source: { kind: 'brief' as const, quote: 'the probe housing from the last project' }, covered: false },
  ]
  return { ...TRACE, intent, summary: { requirements: 14, verified: 8, failing: 1, untested: 4, waived: 1, intent: intent.length, accepted: intent.filter((i) => i.state !== 'proposed').length, uncovered: 1, unlinked: 6 } }
}

const SKILLS: Record<string, () => Partial<SkillView>> = {
  'architecture-choice': () => {
    const a = architecture()
    return {
      summary: 'Two options are proposed. trace recommends **option B** (STM32WL): it wins on cost and power, and loses on part availability.',
      architecture: { ...a, options: OPTIONS, current: a.id ?? null },
      recommendation: { question: 'Which architecture goes forward?', recommended: 'B', options: OPTIONS.map((o) => ({ id: o.id, label: `Option ${o.id}: ${o.name}`, detail: `${o.summary} Weighted score ${o.total}.` })), why: OPTIONS[1]!.why!, givesUp: OPTIONS[1]!.gives_up! },
      checks: [
        { id: 'two', status: 'met', detail: '2 options compared.' }, fixed ? { id: 'fixed', status: 'met' } : { id: 'fixed', status: 'not_met', detail: 'Fix the criteria and their weights first, before reading any score.' },
        chosen ? { id: 'scored', status: 'met' } : { id: 'scored', status: 'not_met', detail: 'Choose an option and name the criteria that decided it.' },
        { id: 'mapped', status: 'not_met', detail: '1 requirement served by no block of option B: R-003.' }, { id: 'stock', status: 'not_met', detail: 'Every key part is in stock for the build quantity, or its exception is signed: not met yet.' },
      ],
    }
  },
  'requirements-review': () => ({
    summary: 'Six requirements are still proposed, and one intent line has no requirement yet.',
    items: [
      { id: 'requirement:R-017', title: 'R-017: Meets CISPR 32 class B radiated emissions', detail: 'From Sold in Australia: CISPR 32 class B.', status: 'open' },
      { id: 'requirement:R-019', title: 'R-019: Has a two-line display', detail: 'From the brief.', status: 'open' },
      { id: 'intent:I-6', title: 'Not covered: Fits a 50 × 30 mm board in the IP67 probe housing.', detail: 'No requirement is derived from this intent line: add one, or leave it out with a reason.', status: 'open' },
    ],
    checks: [
      { id: 'criterion', status: 'not_met', detail: '2 requirements neither accepted nor under an open question: R-017, R-019.' }, { id: 'conflicts', status: 'not_met', unavailable: 'a conflict check between requirements (duplicates are checked and there are none; no tool checks that two requirements can both hold)' },
      { id: 'sources', status: 'met' }, { id: 'covered', status: 'not_met', detail: '1 intent statement no requirement covers, and not left out with a reason: I-6.' }, { id: 'struck', status: 'met', detail: 'No requirement is struck.' },
    ],
  }),
  'pin-plan-review': () => ({
    summary: 'The pin plan matches the schematic except one conflict: USART2 is planned for both the debug console and the GPS.',
    items: [{ id: 'finding:peripheral:U1:USART2:claimed_twice', title: "U1's USART2 is claimed by 2 uses: debug console, gps.", detail: 'Fix it in the plan or the schematic, or waive it.', status: 'open' }],
    checks: [{ id: 'functions', status: 'met' }, { id: 'instances', status: 'not_met', detail: "U1's USART2 is claimed by 2 uses: debug console, gps." }, { id: 'boot', status: 'waived', detail: '1 finding waived.' }, { id: 'match', status: 'met' }],
  }),
}

export function designAction(name: string, a: Record<string, unknown>): Response | undefined {
  const repo = a.repo as string
  if (repo !== SOIL) return undefined
  switch (name) {
    case 'requirements.trace': return ok(trace())
    case 'design.get': return ok(design())
    case 'skill.get': {
      const v = SKILLS[String(a.skill)]
      if (!v) return undefined
      // the person's draft is s1's (it keeps drafts for every skill): merged under this skill's view
      const base = s1Action(name, a)
      return (async () => {
        const r = base ? await base.json() as { result?: Record<string, unknown> } : {}
        const { draft, step, saved } = r.result ?? {}
        return ok({ skill: a.skill, ...v(), ...(draft ? { draft, step, saved } : {}) })
      })() as unknown as Response
    }
    case 'design.decide': {
      const d = a.decision as { kind: string; [k: string]: unknown }
      const by = 'marc@example.com'
      if (d.kind === 'criteria') fixed = { by, at: new Date().toISOString() }
      else if (d.kind === 'architecture') {
        if (d.option !== 'B' && String(d.reason ?? '').length < 10) return fail("Option B is trace's recommendation: say in a line why you chose another instead.")
        chosen = { option: String(d.option), reason: String(d.reason), deciding: (d.deciding as string[]) ?? [], by, at: new Date().toISOString(), against: d.option !== 'B' }
      } else if (d.kind === 'intent') decided[String(d.statement)] = { state: d.choice === 'edit' ? 'edited' : 'accepted', ...(d.text ? { text: String(d.text) } : {}), by }
      else if (d.kind === 'pins') agreed[String(d.part)] = { by, at: new Date().toISOString(), stale: false }
      return ok({ ok: true, decision: { id: crypto.randomUUID().slice(0, 16), kind: d.kind, target: String(d.statement ?? d.requirement ?? d.part ?? 'architecture'), choice: 'recorded', by, at: new Date().toISOString() }, summary: 'Recorded.' })
    }
    default: return undefined
  }
}
