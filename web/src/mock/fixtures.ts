/**
 * Fixture data for mock mode (VITE_MOCK=1) and tests: the three sample projects from the design canvas. Names,
 * numbers, part codes and run ids are illustrative.
 */
import type { ChatMessage, ChatThread, Gate, InboxItem, Journey, Member, MeDoc, ProjectRef, Stage, User, Wait } from '@/lib/types'

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export const ME: User = { sub: 'sub-marc', email: 'marc@example.com', name: 'Marc Teichtahl', class: 'admin' }

export const PROJECTS: ProjectRef[] = [
  { repo: 'acme/soil-sensor', role: 'write', part: 'contributor' },
  { repo: 'acme/motor-driver', role: 'write', part: 'contributor' },
  { repo: 'acme/panel-controller', role: 'write', part: 'contributor' },
]

const BOARD = ['Define', 'Architect', 'Capture', 'Prove', 'Layout', 'Sign-off', 'Release', 'Fabricate', 'Bring up']
const GATE_NAMES = ['Requirements gate', 'Architecture gate', 'Schematic gate', 'Verification gate', 'Layout gate', 'Sign-off gate', 'Release gate', 'Order gate']

function stages(names: string[], current: number, met: number, total: number, extra: Partial<Record<number, Partial<Stage>>> = {}): Stage[] {
  return names.map((name, i) => ({
    id: name.toLowerCase().replace(/\W+/g, '-'),
    name,
    state: i < current ? 'done' : i === current ? 'current' : 'queued',
    criteria: i < current ? { met: total, total } : i === current ? { met, total } : { met: 0, total: 0 },
    ...(i > current ? { prepared: i === current + 1 ? 'trace has drafted the test plan.' : undefined } : {}),
    ...extra[i],
  }))
}

function gates(st: Stage[], ready: boolean): Gate[] {
  return st.slice(0, -1).map((s, i) => ({
    id: GATE_NAMES[i]!.split(' ')[0]!.toLowerCase(),
    name: GATE_NAMES[i]!.replace(/^./, (c) => c.toLowerCase()).replace(/^/, 'the '),
    after: s.id,
    state: s.state === 'done' ? 'signed' : s.state === 'current' ? (ready ? 'ready' : 'open') : 'locked',
    criteria: [],
    waivers: [],
    ...(s.state === 'done' ? { signature: { by: 'Marc', at: ago((9 - i) * DAY) } } : {}),
  }))
}

const soilStages = stages(BOARD, 2, 6, 6, {
  0: { firmware: { text: 'Requirements accepted', ok: true } },
  1: { firmware: { text: 'Peripherals budgeted', ok: true } },
  2: { firmware: { text: 'Pin plan agreed', ok: true } },
})

