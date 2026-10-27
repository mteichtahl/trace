/**
 * Mock fixtures for Knowledge, the graph, Memory and Agents and tools: the Soil sensor / Motor driver / Panel
 * controller story. Shapes follow the API as it answers today (src/api/actions.ts recordView, src/tools/kb/search.ts
 * Hit, the datasheets.* and parts.* tools) and graph.neighbourhood as lib/graph.ts reads it.
 */
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export interface MockMemory {
  id: string
  strategy: 'facts' | 'preferences' | 'sessions'
  actor: string
  text: string
  created_at: string
  active: boolean
  inactive?: { reason: string; by: string; by_you: boolean; at: string }
}

const mem = (id: string, strategy: MockMemory['strategy'], actor: string, text: string, at: number, inactive?: MockMemory['inactive']): MockMemory => ({
  id, strategy, actor, text, created_at: ago(at), active: !inactive, ...(inactive ? { inactive } : {}),
})

export const MEMORIES: Record<string, MockMemory[]> = {
  'acme/soil-sensor': [
    mem('mem-a1', 'facts', 'ams', 'Output capacitor on the 3.3 V regulator must be at least 2.2 µF (TLV755 datasheet p.12). Below that the regulator can oscillate under load.', 11 * DAY),
    mem('mem-a2', 'facts', 'ams', 'Use 1 µF output capacitor on the LDO.', 13 * DAY, { reason: 'datasheet minimum is 2.2 µF', by: 'h-marc', by_you: true, at: ago(11 * DAY) }),
    mem('mem-a3', 'preferences', 'impl', 'The team prefers 0603 passives unless a part needs more.', 15 * DAY),
    mem('mem-a4', 'sessions', 'impl', 'Routing session: OrthoRoute handled the U4 core; 3 nets fell through to Freerouting and were routed there.', 7 * DAY),
    mem('mem-a5', 'facts', 'emc', 'Antenna must sit on the board edge, away from the battery.', 9 * DAY),
    mem('mem-a6', 'preferences', 'verify', 'Bench supply limited to 100 mA at first power-on.', 12 * DAY),
    mem('mem-a7', 'facts', 'worker', 'Build quantity is 10 per run.', 17 * DAY),
    mem('mem-a8', 'preferences', 'person/h-marc', 'Explain test results in plain words, no acronyms.', 16 * DAY),
    mem('mem-a9', 'facts', 'ams', 'Decided with Priya: keep the regulator at 3.3 V; ceramic output capacitors only, X5R or better. Tantalum adds too much series resistance here.', 13 * DAY),
    mem('mem-a10', 'facts', 'verify', 'TX power 14 dBm is the firmware default; the radio allows up to 22 dBm.', 5 * DAY),
    mem('mem-s1', 'sessions', 'verify', 'Priya asked why R-006 (2 km radio range) is failing. The agent read the radio datasheet and the last range test, found the link 0.6 km short, and suggested raising transmit power to +20 dBm.', 2 * HOUR),
    mem('mem-s2', 'sessions', 'impl', 'Priya\'s push abc123 moved the regulator. The agent re-ran the design rule check, fixed 2 clearance findings and re-routed the VBAT net.', 4 * HOUR),
    mem('mem-s3', 'sessions', 'ams', 'Marc asked whether the LDO quiescent current fits the 2-year battery target. The agent checked the sleep budget and said it fits with 18% margin.', 5 * HOUR),
    mem('mem-s4', 'sessions', 'emc', 'Tom asked whether the antenna keep-out is wide enough. The agent compared the layout against the radio module guide and flagged one ground pour that enters the keep-out.', DAY + 3 * HOUR),
    mem('mem-s5', 'sessions', 'thermal', 'Thermal model of the regulator at a transmit burst: 41 °C peak at 25 °C ambient, well within limits.', 5 * DAY),
    mem('mem-s6', 'sessions', 'render', 'Rendered the top and bottom of Rev A for the schematic gate pack.', 5 * DAY + 2 * HOUR),
  ],
  'acme/motor-driver': [
    mem('mem-m1', 'facts', 'ams', 'Motor stall current is 4.2 A at 12 V (motor datasheet p.3); size the sense resistor for 5 A.', 3 * HOUR),
    mem('mem-m2', 'preferences', 'impl', 'Keep the gate driver within 10 mm of the H-bridge FETs.', 2 * DAY),
    mem('mem-m3', 'sessions', 'ams', 'Drafted three block-diagram options for the motor driver; option B uses the DRV8871.', 6 * HOUR),
  ],
  'acme/panel-controller': [
    mem('mem-p1', 'facts', 'verify', 'The FPGA timing closes at 48 MHz with 0.8 ns slack on the slowest path.', DAY),
    mem('mem-p2', 'sessions', 'verify', 'Checked timing on the FPGA; step 2 of 4 found the UART clock domain crossing needs a synchroniser.', 3 * HOUR),
  ],
}

