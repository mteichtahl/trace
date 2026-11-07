/**
 * Mock answers for the build after payment and cloud cost (src/api/actions-build.ts, actions-cost.ts): the panel
 * controller is at Bring up, with its order shipped and followed with DHL, two boards inspected and bring-up readings
 * on SN-002; the soil sensor's cost has estimates by kind and the actuals a day behind; Admin › Usage and cost has
 * the month. Registered in handlers.ts with one line; returns undefined for anything else.
 */
import type { BoardView, BuildView, CostView, JobSpendView, ReadingView, UsageMonth } from '@/lib/types-s1'
import { BUILD, COST } from './fixtures-s1'
import { costWithQuote } from './quotes'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown) => json({ ok: true, result })
const fail = (error: string) => json({ ok: false, error })
const later = (r: Response, ms = 500) => new Promise<Response>((res) => setTimeout(() => res(r), ms)) as unknown as Response

const PANEL = 'acme/panel-controller'
const SOIL = 'acme/soil-sensor'

const readings: ReadingView[] = [
  { id: 'r1', board: 'SN-002', step: 'unpowered', instrument: 'bench-dmm', quantity: '3V3 to ground', value: 14_200, unit: 'Ω', min: 1000, pass: true, at: ago(40 * MIN), by: 'the Verification specialist', run: 'run_7a1' },
  { id: 'r2', board: 'SN-002', step: 'unpowered', instrument: 'bench-dmm', quantity: 'VBAT to ground', value: 21_800, unit: 'Ω', min: 1000, pass: true, at: ago(38 * MIN), by: 'the Verification specialist', run: 'run_7a2' },
  { id: 'r3', board: 'SN-002', step: 'rails', instrument: 'bench-psu', quantity: 'Supply current', value: 0.0124, unit: 'A', max: 0.15, pass: true, at: ago(4 * MIN), by: 'the Verification specialist', run: 'run_7a3' },
  { id: 'r4', board: 'SN-002', step: 'rails', instrument: 'bench-dmm', quantity: '3V3 rail at TP4', value: 3.297, unit: 'V', min: 3.25, max: 3.35, pass: true, at: ago(3 * MIN), by: 'the Verification specialist', run: 'run_7a4' },
]

const boards: BoardView[] = [
  {
    serial: 'SN-001', order: 'Y12-4471058A', revision: 'Rev A', state: 'failed', status: 'failed', received: ago(DAY), photos: ['runs/run_ins1/sn-001-top.jpg'], readings: 0, failing: 0,
    checks: [
      { id: 'k1', check: 'count', kind: 'count', result: 'pass', by: 'Priya Shah', at: ago(DAY) },
      { id: 'k2', check: 'u3-rotation', kind: 'fault', result: 'fail', ref: 'U3', note: 'Rotated 180°: pin 1 at the wrong corner.', by: 'Priya Shah', at: ago(DAY) },
      { id: 'k3', check: 'hand-j2', kind: 'hand', result: 'marked', ref: 'J2', note: 'Left off: the antenna connector waits for the RF test.', by: 'Priya Shah', at: ago(DAY) },
    ],
  },
  {
    serial: 'SN-002', order: 'Y12-4471058A', revision: 'Rev A', state: 'inspected', status: 'inspected', received: ago(DAY), photos: ['runs/run_ins1/sn-002-top.jpg'], readings: 4, failing: 0,
    checks: [
      { id: 'k4', check: 'count', kind: 'count', result: 'pass', by: 'Priya Shah', at: ago(DAY) },
      { id: 'k5', check: 'hand-j2', kind: 'hand', result: 'pass', ref: 'J2', by: 'Priya Shah', at: ago(DAY) },
      { id: 'k6', check: 'label', kind: 'label', result: 'pass', by: 'Priya Shah', at: ago(DAY) },
    ],
  },
]