export const JOURNEYS: Record<string, Journey> = {
  'acme/soil-sensor': {
    repo: 'acme/soil-sensor',
    name: 'Soil sensor',
    description: 'A LoRa soil moisture sensor that runs two years on two AA cells.',
    template: 'board',
    revision: 'Rev A',
    stages: soilStages,
    gates: gates(soilStages, true),
    current: 'capture',
    next: {
      kind: 'gate',
      owner: 'you',
      short: 'you sign the schematic gate',
      summary: 'The schematic gate is ready. All 6 criteria are met and 1 waiver was taken. **trace recommends signing.**',
      why: 'ERC clean, no datasheet conflicts, every part in stock for 10 boards, pin plan matches.',
      action: { label: 'Review and sign', to: '/p/acme~soil-sensor/gates/schematic' },
      secondary: { label: 'Read the evidence', to: '/p/acme~soil-sensor/gates/schematic' },
      reviewer: { summary: 'The schematic gate is waiting for an admin to sign.', action: { label: 'Read the evidence', to: '/p/acme~soil-sensor/gates/schematic' } },
    },
    questions: [
      { id: 'q1', to: 'Priya', text: 'Question to Priya: which antenna connector, u.FL or SMA?', askedAt: ago(2 * DAY), blocks: 'nothing yet; Layout needs it' },
    ],
    waivers: [{ id: 'W-3', title: 'ERC pin-not-driven on U2 VBAT', reason: 'Driven by the battery through J1, which the check cannot see.', risk: 'degraded', caught: 'Bring-up step 3' }],
    jobs: [
      { id: 'job_r1', title: 'Rendering the board for the gate', state: 'running', where: 'On a graphics card', etaS: 180, progress: 0.55 },
      { id: 'job_q1', title: 'Write the test plan for Prove', state: 'queued', startsWhen: 'starts when the schematic gate is signed' },
      { id: 'job_q2', title: 'Run SPICE corners on the LDO', state: 'queued', startsWhen: 'starts when the test plan is written' },
    ],
    recent: [
      { id: 'r1', who: 'Priya Shah', text: 'Push by Priya: 2 findings fixed', ref: 'abc123', at: ago(2 * HOUR) },
      { id: 'r2', who: 'Marc Teichtahl', text: 'Waiver W-3 taken for ERC pin-not-driven on U2', ref: 'VBAT', at: ago(5 * HOUR) },
      { id: 'r3', who: 'trace', text: 'trace re-checked the parts list: all 31 lines in stock for 10 boards', ref: 'run_77b0', at: ago(9 * HOUR) },
      { id: 'r4', who: 'Priya Shah', text: 'Pin plan agreed with the firmware track', at: ago(DAY + 2 * HOUR) },
      { id: 'r5', who: 'Marc Teichtahl', text: 'Architecture gate signed by Marc', at: ago(15 * DAY) },
    ],
    hasMemory: false,
    summary: {
      requirements: { accepted: 24, verified: 0, failing: 0, untested: 24 },
      cost: { cloudToDate: 38, forecast: 120, bom: 142, currency: 'USD', quantity: 10 },
    },
  },
  'acme/motor-driver': {
    repo: 'acme/motor-driver',
    name: 'Motor driver',
    template: 'board',
    revision: 'Rev A',
    stages: stages(BOARD, 1, 3, 5),
    gates: gates(stages(BOARD, 1, 3, 5), false),
    current: 'architect',
    next: {
      kind: 'task',
      owner: 'you',
      short: 'you answer one question',
      summary: 'The Analog specialist needs the motor\'s stall current to size the current-sense resistor. **It recommends 4.2 A**, from the motor datasheet, page 3.',
      action: { label: 'Answer', to: '/p/acme~motor-driver/do/question-answer' },
    },
    questions: [],
    waivers: [],
    jobs: [],
    recent: [{ id: 'm1', who: 'trace', text: 'Block diagram drafted: 3 options', at: ago(6 * HOUR) }],
    summary: { requirements: { accepted: 12, verified: 0, failing: 0, untested: 12 } },
  },
  'acme/panel-controller': {
    repo: 'acme/panel-controller',
    name: 'Panel controller',
    template: 'fpga',
    revision: 'Rev B',
    stages: stages(['Define', 'Architect', 'Prove', 'Layout', 'Release', 'Bring up'], 2, 4, 7),
    gates: gates(stages(['Define', 'Architect', 'Prove', 'Layout', 'Release', 'Bring up'], 2, 4, 7), false),
    current: 'prove',
    next: {
      kind: 'working',
      owner: 'trace',
      short: 'trace checks timing, about 15 minutes',
      summary: 'trace is checking timing on the FPGA. Step 2 of 4, about 15 minutes.',
      action: { label: 'Watch', to: '/p/acme~panel-controller/runs/run_51c0' },
      jobId: 'job_t1',
    },
    questions: [],
    waivers: [],
    jobs: [{ id: 'job_t1', title: 'checking timing on the FPGA', state: 'running', stepIndex: 2, stepCount: 4, etaS: 900, progress: 0.45 }],
    recent: [],
  },
}

