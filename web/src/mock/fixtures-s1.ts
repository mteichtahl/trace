/**
 * Mock fixtures for the gate, the guided skills, New project and the project tabs (web s1). The Soil sensor story:
 * Rev A at Capture with the schematic gate ready, one waiver (W-3) taken. Names, values, part codes and run ids are
 * illustrative.
 */
import type { PlotData } from '@/components/chat/cards'
import type { Criterion, Waiver } from '@/lib/types'
import type {
  BuildView, CostView, CoverageResult, DecisionEntry, DesignView, GateMore, RunRecordView, SkillView, TraceView,
} from '@/lib/types-s1'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString()
const sec = (ms: number) => (Date.now() - ms) / 1000

// ------------------------------------------------------------------ gates

const W3: Waiver = { id: 'W-3', title: 'Electrical rule check: VBAT pin not driven on U2.', reason: "Driven by the battery through J1, which the check can't see.", risk: 'degraded', caught: 'Bring-up step 3 (unpowered rail check).' }

const crit = (id: string, text: string, label: string, kind: 'run' | 'record', summary: string, opened = false, status: Criterion['status'] = 'met'): Criterion => ({
  id, text, status, opened, evidence: { kind, label, id: kind === 'run' ? label : id, summary },
})

export const SOIL_GATES: Record<string, Partial<GateMore>> = {
  requirements: {
    criteria: [
      crit('rq1', 'Every requirement has one testable criterion', 'run_1a02', 'run', 'Checker: 24 of 24 requirements have a number, a unit and a method.', true),
      crit('rq2', 'Every intent statement is covered', 'record', 'record', 'Intent coverage: 10 of 10 statements map to a requirement.', true),
    ],
    record: { notes: 'Range requirement may be tight; keep an eye on it.', acknowledged: [] },
  },
  architecture: {
    criteria: [
      crit('ar1', 'At least two options compared on fixed criteria', 'record', 'record', 'Options A, B and C scored on 6 criteria, weights fixed before scoring.', true),
      crit('ar2', 'Every requirement maps to a block', 'record', 'record', '24 of 24 requirements map to a block in option B.', true),
      crit('ar3', 'Every key part in stock for 10 boards', 'run_3c19', 'run', 'All 5 key parts in stock at LCSC.', true),
    ],
    record: { acknowledged: [] },
  },
  schematic: {
    recommendation: {
      sign: true,
      summary: '**trace recommends signing.** All 6 criteria are met. One waiver was taken, rated degraded, and is caught on the bench.',
      givesUp: "the waived finding on U2's VBAT pin is only checked at bring-up.",
      evidence: [{ kind: 'run', label: 'run_51c0', summary: 'ERC on push 7f3e21: 0 errors, 1 warning (waived as W-3).' }, { kind: 'file', label: 'Commit 7f3e21' }],
    },
    forecast: '**Next: Prove.** Forecast 2 days of agent time, about US$11 of cloud use.',
    criteria: [
      crit('c1', 'Electrical rule check clean or waived', 'run_51c0', 'run', 'ERC on push 7f3e21: 0 errors, 1 warning, waived as W-3.', true),
      crit('c2', 'No open datasheet conflicts', 'run_4a11', 'run', 'Datasheet limits: 31 parts checked, 0 conflicts open.', true),
      crit('c3', 'Every part in stock for 10 boards', 'run_77b0', 'run', 'All 5 key parts are in stock at LCSC for a run of 10 boards.', false),
      crit('c4', 'Firmware pin plan matches the schematic', 'run_62de', 'run', 'Pin plan: 18 used pins agree between the schematic and the firmware configuration.', false),
      crit('c5', 'Every sheet names its requirements', 'record', 'record', 'Power, MCU, Radio and Sensor each list the requirements they serve.', true),
      crit('c6', 'Every change from the draft has a reason', 'record', 'record', '7 changes from the draft, each with a confirmed reason.', false),
    ],
    waivers: [W3],
  },
  order: {
    spend: { total: 184, currency: 'USD', changed: 'Two prices changed since sign-off (+US$3.10). Both parts are still in stock.' },
  },
}

// ------------------------------------------------------------------ runs (the `run` action, with the assumed extras)

const plot: PlotData = {
  title: 'Battery life against reading interval',
  x: { label: 'Interval', unit: 'min' },
  y: { label: 'Battery life', unit: 'y' },
  series: [
    { name: 'Median', points: [[5, 0.9], [10, 1.6], [15, 2.3], [20, 2.9], [30, 3.8]] },
    { name: 'Low end (Monte Carlo)', points: [[5, 0.75], [10, 1.4], [15, 2.08], [20, 2.6], [30, 3.4]] },
  ],
  limit: { value: 2, label: 'R-011: at least 2 years', kind: 'min' },
  verdict: 'Passes at 15 minutes: the low end is 2.08 years, 4% above the requirement. A 10-minute interval would fail.',
  ok: true,
  runId: 'run_9d4e',
}

