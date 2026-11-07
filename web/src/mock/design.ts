/**
 * Mock handlers for the design record (src/api/actions-design.ts and the shapes requirements.trace, design.get and
 * the design skills answer): the soil sensor's intent with accepted and proposed lines, two architecture options with
 * scores, a pin plan with one conflict, sheets that name their requirements, and design.decide recording a person's
 * decision in memory for the session. handlers.ts asks this first and falls through when it answers undefined.
 */
import { DESIGN, TRACE } from './fixtures-s1'
import { s1Action } from './s1'
import type { ArchOption, ArchitectureRecord, DesignView, SkillItem, SkillView, TraceView } from '@/lib/types-s1'

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
    // once fixed, the cost criterion names a requirement changed since: its numbers may be old (#173)
    criteria: [{ id: 'cost', name: 'Cost', weight: 2, description: 'R-014: at most US$12 a board.', ...(fixed ? { stale: { requirements: ['R-014'], since: new Date(Date.now() - 3_600_000).toISOString() } } : {}) }, { id: 'power', name: 'Power', weight: 2, description: null }, { id: 'risk', name: 'Risk', weight: 1, description: null }, { id: 'availability', name: 'Part availability', weight: 1, description: null }],
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

const PIN_QUESTION = 'Which pin order should the OLED header have on U1\'s I2C pins: GND, VCC, SCL, SDA or VCC, GND, SCL, SDA? A wrong order reverses the module\'s supply.'