export const INBOX: InboxItem[] = [
  {
    id: 'n1', kind: 'gate', repo: 'acme/soil-sensor', project: 'Soil sensor', revision: 'Rev A', stage: 'Capture', createdAt: ago(3 * HOUR),
    summary: 'The schematic gate is ready. All 6 criteria are met and 1 waiver was taken. **trace recommends signing.**',
    action: { label: 'Review and sign', to: '/p/acme~soil-sensor/gates/schematic' },
  },
  {
    id: 'n2', kind: 'question', repo: 'acme/motor-driver', project: 'Motor driver', revision: 'Rev A', stage: 'Architect', createdAt: ago(40 * MIN),
    summary: 'The Analog specialist needs the motor\'s stall current to size the current-sense resistor. **It recommends 4.2 A**, from the motor datasheet, page 3.',
    action: { label: 'Answer', to: '/p/acme~motor-driver/do/question-answer' },
    recommended: { id: '4.2', label: 'Use 4.2 A' }, questionId: 'q-stall',
    sources: [{ kind: 'datasheet', label: 'Motor datasheet p.3', summary: 'Stall current 4.2 A at 12 V, 25 °C.' }],
    blocks: 'sense resistor sizing',
  },
]

export const WAITS: Record<string, Wait[]> = {
  'acme/bench-supply': [],
  'acme/soil-sensor': [],
  'acme/panel-controller': [
    { id: 'w1', what: 'Bench supply: waiting for JLCPCB to ship the order', text: 'Waiting for JLCPCB to ship the order', lastCheckedAt: ago(2 * HOUR), nextCheckAt: ahead(4 * HOUR), repo: 'acme/panel-controller' },
  ],
}

export const MEMBERS: Record<string, Member[]> = {
  'acme/soil-sensor': [
    { sub: 'sub-marc', email: 'marc@example.com', name: 'Marc Teichtahl', class: 'admin', part: 'contributor', admin: true },
    { sub: 'sub-priya', email: 'priya@example.com', name: 'Priya Shah', class: 'user', part: 'contributor' },
    { sub: 'sub-tom', email: 'tom@example.com', name: 'Tom Lee', class: 'guest', part: 'reviewer' },
  ],
}

export const ME_DOC: MeDoc = { prefs: { work: { pinned: PROJECTS.map((p) => p.repo) } }, views: {} }

export const THREADS: ChatThread[] = [
  { id: 't1', repo: 'acme/soil-sensor', title: 'Why is R-006 failing?', updatedAt: ago(HOUR), author: 'Marc' },
  { id: 't2', repo: 'acme/soil-sensor', title: 'Regulator choice for the 3V3 rail', updatedAt: ago(DAY) },
]

export const THREAD_MESSAGES: Record<string, ChatMessage[]> = {
  t1: [
    { id: 'm1', role: 'user', content: 'Why is R-006 failing?', at: ago(HOUR) },
    {
      id: 'm2', role: 'assistant', at: ago(HOUR),
      content: [
        '**The bench range test reached 1.4 km, short of the 2 km requirement.** Three things add up:',
        '',
        '- Transmit power is set low: `TX_POWER=14` dBm, the radio allows 22.',
        '- The antenna sits 6 mm inside the ground pour, which detunes it.',
        '- The test site had trees near the 1.2 km mark, costing a few dB.',
        '',
        '| Setting | Now | Recommended |',
        '| --- | --- | --- |',
        '| Antenna position | 6 mm inside | Board edge |',
        '| Transmit power | 14 dBm | **20 dBm** |',
        '',
        '$$\\text{Link margin} = 14 + 2.1 - (-137) = 153.1\\ \\text{dB}$$',
        '',
        '```c',
        '#define TX_POWER  20   /* dBm, was 14 */',
        '```',
        '',
        'See [R-006](/p/acme~soil-sensor/requirements/R-006) and the [Semtech note](https://www.semtech.com/lora).',
      ].join('\n'),
    },
  ],
  t2: [],
}

export const RECALL = ['Why is R-006 failing?', 'Show me the power sheet', 'What does the LDO need on its output?']