export const RUNS: RunRecordView[] = [
  {
    id: 'run_7b02', kind: 'pcb.autoroute', subject: 'soil-sensor.kicad_pcb', started: sec(12 * MIN), finished: null, status: 'running', summary: null,
    title: 'Routing the board', where: 'On a graphics card', jobId: 'job_route', typicalS: 1200,
    steps: [
      { id: 's1', title: 'Plan the routing', state: 'done', detail: 'Found a dense core: U4, 0.5 mm pitch, 48 pads; a graphics card is free, so both routers.', durationS: 40 },
      { id: 's2', title: 'Stage 1: OrthoRoute on 31 core nets', state: 'running', detail: '48 of 62 nets routed', progress: 0.55, durationS: 680 },
      { id: 's3', title: 'Stage 2: Freerouting on the rest', state: 'queued' },
      { id: 's4', title: 'Check locked tracks are unchanged', state: 'queued' },
      { id: 's5', title: 'Design rule check with schematic parity', state: 'queued' },
    ],
    log: [
      { id: 'l1', at: ago(10 * MIN), who: 'Layout specialist', text: "The core around U4 is too tight for the general router alone, so I'm sending its 31 nets to OrthoRoute on a graphics card first, then the remaining nets to Freerouting.", tools: ['Exported the board for the router', 'Locked 18 tracks'] },
      { id: 'l2', at: ago(MIN), who: 'Layout specialist', text: '48 of 62 nets are in. The antenna feed and the USB pair are locked, so the router is working around them.' },
    ],
    artifacts: [{ name: 'route-plan.json', mime: 'application/json', size: 4200 }],
  },
  {
    id: 'run_9d4e', kind: 'sim.montecarlo', subject: 'battery-life', started: sec(2 * DAY), finished: sec(2 * DAY - 9 * MIN), status: 'pass',
    summary: 'Battery life at 15-minute readings: 2.3 years median, 2.08 years at the low end.',
    title: 'Battery-life model and Monte Carlo sweep', requirement: 'R-011',
    steps: [
      { id: 's1', title: 'Build the power model', state: 'done', durationS: 50 },
      { id: 's2', title: 'Sweep the reading interval', state: 'done', durationS: 190 },
      { id: 's3', title: 'Monte Carlo over cell capacity and sleep current', state: 'done', durationS: 300 },
    ],
    plots: [plot],
    measurements: [{ name: 'life_median_y', value: 2.3, unit: 'y' }, { name: 'life_low_y', value: 2.08, unit: 'y' }],
    artifacts: [{ name: 'sweep.csv', mime: 'text/csv', size: 1830 }, { name: 'model.cir', mime: 'text/plain', size: 2210 }],
    log: [{ id: 'l1', at: ago(2 * DAY), who: 'Analog specialist', text: 'Modelled sleep at 4.1 µA and a 120 ms radio burst every reading; swept 5 to 30 minutes with 500 Monte Carlo runs each.', tools: ['Ran sim.montecarlo (500 runs)'] }],
  },
  {
    id: 'run_51c0', kind: 'kicad.erc', subject: 'soil-sensor.kicad_sch', started: sec(2 * HOUR), finished: sec(2 * HOUR - 40_000), status: 'pass',
    summary: 'ERC: 0 errors, 1 warning (waived as W-3).', title: 'Electrical rule check on push 7f3e21', git_sha: '7f3e21',
    findings: [{ id: 'f1', severity: 'waived', text: "U2's VBAT pin shows no driver.", where: 'Power sheet, U2 pin 3' }],
    measurements: [{ name: 'errors', value: 0, unit: null }, { name: 'warnings', value: 1, unit: null }],
    artifacts: [{ name: 'erc-report.json', mime: 'application/json', size: 3800 }],
  },
  {
    id: 'run_4a11', kind: 'datasheets.check', subject: 'soil-sensor', started: sec(2 * HOUR), finished: sec(2 * HOUR - 300_000), status: 'pass',
    summary: 'Datasheet limits: 31 parts checked, 0 conflicts open (1 fixed on push 7f3e21).', title: 'Datasheet limits check',
    findings: [{ id: 'f1', severity: 'waived', text: 'C2 was 1 µF; the regulator asks for at least 2.2 µF. Fixed: now 2.2 µF.', where: 'Power sheet, C2', source: { kind: 'datasheet', label: 'TLV755 datasheet p.12' } }],
  },
  {
    id: 'run_77b0', kind: 'parts.bom_check', subject: 'soil-sensor', started: sec(9 * HOUR), finished: sec(9 * HOUR - 20_000), status: 'pass',
    summary: 'All 5 key parts are in stock at LCSC for a run of 10 boards. Stock was checked against the parts list at push 7f3e21.', title: 'Parts list check',
    table: {
      columns: [{ id: 'ref', label: 'Ref' }, { id: 'mpn', label: 'MPN', mono: true }, { id: 'lcsc', label: 'LCSC', mono: true }, { id: 'stock', label: 'In stock', align: 'right' }, { id: 'needed', label: 'Needed', align: 'right' }],
      rows: [
        { ref: 'C2', mpn: 'CL10A225KP8NNNC', lcsc: 'C23630', stock: '1.2M', needed: 10 },
        { ref: 'D1', mpn: 'SMAJ5.0A', lcsc: 'C113950', stock: '48k', needed: 10 },
        { ref: 'J1', mpn: 'S2B-PH-K-S', lcsc: 'C173752', stock: '21k', needed: 10 },
        { ref: 'U1', mpn: 'STM32WLE5JCI6', lcsc: 'C2846493', stock: '1,140', needed: 10 },
        { ref: 'U2', mpn: 'TLV75533PDBVR', lcsc: 'C2861882', stock: '9,870', needed: 10 },
      ],
      note: 'Prices and stock from LCSC at 09:12 today. Stock can change before the order; trace re-checks at Release.',
    },
  },
  {
    id: 'run_62de', kind: 'firmware.pins', subject: 'soil-sensor', started: sec(DAY), finished: sec(DAY - 30_000), status: 'pass',
    summary: 'Pin plan: 18 used pins agree between the schematic and the firmware configuration; 4 spare pins go to test points.', title: 'Pin plan check',
  },
  {
    id: 'run_6d20', kind: 'pcb.autoroute', subject: 'soil-sensor.kicad_pcb', started: sec(DAY + 4 * HOUR), finished: sec(DAY + 3 * HOUR), status: 'fail',
    summary: "3 nets could not fit between U4's pins. trace suggested moving U4 2 mm left.", title: 'Routing the board (earlier attempt)',
  },
]