export interface MockHit {
  text: string
  score: number
  source: string
  kind: string
  path: string | null
  commit: string | null
  citation: string
  datasheet?: { part: string; sha256: string; page: number }
}

const doc = (path: string, text: string, score: number, kind = 'markdown'): MockHit => ({ text, score, source: 'repo', kind, path, commit: 'abc123def4567890', citation: `${path}@abc123def456` })
const sheet = (part: string, page: number, text: string, score: number): MockHit => ({ text, score, source: 'datasheet', kind: 'datasheet', path: null, commit: null, citation: `${part}, sha256 9f2c…, page ${page}`, datasheet: { part, sha256: `9f2c${part.length}e1`, page } })

export const KB: Record<string, MockHit[]> = {
  'acme/soil-sensor': [
    sheet('TLV755', 12, 'For stability the device requires an output capacitor of at least 2.2 µF with an equivalent series resistance below 1 Ω. Ceramic capacitors of X5R or X7R type are recommended.', 0.82),
    doc('docs/power-notes.md', 'Power notes place the output capacitor next to U2 and explain the battery-to-3.3 V path. C7 sits on the 3V3 rail as the LDO output capacitor; keep it within 2 mm of U2 pin 5 so the loop stays stable under radio bursts.', 0.71),
    doc('docs/radio.md', 'The SX1262 radio draws up to 118 mA during a +22 dBm transmit burst. The regulator must hold 3.3 V through the burst; see the power notes for the output capacitor.', 0.52),
    sheet('SX1262', 18, 'Transmit power is set by the PA configuration; at +20 dBm the current is about 90 mA. The antenna must be matched to 50 Ω and placed at the board edge.', 0.49),
    doc('CLAUDE.md', 'Project rules: ceramic capacitors only, 0603 or larger; every requirement links to its test.', 0.31),
    doc('docs/bench.md', 'Bench supply starts at 100 mA current limit for first power-on.', 0.22),
  ],
  'acme/motor-driver': [
    doc('docs/motor.md', 'The motor stalls at 4.2 A from 12 V. The sense resistor must survive a stall for 2 s.', 0.66),
    sheet('DRV8871', 9, 'The output capacitor on VM should be at least 47 µF of bulk capacitance placed close to the device for stability.', 0.48),
  ],
  'acme/panel-controller': [
    doc('docs/fpga-timing.md', 'Timing constraints for the panel controller: 48 MHz system clock; the UART runs in its own clock domain.', 0.4),
  ],
}

export const FILES: Record<string, { path: string; kind: string; size: number; release?: string }[]> = {
  'acme/soil-sensor': [
    { path: 'docs/power-notes.md', kind: 'documents', size: 6_210 },
    { path: 'docs/radio.md', kind: 'documents', size: 4_880 },
    { path: 'docs/bench.md', kind: 'documents', size: 2_120 },
    { path: 'docs/requirements.md', kind: 'documents', size: 11_400 },
    { path: 'CLAUDE.md', kind: 'documents', size: 1_900 },
    { path: 'hardware/soil-sensor.kicad_sch', kind: 'design', size: 412_000 },
    { path: 'hardware/soil-sensor.kicad_pcb', kind: 'design', size: 1_220_000 },
    { path: 'release/rev-a/bom.csv', kind: 'fabrication', size: 3_400, release: 'Rev A' },
  ],
  'acme/motor-driver': [
    { path: 'docs/motor.md', kind: 'documents', size: 3_100 },
    { path: 'docs/architecture-options.md', kind: 'documents', size: 8_800 },
  ],
  'acme/panel-controller': [{ path: 'docs/fpga-timing.md', kind: 'documents', size: 5_000 }],
}

