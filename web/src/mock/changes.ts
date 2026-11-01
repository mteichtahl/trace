/**
 * Mock answers for the guided flow (docs/guided-flow.md): each stage's guide and the Soil sensor's Capture steps on
 * journey.get, and the change actions (changes.list, change.get, change.diff, change.accept, change.ask,
 * change.discard) over two open changes. Accepting moves Capture to step 4 and starts the stock check; state lives in
 * memory for the session. The files a change touches have a before (base) and an after (head) version, served by
 * files.url through `changeFileContent`.
 */
import type { ChangeDetail, Journey, StageGuide, StageStep } from '@/lib/types'
import type { GateMore } from '@/lib/types-s1'
import { JOURNEYS, PROJECTS } from './fixtures'
import { DRAWING_SVG } from './fixtures-files'
import sch from './files/soil-sensor.kicad_sch?raw'

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const MIN = 60_000
const BASE = 'a91c04b'
const HEAD = '7f3e21a'

// ------------------------------------------------------------------ stage guides (board template)

export const GUIDES: Record<string, StageGuide> = {
  define: { purpose: 'Agree what the product must do, as requirements each with one test.', you_do: 'Describe the product, answer trace\'s questions and accept each requirement.', trace_does: 'Drafts the requirements from what you say and checks each can be tested.', you_get: 'A signed list of requirements every later stage is checked against.', typical_time: '1 to 3 days', next: 'Architect: choose how the product is built.' },
  architect: { purpose: 'Choose how the product is built: its blocks and key parts.', you_do: 'Compare trace\'s options and pick one, with a reason when it is not the recommendation.', trace_does: 'Drafts two or three options and scores them against fixed criteria.', you_get: 'A block diagram with its key parts in stock.', typical_time: '1 to 2 days', next: 'Capture: draw the schematic.' },
  capture: { purpose: 'Turn the agreed architecture into a complete schematic with every part chosen and in stock.', you_do: 'Review trace\'s sheets, finish anything it couldn\'t, and answer its questions.', trace_does: 'Drafts the sheets, picks parts that are in stock and runs the electrical checks.', you_get: 'A checked schematic and a parts list priced for your quantity.', typical_time: '2 to 4 days', next: 'Prove: simulate the circuit and write the test plan.' },
  prove: { purpose: 'Show the circuit meets its requirements before a board is made.', you_do: 'Read the results and decide on anything that falls short.', trace_does: 'Simulates the circuit across temperature and part tolerances and writes the test plan.', you_get: 'Evidence for each requirement, and a plan for the bench.', typical_time: '1 to 3 days', next: 'Layout: place the parts and route the board.' },
  layout: { purpose: 'Place the parts and route the board so it can be made.', you_do: 'Set the board outline and adjust placement where you know better.', trace_does: 'Routes the board and runs the design rule checks.', you_get: 'A routed board that passes the maker\'s rules.', typical_time: '2 to 5 days', next: 'Sign-off: check everything once more before release.' },
  'sign-off': { purpose: 'Check the whole design once more before anything is ordered.', you_do: 'Read the release review and sign it.', trace_does: 'Re-runs every check and compares the board with the schematic.', you_get: 'A design ready to release.', typical_time: 'Half a day', next: 'Release: freeze the files for the maker.' },
  release: { purpose: 'Freeze the files the maker needs.', you_do: 'Confirm the release.', trace_does: 'Builds the fabrication files and the parts list for the maker.', you_get: 'A frozen release, Rev A.', typical_time: 'An hour', next: 'Fabricate: order the boards.' },
  fabricate: { purpose: 'Order the boards and receive them.', you_do: 'Approve the spend and check the boards when they arrive.', trace_does: 'Prepares the order and watches it until it ships.', you_get: 'Boards on your bench.', typical_time: '1 to 3 weeks', next: 'Bring up: power the first board and test it.' },
  'bring-up': { purpose: 'Power the first boards and test them against the requirements.', you_do: 'Wire the bench and run the tests with trace.', trace_does: 'Guides each test and records the results.', you_get: 'A board shown to meet its requirements.', typical_time: '2 to 5 days', next: null },
}