export const JOB_ROUTE = { id: 'job_route', kind: 'task', repository: 'acme/soil-sensor', state: 'running', version: 4 }

// ------------------------------------------------------------------ requirements and traceability

const R = (id: string, text: string, kind: string, acceptance: string, verdict: CoverageResult['requirements'][number]['verdict'], tests: string[] = [], status = 'pass') => ({
  id, text, kind, acceptance, status: 'accepted', verdict, source: 'Intent', priority: 'must' as const,
  tests: tests.map((t) => ({ id: t, method: t.startsWith('TST-H') ? 'hil' : 'spice', status: verdict === 'untested' || verdict === 'no_test' ? 'planned' : status, last_run: verdict === 'untested' || verdict === 'no_test' ? null : t === 'TST-011' ? 'run_9d4e' : t === 'TST-H06' ? 'run_6d20' : t === 'TST-014' ? 'run_4a11' : 'run_51c0' })),
})

export const COVERAGE: CoverageResult = {
  summary: { requirements: 8, verified: 3, failing: 1, untested: 3, waived: 1 },
  requirements: [
    R('R-001', 'Measures volumetric soil moisture from 0 to 60%', 'functional', '±3% between 0 and 60% at 25 °C', 'verified', ['TST-001']),
    R('R-003', 'Operates from −10 °C to 60 °C', 'electrical', 'All functions from −10 to 60 °C', 'untested', ['TST-H03']),
    R('R-004', 'Runs from one 3.7 V lithium cell, 2,000 mAh', 'electrical', 'Input 3.0 to 4.2 V', 'verified', ['TST-004']),
    R('R-006', 'Reaches the gateway at 2 km line of sight', 'functional', '≥ 2 km at SF10, 14 dBm, 10 % packet loss', 'failing', ['TST-H06'], 'fail'),
    R('R-008', 'Charges and configures over USB-C', 'functional', 'USB 2.0 full speed; 500 mA charge', 'untested', ['TST-H08']),
    R('R-011', 'Battery life at least 2 years at one reading every 15 minutes', 'electrical', '≥ 2 years at 25 °C', 'verified', ['TST-011']),
    R('R-014', 'Output capacitor at least 2.2 µF on the 3V3 rail', 'electrical', 'C ≥ 2.2 µF after derating', 'waived', ['TST-014']),
    R('R-017', 'Meets CISPR 32 class B radiated emissions', 'emc', 'Below the class B limit with 6 dB margin (estimate)', 'untested'),
  ],
}

export const TRACE: TraceView = {
  intent: [
    { id: 'I-1', topic: 'Purpose', text: 'Measures soil moisture in a farm paddock and reports it to a LoRa gateway.' },
    { id: 'I-2', topic: 'Environment', text: 'Operates from −10 °C to 60 °C, outdoors, buried to 150 mm.' },
    { id: 'I-3', topic: 'Power', text: 'Runs two years from one lithium cell at one reading every 15 minutes.' },
    { id: 'I-4', topic: 'Interfaces', text: 'LoRa radio to the gateway, 2 km line of sight; USB-C for charging and setup.' },
    { id: 'I-5', topic: 'Compliance', text: 'Sold in Australia: CISPR 32 class B.' },
  ],
  links: [
    { requirement: 'R-001', intent: 'I-1' }, { requirement: 'R-003', intent: 'I-2' }, { requirement: 'R-004', intent: 'I-3' }, { requirement: 'R-011', intent: 'I-3' },
    { requirement: 'R-014', intent: 'I-3' }, { requirement: 'R-006', intent: 'I-4' }, { requirement: 'R-008', intent: 'I-4' }, { requirement: 'R-017', intent: 'I-5' },
  ],
}

// ------------------------------------------------------------------ design: drawings as SVG files (files.list / files.url)

const svg = (body: string, w = 800, h = 420) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" font-family="monospace" font-size="12" fill="none" stroke="#444" stroke-width="1.5"><rect width="${w}" height="${h}" fill="#fbfbf9" stroke="none"/>${body}</svg>`)}`
const t = (x: number, y: number, s: string, size = 12) => `<text x="${x}" y="${y}" fill="#333" stroke="none" font-size="${size}">${s}</text>`
const gnd = (x: number, y: number) => `<path d="M${x} ${y}v14M${x - 10} ${y + 14}h20M${x - 6} ${y + 18}h12M${x - 2} ${y + 22}h4"/>`