export const DATASHEETS = [
  { mpn: 'TLV755', written: 'TLV75533PDBVR', manufacturer: 'Texas Instruments', title: '500-mA, low-IQ, small-size, low-dropout regulator', status: 'current', current: { sha256: '9f2c6e1', file: 'tlv755.pdf', pages: 38, via: 'lcsc', source_url: 'https://www.ti.com/lit/ds/symlink/tlv755p.pdf', by: 'trace', at: Date.now() / 1000 - 20 * 86400 }, versions: 1, changed: false, aliases: [] },
  { mpn: 'SX1262', written: 'SX1262IMLTRT', manufacturer: 'Semtech', title: 'Long range, low power, sub-GHz RF transceiver', status: 'current', current: { sha256: '77ab012', file: 'sx1262.pdf', pages: 108, via: 'mouser', source_url: null, by: 'trace', at: Date.now() / 1000 - 30 * 86400 }, versions: 2, changed: true, aliases: [] },
  { mpn: 'DRV8871', written: 'DRV8871DDAR', manufacturer: 'Texas Instruments', title: '3.6-A brushed DC motor driver with internal current sense', status: 'current', current: { sha256: 'c0de991', file: 'drv8871.pdf', pages: 28, via: 'lcsc', source_url: null, by: 'trace', at: Date.now() / 1000 - 4 * 86400 }, versions: 1, changed: false, aliases: [] },
  { mpn: 'STM32WLE5JC', written: 'STM32WLE5JCI6', manufacturer: 'STMicroelectronics', title: 'Sub-GHz wireless microcontroller', status: 'current', current: { sha256: 'aa31f00', file: 'stm32wle5.pdf', pages: 146, via: 'digikey', source_url: null, by: 'trace', at: Date.now() / 1000 - 45 * 86400 }, versions: 1, changed: false, aliases: [] },
  { mpn: 'CL10A225KP8NNNC', written: 'CL10A225KP8NNNC', manufacturer: 'Samsung Electro-Mechanics', title: '2.2 µF 10 V X5R 0603 ceramic capacitor', status: 'current', current: { sha256: '5e5e5e5', file: 'cl10a225.pdf', pages: 4, via: 'lcsc', source_url: null, by: 'trace', at: Date.now() / 1000 - 12 * 86400 }, versions: 1, changed: false, aliases: [] },
]

const offer = (mpn: string, manufacturer: string, description: string, stock: number, breaks: [number, number][], lifecycle: string, pkg: string, provider = 'lcsc') => ({
  mpn, manufacturer, provider, seller: provider.toUpperCase(), provider_part: `C${Math.abs(hash(mpn)) % 900000 + 10000}`, stock, moq: breaks[0]?.[0] ?? 1,
  price_breaks: breaks.map(([qty, price]) => ({ qty, price })), lifecycle, package: pkg, url: `https://www.lcsc.com/search?q=${mpn}`, description,
})
function hash(s: string): number {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0
  return h
}

export const OFFERS = [
  offer('TLV75533PDBVR', 'Texas Instruments', '500 mA LDO, 3.3 V, SOT-23-5', 9_870, [[1, 0.21], [10, 0.17], [100, 0.12]], 'active', 'SOT-23-5'),
  offer('TLV75533PDRVR', 'Texas Instruments', '500 mA LDO, 3.3 V, WSON-6', 4_120, [[1, 0.24], [10, 0.19], [100, 0.14]], 'active', 'WSON-6'),
  offer('AP2112K-3.3TRG1', 'Diodes Inc', '600 mA LDO, 3.3 V, SOT-23-5', 140_000, [[1, 0.09], [10, 0.07], [100, 0.05]], 'active', 'SOT-23-5'),
  offer('MCP1700T-3302E/TT', 'Microchip', '250 mA LDO, 3.3 V, SOT-23', 0, [[1, 0.31]], 'nrnd', 'SOT-23'),
  offer('CL10A225KP8NNNC', 'Samsung Electro-Mechanics', '2.2 µF 10 V X5R 0603', 1_200_000, [[50, 0.004], [500, 0.0028]], 'active', '0603'),
  offer('SX1262IMLTRT', 'Semtech', 'Sub-GHz LoRa transceiver, QFN-24', 3_400, [[1, 4.85], [10, 4.1]], 'active', 'QFN-24'),
  offer('DRV8871DDAR', 'Texas Instruments', '3.6 A brushed DC motor driver, HSOP-8', 2_250, [[1, 1.92], [10, 1.6]], 'active', 'HSOP-8'),
]