const PANEL_BUILD: BuildView = {
  releases: [{ id: 'rel-a', revision: 'Rev A', at: ago(16 * DAY), commit: '9c02e1f', files: 12, by: 'Marc Teichtahl', frozen: true }],
  orders: [{
    id: 'ord-p1', release: 'Rev A', state: 'shipped', boards: 5, total: 131.4, currency: 'USD', number: 'Y12-4471058A', paid: 131.4, ship: ago(5 * DAY).slice(0, 10),
    placedAt: ago(12 * DAY), placedBy: 'Marc Teichtahl', shippedAt: ago(5 * DAY), deliveredAt: null,
    tracking: { carrier: 'dhl', number: '1234567890', checkable: true, status: 'Arrived at the delivery facility in Melbourne', state: 'transit', eventAt: ago(7 * HOUR), eta: ahead(DAY) },
    cost: [{ label: 'Paid to JLCPCB', amount: 131.4 }], options: [], parts: [], files: [],
    wait: {
      id: 'order-Y12-4471058A', what: 'DHL to deliver order Y12-4471058A', source: 'timer', checkable: true, lastCheckedAt: ago(52 * MIN), nextCheckAt: ahead(68 * MIN),
      text: 'Waiting for DHL to deliver order Y12-4471058A (tracking 1234567890). DHL last said: Arrived at the delivery facility in Melbourne. Checked 52 minutes ago; next check in about 1 hour (DHL sends no events, so trace asks on a timer that backs off while nothing changes).',
    },
  }],
  boards,
  bench: {
    configured: true,
    instruments: [
      { name: 'bench-psu', kind: 'psu', address: 'TCPIP::192.168.1.40::5025::SOCKET', answered: true, identity: { manufacturer: 'RIGOL TECHNOLOGIES', model: 'DP832', serial: 'DP8C1912', firmware: '00.01.16', at: ago(HOUR), run: 'run_id1' } },
      { name: 'bench-dmm', kind: 'dmm', address: 'TCPIP::192.168.1.41::5025::SOCKET', answered: true, identity: { manufacturer: 'Keysight Technologies', model: '34465A', serial: 'MY57501234', firmware: 'A.03.01', at: ago(HOUR), run: 'run_id2' } },
      { name: 'bench-scope', kind: 'scope', address: 'USB0::0x1AB1::0x04CE::INSTR', answered: false },
    ],
    readings,
    boards: [{ serial: 'SN-002', steps: [{ step: 'unpowered', readings: 2, passed: true, failing: [] }, { step: 'rails', readings: 2, passed: true, failing: [] }] }],
  },
  notes: [],
}

/** The soil sensor's jobs, a little like test-esp32's run 2: a second proposal, docs sent back, a lost PDF job. */
const jobSpend = (o: Partial<JobSpendView> & Pick<JobSpendView, 'id' | 'title' | 'stage' | 'amount'> & { daysAgo: number; minutes: number }): JobSpendView => {
  const { daysAgo, minutes, ...rest } = o
  const specialists: Record<string, string> = { verify: 'Verification', impl: 'Implementation', ams: 'Analog and mixed-signal', thermal: 'Thermal', docs: 'Documentation', render: 'Rendering' }
  const agent = rest.agent ?? 'impl'
  return {
    agent, specialist: specialists[agent] ?? agent, stageId: rest.stage?.toLowerCase() ?? null, outcome: 'finished', started: ago(daysAgo * DAY), ended: ago(daysAgo * DAY - minutes * MIN),
    seconds: minutes * 60, byKind: { agents: rest.amount, gpu: 0, cpu: 0, tools: 0 }, workers: 0, repeat: null, ...rest,
  }
}
const SOIL_JOBS: JobSpendView[] = [
  jobSpend({ id: 'job-c7', agent: 'docs', title: 'Bring the design documents up to date with the power sheet', stage: 'Capture', amount: 2.85, daysAgo: 0.2, minutes: 14, repeat: { kind: 'redone', of: 'job-c3', text: 'Redone: worked again on an earlier job\'s change' } }),
  jobSpend({ id: 'job-c6', agent: 'docs', title: 'Make the design documents PDF', stage: 'Capture', amount: 1.1, daysAgo: 0.5, minutes: 31, outcome: 'lost' }),
  jobSpend({ id: 'job-c5', agent: 'ams', title: 'Changes asked on #12: move the LDO enable to the MCU', stage: 'Capture', amount: 4.2, daysAgo: 0.9, minutes: 22, repeat: { kind: 'sent_back', of: 'job-c1', text: 'Sent back: a person asked for changes' } }),
  jobSpend({ id: 'job-c4', agent: 'verify', title: 'Check the pin plan against the datasheets', stage: 'Capture', amount: 1.65, daysAgo: 1.4, minutes: 9 }),
  jobSpend({ id: 'job-c3', agent: 'docs', title: 'Write the Capture design documents', stage: 'Capture', amount: 2.3, daysAgo: 2, minutes: 12 }),
  jobSpend({ id: 'job-c1', agent: 'ams', title: 'Draw the power and USB-C input sheet', stage: 'Capture', amount: 7.9, daysAgo: 3, minutes: 48, workers: 1, byKind: { agents: 7.48, gpu: 0, cpu: 0.42, tools: 0 } }),
  jobSpend({ id: 'job-a4', agent: 'thermal', title: 'Thermal model of the sealed case', stage: 'Architect', amount: 2.4, daysAgo: 15.5, minutes: 26, byKind: { agents: 1.3, gpu: 0, cpu: 1.1, tools: 0 } }),
  jobSpend({ id: 'job-a3', agent: 'impl', title: 'Propose three architectures with real parts', stage: 'Architect', amount: 3.9, daysAgo: 16, minutes: 19, repeat: { kind: 'duplicate', of: 'job-a2', text: 'Duplicate: the same request as an earlier job' } }),
  jobSpend({ id: 'job-a2', agent: 'impl', title: 'Propose three architectures with real parts', stage: 'Architect', amount: 4.7, daysAgo: 16.2, minutes: 23 }),
  jobSpend({ id: 'job-d2', agent: 'verify', title: 'Draft the requirements from the intent', stage: 'Define', amount: 4.1, daysAgo: 19, minutes: 17 }),
  jobSpend({ id: 'job-d1', agent: 'docs', title: 'Write the project brief', stage: 'Define', amount: 1.9, daysAgo: 20, minutes: 8 }),
  { ...jobSpend({ id: null, title: 'Not tied to a job', stage: null, amount: 1.12, daysAgo: 0, minutes: 0 }), agent: null, specialist: null, started: null, ended: null, seconds: null, outcome: 'unknown', byKind: { agents: 0, gpu: 1.12, cpu: 0, tools: 0 } },
]
const SOIL_SPEND = {
  total: 38.12, repeated: 10.95, wasted: 1.1,
  stages: [
    { stage: 'Define', id: 'define', amount: 6, jobs: 2, repeated: 0, wasted: 0 },
    { stage: 'Architect', id: 'architect', amount: 11, jobs: 3, repeated: 3.9, wasted: 0 },
    { stage: 'Capture', id: 'capture', amount: 21.12, jobs: 6, repeated: 7.05, wasted: 1.1 },
  ],
  jobs: SOIL_JOBS,
}