const CAPTURE_STEPS: StageStep[] = [
  { id: 'draft', text: 'trace drafts the schematic sheets', owner: 'trace', state: 'done', ref: null },
  { id: 'pins', text: 'Agree the pin plan with firmware', owner: 'person', who: 'Priya', state: 'done', ref: { kind: 'criterion', id: 'c4' } },
  { id: 'change-12', text: "Review trace's power and USB sheet", owner: 'you', state: 'now', ref: { kind: 'change', id: '12' }, to: '/p/acme~soil-sensor/changes/12' },
  { id: 'stock', text: 'Check every part is in stock for 10 boards', owner: 'trace', state: 'next', ref: { kind: 'criterion', id: 'c3' } },
  { id: 'sign', text: 'Sign the schematic gate', owner: 'admins', state: 'later', ref: { kind: 'gate', id: 'schematic' }, to: '/p/acme~soil-sensor/gates/schematic' },
]

// give every journey's stages their guide, and the Soil sensor its Capture steps (once)
for (const j of Object.values(JOURNEYS)) for (const s of j.stages) s.guide ??= GUIDES[s.id]
const soil = JOURNEYS['acme/soil-sensor']!
soil.stages.find((s) => s.id === 'capture')!.steps = CAPTURE_STEPS

// ------------------------------------------------------------------ the changes

const SCH_BEFORE = sch.replace(/\t\(symbol \(lib_id "Device:R"\) \(at 180 100 0\)[\s\S]*?\n\t\)\n/, '')
const DECISIONS_BEFORE = '# Decisions\n\n- Architecture option B chosen: one LoRa SoC, no separate MCU.\n- Two AA cells replaced by one lithium cell (R-004).\n'
const DECISIONS_AFTER = `${DECISIONS_BEFORE}- The 3.3 V regulator is the AP2112K-3.3 (600 mA), not the MCP1700:
  the MCP1700 has no stock until February, and the AP2112K costs the same with twice the headroom.
- USB-C input protected against reverse and over-voltage with a TVS diode (D1).
- A power-good light (LED1) and two test points (TP1, TP2) added for bring-up.
`
const RENDER_AFTER = DRAWING_SVG.replace('Soil sensor enclosure outline', 'Soil sensor front end, probe moved 4 mm').replace('<rect x="300" y="20"', '<rect x="296" y="24"')

const FILES: Record<string, { before: string | null; after: string | null; mime: string }> = {
  'hardware/power.kicad_sch': { before: SCH_BEFORE, after: sch, mime: 'text/plain' },
  'docs/decisions.md': { before: DECISIONS_BEFORE, after: DECISIONS_AFTER, mime: 'text/markdown' },
  'hardware/sensor.kicad_sch': { before: sch, after: sch, mime: 'text/plain' },
  'docs/renders/front.svg': { before: DRAWING_SVG, after: RENDER_AFTER, mime: 'image/svg+xml' },
}

/** A changed file's bytes at the change's base (before) or head (after). */
export function changeFileContent(path: string, commit?: string): { bytes: string; mime: string } | null {
  const f = FILES[path]
  if (!f) return null
  const t = commit === BASE ? f.before : f.after
  return t === null ? null : { bytes: t, mime: f.mime }
}

const summary = (n: number, o: Partial<ChangeDetail>): ChangeDetail => ({
  number: n, title: '', url: `https://github.com/acme/soil-sensor/pull/${n}`, draft: false, held: true, from: 'the schematic specialist', job_id: `job_${n}`,
  stage: 'capture', opened_at: ago(20 * MIN), updated_at: ago(20 * MIN), state: 'open', mergeable: 'clean', checks: null, verdict: 'ready',
  summary: [], files: [], checks_list: [], requirements: [], recommendation: { verdict: 'none', why: '' }, may_accept: false, blockers: [],
  base: { ref: 'main', sha: BASE }, head: { ref: `claude/task-${n}`, sha: HEAD }, ...o,
})