export const TOOLS = [
  ['kicad.erc', 'Run the electrical rule check on a schematic and list its findings with sheet and position.', 'read'],
  ['kicad.drc', 'Run the design rule check on a board and list its findings with layer and position.', 'read'],
  ['kicad.components', 'List the components of a schematic with their values, footprints and fields.', 'read'],
  ['kicad.netlist', 'The netlist of a schematic: every net and the pins on it.', 'read'],
  ['calc.divider', 'Resistor divider: the output voltage, or the resistors for a target, from the E-series.', 'read'],
  ['calc.ldo_thermal', 'LDO heat: power dissipated and junction temperature for an input, output and load.', 'read'],
  ['calc.trace_width', 'Trace width for a current and temperature rise (IPC-2152).', 'read'],
  ['sim.spice', 'Run a SPICE netlist in ngspice and return the measured values and plots.', 'read'],
  ['sim.montecarlo', 'Monte Carlo: run a netlist many times with parts varied within tolerance.', 'read'],
  ['protocol.uart_timing', 'UART timing: baud error for a clock and divider.', 'read'],
  ['parts.search', 'Keyword search across the configured providers (e.g. "100nF 0402 X7R 16V"), filtered by package, manufacturer or in stock.', 'read'],
  ['parts.lookup', 'Look a part number (or an LCSC code) up at every configured provider, merged: stock, MOQ, price breaks, lifecycle, package, datasheet URL.', 'read'],
  ['parts.bom_check', 'Check a BOM for a build of N boards: per line the best offer, stock, unit price at the quantity bought and flags.', 'read'],
  ['parts.alternatives', 'Candidate alternatives for a part: same package and the same key attributes the providers print.', 'read'],
  ['parts.fetch_datasheet', "Fetch a part's datasheet and add it to the shared datasheet library.", 'write'],
  ['datasheets.list', 'The shared library: parts by MPN, manufacturer or title (substring), with their current sha256 and open changes.', 'read'],
  ['datasheets.find', 'Find text in a datasheet: every page it appears on with a snippet. Cite the page.', 'read'],
  ['datasheets.text', 'The text of datasheet pages (from its text layer), capped per page.', 'read'],
  ['datasheets.params', 'Electrical characteristics: the table rows whose parameter name or symbol matches, with min/typ/max/unit.', 'read'],
  ['verify.coverage', 'Requirements coverage: which requirements have passing, failing or no tests.', 'read'],
  ['fpga.timing', 'Read the FPGA timing report: worst slack per clock and the failing paths.', 'read'],
  ['firmware.size', 'Firmware size: sections against flash and RAM, the largest symbols.', 'read'],
  ['pcb.autoroute', 'Route the board with OrthoRoute on a graphics card, falling back to Freerouting for nets it cannot finish.', 'write'],
  ['pcb.placement_check', 'Check placement against the rules: keep-outs, courtyards, decoupling distance.', 'read'],
  ['pcb.floorplan', 'Plan the floor: block areas and their placement on the board outline.', 'read'],
  ['render.board', 'Render the board in Blender with KiCad\'s 3D models, top or bottom.', 'write'],
  ['render.turntable', 'Render a turntable video of the board.', 'write'],
  ['emc.check', 'EMC review of the layout: return paths, loop areas and edge-coupled traces.', 'read'],
  ['thermal.check', 'Thermal model of the board at a load case: hot spots and part temperatures.', 'read'],
  ['kb.search', 'Search this project\'s knowledge base before asking a person.', 'read'],
  ['kb.status', 'This project\'s knowledge base: its newest ingestion job and how many documents it holds.', 'read'],
  ['kb.sync', 'Sync the default branch into this project\'s knowledge base.', 'write'],
  ['memory.recall', 'Recall what earlier sessions of this agent on this project remembered.', 'read'],
].map(([name, description, needs]) => ({
  name: name!, description: description!, needs: needs as 'read' | 'write',
  input: name === 'parts.search'
    ? { type: 'object', properties: { query: { type: 'string', description: 'keywords, e.g. "100nF 0402 X7R 16V"' }, package: { type: 'string' }, in_stock: { type: 'boolean', default: false }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }, required: ['query'] }
    : name === 'calc.divider'
      ? { type: 'object', properties: { vin: { type: 'number', description: 'input voltage, V' }, vout: { type: 'number', description: 'target output, V' }, series: { type: 'string', enum: ['E12', 'E24', 'E96'], default: 'E24' } }, required: ['vin', 'vout'] }
      : name === 'calc.ldo_thermal'
        ? { type: 'object', properties: { vin: { type: 'number' }, vout: { type: 'number' }, load_a: { type: 'number', description: 'load current, A' }, theta_ja: { type: 'number', description: '°C/W' } }, required: ['vin', 'vout', 'load_a'] }
        : name.startsWith('datasheets.')
          ? { type: 'object', properties: { mpn: { type: 'string' }, query: { type: 'string' } }, required: ['mpn'] }
          : { type: 'object', properties: {} },
}))