const POWER_SHEET = svg(
  `${t(56, 108, 'J1', 13)}<rect x="56" y="118" width="50" height="78"/>${t(66, 210, 'BAT · JST-PH 2', 10)}
  <path d="M106 140H700"/>${t(160, 132, 'VBAT')}
  <path d="M106 176h40v80"/>${gnd(146, 256)}
  <path d="M210 140v42"/><path d="M200 182l10 -16 10 16z"/><path d="M210 182v74"/>${gnd(210, 256)}${t(226, 176, 'D1  TVS 5 V', 11)}
  <path d="M330 140v54M318 194h24M318 202h24M330 202v54"/>${gnd(330, 256)}${t(350, 198, 'C1  1 µF', 11)}
  <rect x="440" y="120" width="140" height="100"/>${t(452, 112, 'U2', 13)}${t(476, 170, 'TLV75533')}${t(476, 186, 'LDO 3.3 V', 10)}${t(450, 140, 'VBAT', 10)}${t(540, 140, 'VOUT', 10)}
  <path d="M510 220v36"/>${gnd(510, 256)}
  <path d="M660 140v54M648 194h24M648 202h24M660 202v54"/>${gnd(660, 256)}${t(680, 198, 'C2  2.2 µF', 11)}
  <path d="M700 132h40l10 8-10 8h-40z"/>${t(706, 144, '3V3', 10)}
  ${t(560, 400, 'Power · Sheet 1 of 4 · Rev A', 10)}`,
)
const MCU_SHEET = svg(`<rect x="300" y="90" width="200" height="240"/>${t(310, 82, 'U1', 13)}${t(330, 215, 'STM32WLE5JC')}${[0, 1, 2, 3, 4, 5].map((i) => `<path d="M260 ${120 + i * 35}h40"/><path d="M500 ${120 + i * 35}h40"/>`).join('')}${t(560, 400, 'MCU · Sheet 2 of 4 · Rev A', 10)}`)
const BOARD = svg(
  `<rect x="150" y="60" width="500" height="300" rx="18" fill="#1f5f3a" stroke="#123"/>
  <rect x="360" y="170" width="70" height="70" fill="#111"/>${'<rect x="190" y="180" width="40" height="50" fill="#ddd"/>'}
  <rect x="520" y="90" width="60" height="50" fill="#555"/><rect x="590" y="260" width="30" height="50" fill="#c9a227"/>
  ${[0, 1, 2].map((i) => `<rect x="${330 + i * 40}" y="320" width="26" height="14" fill="#c9a227"/>`).join('')}
  ${[[170, 80], [630, 80], [170, 340], [630, 340]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="7" fill="#c9a227"/>`).join('')}
  <path d="M230 205h130M430 205h90v-65" stroke="#c9a227" stroke-width="3"/>
  <text x="372" y="210" fill="#eee" stroke="none">U1</text><text x="532" y="120" fill="#eee" stroke="none">U2</text><text x="196" y="250" fill="#eee" stroke="none">J1</text>`,
)

export const FILES = [
  { path: 'build/kicad/soil-sensor/sch/power.svg', kind: 'sheet', size: 48_000 },
  { path: 'build/kicad/soil-sensor/sch/mcu.svg', kind: 'sheet', size: 52_000 },
  { path: 'build/kicad/soil-sensor/pcb/top.svg', kind: 'board', size: 210_000 },
  { path: 'release/rev-a/soil-sensor-gerbers.zip', kind: 'fabrication', size: 340_000, release: 'Rev A' },
]
export const FILE_URLS: Record<string, string> = {
  'build/kicad/soil-sensor/sch/power.svg': POWER_SHEET,
  'build/kicad/soil-sensor/sch/mcu.svg': MCU_SHEET,
  'build/kicad/soil-sensor/pcb/top.svg': BOARD,
}

const SCH_FINDINGS = [
  { id: 'F1', severity: 'blocks' as const, text: "C2 is 1 µF; the regulator's datasheet asks for at least 2.2 µF on its output for stability.", at: { x: 0.83, y: 0.42 }, where: 'C2', sheet: 'power', source: { kind: 'datasheet' as const, label: 'TLV755 datasheet p.12' } },
  { id: 'F2', severity: 'fix' as const, text: "U2's VBAT pin shows no driver in the electrical rule check (ERC).", at: { x: 0.56, y: 0.32 }, where: 'U2 pin 3', sheet: 'power' },
]

export const DESIGN: DesignView = {
  architecture: {
    option: 'Option B: STM32WL with integrated radio',
    blocks: [
      { id: 'b-power', name: 'Power', part: 'TLV75533', stock: 'in_stock', serves: ['R-004', 'R-011', 'R-014'], x: 0.06, y: 0.38 },
      { id: 'b-mcu', name: 'MCU and radio', part: 'STM32WLE5JC', stock: 'low', serves: ['R-006', 'R-011'], x: 0.4, y: 0.38 },
      { id: 'b-sensor', name: 'Moisture sensor', part: 'Capacitive probe', stock: 'in_stock', serves: ['R-001', 'R-003'], x: 0.74, y: 0.12 },
      { id: 'b-usb', name: 'USB-C and charger', part: 'MCP73831', stock: 'in_stock', serves: ['R-008'], x: 0.06, y: 0.74 },
      { id: 'b-antenna', name: 'Antenna', part: 'u.FL connector', stock: 'in_stock', serves: ['R-006', 'R-017'], x: 0.74, y: 0.64 },
    ],
    connections: [
      { from: 'b-power', to: 'b-mcu', label: '3V3 rail' },
      { from: 'b-mcu', to: 'b-sensor', label: 'ADC + excite' },
      { from: 'b-mcu', to: 'b-antenna', label: 'RF 915 MHz' },
      { from: 'b-usb', to: 'b-power', label: 'VBAT 4.2 V' },
    ],
  },
  sheets: [
    { id: 'power', name: 'Power', path: 'build/kicad/soil-sensor/sch/power.svg', serves: ['R-004', 'R-014'], findings: SCH_FINDINGS },
    { id: 'mcu', name: 'MCU', path: 'build/kicad/soil-sensor/sch/mcu.svg', serves: ['R-006', 'R-011'], findings: [] },
    { id: 'radio', name: 'Radio', serves: ['R-006'], findings: [{ id: 'F3', severity: 'fix', text: 'Antenna feed has no matching network footprints.', where: 'J2' }] },
    { id: 'sensor', name: 'Sensor', serves: ['R-001'], findings: [] },
  ],
  pins: [
    { pin: 'PA0', net: 'SENSE_EXC', fn: 'TIM2_CH1', status: 'ok' },
    { pin: 'PA1', net: 'SENSE_ADC', fn: 'ADC_IN6', status: 'ok' },
    { pin: 'PA2', net: 'UART_TX', fn: 'USART2_TX', status: 'ok' },
    { pin: 'PA3', net: 'UART_RX', fn: 'USART2_RX', status: 'ok' },
    { pin: 'PA13', net: 'SWDIO', fn: 'SWDIO', status: 'ok' },
    { pin: 'PA14', net: 'SWCLK', fn: 'SWCLK', status: 'ok' },
    { pin: 'PB3', net: 'LED', fn: 'GPIO', alt: 'SWO', status: 'waived', note: 'Debug trace pin used for the LED; waived (W-5).' },
    { pin: 'PB6', net: 'I2C_SCL', fn: 'I2C1_SCL', status: 'ok' },
    { pin: 'PB7', net: 'I2C_SDA', fn: 'I2C1_SDA', status: 'ok' },
    { pin: 'PB8', net: 'TP_SPARE1', fn: 'Spare', status: 'spare' },
  ],
  board: {
    path: 'build/kicad/soil-sensor/pcb/top.svg', size: '50 × 30 mm · 4 layers · ENIG', layers: ['Top copper', 'Inner 1', 'Inner 2', 'Bottom copper', 'Silkscreen'],
    findings: [
      { id: 'B1', severity: 'blocks', text: 'Decoupling C5 is 6.1 mm from U1 pin 12; the rule is 3 mm.', at: { x: 0.56, y: 0.47 }, where: 'C5' },
      { id: 'B2', severity: 'fix', text: 'J1 sits 0.3 mm inside the board edge clearance.', at: { x: 0.26, y: 0.48 }, where: 'J1' },
      { id: 'B3', severity: 'waived', text: 'Silkscreen over pad on TP3.', at: { x: 0.77, y: 0.66 }, where: 'TP3' },
    ],
  },
}

// ------------------------------------------------------------------ build

export const BUILD: BuildView = {
  releases: [{ id: 'rel-a', revision: 'Rev A', at: ago(3 * DAY), commit: 'a41e9d0', files: 14, by: 'Marc Teichtahl', frozen: true }],
  orders: [
    {
      id: 'ord-1', release: 'Rev A', state: 'ready', boards: 10, total: 184, currency: 'USD', budget: 400, changed: 'Two prices changed since sign-off (+US$3.10). Both parts are still in stock.',
      cost: [{ label: 'Boards', amount: 38 }, { label: 'Assembly', amount: 61 }, { label: 'Parts', amount: 71 }, { label: 'Shipping', amount: 14 }],
      options: [
        { option: 'Layers', value: '4' }, { option: 'Thickness', value: '1.6 mm' }, { option: 'Colour', value: 'Green' }, { option: 'Surface finish', value: 'ENIG' },
        { option: 'Outer copper', value: '1 oz' }, { option: 'Impedance control', value: 'Yes (JLC04161H-7628)' }, { option: 'Quantity', value: '10' }, { option: 'Assembly', value: 'Top side' },
      ],
      parts: [
        { ref: 'U1', name: 'Microcontroller', lcsc: 'C2652091', stock: 3140, then: 3.86, now: 3.98 },
        { ref: 'U2', name: 'LoRa radio module', lcsc: 'C2939786', stock: 1208, then: 1.92, now: 2.11 },
        { ref: 'U3', name: 'Low-dropout regulator (LDO)', lcsc: 'C82942', stock: 48920, then: 0.21, now: 0.21 },
        { ref: 'J1', name: 'Battery connector', lcsc: 'C131337', stock: 22605, then: 0.06, now: 0.06 },
        { ref: 'J2', name: 'Antenna connector', lcsc: 'C88374', stock: 9771, then: 0.18, now: 0.18 },
        { ref: 'C1–C14', name: '100 nF capacitors, 0402', lcsc: 'C1525', stock: 9830112, then: 0.002, now: 0.002 },
      ],
      files: ['gerbers.zip', 'bom-jlcpcb.csv', 'cpl-jlcpcb.csv'],
      checkedAt: ago(2 * HOUR),
      wait: { id: 'w-ord', what: 'Waiting for JLCPCB to confirm the order', text: 'Starts once the order is recorded', lastCheckedAt: ago(2 * MIN), nextCheckAt: ahead(13 * MIN) },
      meanwhile: [{ title: 'Bring-up firmware build', state: 'done' }, { title: 'Bring-up plan', state: 'running' }, { title: 'Bench wiring view', state: 'todo' }, { title: 'Test scripts dry-run', state: 'todo' }],
    },
  ],
  boards: [],
  bench: { configured: false, instruments: [{ name: 'Bench supply', kind: 'psu', address: 'TCPIP::192.168.1.40::INSTR', answered: true }, { name: 'Scope', kind: 'scope', address: 'USB::0x1AB1::INSTR', answered: false }], note: 'Bench setup opens once boards arrive.' },
}

// ------------------------------------------------------------------ cost and time

export const COST: CostView = {
  currency: 'USD',
  spent: { cloud: 38, orders: 0 },
  committed: 184,
  forecast: 120,
  budget: 400,
  stages: [
    { stage: 'Define', state: 'done', cloud: 6, days: 3 },
    { stage: 'Architect', state: 'done', cloud: 11, days: 4 },
    { stage: 'Capture', state: 'current', cloud: 21, days: 6, forecastDays: 7 },
    { stage: 'Prove', state: 'queued', cloud: 0, days: 0, forecastDays: 2 },
    { stage: 'Layout', state: 'queued', cloud: 0, days: 0, forecastDays: 3 },
  ],
  lines: [
    { id: 'c1', at: ago(2 * HOUR), what: 'Electrical rule check and datasheet limits', kind: 'cpu', amount: 0.42 },
    { id: 'c2', at: ago(9 * HOUR), what: 'Parts list check', kind: 'agents', amount: 0.18 },
    { id: 'c3', at: ago(DAY), what: 'Schematic drafting (Analog specialist)', kind: 'agents', amount: 7.9 },
    { id: 'c4', at: ago(2 * DAY), what: 'Battery-life Monte Carlo sweep', kind: 'cpu', amount: 1.1 },
    { id: 'c5', at: ago(5 * DAY), what: 'Board render for the architecture gate', kind: 'gpu', amount: 2.4 },
  ],
}

// ------------------------------------------------------------------ decisions

export const DECISIONS: DecisionEntry[] = [
  { id: 'd1', kind: 'gate', title: 'Architecture gate signed', by: 'Marc Teichtahl', at: ago(15 * DAY), state: 'signed', to: '/p/acme~soil-sensor/gates/architecture' },
  { id: 'd2', kind: 'gate', title: 'Requirements gate signed', by: 'Marc Teichtahl', at: ago(19 * DAY), state: 'signed', to: '/p/acme~soil-sensor/gates/requirements' },
  { id: 'd3', kind: 'decision', title: 'Architecture: option B, STM32WL with integrated radio', by: 'Marc Teichtahl', at: ago(15 * DAY), choice: 'Option B', recommended: true },
  { id: 'd4', kind: 'question', title: 'Reading interval for battery life', by: 'Priya Shah', at: ago(10 * DAY), choice: 'Every 15 minutes', recommended: true, state: 'answered' },
  { id: 'd5', kind: 'question', title: 'Sensor supply range', by: 'Marc Teichtahl', at: ago(8 * DAY), choice: '3.0 to 3.6 V', recommended: false, reason: 'The probe we stock is rated to 3.0 V, not 2.7 V.', state: 'answered' },
  { id: 'd6', kind: 'waiver', title: 'W-3: ERC pin-not-driven on U2 VBAT', by: 'Marc Teichtahl', at: ago(5 * HOUR), reason: 'Driven by the battery through J1, which the check cannot see.', state: 'active' },
  { id: 'd7', kind: 'change', title: 'CR-2: move to a 2,000 mAh cell', by: 'Priya Shah', at: ago(12 * DAY), state: 'approved', reason: 'The 1,200 mAh cell could not meet two years at 15-minute readings.' },
]

// ------------------------------------------------------------------ guided skills (skill.get)

const DRAFT_CHANGES = [
  { id: 'ch1', what: 'C3 changed', from: '100 nF', to: '1 µF', guess: "Matches the radio module's bulk capacitor guidance" },
  { id: 'ch2', what: 'R7 changed', from: '10 kΩ', to: '4.7 kΩ', guess: 'Faster I2C edges at 400 kHz', confirmed: true, reason: 'Faster I2C edges at 400 kHz' },
]

export const SKILL_VIEWS: Record<string, Partial<SkillView>> = {
  'schematic-finish': {
    summary: "You're on step 3. The Power sheet has two findings left. The output capacitor blocks the gate; the ERC warning on U2 can be fixed or waived.",
    step: 2,
    recommendation: {
      recommended: 'c22', options: [{ id: 'c22', label: 'Change C2 to 2.2 µF', detail: '(0603, X5R, 10 V, LCSC C23630, in stock)' }, { id: 'waive', label: 'Waive and test stability on the bench' }],
      why: 'The regulator needs at least 2.2 µF on its output to stay stable.', evidence: [{ kind: 'datasheet', label: 'TLV755 datasheet p.12' }, { kind: 'run', label: 'run_4a11' }],
      givesUp: 'About US$0.002 more per board.',
    },
    checks: [{ id: 'notes', status: 'met' }, { id: 'erc', status: 'met' }, { id: 'datasheet', status: 'not_met', detail: 'C2 on the Power sheet' }, { id: 'mpn', status: 'met' }, { id: 'serves', status: 'not_met', detail: 'Radio sheet' }],
    sheets: [
      { id: 'power', name: 'Power', open: 2, serves: ['R-004', 'R-014'], path: 'build/kicad/soil-sensor/sch/power.svg' },
      { id: 'mcu', name: 'MCU', open: 0, serves: ['R-006', 'R-011'], path: 'build/kicad/soil-sensor/sch/mcu.svg' },
      { id: 'radio', name: 'Radio', open: 1, serves: [] },
      { id: 'sensor', name: 'Sensor', open: 0, serves: ['R-001'] },
    ],
    findings: SCH_FINDINGS,
    changes: DRAFT_CHANGES,
    push: { sha: '7f3e21', at: ago(4 * MIN), fixed: 2, new: 1 },
  },
  'placement-adjust': {
    summary: 'trace placed 64 parts. One finding blocks routing: decoupling C5 is too far from U1. J1 sits just inside the edge clearance.',
    checks: [{ id: 'check', status: 'not_met' }, { id: 'fixed', status: 'met' }, { id: 'locked', status: 'not_met' }],
    findings: DESIGN.board!.findings,
    changes: [{ id: 'mv1', what: 'U4 moved 2 mm left', guess: 'Routing: room for 3 nets between U4 and U5' }, { id: 'mv2', what: 'J2 rotated 90°', guess: 'Mechanical: antenna exits the enclosure side' }],
    push: { sha: '9c01aa', at: ago(20 * MIN), fixed: 1, new: 0 },
    items: [
      { id: 'blk1', title: 'Power: U2 and C2 within 2 mm', status: 'done' },
      { id: 'blk2', title: 'MCU: crystal Y1 next to pins 4 and 5', status: 'done' },
      { id: 'blk3', title: 'Radio: antenna on the edge, keep-out clear', status: 'open' },
    ],
  },
  'intent-builder': {
    summary: 'Power is done. Next, interfaces: what does the board connect to?',
    intent: {
      topic: 3,
      answered: ['purpose', 'environment', 'power'],
      statements: [
        { id: 's1', topic: 'Purpose', text: 'Measures soil moisture in a farm paddock and reports it to a LoRa gateway; used by the farm manager.', state: 'accepted' },
        { id: 's2', topic: 'Environment', text: 'Operates from −10 °C to 60 °C, outdoors, buried to 150 mm.', state: 'accepted' },
        { id: 's3', topic: 'Power', text: 'Runs from one 3.7 V lithium cell, 2,000 mAh.', state: 'accepted' },
        { id: 's4', topic: 'Power', text: 'Battery life of at least 2 years at one reading every 15 minutes.', state: 'draft' },
        { id: 's5', topic: 'Power', text: '"Low power" sleep mode.', state: 'needs_number', flag: 'Needs a number' },
        { id: 's6', topic: 'Interfaces', text: 'LoRa radio, u.FL antenna, 5.5 kbit/s, both directions; band and range to confirm.', state: 'needs_number', flag: 'Needs a number' },
        { id: 's7', topic: 'Interfaces', text: 'USB-C, 12 Mbit/s, both directions, for charging and setup.', state: 'draft' },
      ],
      questions: [{ id: 'oq1', text: 'Which gateway model will the farm use?', owner: 'Marc' }, { id: 'oq2', text: 'Must the enclosure be IP67 or IP65?', owner: 'Priya Shah' }],
    },
    checks: [{ id: 'answered', status: 'not_met', detail: '6 left' }, { id: 'quantities', status: 'not_met', detail: '1 left' }, { id: 'vague', status: 'not_met', detail: '1 left' }, { id: 'interfaces', status: 'not_met', detail: 'In progress' }, { id: 'conflicts', status: 'met' }, { id: 'testable', status: 'met' }, { id: 'owners', status: 'met' }],
    recommendation: {
      question: "'LoRa' needs a band and a range.", recommended: 'au915', options: [{ id: 'au915', label: 'AU915, 2 km' }, { id: 'other', label: 'Other answer' }],
      why: 'For a farm sensor in Australia trace recommends **AU915** and **2 km line of sight**, from your purpose statement.',
    },
  },
  'bring-up-run': {
    summary: 'Board SN-003 is on the bench. Inspection and the unpowered checks passed; the 3V3 rail is next, current-limited to 150 mA.',
    step: 2,
    checks: [{ id: 'limits', status: 'met' }, { id: 'shorts', status: 'met' }, { id: 'results', status: 'not_met', detail: '0 of 6 hardware tests' }, { id: 'issues', status: 'met' }],
    bench: {
      powered: true,
      checklist: [
        { id: 'k1', text: 'No bridges, missing or rotated parts', by: 'person', done: true },
        { id: 'k2', text: 'VBAT to ground above 1 kΩ', by: 'trace', done: true },
        { id: 'k3', text: '3V3 to ground above 1 kΩ', by: 'trace', done: true },
        { id: 'k4', text: 'Supply set: 3.7 V, limit 150 mA', by: 'trace', done: true, powered: true },
        { id: 'k5', text: '3V3 rail between 3.25 and 3.35 V', by: 'trace', done: false, powered: true },
        { id: 'k6', text: 'Idle current under 20 mA', by: 'trace', done: false, powered: true },
        { id: 'k7', text: 'Probe on TP4 (3V3) connected', by: 'person', done: false, powered: true },
      ],
      readouts: [
        { id: 'v', label: 'Supply voltage', value: 3.7, unit: 'V', min: 3.6, max: 3.8 },
        { id: 'i', label: 'Supply current', value: 0.0124, unit: 'A', max: 0.15 },
        { id: 'r', label: '3V3 rail (TP4)', value: 3.297, unit: 'V', min: 3.25, max: 3.35 },
      ],
      wires: [
        { id: 'w1', from: 'Supply CH1 +', to: 'J1 pin 1', net: 'VBAT', power: true, limit: '150 mA', done: true },
        { id: 'w2', from: 'Supply CH1 −', to: 'J1 pin 2', net: 'GND', power: true, done: true },
        { id: 'w3', from: 'Scope CH1', to: 'TP4', net: '3V3', done: false },
        { id: 'w4', from: 'USB serial', to: 'J3', net: 'UART', done: true },
      ],
    },
  },
  waiver: {
    summary: 'Waive or fix? trace recommends fixing the C2 finding now: the part is in stock and costs US$0.002 more. The U2 VBAT finding is a fair waiver.',
    waivable: [
      { id: 'F2', kind: 'finding', title: "ERC: U2's VBAT pin shows no driver", evidence: { kind: 'run', label: 'run_51c0' }, recommendation: 'waive', why: 'The pin is driven by the battery through J1, which the check cannot see. Bring-up step 3 checks the rail.' },
      { id: 'F1', kind: 'finding', title: 'C2 below the regulator\'s 2.2 µF minimum', evidence: { kind: 'datasheet', label: 'TLV755 datasheet p.12' }, recommendation: 'fix', why: 'A 2.2 µF part is in stock and fixes it outright.' },
      { id: 'R-017', kind: 'requirement', title: 'R-017: CISPR 32 class B radiated emissions', recommendation: 'fix', why: 'Only an estimate exists; the lab test in Certify settles it.' },
    ],
  },
  'change-request': {
    summary: 'Tell trace what you want to change and why; it traces the impact before anything is committed.',
    impact: {
      stages: ['Capture', 'Prove'], gates: ['the schematic gate'], stale: ['run_51c0 (ERC)', 'run_77b0 (parts list check)', 'run_9d4e (battery life)'],
      cost: 'about US$14 of cloud use', time: 'about 3 days', released: false,
      recommendation: { recommended: 'approve', options: [{ id: 'approve', label: 'Approve for this revision' }, { id: 'defer', label: 'Defer to Rev B' }, { id: 'reject', label: 'Reject' }], why: 'Rev A is not released yet, so the change is cheapest now.', givesUp: 'About 3 days on the schedule.' },
    },
  },
}

export const QUESTIONS: Record<string, SkillView['question']> = {
  'acme/motor-driver': {
    id: 'q-stall', to: 'Marc', text: "What is the motor's stall current?", askedAt: ago(40 * MIN), blocks: 'sizing the current-sense resistor',
    context: 'The Analog specialist is sizing the current-sense resistor for the H-bridge.',
    recommended: { id: '4.2', label: 'Use 4.2 A' }, options: [{ id: '4.2', label: 'Use 4.2 A' }, { id: '3.5', label: 'Use 3.5 A (rated, not stall)' }],
    sources: [{ kind: 'datasheet', label: 'Motor datasheet p.3', summary: 'Stall current 4.2 A at 12 V, 25 °C.' }],
    searched: [{ kind: 'datasheet', label: 'Motor datasheet' }, { kind: 'requirement', label: 'R-003' }, { kind: 'memory', label: 'Project notes' }],
    quantity: { unit: 'A' },
  },
  'acme/soil-sensor': {
    id: 'q1', to: 'Priya', text: 'Which antenna connector, u.FL or SMA?', askedAt: ago(2 * DAY), blocks: 'nothing yet; Layout needs it',
    context: 'The Layout specialist is planning the radio corner of the board.',
    recommended: { id: 'ufl', label: 'u.FL' }, options: [{ id: 'ufl', label: 'u.FL' }, { id: 'sma', label: 'SMA' }],
    sources: [{ kind: 'requirement', label: 'R-006' }, { kind: 'part', label: 'U.FL-R-SMT-1' }],
    searched: [{ kind: 'requirement', label: 'R-006' }, { kind: 'datasheet', label: 'STM32WL RF design guide' }],
  },
}

export const WAIVERS_EXTRA: Waiver[] = []

export const EXISTING_USERS = [
  { email: 'marc@example.com', sub: 'sub-marc', status: 'CONFIRMED', enabled: true, class: 'admin' as const, projects: ['acme/soil-sensor', 'acme/motor-driver'] },
  { email: 'priya@example.com', sub: 'sub-priya', status: 'CONFIRMED', enabled: true, class: 'user' as const, projects: ['acme/soil-sensor', 'acme/motor-driver'] },
  { email: 'tom@example.com', sub: 'sub-tom', status: 'CONFIRMED', enabled: true, class: 'guest' as const, projects: ['acme/soil-sensor'] },
  { email: 'ana@example.com', sub: 'sub-ana', status: 'CONFIRMED', enabled: true, class: 'admin' as const, projects: [] },
]

export const SETTINGS = {
  'project.name': 'Soil sensor',
  'project.description': 'A battery-powered soil moisture sensor for farms that reports over LoRa to a gateway every 15 minutes.',
  'project.icon': { glyph: 'sensor', colour: 'green' },
  'build.quantity': 10,
  'build.budget': 400,
  'build.unit_cost': 18,
  'stages.later': { certify: true, produce: false, sustain: false },
}
