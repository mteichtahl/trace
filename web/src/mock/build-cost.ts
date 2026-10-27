/**
 * Mock answers for the build after payment and cloud cost (src/api/actions-build.ts, actions-cost.ts): the panel
 * controller is at Bring up, with its order shipped and followed with DHL, two boards inspected and bring-up readings
 * on SN-002; the soil sensor's cost has estimates by kind and the actuals a day behind; Admin › Usage and cost has
 * the month. Registered in handlers.ts with one line; returns undefined for anything else.
 */
import type { BoardView, BuildView, CostView, ReadingView, UsageMonth } from '@/lib/types-s1'
import { BUILD, COST } from './fixtures-s1'

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

const SOIL_COST: CostView = {
  ...COST,
  spent: { cloud: 38.12, orders: 0, detail: { estimated: { agents: 31.4, gpu: 2.4, cpu: 4.32, total: 38.12 }, actual: { total: 9.86, byService: { 'Amazon Bedrock AgentCore': 7.2, 'AWS CodeBuild': 1.9, 'AWS Secrets Manager': 0.76 }, through: ago(DAY).slice(0, 10), estimatedDays: 1 }, basis: 'estimate' } },
  lines: COST.lines.map((l) => ({ ...l, estimate: true })),
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
    { repo: SOIL, estimated: { agents: 31.4, gpu: 2.4, cpu: 4.32, total: 38.12 }, actual: 9.86, orders: 0, orderCurrency: 'USD', budget: 400, started: true },
    { repo: 'acme/motor-driver', estimated: { agents: 12.1, gpu: 0, cpu: 0.6, total: 12.7 }, actual: 3.1, orders: 0, orderCurrency: 'USD', budget: null, started: true },
    { repo: PANEL, estimated: { agents: 22.9, gpu: 6.8, cpu: 1.2, total: 30.9 }, actual: 7.4, orders: 131.4, orderCurrency: 'USD', budget: 250, started: true },
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
    case 'cost.get': return repo === SOIL ? ok(SOIL_COST) : undefined
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