export const RUNS: Record<string, { id: string; kind: string; subject: string | null; started: number; finished: number | null; status: string; summary: string | null }[]> = {
  'acme/soil-sensor': [
    { id: 'run_77b0', kind: 'parts.bom_check', subject: 'Rev A', started: Date.now() / 1000 - 9 * 3600, finished: Date.now() / 1000 - 9 * 3600 + 40, status: 'pass', summary: 'All 31 lines in stock for 10 boards' },
    { id: 'run_4a11', kind: 'sim.spice', subject: 'ldo-stability', started: Date.now() / 1000 - 11 * 86400, finished: Date.now() / 1000 - 11 * 86400 + 120, status: 'pass', summary: 'Phase margin 61° with 2.2 µF' },
    { id: 'run_4a10', kind: 'sim.spice', subject: 'ldo-stability', started: Date.now() / 1000 - 11 * 86400 - 600, finished: Date.now() / 1000 - 11 * 86400 - 480, status: 'fail', summary: 'Phase margin 38° with 1 µF' },
    { id: 'run_8f2c', kind: 'kicad.erc', subject: 'soil-sensor', started: Date.now() / 1000 - 2 * 3600, finished: Date.now() / 1000 - 2 * 3600 + 15, status: 'pass', summary: 'Clean, 1 waived' },
    { id: 'run_8e14', kind: 'pcb.placement_check', subject: 'Rev A', started: Date.now() / 1000 - 3600, finished: Date.now() / 1000 - 3600 + 20, status: 'pass', summary: 'No findings' },
    { id: 'run_6d20', kind: 'pcb.autoroute', subject: 'Rev A', started: Date.now() / 1000 - 12 * 60, finished: Date.now() / 1000 - 9 * 60, status: 'pass', summary: '48 nets routed' },
    { id: 'run_6d1f', kind: 'pcb.autoroute', subject: 'Rev A', started: Date.now() / 1000 - 7 * 86400, finished: Date.now() / 1000 - 7 * 86400 + 900, status: 'error', summary: 'Graphics card job timed out' },
  ],
}

// ------------------------------------------------------------------ the graph around R-006

type N = { id: string; kind: string; label: string; title?: string; summary?: string; status?: string; to?: string; facts?: Record<string, string>; repo?: string }
type L = { source: string; target: string; kind: string }