const SOIL_COST: CostView = {
  ...COST,
  money: true,
  // the build is forecast, not committed, before Fabricate: from the order estimate's high end, not the target (#178)
  committed: 0,
  forecast: 171.2,
  forecastBasis: { kind: 'estimate', low: 96.4, high: 171.2, at: ago(DAY), partsRun: 'b0c4a1e9d2f37a60' },
  // two budgets: the build's for the order (US$171.20 forecast of US$200) and the cloud-work allowance for trace's work
  budget: 200,
  cloudBudget: 60,
  quantity: 10,
  unit_cost: 12,
  jobs: SOIL_SPEND,
  stages: COST.stages.map((x) => (x.stage === 'Capture' ? { ...x, cloud: 21.12 } : x)),
  // the US$60 allowance less Define's and Architect's US$17: US$43 for Capture and the 2 stages after it (the build's
  // forecast never comes off it)
  warning: { level: 'over', stage: 'Capture', spent: 21.12, share: 14.33, left: 43, stagesLeft: 3, top: [SOIL_JOBS[5]!, SOIL_JOBS[2]!, SOIL_JOBS[0]!] },
  spent: { cloud: 38.12, orders: 0, detail: { estimated: { agents: 31.4, gpu: 2.4, cpu: 4.32, total: 38.12 }, actual: { total: 9.86, byService: { 'Amazon Bedrock AgentCore': 7.2, 'AWS CodeBuild': 1.9, 'AWS Secrets Manager': 0.76 }, through: ago(DAY).slice(0, 10), estimatedDays: 1 }, basis: 'estimate' } },
  lines: COST.lines.map((l) => ({ ...l, estimate: true })),
  // the order estimate from Capture's parts check: the per-board requirement at risk, seen before Sign-off (#162)
  orderEstimate: {
    currency: 'USD', quantity: 10, low: 96.4, high: 171.2, perBoard: { low: 10.14, high: 13.62 }, at: ago(DAY), partsRun: 'b0c4a1e9d2f37a60', verdict: 'at_risk',
    lines: [
      { key: 'parts', what: 'Parts for 10 boards (18 lines checked)', low: 71.4, high: 71.4, source: 'parts check b0c4a1e9d2f37a60' },
      { key: 'boards', what: '10 bare boards (no board yet: priced as two layers, up to 100 x 100 mm)', low: 2, high: 30, source: 'JLCPCB\'s published prices of 2026-10-01, not a quote' },
      { key: 'assembly', what: 'Assembly: setup and stencil, 3 to 6 extended parts, about 260 parts placed', low: 28, high: 35.2, source: 'JLCPCB\'s published prices of 2026-10-01, not a quote' },
      { key: 'shipping', what: 'Shipping, a small parcel', low: 15, high: 40, source: 'JLCPCB\'s published prices of 2026-10-01, not a quote; depends on the destination' },
    ],
    notIn: ['No case yet: a case is added once one is built (mech.build gives its volume).'],
    limits: [
      { requirement: 'REQ-COST-001', kind: 'total', amount: 200, currency: 'USD', verdict: 'under', text: 'REQ-COST-001: the order US$96.40 to US$171.20, under US$200.' },
      { requirement: 'REQ-COST-002', kind: 'per_board', amount: 12, currency: 'USD', verdict: 'at_risk', text: 'REQ-COST-002: per board US$10.14 to US$13.62, at risk against US$12 (up to US$1.62 over).' },
    ],
    text: '',
  },
  explorer: { checkedAt: ago(3 * HOUR), nextAt: ahead(21 * HOUR), ok: true, tag: 'active', text: `Read from Cost Explorer by the trace:project cost allocation tag. A day's figures settle about 24 hours later, so the latest days may still change. Read ${ago(3 * HOUR).slice(0, 16).replace('T', ' ')} UTC; next read ${ahead(21 * HOUR).slice(0, 16).replace('T', ' ')} UTC.` },
  prices: {
    asOf: ago(6 * HOUR).slice(0, 10), stale: false, sources: ['https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html'],
    source: 'price-list', status: 'met', fetchedAt: ago(6 * HOUR), nextAt: ahead(18 * HOUR), failed: null, overrides: false, notes: [], pricedBy: { fetched: 41, 'built-in': 2 },
    text: `Estimates use prices from the AWS price list, fetched ${ago(6 * HOUR).slice(0, 10)} for us-east-1 (Claude on Bedrock per million tokens per model; g6.xlarge on demand in us-east-1 (one job holds the instance); c7i.xlarge on demand in us-east-1, per vCPU (0.1785 an hour for 4)). Next fetch ${ahead(18 * HOUR).slice(0, 16).replace('T', ' ')} UTC. Priced here: 41 from the AWS price list, 2 from the built-in table.`,
  },
  notes: ['Cloud estimates (agents, graphics card and CPU jobs) are computed from each run\'s tokens and each job\'s running time with the price table; they are estimates. What AWS billed comes from Cost Explorer, a day behind, and counts only resources tagged with the project (Bedrock and the shared job instances are not tagged per project).'],
}

