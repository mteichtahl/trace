/**
 * The design record (src/tools/design): the agents' tools propose intent, architectures, the pin plan and which
 * requirements each sheet serves; people's decisions are laid over them (record.ts); the pin plan is checked against a
 * netlist; tracectl db merge keeps the newer row; kicad.export's drawings are matched to their sheets.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CheckInput, checkSkill } from '../../src/api/skill-checks.js'
import { merge } from '../../src/core/dbmerge.js'
import '../../src/core/journey.js'
import { openProject } from '../../src/core/store.js'
import { type DesignDecision, loadDesignDecisions, recordDesignDecision } from '../../src/tools/design/decisions.js'
import { DesignDb, type PinRow, readDesignRows } from '../../src/tools/design/db.js'
import { architectureView, decidedFields, intentDraft, intentView, interfaceFromWords, linksView, missingFields, ownSignatures, parseNets, pinCheck, pinPlanPrint } from '../../src/tools/design/record.js'
import { drawingArtifacts, sheetOfSvg, sheetPlaces, svgSizeMm } from '../../src/tools/kicad/export.js'
import { VerifyDb } from '../../src/tools/verify/db.js'
import { allTools } from '../../src/tools/index.js'

type Dict = Record<string, unknown>
const reg = allTools()
const call = async (name: string, args: Dict): Promise<Dict> => (await reg.call(name, args, { hardware: false, via: 'test' })) as Dict
const by = { label: 'priya@example.com', hash: 'h-priya' }

// No project in scope: the tools read people's decisions only when the session names its project (TRACE_PROJECT, or
// GITHUB_REPOSITORY on a runner, with TRACE_HOME), so these tests clear what a CI runner sets and see every row as proposed.
beforeEach(() => {
  for (const k of ['TRACE_PROJECT', 'TRACE_MEMORY_REPOSITORY', 'GITHUB_REPOSITORY', 'TRACE_PROJECT_HOME']) vi.stubEnv(k, '')
})
afterEach(() => { vi.unstubAllEnvs() })

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'trace-design-'))
  mkdirSync(join(dir, '.git'))
  return dir
}

describe('design.intent', () => {
  it('proposes statements, links requirements to them, and lists them as proposed', async () => {
    const v = new VerifyDb()
    v.addRequirement({ id: 'REQ-D1', text: 'Range of 2 km line of sight', kind: 'functional', acceptance: 'at least 2 km at 1% packet loss' })
    v.close()
    const add = await call('design.intent', {
      action: 'add', statements: [
        { id: 'INT-purpose', topic: 'purpose', text: 'Reports soil moisture to a LoRa gateway.', source: { kind: 'person', ref: 'Priya' } },
        { id: 'INT-range', topic: 'performance', text: 'Reaches the gateway 2 km away, line of sight.', source: { kind: 'brief', quote: 'two kilometres to the shed' } },
        { id: 'INT-sleep', topic: 'power', text: 'Low power sleep.' },
      ],
    })
    expect(add.added).toEqual(['INT-purpose', 'INT-range', 'INT-sleep'])
    expect(await call('design.intent', { action: 'link', requirement: 'REQ-D1', intent: ['INT-range'] })).toEqual({ requirement: 'REQ-D1', derived_from: ['INT-range'] })
    await expect(call('design.intent', { action: 'link', requirement: 'REQ-nope', intent: ['INT-range'] })).rejects.toThrow(/no requirement REQ-nope/)
    const list = await call('design.intent', { action: 'list' }) as { statements: { id: string; state: string; flags: string[] }[]; links: unknown[]; note?: string }
    expect(list.statements.map((s) => [s.id, s.state])).toEqual([['INT-purpose', 'proposed'], ['INT-range', 'proposed'], ['INT-sleep', 'proposed']])
    // a power statement with no number, and a vague word
    expect(list.statements.find((s) => s.id === 'INT-sleep')?.flags).toEqual(['needs_number', 'vague'])
    expect(list.links).toEqual([{ requirement: 'REQ-D1', intent: 'INT-range' }])
    expect(list.note).toMatch(/cannot read/)
    // an unknown names the stage it is decided by
    await expect(call('design.intent', { action: 'add', statements: [{ topic: 'compliance', kind: 'unknown', text: 'Which standard.' }] })).rejects.toThrow(/decide_by/)
    const w = await call('design.intent', { action: 'withdraw', id: 'INT-sleep' }) as { statement: { status: string } }
    expect(w.statement.status).toBe('withdrawn')
  })
})

describe('people\'s decisions over the proposals', () => {
  const dir = freshDb()
  const db = openProject(dir)
  const d = new DesignDb(dir)
  d.addIntent([
    { id: 'I-a', topic: 'physical', text: 'Fits a 50 × 30 mm board.', limits: [{ name: 'board_width', max: 50, unit: 'mm' }, { name: 'board_height', max: 30, unit: 'mm' }] },
    { id: 'I-b', topic: 'power', text: 'Runs two years on one cell.', conflicts: ['I-c'] },
    { id: 'I-c', topic: 'power', text: 'Reads every 10 seconds.' },
    { id: 'I-q', topic: 'build', kind: 'question', text: 'How many boards in the first run?' },
    { id: 'I-i', topic: 'interfaces', text: 'USB-C for charging.', interface: { type: 'USB device', connector: 'USB-C' } },
  ])

  it('accepted words stand until an agent changes them; an edit replaces them; a reject leaves the trace view', () => {
    const decisions: DesignDecision[] = []
    decisions.push(recordDesignDecision(db, { kind: 'intent', target: 'I-a', choice: 'accepted', detail: { text: 'Fits a 50 × 30 mm board.' } }, by))
    decisions.push(recordDesignDecision(db, { kind: 'intent', target: 'I-c', choice: 'edited', detail: { text: 'Reads every 10 seconds.', edited: 'Reads every 15 minutes.' } }, by))
    let v = intentView(d.rows(), loadDesignDecisions(db))
    expect(v.find((x) => x.id === 'I-a')).toMatchObject({ state: 'accepted', decided: { by: by.label } })
    expect(v.find((x) => x.id === 'I-c')).toMatchObject({ state: 'edited', words: 'Reads every 15 minutes.' })
    // the conflict resolved: one side gave way (reworded)
    expect(v.find((x) => x.id === 'I-b')?.flags).not.toContain('conflict')
    expect(v.find((x) => x.id === 'I-q')?.flags).toEqual(['no_owner'])
    expect(v.find((x) => x.id === 'I-i')?.flags).toContain('interface_incomplete')
    d.updateIntent('I-a', { text: 'Fits a 60 × 30 mm board.' })
    v = intentView(d.rows(), loadDesignDecisions(db))
    expect(v.find((x) => x.id === 'I-a')).toMatchObject({ state: 'proposed', changed_since: true })
    recordDesignDecision(db, { kind: 'intent', target: 'I-b', choice: 'rejected', detail: { text: 'x', reason: 'Two years is not needed.' } }, by)
    v = intentView(d.rows(), loadDesignDecisions(db))
    expect(v.find((x) => x.id === 'I-b')?.state).toBe('rejected')
    // the newest decision on a target stands; the one before is kept, superseded
    recordDesignDecision(db, { kind: 'intent', target: 'I-b', choice: 'accepted', detail: { text: 'Runs two years on one cell.' } }, by)
    expect(loadDesignDecisions(db).filter((x) => x.target === 'I-b').map((x) => [x.choice, x.supersededAt === null])).toEqual([['rejected', false], ['accepted', true]])
    const draft = intentDraft(intentView(d.rows(), loadDesignDecisions(db)))
    expect(draft.answered).toEqual(['power', 'interfaces', 'physical'])
    expect(draft.questions).toEqual([{ id: 'I-q', text: 'How many boards in the first run?', owner: 'no owner yet' }])
  })

  it('a conflict accepted on both sides as worded stays open; a reason on one side resolves it', () => {
    const rows = d.rows()
    const both: DesignDecision[] = [
      { id: '1', kind: 'intent', target: 'I-b', choice: 'accepted', detail: { text: 'Runs two years on one cell.' }, by: 'p', byHash: 'h', at: 1, supersededAt: null },
      { id: '2', kind: 'intent', target: 'I-c', choice: 'accepted', detail: { text: 'Reads every 10 seconds.' }, by: 'p', byHash: 'h', at: 1, supersededAt: null },
    ]
    expect(intentView(rows, both).find((x) => x.id === 'I-b')?.flags).toContain('conflict')
    const reasoned = [both[0]!, { ...both[1]!, detail: { text: 'Reads every 10 seconds.', reason: 'Only for the first hour after install.' } }]
    expect(intentView(rows, reasoned).find((x) => x.id === 'I-b')?.flags).not.toContain('conflict')
  })

  it('a gate a person signed after an agent last wrote the words accepts them (test-esp32 #209)', () => {
    const rows = d.rows()
    const a = rows.intent.find((x) => x.id === 'I-a')!
    const accepted: DesignDecision[] = [{ id: '1', kind: 'intent', target: 'I-a', choice: 'accepted', detail: { text: 'Fits a 40 × 30 mm board.' }, by: 'p', byHash: 'h', at: a.updated - 100, supersededAt: null }]
    // accepted, then an agent changed the words (the budget raised through a change): proposed again
    expect(intentView(rows, accepted).find((x) => x.id === 'I-a')).toMatchObject({ state: 'proposed', changed_since: true })
    // a signature from before the change accepts nothing
    expect(intentView(rows, accepted, [{ gate: 'Define', by: 'marc', at: a.updated - 10 }]).find((x) => x.id === 'I-a')?.state).toBe('proposed')
    // the first gate signed over the new words accepts them, and says which
    const signed = intentView(rows, accepted, [{ gate: 'Layout', by: 'marc', at: a.updated + 200 }, { gate: 'Define', by: 'marc', at: a.updated + 100 }])
    expect(signed.find((x) => x.id === 'I-a')).toMatchObject({ state: 'accepted', changed_since: false, decided: { by: 'marc', gate: 'Define', at: new Date((a.updated + 100) * 1000).toISOString() } })
    // a line an agent added that no person decided on (the setup access point): accepted by the gate signed after it
    expect(intentView(rows, [], [{ gate: 'Layout', by: 'marc', at: Math.max(...rows.intent.map((x) => x.updated)) + 1 }]).filter((x) => x.kind === 'statement').every((x) => x.state === 'accepted')).toBe(true)
    // a person's rejection stands over any signature
    const rejected: DesignDecision[] = [{ ...accepted[0]!, choice: 'rejected', at: a.updated + 1 }]
    expect(intentView(rows, rejected, [{ gate: 'Layout', by: 'marc', at: a.updated + 200 }]).find((x) => x.id === 'I-a')?.state).toBe('rejected')
  })

  it('a signature carried into a new revision is not a person signing (ownSignatures)', () => {
    const r = {
      gates: [{ id: 'define.gate', name: 'Requirements baseline' }],
      signatures: [
        { gate: 'define.gate', by: 'marc', at: 10, notes: null },
        { gate: 'define.gate', by: 'marc', at: 20, notes: 'Carried from revision A: the change starts at Layout.' },
      ],
    }
    expect(ownSignatures(r)).toEqual([{ gate: 'Requirements baseline', by: 'marc', at: 10 }])
    expect(ownSignatures(null)).toEqual([])
  })
})

describe('an interface statement\'s fields follow the person\'s edit (test-esp32 #20)', () => {
  it('reads the five fields from plain words, and from labelled ones', () => {
    expect(interfaceFromWords('USB-C receptacle, USB 2.0 full speed device, 12 Mbit/s, both directions, for charging and setup.')).toEqual({
      type: 'USB device', connector: 'USB-C receptacle', protocol: 'USB 2.0 full speed', rate: '12 Mbit/s', direction: 'both',
    })
    expect(interfaceFromWords('An I2C bus to the OLED on a 4-pin header at 400 kHz, output only.')).toEqual({ type: 'I2C', connector: '4-pin header', protocol: 'I2C', rate: '400 kHz', direction: 'out' })
    expect(interfaceFromWords('Debug UART: type: UART; connector: Tag-Connect TC2030; protocol: 115200 8N1; rate: 115200 baud; direction: both')).toEqual({
      type: 'UART', connector: 'Tag-Connect TC2030', protocol: '115200 8N1', rate: '115200 baud', direction: 'both',
    })
    // nothing named, nothing taken
    expect(interfaceFromWords('Talks to the gateway.')).toEqual({})
  })

  it('a field as it was stands while the new words still say it; one the words change follows them; one set by hand wins', () => {
    const was = { type: 'power input', connector: 'USB-C receptacle', protocol: 'none', rate: '400 kHz' }
    expect(decidedFields(was, 'USB-C power input at 1 MHz, in only.', undefined)).toEqual({ type: 'power input', connector: 'USB-C receptacle', protocol: 'none', rate: '1 MHz', direction: 'in' })
    expect(decidedFields(was, 'USB-C power input, in only.', { protocol: ' USB PD sink ', rate: '' })).toMatchObject({ protocol: 'USB PD sink', rate: '400 kHz' })
    expect(missingFields({ type: 'I2C', connector: ' ', rate: '400 kHz' })).toEqual(['connector', 'protocol', 'direction'])
  })

  it('the fields stored with an edit stand over the agent\'s, and the draft panel names the ones still empty', () => {
    const dir = freshDb()
    const d = new DesignDb(dir)
    d.addIntent([{ id: 'I-oled', topic: 'interfaces', text: 'OLED display.', interface: { type: 'I2C', connector: '4-pin header' } }])
    const rows = d.rows()
    let draft = intentDraft(intentView(rows, []))
    expect(draft.statements[0]).toMatchObject({ flag: 'Missing protocol, rate, direction', interface: { type: 'I2C', connector: '4-pin header' }, missing: ['protocol', 'rate', 'direction'] })
    const edit: DesignDecision = { id: '1', kind: 'intent', target: 'I-oled', choice: 'edited', detail: { text: 'OLED display.', edited: 'OLED on I2C at 400 kHz, out.', interface: { protocol: 'I2C', rate: '400 kHz', direction: 'out' } }, by: 'p', byHash: 'h', at: 1, supersededAt: null }
    const v = intentView(rows, [edit])
    expect(v[0]).toMatchObject({ interface: { type: 'I2C', connector: '4-pin header', protocol: 'I2C', rate: '400 kHz', direction: 'out' } })
    expect(v[0]?.flags).not.toContain('interface_incomplete')
    draft = intentDraft(v)
    expect(draft.statements[0]).toMatchObject({ state: 'accepted', missing: [] })
    // rejected, the agent's fields are what is left
    expect(intentView(rows, [{ ...edit, choice: 'rejected' }])[0]?.interface).toEqual({ type: 'I2C', connector: '4-pin header' })
    d.close()
  })
})

describe('design.architecture', () => {
  it('records options, criteria, scores, blocks and connections; the view weighs scores and draws the recommendation until a person chooses', async () => {
    const v = new VerifyDb()
    v.addRequirement({ id: 'REQ-A1', text: 'Battery life two years', kind: 'electrical' })
    v.close()
    await call('design.architecture', { action: 'set_option', option: { id: 'A', name: 'Separate radio', summary: 'An STM32L0 with an SX1262 module.', risks: ['Two parts to source'] } })
    await call('design.architecture', { action: 'set_option', option: { id: 'B', name: 'STM32WL', summary: 'One chip with the radio inside.', recommended: true, why: 'Fewer parts, lower sleep current.', gives_up: 'A second source for the radio.' } })
    await call('design.architecture', { action: 'set_criteria', criteria: [{ id: 'cost', name: 'Cost', weight: 2 }, { id: 'risk', name: 'Risk', weight: 1 }] })
    await call('design.architecture', { action: 'set_scores', scores: [
      { option: 'A', criterion: 'cost', score: 3, reason: 'Two chips cost more.' }, { option: 'A', criterion: 'risk', score: 4, reason: 'Well known parts.' },
      { option: 'B', criterion: 'cost', score: 5, reason: 'One chip.' }, { option: 'B', criterion: 'risk', score: 3, reason: 'Newer part.' },
    ] })
    await expect(call('design.architecture', { action: 'set_blocks', id: 'B', blocks: [{ id: 'mcu', name: 'MCU', requirements: ['REQ-nope'] }] })).rejects.toThrow(/no such requirement REQ-nope/)
    const b = await call('design.architecture', { action: 'set_blocks', id: 'B', blocks: [
      { id: 'pwr', name: 'Power', parts: [{ mpn: 'TLV75533PDBVR', key: true }], requirements: ['REQ-A1'] },
      { id: 'mcu', name: 'MCU and radio', parts: [{ mpn: 'STM32WLE5JCI6', key: true }] },
    ] }) as { blocks: unknown[] }
    expect(b.blocks).toHaveLength(2)
    await expect(call('design.architecture', { action: 'set_connections', id: 'B', connections: [{ from: 'pwr', to: 'nope', kind: 'rail', label: '3.3 V' }] })).rejects.toThrow(/no block nope/)
    await call('design.architecture', { action: 'set_connections', id: 'B', connections: [{ from: 'pwr', to: 'mcu', kind: 'rail', label: '3.3 V, 50 mA' }] })
    const list = await call('design.architecture', { action: 'list' }) as unknown as ReturnType<typeof architectureView>
    expect(list.options.map((o) => [o.id, o.total])).toEqual([['A', 10], ['B', 13]])
    expect(list).toMatchObject({ recommended: 'B', current: 'B', chosen: null, fixed: null })
    expect(list.options[1]?.blocks.map((x) => [x.id, x.x, x.y])).toEqual([['mcu', 0, 0.5], ['pwr', 1, 0.5]])
    // one recommendation at a time
    await call('design.architecture', { action: 'set_option', option: { id: 'A', name: 'Separate radio', summary: 'An STM32L0 with an SX1262 module.', recommended: true } })
    const again = await call('design.architecture', { action: 'list' }) as unknown as ReturnType<typeof architectureView>
    expect(again.options.filter((o) => o.recommended).map((o) => o.id)).toEqual(['A'])
  })

  it('a part off the board is kept with its size, and is always a key part (#136)', async () => {
    await call('design.architecture', { action: 'set_option', option: { id: 'A', name: 'Header display', summary: 'An OLED module on a 4-pin header.' } })
    await expect(call('design.architecture', { action: 'set_blocks', id: 'A', blocks: [{ id: 'display', name: 'Display', parts: [{ mpn: 'SSD1306-0.96-I2C', off_board: true, size_mm: [27.3, 27.8] }] }] })).rejects.toThrow()
    const b = await call('design.architecture', { action: 'set_blocks', id: 'A', blocks: [{ id: 'display', name: 'Display', parts: [
      { mpn: '2.54-1*4PFemale', role: 'header', key: true },
      { mpn: 'SSD1306-0.96-I2C', role: '0.96 inch OLED module', off_board: true, size_mm: [27.3, 27.8, 3.7] },
    ] }] }) as { blocks: { parts: unknown[] }[] }
    expect(b.blocks[0]?.parts).toEqual([
      { mpn: '2.54-1*4PFemale', role: 'header', key: true },
      { mpn: 'SSD1306-0.96-I2C', role: '0.96 inch OLED module', off_board: true, size_mm: [27.3, 27.8, 3.7], key: true },
    ])
  })

  it('a person\'s fixed criteria and choice stand over trace\'s', () => {
    const dir = freshDb()
    const db = openProject(dir)
    const d = new DesignDb(dir)
    d.setOption({ id: 'A', name: 'A', summary: 'Option A in a sentence.' })
    d.setOption({ id: 'B', name: 'B', summary: 'Option B in a sentence.', recommended: true })
    d.setCriteria([{ id: 'cost', name: 'Cost' }])
    recordDesignDecision(db, { kind: 'architecture.criteria', target: 'architecture', choice: 'fixed', detail: { criteria: [{ id: 'cost', name: 'Cost', weight: 3 }, { id: 'size', name: 'Size', weight: 1 }] } }, by)
    recordDesignDecision(db, { kind: 'architecture.choice', target: 'architecture', choice: 'chosen', detail: { option: 'A', reason: 'We already stock its parts.', deciding: ['cost'] } }, by)
    const a = architectureView(d.rows(), loadDesignDecisions(db))
    expect(a.criteria.map((c) => [c.id, c.weight])).toEqual([['cost', 3], ['size', 1]])
    expect(a).toMatchObject({ current: 'A', chosen: { option: 'A', against: true, deciding: ['cost'] }, fixed: { by: by.label } })
  })
})

describe('fixed criteria follow the requirements they quote (test-esp32 run 2, #173)', () => {
  const empty = { intent: [], links: [], options: [], scores: [], blocks: [], connections: [], pins: [], sheets: [] }
  const fix = (at: number): DesignDecision => ({ id: 'f', kind: 'architecture.criteria', target: 'architecture', choice: 'fixed', detail: { criteria: [{ id: 'cost', name: 'Cost against 8 USD/board and 100 USD project', weight: 3 }] }, by: 'marc', byHash: 'h', at, supersededAt: null })
  const row = (name: string, updated: number) => ({ id: 'cost', name, weight: 3, description: 'REQ-f3f79d (per board) and REQ-4ce9e8 (the project).', status: 'proposed' as const, updated, by: 'impl' })

  it('reads the criterion as reworded after the fix, keeping its fixed weight', () => {
    const a = architectureView({ ...empty, criteria: [row('Cost against 9 USD/board and 275 USD project', 300)], requirements: [{ id: 'REQ-f3f79d', updated: 250 }, { id: 'REQ-4ce9e8', updated: 250 }] }, [fix(100)])
    expect(a.criteria).toEqual([expect.objectContaining({ id: 'cost', name: 'Cost against 9 USD/board and 275 USD project', weight: 3, was: 'Cost against 8 USD/board and 100 USD project' })])
    expect(a.criteria[0]!.stale).toBeUndefined()
  })

  it('says a criterion may quote old numbers when a requirement it names changed after its words', () => {
    const a = architectureView({ ...empty, criteria: [row('Cost against 8 USD/board and 100 USD project', 50)], requirements: [{ id: 'REQ-f3f79d', updated: 250 }, { id: 'REQ-4ce9e8', updated: 90 }] }, [fix(100)])
    expect(a.criteria[0]).toMatchObject({ name: 'Cost against 8 USD/board and 100 USD project', stale: { requirements: ['REQ-f3f79d'], since: new Date(250_000).toISOString() } })
    expect(a.criteria[0]!.was).toBeUndefined()
    // before any fix, the proposed row's own time counts
    expect(architectureView({ ...empty, criteria: [row('Cost', 300)], requirements: [{ id: 'REQ-f3f79d', updated: 250 }] }, []).criteria[0]!.stale).toBeUndefined()
  })
})

describe('the pin plan', () => {
  const pins = [
    { part: 'U1', pin: '30', name: 'PA9', function: 'USART1_TX', peripheral: 'USART1', use: 'GPS', net: '/GPS_RX', alternates: ['USART1_TX', 'TIM1_CH2', 'GPIO'] },
    { part: 'U1', pin: '31', name: 'PA10', function: 'USART1_RX', peripheral: 'USART1', use: 'debug console', net: '/GPS_TX', alternates: ['USART1_RX', 'GPIO'] },
    { part: 'U1', pin: '34', name: 'PA13', function: 'GPIO_OUT', kind: 'signal' as const, reserved: 'debug' as const, net: '/LED', alternates: ['SWDIO', 'GPIO_OUT'] },
    { part: 'U1', pin: '12', name: 'PB0', function: 'SPI1_SCK', net: '/SCK', alternates: ['ADC_IN8', 'GPIO'] },
    { part: 'U1', pin: '13', name: 'PB1', kind: 'spare' as const },
    { part: 'U1', pin: '14', name: 'PB2' },
  ]

  it('finds a missing net or function, an unsupported function, a peripheral claimed twice and a reserved pin reused', async () => {
    await call('design.pins', { action: 'set', pins })
    const l = await call('design.pins', { action: 'list', part: 'U1' }) as { findings: { id: string; target: string; kind: string; text: string }[] }
    const kinds = l.findings.map((f) => `${f.target}${f.kind}`)
    expect(kinds).toEqual(expect.arrayContaining(['pin:U1.34reserved', 'pin:U1.12unsupported', 'pin:U1.14no_net', 'pin:U1.14no_function', 'peripheral:U1.USART1claimed_twice']))
    expect(l.findings.find((f) => f.kind === 'claimed_twice')?.text).toBe("U1's USART1 is claimed by 2 uses: gps, debug console.")
    expect(l.findings.find((f) => f.kind === 'unsupported')?.text).toBe('U1 pin 12 (PB0) cannot carry SPI1_SCK: the part allows ADC_IN8, GPIO there.')
  })

  it('against the netlist: a pin on another net, a pin the schematic leaves unconnected, one the plan does not name', () => {
    const rows = readDesignRows(openProject())
    const nets = parseNets(['/GPS_RX\tU1.30 U3.4', '/GPS_TX\tU1.33 U3.3', '/LED\tU1.34 D1.1', '/SCK\tU1.12', '/EXTRA\tU1.40 R9.1', 'GND\tU1.1'].join('\n'))
    const f = pinCheck(rows.pins, nets)
    const by = (k: string) => f.filter((x) => x.kind === k).map((x) => x.target)
    expect(by('mismatch')).toEqual([])
    expect(by('not_on_schematic')).toEqual(['pin:U1.31'])
    expect(by('missing_pin').sort()).toEqual(['pin:U1.1', 'pin:U1.33', 'pin:U1.40'].sort())
    const moved = parseNets('/GPS_RX\tU1.31\n/GPS_TX\tU1.30')
    expect(pinCheck(rows.pins.filter((p) => p.pin === '30'), moved).find((x) => x.kind === 'mismatch')?.text).toBe('U1 pin 30 (PA9) should be on /GPS_RX; the schematic has it on /GPS_TX.')
    // the agreement's fingerprint changes with the plan
    const before = pinPlanPrint(rows.pins, 'U1')
    expect(pinPlanPrint(rows.pins.map((p) => (p.pin === '30' ? { ...p, net: '/OTHER' } : p)), 'U1')).not.toBe(before)
  })

  it('a boot strapping pin something else drives needs an external pull (test-esp32 #104)', () => {
    const pin = (o: Partial<PinRow>): PinRow => ({ part: 'U1', pin: '25', name: 'IO0', function: 'BOOT_STRAP', peripheral: null, use: null, net: '/IO0', kind: 'boot', reserved: 'boot', alternates: [], constraints: null, note: null, status: 'proposed', updated: 0, by: null, ...o })
    const io0 = pin({})
    // the e2e board: IO0 on the auto-reset transistor's collector only, EN pulled up by R3
    const bare = parseNets(['/IO0\tQ2.3 U1.25', '/EN\tC5.1 Q1.3 R3.2 U1.3', '+3V3\tR3.1 U1.2', 'GND\tU1.1 C5.2'].join('\n'))
    const f = pinCheck([io0, pin({ pin: '3', name: 'EN', function: 'CHIP_EN', net: '/EN', kind: 'reset', reserved: 'reset' })], bare).filter((x) => x.kind === 'strap_pull')
    expect(f.map((x) => x.target)).toEqual(['pin:U1.25'])
    expect(f[0]?.severity).toBe('fix')
    expect(f[0]?.text).toMatch(/^U1 pin 25 \(IO0\) is a boot strapping pin on IO0 with Q2, and no resistor pulls IO0 to a supply or ground/)
    // a 10 kOhm to +3V3 (run 1's board), or a pull-down to GND, is the pull
    for (const rail of ['+3V3', 'GND']) {
      const pulled = parseNets([`/IO0\tQ2.3 R5.2 U1.25`, `${rail}\tR5.1 U1.2`].join('\n'))
      expect(pinCheck([io0], pulled).filter((x) => x.kind === 'strap_pull')).toEqual([])
    }
    // a resistor in series to another signal is not a pull; a strap left unconnected, or tied to a rail, is not a finding
    expect(pinCheck([io0], parseNets('/IO0\tR5.2 U1.25\n/BTN\tR5.1 SW1.1')).filter((x) => x.kind === 'strap_pull')).toHaveLength(1)
    expect(pinCheck([io0], parseNets('unconnected-(U1-IO0-Pad25)\tU1.25')).filter((x) => x.kind === 'strap_pull')).toEqual([])
    expect(pinCheck([io0], parseNets('+3V3\tU1.25 U1.2')).filter((x) => x.kind === 'strap_pull')).toEqual([])
  })

  it('Pin plan review\'s boot check is not met over a strap with no pull, until it is waived', () => {
    const io0: PinRow = { part: 'U1', pin: '25', name: 'IO0', function: 'BOOT_STRAP', peripheral: null, use: null, net: '/IO0', kind: 'boot', reserved: 'boot', alternates: [], constraints: null, note: null, status: 'proposed', updated: 0, by: null }
    const design = { intent: [], links: [], options: [], criteria: [], scores: [], blocks: [], connections: [], pins: [io0], sheets: [] }
    const input = (nets: string, waived: string[] = []): CheckInput => ({
      r: waived.length ? { waivers: waived.map((target) => ({ targetKind: 'finding', target, closedAt: null })) } as unknown as CheckInput['r'] : null,
      viewer: { admin: false } as CheckInput['viewer'], requirements: [], struck: [], erc: null, drc: null, bom: null, board: null, placement: null,
      instruments: [], orders: [], tests: [], draft: null, gate: null, question: null, design: { rows: design, decisions: [] }, nets: parseNets(nets),
    } as CheckInput)
    const boot = (i: CheckInput) => checkSkill('pin-plan-review', i)?.find((c) => c.id === 'boot')
    expect(boot(input('/IO0\tQ2.3 U1.25'))).toMatchObject({ status: 'not_met', detail: expect.stringContaining('no resistor pulls IO0') })
    expect(boot(input('/IO0\tQ2.3 U1.25', ['pin:U1.25:strap_pull']))).toMatchObject({ status: 'waived' })
    expect(boot(input('/IO0\tQ2.3 R5.2 U1.25\n+3V3\tR5.1'))).toMatchObject({ status: 'met' })
  })
})

describe('design.sheets', () => {
  it('names the requirements a sheet serves, and why one serves none', async () => {
    await expect(call('design.sheets', { action: 'set', sheet: 'hw/conn.kicad_sch', requirements: [] })).rejects.toThrow(/says why/)
    await call('design.sheets', { action: 'set', sheet: 'hw/conn.kicad_sch', requirements: [], reason: 'Connectors and mounting holes only.' })
    await call('design.sheets', { action: 'set', sheet: 'hw/power.kicad_sch', block: 'pwr', requirements: ['REQ-A1'] })
    const l = await call('design.sheets', { action: 'list' }) as { sheets: { sheet: string; requirements: string[] }[] }
    expect(l.sheets.map((s) => [s.sheet, s.requirements])).toEqual([['hw/conn.kicad_sch', []], ['hw/power.kicad_sch', ['REQ-A1']]])
  })
})

describe('tracectl db merge of the design record', () => {
  it('keeps the newer row of each, and a link removed on one branch stays removed if that is newer', () => {
    const mk = (): string => {
      const dir = freshDb()
      const v = new VerifyDb(dir)
      v.addRequirement({ id: 'REQ-M', text: 'Something measurable', kind: 'functional' })
      v.close()
      return dir
    }
    const base = mk()
    const d = new DesignDb(base)
    d.addIntent([{ id: 'I-m', topic: 'purpose', text: 'Base words.' }])
    d.link('REQ-M', ['I-m'])
    d.close()
    const path = (dir: string): string => join(dir, '.trace', 'project.db')
    const ours = freshDb()
    const theirs = freshDb()
    // copy base into both sides
    for (const t of [ours, theirs]) {
      mkdirSync(join(t, '.trace'), { recursive: true })
      const src = new DatabaseSync(path(base))
      src.exec(`VACUUM INTO '${path(t)}'`)
      src.close()
    }
    const o = new DesignDb(ours)
    o.updateIntent('I-m', { text: 'Our words.' })
    o.close()
    const th = new DesignDb(theirs)
    th.unlink('REQ-M', 'I-m')
    th.addIntent([{ id: 'I-t', topic: 'power', text: 'Theirs, 3.3 V.' }])
    th.updateIntent('I-m', { text: 'Their later words.' })
    th.close()
    expect(merge(path(base), path(ours), path(theirs))).toEqual([])
    const m = new DesignDb(ours)
    const rows = m.rows()
    expect(rows.intent.map((x) => [x.id, x.text])).toEqual([['I-m', 'Their later words.'], ['I-t', 'Theirs, 3.3 V.']])
    expect(linksView(rows)).toEqual([])
    m.close()
  })
})

describe('kicad.export drawings', () => {
  it('matches each SVG kicad-cli wrote to its sheet, keeps the board drawing and render, and reads the page size', () => {
    const out = mkdtempSync(join(tmpdir(), 'trace-export-'))
    mkdirSync(join(out, 'schematic-svg'))
    const page = (w: number, h: number): string => `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}"></svg>`
    writeFileSync(join(out, 'schematic-svg', 'demo.svg'), page(297, 210))
    writeFileSync(join(out, 'schematic-svg', 'demo-Power.svg'), page(297, 210))
    writeFileSync(join(out, 'schematic-svg', 'stray.svg'), page(100, 100))
    writeFileSync(join(out, 'demo-board.svg'), page(50, 30))
    writeFileSync(join(out, 'demo-top.png'), Buffer.from([137, 80, 78, 71]))
    writeFileSync(join(out, 'demo-gerbers.zip'), 'zip')
    const sheets = sheetPlaces({ root: '/repo/hw/demo.kicad_sch', sheets: [{ name: 'Power', file: 'power.kicad_sch', path: '/Power/' }] }, '/repo')
    expect(sheets).toEqual([{ file: 'hw/demo.kicad_sch', path: '/', name: 'demo' }, { file: 'hw/power.kicad_sch', path: '/Power/', name: 'Power' }])
    expect(sheetOfSvg('demo-Power.svg', 'demo', sheets)?.file).toBe('hw/power.kicad_sch')
    expect(svgSizeMm(page(297, 210))).toEqual({ width_mm: 297, height_mm: 210 })
    const d = drawingArtifacts(out, { project: 'demo', sheets })
    expect(d.keep.map((k) => [k.drawing.artifact, k.drawing.kind, k.drawing.file ?? null, k.mime])).toEqual([
      ['sheets/hw/power.kicad_sch.svg', 'sheet', 'hw/power.kicad_sch', 'image/svg+xml'],
      ['sheets/hw/demo.kicad_sch.svg', 'sheet', 'hw/demo.kicad_sch', 'image/svg+xml'],
      ['sheets/stray.svg', 'sheet', null, 'image/svg+xml'],
      ['board/demo-board.svg', 'board', null, 'image/svg+xml'],
      ['board/demo-top.png', 'render', null, 'image/png'],
    ])
    expect(d.keep[3]?.drawing).toMatchObject({ width_mm: 50, height_mm: 30 })
    expect(d.left).toEqual(['stray.svg (not matched to a sheet: kept under its own name)'])
  })
})