const S = 'acme/soil-sensor'
export const GRAPH_NODES: N[] = [
  { id: 'R-006', kind: 'requirement', label: 'R-006', title: 'Reaches a gateway 2 km away', summary: 'Requirement: the sensor reaches a LoRa gateway 2 km away in open country.', status: 'failing', to: '/p/acme~soil-sensor/requirements/R-006', repo: S },
  { id: 'R-002', kind: 'requirement', label: 'R-002', title: '2 years on 2×AA', summary: 'Requirement: two years on two AA cells at one reading an hour.', status: 'untested', to: '/p/acme~soil-sensor/requirements/R-002', repo: S },
  { id: 'I-3', kind: 'intent', label: '2 km line of sight', title: 'Intent: 2 km line of sight', summary: 'From the intent: "it should reach the farm gateway about 2 km away".', repo: S },
  { id: 'run_8e14', kind: 'run', label: 'Bench range test', title: 'Bench range test', summary: 'Reached 1.4 km against the 2 km requirement on 22 Oct.', status: 'failing', to: '/p/acme~soil-sensor/runs/run_8e14', facts: { 'Run id': 'run_8e14', Agent: 'Verification', Kind: 'Bench session', Date: '22 Oct, 14:10' }, repo: S },
  { id: 'run_c19e', kind: 'run', label: 'run_c19e link budget', title: 'Link budget', summary: 'Link budget calculation: 153 dB margin at +20 dBm.', status: 'verified', to: '/p/acme~soil-sensor/runs/run_c19e', repo: S },
  { id: 'B-radio', kind: 'block', label: 'Radio', title: 'Radio block', summary: 'The LoRa radio and its matching network.', repo: S },
  { id: 'B-antenna', kind: 'block', label: 'Antenna', title: 'Antenna block', summary: 'The antenna and its connector at the board edge.', repo: S },
  { id: 'P-sx1262', kind: 'part', label: 'SX1262', title: 'SX1262 · LoRa transceiver', summary: 'In stock 3,400 · Used by 2 of your projects', to: '/knowledge/library?part=SX1262' },
  { id: 'P-ufl', kind: 'part', label: 'u.FL connector', title: 'u.FL connector', summary: 'U.FL-R-SMT-1 · in stock 52,000', to: '/knowledge/library?part=U.FL-R-SMT-1' },
  { id: 'D-sx1262-18', kind: 'datasheet', label: 'SX1262 p.18', title: 'SX1262 datasheet p.18', summary: 'PA configuration and transmit current at each power level.', to: '/knowledge/library?datasheet=SX1262&page=18' },
  { id: 'W-5', kind: 'decision', label: 'W-5 antenna clearance', title: 'Waiver W-5: antenna clearance', summary: 'Waived 4 mm of antenna clearance for Rev A; caught at the bench range test.', status: 'waived', repo: S },
  { id: 'A-B', kind: 'decision', label: 'Architecture option B', title: 'Architecture option B', summary: 'Chose the SX1262 with an external antenna at the architecture gate.', repo: S },
  { id: 'CR-3', kind: 'decision', label: 'CR-3 Raise TX power', title: 'Change request CR-3 · Raise TX power', summary: 'Raise transmit power to +20 dBm; battery life drops about 6%.', repo: S },
  { id: 'M-tx', kind: 'memory', label: 'TX power 14 dBm default', title: 'Memory · TX power 14 dBm default', summary: 'TX power 14 dBm is the firmware default; the radio allows up to 22 dBm.', status: 'active', to: '/p/acme~soil-sensor/memory?m=mem-a10', repo: S },
  { id: 'M-edge', kind: 'memory', label: 'Antenna must sit on board edge', title: 'Memory · Antenna on the board edge', summary: 'Antenna must sit on the board edge, away from the battery.', status: 'active', to: '/p/acme~soil-sensor/memory?m=mem-a5', repo: S },
  { id: 'doc-rf', kind: 'document', label: 'rf-notes.md', title: 'rf-notes.md', summary: 'Notes on the antenna match and the keep-out.', to: '/knowledge/documents?path=docs/rf-notes.md', repo: S },
  { id: 'PS', kind: 'person', label: 'PS', title: 'Priya Shah', summary: 'Contributor on Soil sensor.' },
]
export const GRAPH_LINKS: L[] = [
  { source: 'R-006', target: 'I-3', kind: 'derived_from' },
  { source: 'R-002', target: 'I-3', kind: 'derived_from' },
  { source: 'run_8e14', target: 'R-006', kind: 'fails' },
  { source: 'run_c19e', target: 'R-006', kind: 'proves' },
  { source: 'B-radio', target: 'R-006', kind: 'serves' },
  { source: 'B-antenna', target: 'R-006', kind: 'serves' },
  { source: 'B-radio', target: 'P-sx1262', kind: 'uses' },
  { source: 'B-antenna', target: 'P-ufl', kind: 'uses' },
  { source: 'M-tx', target: 'D-sx1262-18', kind: 'cites' },
  { source: 'M-tx', target: 'run_8e14', kind: 'learned_from' },
  { source: 'W-5', target: 'R-006', kind: 'waives' },
  { source: 'PS', target: 'W-5', kind: 'decided_in' },
  { source: 'A-B', target: 'B-radio', kind: 'decided_in' },
  { source: 'CR-3', target: 'run_8e14', kind: 'cites' },
  { source: 'doc-rf', target: 'run_8e14', kind: 'related' },
  { source: 'M-edge', target: 'B-antenna', kind: 'related' },
]

/** Depth 3 adds the passives around the radio, enough to show grouping ("+N more parts"). */
export const GRAPH_EXTRA: { nodes: N[]; links: L[] } = (() => {
  const nodes: N[] = []
  const links: L[] = []
  for (let i = 1; i <= 140; i++) {
    const id = `P-c${i}`
    nodes.push({ id, kind: 'part', label: `C${i + 10}`, title: `C${i + 10} · ${i % 3 === 0 ? '100 nF' : i % 3 === 1 ? '10 pF' : '2.2 µF'}`, summary: 'Passive on the radio block.' })
    links.push({ source: 'B-radio', target: id, kind: 'uses' })
  }
  return { nodes, links }
})()