const MONTH = (): UsageMonth => ({
  month: new Date().toISOString().slice(0, 7), currency: 'USD',
  projects: [
    { repo: SOIL, estimated: { agents: 31.4, gpu: 2.4, cpu: 4.32, total: 38.12 }, actual: 9.86, orders: 0, orderCurrency: 'USD', budget: 200, cloudBudget: 60, started: true },
    { repo: 'acme/motor-driver', estimated: { agents: 12.1, gpu: 0, cpu: 0.6, total: 12.7 }, actual: 3.1, orders: 0, orderCurrency: 'USD', budget: null, cloudBudget: null, started: true },
    { repo: PANEL, estimated: { agents: 22.9, gpu: 6.8, cpu: 1.2, total: 30.9 }, actual: 7.4, orders: 131.4, orderCurrency: 'USD', budget: 250, cloudBudget: null, started: true },
  ],
  totals: { estimated: 81.72, actual: 32.86, orders: 131.4 },
  shared: { total: 12.5, byService: { 'AWS Batch': 8.1, 'AWS Lambda': 2.2, 'Amazon CloudFront': 2.2 }, text: 'This installation\'s spend that carries no project tag: the shared job queues, the web app, the API.' },
  explorer: SOIL_COST.explorer!,
  prices: SOIL_COST.prices!,
})