const CHANGES: Record<string, ChangeDetail[]> = {
  'acme/soil-sensor': [
    summary(12, {
      title: 'Power and USB-C input sheet', opened_at: ago(20 * MIN), updated_at: ago(12 * MIN),
      checks: { total: 7, passed: 7, failed: 0, running: 0, skipped: 0, failing: [] }, verdict: 'ready',
      summary: [
        'Added a USB-C input with protection against reversed or excess voltage.',
        'Chose the **AP2112K-3.3** regulator (600 mA, 4,812 in stock) over the planned MCP1700, which is out of stock.',
        'Added a power-good light and two test points for bring-up.',
      ],
      files: [
        { path: 'hardware/power.kicad_sch', status: 'modified', additions: 14, deletions: 0, kind: 'schematic' },
        { path: 'hardware/parts-list.csv', status: 'modified', additions: 6, deletions: 1, kind: 'parts' },
        { path: 'docs/decisions.md', status: 'modified', additions: 4, deletions: 0, kind: 'text' },
      ],
      checks_list: [
        { name: 'Electrical rules check', state: 'passed', summary: 'No errors' },
        { name: 'Every part in stock for 10 boards', state: 'passed', summary: 'All 31 lines in stock at LCSC' },
        { name: 'Matches the pin plan', state: 'passed', summary: '18 used pins agree with the firmware' },
        { name: 'Datasheet limits', state: 'passed', summary: '0 conflicts' },
        { name: 'Every sheet names its requirements', state: 'passed', summary: null },
        { name: 'Footprints exist in the library', state: 'passed', summary: null },
        { name: 'Parts list matches the schematic', state: 'passed', summary: null },
      ],
      requirements: ['R-004', 'R-008'],
      recommendation: { verdict: 'accept', why: 'All 7 checks passed and it covers R-004 and R-008. The regulator swap gives twice the headroom for the same price, and the original part has no stock until February.' },
      may_accept: true,
    }),
    summary(13, {
      title: 'Sensor front end sheet', from: 'the analog specialist', opened_at: ago(8 * MIN), updated_at: ago(2 * MIN), mergeable: 'unknown',
      checks: { total: 7, passed: 4, failed: 0, running: 3, skipped: 0, failing: [] }, verdict: 'checking',
      summary: ['Moved the moisture probe connector 4 mm so it clears the enclosure wall.', 'Updated the front render to match.'],
      files: [
        { path: 'hardware/sensor.kicad_sch', status: 'modified', additions: 3, deletions: 3, kind: 'schematic' },
        { path: 'docs/renders/front.svg', status: 'modified', additions: 2, deletions: 2, kind: 'image' },
      ],
      checks_list: [
        { name: 'Electrical rules check', state: 'passed', summary: 'No errors' },
        { name: 'Datasheet limits', state: 'passed', summary: null },
        { name: 'Footprints exist in the library', state: 'passed', summary: null },
        { name: 'Parts list matches the schematic', state: 'passed', summary: null },
        { name: 'Every part in stock for 10 boards', state: 'running', summary: null },
        { name: 'Matches the pin plan', state: 'running', summary: null },
        { name: 'Enclosure clearance', state: 'running', summary: null },
      ],
      requirements: ['R-001'],
      recommendation: { verdict: 'wait', why: '3 checks are still running; trace will say when they finish.' },
      may_accept: false, blockers: ['3 checks are still running. Accepting opens once they pass.'],
    }),
  ],
}

const partOf = (repo: string) => PROJECTS.find((p) => p.repo === repo)?.part ?? 'contributor'
const open = (repo: string) => (CHANGES[repo] ?? []).filter((c) => c.state === 'open')
const SUMMARY_KEYS = ['number', 'title', 'url', 'draft', 'held', 'from', 'job_id', 'stage', 'opened_at', 'updated_at', 'state', 'mergeable', 'checks', 'verdict'] as const
const toSummary = (c: ChangeDetail) => Object.fromEntries(SUMMARY_KEYS.map((k) => [k, c[k]]))