function design(): DesignView {
  // an open question about the I2C pins: not agreed until it is answered (test-esp32 #106)
  const pins = (DESIGN.pins ?? []).map((p) => ({ ...p, part: 'U1', ...(/^I2C1_/.test(p.fn) ? { status: 'asked' as const, question: 'q-pins', note: `Open question: ${PIN_QUESTION}` } : {}) }))
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
    case: {
      run: '5e6f7a8b9c0d1e2f', at, status: 'fail', summary: '2 clashes (C1 with lid 3.10 mm³; J2 with lid 1.42 mm³); 1 gap under its clearance (J1 in its opening 0.20 mm, needs 0.50 mm)',
      board: 'hardware/soil-sensor.kicad_pcb', process: 'MJF PA12-HP at jlc3dp', size: '58.4 × 38.4 × 19.6 mm',
      findings: [
        { id: 'layout.fit@urn:trace:trace:acme%2Fsoil-sensor:case-finding:clash%2FC1%2Flid', kind: 'clash', severity: 'blocks', text: 'C1 clashes with the lid (3.1 mm³)', where: 'C1', x_mm: 28, y_mm: 14.1, source: { kind: 'run', id: '5e6f7a8b9c0d1e2f', label: 'case build 5e6f7a8b' } },
        { id: 'layout.fit@urn:trace:trace:acme%2Fsoil-sensor:case-finding:clash%2FJ2%2Flid', kind: 'clash', severity: 'waived', text: 'J2 clashes with the lid (1.42 mm³)', where: 'J2', x_mm: 40, y_mm: 8, source: { kind: 'run', id: '5e6f7a8b9c0d1e2f', label: 'case build 5e6f7a8b' } },
        { id: 'layout.fit@urn:trace:trace:acme%2Fsoil-sensor:case-finding:gap%2FJ1%2Faround', kind: 'gap', severity: 'blocks', text: 'J1 in its opening: 0.2 mm, needs 0.5 mm', where: 'J1', x_mm: 13, y_mm: 14.4, source: { kind: 'run', id: '5e6f7a8b9c0d1e2f', label: 'case build 5e6f7a8b' } },
        { id: 'layout.fit@urn:trace:trace:acme%2Fsoil-sensor:case-rule:lid_top', kind: 'rule', severity: 'blocks', text: 'Outside the process\'s rules: the lid\'s top as built is 1.4 mm, under MJF\'s 2 mm for a 58 mm part', source: { kind: 'run', id: '5e6f7a8b9c0d1e2f', label: 'case build 5e6f7a8b' } },
      ],
      stale: ['J1 at the board\'s edge moved or changed since the build'],
    },
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

/**
 * Requirements review on the soil sensor, as skill.submit answers it (src/api/actions-skills.ts), so its outcomes can
 * be seen (test-esp32 #89): the bar from the draft; R-017 waits on an open question, so the bar lets it through
 * undecided, and a review submitted without it is recorded with the baseline gate's criteria still not met (partly
 * refused). Accepting R-017 is refused the first time: the Verification agent has just added R-022, a duplicate of
 * it, so the record's check of conflicts is not met when Submit checks it again; striking one of the two clears it.
 */
type ReviewDraft = { decisions?: { requirement: string; choice: string; reason?: string }[]; uncovered?: { statement: string }[]; no_conflicts?: boolean }
const review = { duplicate: false }
const REVIEW_CHECKS: Record<string, string> = { criterion: 'One testable criterion each', conflicts: 'No conflicts or duplicates', sources: 'Every requirement cites its source', covered: 'Every intent statement covered', struck: 'Struck requirements keep their reason' }
const choiceOf = (d: ReviewDraft, id: string): string | undefined => d.decisions?.find((x) => x.requirement === id)?.choice
function reviewChecks(d: ReviewDraft = {}): SkillView['checks'] {
  const undecided = ['R-019', ...(review.duplicate ? ['R-022'] : [])].filter((id) => !choiceOf(d, id))
  const duplicate = review.duplicate && choiceOf(d, 'R-017') !== 'strike' && choiceOf(d, 'R-022') !== 'strike'
  const struck = (d.decisions ?? []).filter((x) => x.choice === 'strike')
  return [
    undecided.length ? { id: 'criterion', status: 'not_met', detail: `${undecided.length} requirement${undecided.length > 1 ? 's' : ''} neither accepted nor under an open question: ${undecided.join(', ')}.` } : { id: 'criterion', status: 'met' },
    duplicate ? { id: 'conflicts', status: 'not_met', detail: 'Duplicates: R-017 and R-022.' }
      : d.no_conflicts ? { id: 'conflicts', status: 'met', detail: 'No duplicates, no conflicting intent, and you confirmed no two requirements contradict each other.', by_draft: 'no_conflicts' }
      : { id: 'conflicts', status: 'not_met', detail: 'No duplicates and no conflicting intent were found. Confirm in Resolve conflicts that no two requirements contradict each other: no tool compares their numbers.', by_draft: 'no_conflicts' },
    { id: 'sources', status: 'met' },
    d.uncovered?.some((x) => x.statement === 'I-6') ? { id: 'covered', status: 'met' } : { id: 'covered', status: 'not_met', detail: '1 intent statement no requirement covers, and not left out with a reason: I-6.' },
    { id: 'struck', status: 'met', detail: struck.length ? undefined : 'No requirement is struck.' },
  ]
}
function submitReview(d: ReviewDraft): Response {
  // the Verification agent's duplicate lands while the person reviews: Submit checks the record again and finds it
  if (choiceOf(d, 'R-017') === 'accept' && !review.duplicate) review.duplicate = true
  const missing = (reviewChecks(d) ?? []).filter((c) => c.status === 'not_met')
  if (missing.length) return fail(`Requirements review cannot be submitted yet. Not met: ${missing.map((c) => `${REVIEW_CHECKS[c.id]}${c.detail ? ` (${c.detail})` : ''}`).join('; ')}.`)
  const n = (choice: string) => (d.decisions ?? []).filter((x) => x.choice === choice).length
  const recorded = [n('accept') ? `${n('accept')} requirement${n('accept') > 1 ? 's' : ''} accepted` : '', n('strike') ? `${n('strike')} requirement${n('strike') > 1 ? 's' : ''} struck` : '', d.uncovered?.length ? `${d.uncovered.length} intent line${d.uncovered.length > 1 ? 's' : ''} left out` : ''].filter(Boolean).join(', ')
  const waits = !choiceOf(d, 'R-017')
  const why = 'R-017 waits on an open question: answer it, then accept or strike it here.'
  const criteria = [
    { id: 'define.accepted', text: 'Every requirement is accepted or struck.', ...(waits ? { status: 'not_met', why, step: 'decide' } : { status: 'met' }) },
    { id: 'define.measurable', text: 'Every requirement has a criterion that can be measured, with a number and a unit.', ...(waits ? { status: 'not_met', why: 'It is checked once every requirement is accepted or struck.', step: 'decide' } : { status: 'met' }) },
    { id: 'define.firmware', text: 'The firmware requirements are accepted with the rest.', ...(waits ? { status: 'not_met', why, step: 'decide' } : { status: 'met' }) },
  ]
  return ok({ ok: true, repo: SOIL, skill: 'requirements-review', id: `rec_${Math.random().toString(16).slice(2, 6)}`, started: [], ...(recorded ? { recorded } : {}), criteria, ...(waits ? { draft_kept: true } : {}) })
}

/**
 * The key parts of each option with their newest parts check, for Accept the key parts (test-esp32 #38, #96): option B's
 * STM32WL is short at LCSC for the 10 boards and excepted by Priya; A's are all in stock, one unchecked.
 */
const check = (run: string, order_code: string | null, need: number, status: string, stock: number | null, unit_price: number | null, note: string) =>
  ({ run, at, boards: 10, order_code, need, status, flags: status === 'low' ? ['low-stock'] : status === 'short' ? ['short'] : [], stock, unit_price, currency: 'USD', note })
const KEY_PARTS: Record<string, NonNullable<SkillView['key_parts']>['parts']> = {
  A: [
    { block: 'b-power', block_name: 'Power', mpn: 'TLV75533PDBVR', role: '3.3 V regulator', off_board: false, check: check('3c19aa01', 'C2848334', 10, 'ok', 48210, 0.118, '48210 in stock, 10 needed'), standing: 'ok', why: null, exception: null },
    { block: 'b-mcu', block_name: 'MCU', mpn: 'STM32L072CZT6', role: null, off_board: false, check: check('3c19aa01', 'C93986', 10, 'ok', 1830, 4.62, '1830 in stock, 10 needed'), standing: 'ok', why: null, exception: null },
    { block: 'b-radio', block_name: 'Radio', mpn: 'SX1262IMLTRT', role: 'LoRa radio', off_board: false, check: null, standing: 'unchecked', why: 'Not checked for stock yet: trace runs the parts check at the build quantity.', exception: null },
  ],
  B: [
    { block: 'b-power', block_name: 'Power', mpn: 'TLV75533PDBVR', role: '3.3 V regulator', off_board: false, check: check('3c19aa01', 'C2848334', 10, 'ok', 48210, 0.118, '48210 in stock, 10 needed'), standing: 'ok', why: null, exception: null },
    { block: 'b-mcu', block_name: 'MCU and radio', mpn: 'STM32WLE5JCI6', role: 'microcontroller with LoRa radio', off_board: false, check: check('3c19aa01', 'C2652063', 10, 'short', 6, 5.87, '6 in stock, 10 needed: 4 short'), standing: 'problem', why: 'Short: 10 needed, 6 in stock.', exception: { reason: 'Four come from the last build\'s spares; the rest from LCSC.', by: 'Priya', scope: 'part' } },
    { block: 'b-usb', block_name: 'USB-C and charger', mpn: 'MCP73831T-2ACI/OT', role: 'charger', off_board: false, check: check('3c19aa01', 'C424093', 10, 'low', 14, 0.452, '14 in stock covers 10, with under 2× to spare'), standing: 'ok', why: null, exception: null },
  ],
}

const SKILLS: Record<string, (draft?: ReviewDraft) => Partial<SkillView>> = {
  'architecture-choice': () => {
    const a = architecture()
    return {
      summary: 'Two options are proposed. trace recommends **option B** (STM32WL): it wins on cost and power, and loses on part availability.',
      architecture: { ...a, options: OPTIONS, current: a.id ?? null },
      recommendation: { question: 'Which architecture goes forward?', recommended: 'B', options: OPTIONS.map((o) => ({ id: o.id, label: `Option ${o.id}: ${o.name}`, detail: `${o.summary} Weighted score ${o.total}.` })), why: OPTIONS[1]!.why!, givesUp: OPTIONS[1]!.gives_up!, reasonNeeded: { A: 'Option B scores higher (23 against 19)' } },
      key_parts: { option: a.id ?? 'B', quantity: 10, parts: KEY_PARTS[a.id ?? 'B'] ?? [] },
      checks: [
        { id: 'two', status: 'met', detail: '2 options compared.' }, fixed ? { id: 'fixed', status: 'met' } : { id: 'fixed', status: 'not_met', detail: 'Fix the criteria and their weights first, before reading any score.' },
        chosen ? { id: 'scored', status: 'met' } : { id: 'scored', status: 'not_met', detail: 'Choose an option and name the criteria that decided it.' },
        { id: 'mapped', status: 'not_met', detail: '1 requirement served by no block of option B: R-003.' }, { id: 'stock', status: 'met', detail: 'From the architect.stock shape over the project\'s records, 1 finding waived.' },
      ],
    }
  },
  'requirements-review': (d) => {
    const rq = (id: string, title: string, detail: string, criterion: string | null = null, was?: SkillItem['was']) => ({ id: `requirement:${id}`, title: `${id}: ${title}`, detail, status: 'open' as const, criterion, ...(was ? { was } : {}) })
    return {
      summary: 'Three requirements are still proposed (R-017 waits on an open question about its test house; R-011 came back after an answer changed its acceptance limit), and one intent line has no requirement yet.',
      items: [
        rq('R-017', 'Meets CISPR 32 class B radiated emissions', 'From Sold in Australia: CISPR 32 class B. An open question asks which test house measures it.', 'Below the class B limit lines, 30 MHz to 1 GHz'),
        rq('R-019', 'Has a two-line display', 'From the brief.'),
        // an answer that changed a requirement brought it back: its criterion changed, its words did not (test-esp32 #63)
        rq('R-011', 'The 3.3 V rail is rated for at least 600 mA', 'From Runs from one 3.7 V lithium cell. Reopened: an answer changed its acceptance limit.', '3.1-3.6 V at every load, at up to 600 mA', {
          choice: 'accepted', by: 'marc@example.com', at: '2026-11-05T09:40:00.000Z', changes: [{ field: 'criterion', before: '3.3 V ± 3 % at up to 600 mA', after: '3.1-3.6 V at every load, at up to 600 mA' }],
        }),
        ...(review.duplicate ? [rq('R-022', 'Meets CISPR 32 class B radiated emissions', 'Added by the Verification agent from the EMC test plan, after you opened this review.')] : []),
        { id: 'intent:I-6', title: 'Not covered: Fits a 50 × 30 mm board in the IP67 probe housing.', detail: 'No requirement is derived from this intent line: add one, or leave it out with a reason.', status: 'open' },
      ],
      checks: reviewChecks(d),
    }
  },
  'case-design': () => ({
    summary: 'Six case designs could work for this board; trace recommends a **DIN rail enclosure** printed in MJF PA12-HP, because the requirements ask for a rail mount.',
    recommendation: {
      question: 'Which case should trace build?', recommended: 'din-rail/screws/lid/mjf',
      options: [
        { id: 'din-rail/screws/lid/mjf', label: 'DIN rail enclosure, MJF PA12-HP at JLC3DP, board screwed into its mounting holes', detail: "right when it mounts on a rail in a cabinet. MJF PA12-HP at JLC3DP is trace's recommended process (strong and isotropic nylon). the requirements ask for a DIN rail mount (“R-021: Mounts on a 35 mm DIN rail”). Gives up: about 5 mm more height for the rail foot, and it must hang on a rail" },
        { id: 'printed-shell/screws/lid/mjf', label: 'Printed two-part shell, MJF PA12-HP at JLC3DP, board screwed into its mounting holes', detail: "the simplest case: two printed parts, the board screwed or clamped inside. MJF PA12-HP at JLC3DP is trace's recommended process (strong and isotropic nylon). Gives up: nothing to mount it by: it sits on a shelf or is fixed by its own screws" },
        { id: 'din-rail/screws/lid/cnc', label: 'DIN rail enclosure, CNC aluminium 6061 at JLCCNC, board screwed into its mounting holes', detail: 'right when it mounts on a rail in a cabinet. the requirements ask for a DIN rail mount. Gives up: about 5 mm more height for the rail foot, and it must hang on a rail; machined aluminium costs several times a printed case' },
      ],
      why: "right when it mounts on a rail in a cabinet; MJF PA12-HP at JLC3DP is trace's recommended process; the requirements ask for a DIN rail mount (“R-021: Mounts on a 35 mm DIN rail”)",
      givesUp: 'about 5 mm more height for the rail foot, and it must hang on a rail',
      evidence: [{ kind: 'run', id: '3c4d5e6f7a8b9c0d', label: 'the case options' }],
    },
    items: [
      { id: 'not-offered:extruded-box/mjf', title: 'Extruded box with end plates, MJF PA12-HP at JLC3DP', detail: "J2 sticks out past the board's long edge, so the board cannot slide into the tube", status: 'waived', label: 'Not offered' },
      { id: 'not-offered:extruded-box/cnc', title: 'Extruded box with end plates, CNC aluminium 6061 at JLCCNC', detail: "J2 sticks out past the board's long edge, so the board cannot slide into the tube", status: 'waived', label: 'Not offered' },
    ],
    checks: [{ id: 'process', status: 'met', detail: 'MJF PA12-HP at jlc3dp, within its build size.' }, { id: 'clearances', status: 'met' }, { id: 'fit', status: 'not_met', detail: 'No case build is recorded yet: run mech.build.' }, { id: 'rules', status: 'not_met', detail: 'No case build is recorded yet: run mech.build.' }],
  }),
  'pin-plan-review': () => ({
    summary: 'The pin plan matches the schematic except one conflict: USART2 is planned for both the debug console and the GPS.',
    pending_errors: [`Answer the open question first: the Firmware specialist asks "${PIN_QUESTION}" Its answer may change what Pin plan review agrees.`],
    items: [{ id: 'question:q-pins', title: `Open question about U1: ${PIN_QUESTION}`, detail: 'the Firmware specialist asks. Answer it before agreeing the plan; it holds back the I2C rows of the pin plan (capture.pins).', status: 'open', label: 'Unanswered', question: 'q-pins' }, { id: 'finding:peripheral:U1:USART2:claimed_twice', title: "U1's USART2 is claimed by 2 uses: debug console, gps.", detail: 'Fix it in the plan or the schematic, or waive it.', status: 'open' }],
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
        return ok({ skill: a.skill, ...v(draft as ReviewDraft | undefined), ...(draft ? { draft, step, saved } : {}) })
      })() as unknown as Response
    }
    case 'skill.submit':
      return a.skill === 'requirements-review' ? (new Promise<Response>((res) => setTimeout(() => res(submitReview((a.draft ?? {}) as ReviewDraft)), 700)) as unknown as Response) : undefined
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