/** The panel controller's hardware skills, from its boards and readings (the soil sensor keeps fixtures-s1's). */
function panelSkill(skill: string): Record<string, unknown> | undefined {
  const latest = readings.filter((r) => r.board === 'SN-002')
  if (skill === 'incoming-inspection') {
    return {
      skill, summary: 'Five boards were ordered; two are recorded. SN-001 has U3 rotated, so it is set aside; SN-002 is cleared for bring-up.', step: 2, boards, handPlaced: ['J2'],
      checks: [{ id: 'count', status: 'not_met', detail: '2 of the 5 boards ordered are recorded.' }, { id: 'faults', status: 'met' }, { id: 'hand', status: 'met' }, { id: 'reasons', status: 'met' }],
      bench: { powered: false, readouts: [], checklist: [{ id: 'c1', text: 'Every board counted against the order', by: 'person', done: false }, { id: 'c2', text: 'A photo of each side of each board', by: 'person', done: true }] },
    }
  }
  if (skill === 'bench-setup') {
    return {
      skill, summary: 'The supply and the multimeter answered; the scope has not. Check its USB cable, then run its identity query again.', step: 1,
      checks: [{ id: 'limits', status: 'met' }, { id: 'idn', status: 'not_met', detail: 'bench-scope has not answered its identity query: run hil.idn on the bench.' }, { id: 'wired', status: 'not_met', unavailable: 'the bench wiring (each connection with its net), in the record' }, { id: 'hardware', status: 'not_met', unavailable: 'which machine the bench tools run on; the API cannot see the bench machine' }],
      bench: { powered: false, readouts: [], checklist: PANEL_BUILD.bench!.instruments.map((i) => ({ id: `idn-${i.name}`, text: `${i.name} answers its identity query${i.identity?.model ? ` (${[i.identity.manufacturer, i.identity.model].join(' ')})` : ''}`, by: 'trace', done: i.answered })) },
    }
  }
  if (skill === 'bring-up-run') {
    return {
      skill, summary: 'SN-002 is on the bench. The unpowered checks passed; the 3V3 rail is in limits at 3.297 V with 12.4 mA drawn.', step: 2,
      checks: [{ id: 'limits', status: 'met' }, { id: 'shorts', status: 'met' }, { id: 'results', status: 'not_met', detail: '6 hardware tests without a result: TST-007, TST-008, TST-009, TST-010, TST-011 and 1 more.' }, { id: 'issues', status: 'not_met', unavailable: 'each failure linked to its issue, in the record' }],
      bench: {
        board: 'SN-002', powered: true, readings: latest,
        readouts: latest.map((r) => ({ id: r.id, label: `${r.quantity}${r.instrument ? ` (${r.instrument})` : ''}`, value: r.value, unit: r.unit ?? '', ...(r.min !== undefined ? { min: r.min } : {}), ...(r.max !== undefined ? { max: r.max } : {}), step: r.step, at: r.at })),
        checklist: latest.map((r) => ({ id: `r-${r.id}`, text: r.quantity, by: 'trace', done: r.pass, powered: r.step !== 'unpowered' })),
      },
    }
  }
  return undefined
}

export function buildCostAction(name: string, a: Record<string, unknown>): Response | undefined {
  const repo = a.repo as string
  switch (name) {
    case 'skill.get': { const v = repo === PANEL ? panelSkill(String(a.skill)) : undefined; return v ? ok(v) : undefined }
    case 'build.get': return repo === PANEL ? ok(PANEL_BUILD) : undefined
    case 'cost.get': return repo === SOIL ? ok(costWithQuote(SOIL_COST)) : undefined
    case 'usage.month': return ok(MONTH())
    case 'order.update': {
      const o = [...PANEL_BUILD.orders, ...BUILD.orders].find((x) => x.id === a.order || x.number === a.order)
      if (!o) return fail(`No order ${String(a.order)} is recorded.`)
      if (a.state) o.state = a.state as never
      if (a.carrier && a.tracking) o.tracking = { carrier: a.carrier as never, number: String(a.tracking), checkable: a.carrier === 'dhl' }
      if (o.state === 'delivered') o.wait = null
      return later(ok({ ok: true, wait: o.wait ?? null }))
    }
    case 'order.check_now': return later(ok({ ok: true }), 900)
    case 'board.record': {
      const serial = String(a.serial)
      if (!boards.some((b) => b.serial === serial)) boards.push({ serial, order: 'Y12-4471058A', state: 'received', status: 'received', received: new Date().toISOString(), photos: (a.photos as string[]) ?? [], checks: [] })
      return later(ok({ ok: true, created: true }))
    }
    case 'board.check': {
      const b = boards.find((x) => x.serial === a.serial)
      if (!b) return fail(`Board ${String(a.serial)} is not recorded. Record it as received first.`)
      b.checks = [...(b.checks ?? []).filter((c) => c.check !== a.check), { id: crypto.randomUUID(), check: String(a.check), kind: a.kind as never, result: a.result as never, ...(a.ref ? { ref: String(a.ref) } : {}), by: 'Marc Teichtahl', at: new Date().toISOString() }]
      if (a.result === 'fail') { b.state = 'failed'; b.status = 'failed' }
      return later(ok({ ok: true }))
    }
    default: return undefined
  }
}