/** After a change is accepted: Capture moves to step 4 and trace starts the stock check. */
function accepted(j: Journey, n: number) {
  const st = j.stages.find((s) => s.id === 'capture')
  if (st?.steps) {
    st.steps = st.steps.map((s) => (s.ref?.kind === 'change' && s.ref.id === String(n) ? { ...s, state: 'done' } : s.id === 'stock' ? { ...s, state: 'now' } : s.id === 'sign' ? { ...s, state: 'next' } : s))
    st.criteria = { ...st.criteria, met: Math.min(st.criteria.total, st.criteria.met + 1) }
  }
  const g = j.gates.find((x) => x.id === 'schematic') as GateMore | undefined
  const c = g?.criteria.find((x) => x.id === 'c7')
  if (c) c.status = 'met'
  j.next = {
    kind: 'working', owner: 'trace', short: 'trace checks stock for 10 boards',
    summary: 'trace is checking every part is in stock for 10 boards. About 4 minutes.',
    step: { index: 4, total: 5 }, after: 'Then the schematic gate is ready for an admin to sign.',
    reviewer: { summary: 'trace is checking every part is in stock for 10 boards. About 4 minutes.' },
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown) => json({ ok: true, result })
const fail = (error: string) => json({ ok: false, error })
const later = (r: Response, ms = 600) => new Promise<Response>((res) => setTimeout(() => res(r), ms)) as unknown as Response

/** An answer for the change actions, or undefined for any other action. `done(repo, n)` clears its inbox item. */
export function changesAction(name: string, a: Record<string, unknown>, done: (repo: string, n: number) => void): Response | undefined {
  if (!name.startsWith('change')) return undefined
  const repo = String(a.repo ?? '')
  if (!JOURNEYS[repo]) return json({ ok: false, error: 'no access' }, 403)
  if (name === 'changes.list') return ok({ repo, changes: open(repo).map(toSummary) })
  const c = (CHANGES[repo] ?? []).find((x) => x.number === Number(a.number))
  if (!c) return fail('no such change')
  const reviewer = partOf(repo) === 'reviewer'
  switch (name) {
    case 'change.get':
      return ok(reviewer ? { ...c, may_accept: false, blockers: ['You are a reviewer on this project: you can read changes, and contributors accept them.'] } : c)
    case 'change.diff': {
      const f = c.files.find((x) => x.path === a.path)
      if (!f) return fail(`no file ${String(a.path)} in this change`)
      return ok({ path: f.path, kind: f.kind, patch: null, before: f.status === 'added' ? null : { ref: BASE }, after: f.status === 'removed' ? null : { ref: HEAD }, binary: f.kind === 'binary' })
    }
    case 'change.accept':
      if (reviewer) return fail('Only contributors can accept a change.')
      if (!c.may_accept) return fail(c.blockers[0] ?? 'This change cannot be accepted yet.')
      c.state = 'merged'
      accepted(JOURNEYS[repo]!, c.number)
      done(repo, c.number)
      return later(ok({ merged: true, sha: 'f00dfee', stage: 'capture', next: 'trace is checking stock for 10 boards, about 4 minutes.' }))
    case 'change.ask':
      if (reviewer) return fail('Only contributors can ask for changes.')
      c.verdict = 'checking'
      c.may_accept = false
      c.blockers = ['The specialist is revising it from your note.']
      c.checks = c.checks ? { ...c.checks, passed: 0, running: c.checks.total } : null
      return later(ok({ job_id: `job_rev_${c.number}` }))
    case 'change.discard':
      if (reviewer) return fail('Only contributors can discard a change.')
      c.state = 'closed'
      done(repo, c.number)
      return later(ok({ closed: true }))
    default:
      return undefined
  }
}
