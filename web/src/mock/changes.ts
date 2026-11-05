/**
 * Mock answers for the guided flow (docs/guided-flow.md): each stage's guide and the Soil sensor's Capture steps on
 * journey.get, and the change actions (changes.list, change.get, change.diff, change.accept, change.ask,
 * change.discard, change.rerun) over the open changes. Accepting moves Capture to step 4 and starts the stock check; state lives in
 * memory for the session. The files a change touches have a before (base) and an after (head) version, served by
 * files.url through `changeFileContent`.
 */
import { PARTS_DB_AFTER, PARTS_DB_BEFORE } from './fixtures-db'
import type { ChangeDetail, Journey, StageGuide, StageStep } from '@/lib/types'
import type { GateMore } from '@/lib/types-s1'
import { JOURNEYS, PROJECTS } from './fixtures'
import { DRAWING_SVG } from './fixtures-files'
import sch from './files/soil-sensor.kicad_sch?raw'

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const MIN = 60_000
const BASE = 'a91c04b'
// a full sha, as change.get gives it (change.accept takes 40 hex characters)
const HEAD = '7f3e21a0c5d2b9e84f61a3c7d0e2b5f9a8c4d1e6'

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
  { id: 'pins', text: 'Agree the pin plan with firmware', owner: 'person', who: 'Priya', state: 'done', ref: { kind: 'criterion', id: 'capture.pins' } },
  // trace checks the stock while you review a change that does not meet it: alongside you, not after you
  { id: 'stock', text: 'Check every part is in stock for 10 boards', owner: 'trace', state: 'later', alongside: true, ref: { kind: 'criterion', id: 'capture.stock' } },
  { id: 'change-12', text: "Review trace's power and USB sheet", owner: 'you', state: 'now', ref: { kind: 'change', id: '12' }, to: '/p/acme~soil-sensor/changes/12' },
  { id: 'sign', text: 'Sign the schematic gate', owner: 'admins', state: 'next', ref: { kind: 'gate', id: 'schematic' }, to: '/p/acme~soil-sensor/gates/schematic' },
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

const FILES: Record<string, { before: string | Uint8Array | null; after: string | Uint8Array | null; mime: string }> = {
  'hardware/parts.db': { before: PARTS_DB_BEFORE, after: PARTS_DB_AFTER, mime: 'application/vnd.sqlite3' },
  'hardware/power.kicad_sch': { before: SCH_BEFORE, after: sch, mime: 'text/plain' },
  'docs/decisions.md': { before: DECISIONS_BEFORE, after: DECISIONS_AFTER, mime: 'text/markdown' },
  'hardware/sensor.kicad_sch': { before: sch, after: sch, mime: 'text/plain' },
  'docs/renders/front.svg': { before: DRAWING_SVG, after: RENDER_AFTER, mime: 'image/svg+xml' },
  'docs/design/protocol-specification.md': { before: null, after: '# Protocol specification\n\n## I2C display bus\n\n- Address 0x3C, 400 kHz.\n- 4.7 kΩ pull-ups to 3V3 on SCL and SDA.\n', mime: 'text/markdown' },
}

/** A changed file's bytes at the change's base (before) or head (after). */
export function changeFileContent(path: string, commit?: string): { bytes: string | Uint8Array; mime: string } | null {
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
        { path: 'hardware/parts.db', status: 'modified', additions: 0, deletions: 0, kind: 'binary' },
      ],
      checks_list: [
        { name: 'Electrical rules check', state: 'passed', summary: 'No errors', id: 'job:9101' },
        { name: 'Every part in stock for 10 boards', state: 'passed', summary: 'All 31 lines in stock at LCSC', id: 'cr:5502' },
        { name: 'Matches the pin plan', state: 'passed', summary: '18 used pins agree with the firmware', id: 'cr:5503' },
        { name: 'Datasheet limits', state: 'passed', summary: '0 conflicts', id: 'cr:5504' },
        { name: 'Every sheet names its requirements', state: 'passed', summary: null, id: 'cr:5505' },
        { name: 'Footprints exist in the library', state: 'passed', summary: null, id: 'job:9106' },
        { name: 'Parts list matches the schematic', state: 'passed', summary: null, id: null },
      ],
      requirements: ['R-004', 'R-008'],
      recommendation: { verdict: 'accept', why: 'All 7 checks passed and it covers R-004 and R-008. The regulator swap gives twice the headroom for the same price, and the original part has no stock until February.' },
      may_accept: true,
      built_on_by: [{ number: 15, title: 'Bring-up test points on the power sheet' }],
    }),
    summary(13, {
      title: 'Sensor front end sheet', from: 'the analog specialist', opened_at: ago(8 * MIN), updated_at: ago(2 * MIN), mergeable: 'unknown',
      checks: { total: 7, passed: 4, failed: 1, running: 2, skipped: 0, failing: ['Enclosure clearance'] }, verdict: 'checking',
      summary: ['Moved the moisture probe connector 4 mm so it clears the enclosure wall.', 'Updated the front render to match.'],
      files: [
        { path: 'hardware/sensor.kicad_sch', status: 'modified', additions: 3, deletions: 3, kind: 'schematic' },
        { path: 'docs/renders/front.svg', status: 'modified', additions: 2, deletions: 2, kind: 'image' },
      ],
      checks_list: [
        { name: 'Electrical rules check', state: 'passed', summary: 'No errors', id: 'job:9201' },
        { name: 'Datasheet limits', state: 'passed', summary: null, id: 'cr:5602' },
        { name: 'Footprints exist in the library', state: 'passed', summary: null, id: 'job:9203' },
        { name: 'Parts list matches the schematic', state: 'passed', summary: null, id: 'cr:5604' },
        { name: 'Enclosure clearance', state: 'failed', summary: 'J3 is 0.6 mm from the wall; 1 mm needed', id: 'job:9207' },
        { name: 'Every part in stock for 10 boards', state: 'running', summary: null, id: 'cr:5605' },
        { name: 'Matches the pin plan', state: 'running', summary: null, id: 'cr:5606' },
      ],
      requirements: ['R-001'],
      recommendation: { verdict: 'wait', why: 'The enclosure clearance check failed and 2 checks are still running; trace is fixing the clearance.' },
      may_accept: false, blockers: ['2 checks are still running and 1 failed. Accepting opens once they pass.'],
    }),
    // an edit someone made in the app (docs/stay-in-trace.md): a setting a contributor changed, waiting for an admin
    summary(14, {
      title: 'Boards per build: 5 → 10', kind: 'setting', by_name: 'Alex L.', mine: false, applies: 'review', from: 'a setting change by Alex L.',
      job_id: null, stage: null, opened_at: ago(30 * MIN), updated_at: ago(25 * MIN), head: { ref: 'trace/settings-quantity-m1', sha: HEAD },
      checks: { total: 1, passed: 1, failed: 0, running: 0, skipped: 0, failing: [] }, verdict: 'ready',
      summary: ['Boards per build: 5 → 10.', 'Made in trace by Alex L. as a setting change.'],
      files: [{ path: '.trace/project.db', status: 'modified', additions: 0, deletions: 0, kind: 'binary' }],
      checks_list: [{ name: 'build', state: 'passed', summary: 'Built.' }],
      recommendation: { verdict: 'accept', why: 'Its check passed, and it can be merged. Alex L. made it in trace; accepting applies it.' },
      may_accept: true, may_ask: false, may_discard: true, rule_blocks: false,
    }),
    // a stacked change (docs/stacked-changes.md): built on change 12, which is accepted first
    summary(15, {
      title: 'Bring-up test points on the power sheet', opened_at: ago(6 * MIN), updated_at: ago(4 * MIN),
      base: { ref: 'claude/task-12', sha: BASE }, head: { ref: 'claude/task-15', sha: HEAD },
      builds_on: { number: 12, title: 'Power and USB-C input sheet' },
      checks: { total: 7, passed: 7, failed: 0, running: 0, skipped: 0, failing: [] }, verdict: 'blocked',
      summary: ['Added test points on 3V3, VBUS and the power-good line, as the bring-up plan asks.', 'Built on the power sheet change, so it uses its new regulator.'],
      files: [{ path: 'hardware/power.kicad_sch', status: 'modified', additions: 6, deletions: 0, kind: 'schematic' }],
      checks_list: [{ name: 'Electrical rules check', state: 'passed', summary: 'No errors', id: 'job:9301' }],
      requirements: ['R-011'],
      recommendation: { verdict: 'wait', why: 'It builds on "Power and USB-C input sheet" (change 12), which is not accepted yet. Its checks passed: it follows that change into the design once it is accepted.' },
      may_accept: false, blockers: ['It builds on "Power and USB-C input sheet" (change 12), which is not accepted yet. Accept that one first.'],
    }),
    // a sound change whose trace-prs jobs died on GitHub's rate limit (test-esp32 run 2, #126, #128): run them again,
    // never ask for changes
    summary(16, {
      title: 'Sensor board layout, rev A', from: 'the layout specialist', stage: 'layout', opened_at: ago(3 * MIN), updated_at: ago(2 * MIN), mergeable: 'unstable',
      checks: { total: 3, passed: 1, failed: 2, running: 0, skipped: 0, failing: ['trace-prs'] }, verdict: 'blocked',
      summary: ['Placed and routed the sensor board on two layers, 48 × 30 mm.', 'The design rule check passes with no violations.'],
      files: [{ path: 'docs/renders/front.svg', status: 'modified', additions: 2, deletions: 2, kind: 'image' }],
      checks_list: [
        { name: 'Design rule check', state: 'passed', summary: 'No violations', id: 'job:9401' },
        { name: 'open-pr', state: 'failed', summary: null, id: 'job:9402' },
        { name: 'automerge', state: 'failed', summary: null, id: 'job:9403' },
      ],
      requirements: ['R-002', 'R-006'],
      recommendation: { verdict: 'wait', why: 'GitHub was busy (it limited how many requests trace could make), so the open-pr and automerge checks did not run properly. That says nothing about the work. Run them again; trace recommends once they have run.' },
      may_accept: false, blockers: ['The open-pr and automerge checks did not run properly: GitHub was busy (it limited how many requests trace could make). Run them again.'],
      infra_failed: { checks: [{ id: 'job:9402', name: 'open-pr' }, { id: 'job:9403', name: 'automerge' }], why: 'GitHub was busy (it limited how many requests trace could make)' },
    }),
    // an answer to its specialist's question that trace has not applied yet (test-esp32 log #131): never "accept"
    summary(17, {
      title: 'Wi-Fi setup in the user guide', from: 'the Documentation specialist', stage: 'layout', opened_at: ago(2 * MIN), updated_at: ago(1 * MIN),
      head: { ref: 'claude/task-wifi-docs', sha: HEAD },
      checks: { total: 2, passed: 2, failed: 0, running: 0, skipped: 0, failing: [] }, verdict: 'unfinished',
      answers: [{ question: 'aqf54afeab7d8d4a', text: 'How does a user clear the saved Wi-Fi network?' }],
      summary: ['Wrote the Wi-Fi setup section of the user guide.', 'Added a troubleshooting section for a board that does not join the network.'],
      files: [{ path: 'docs/user-guide.md', status: 'modified', additions: 48, deletions: 2, kind: 'text' }],
      checks_list: [{ name: 'build', state: 'passed', summary: 'Built.', id: 'job:9401' }, { name: 'Docs links', state: 'passed', summary: null, id: null }],
      recommendation: { verdict: 'wait', why: 'Waiting for trace to apply your answer to "How does a user clear the saved Wi-Fi network?" to it. Accepted now, it would go into the design without that answer.' },
      may_accept: true,
    }),
    // its checks passed, but the job behind it is still running: not ready, whatever the checks say (log #68)
    summary(18, {
      title: 'Protocol specification: I2C display', from: 'the Documentation specialist', stage: 'capture', opened_at: ago(5 * MIN), updated_at: ago(1 * MIN),
      head: { ref: 'claude/task-18', sha: HEAD }, working: true,
      checks: { total: 2, passed: 2, failed: 0, running: 0, skipped: 0, failing: [] }, verdict: 'checking',
      summary: ['Started the protocol specification with the I2C display bus: address, speed and pull-ups.'],
      files: [{ path: 'docs/design/protocol-specification.md', status: 'added', additions: 48, deletions: 0, kind: 'text' }],
      checks_list: [
        { name: 'Documents check', state: 'passed', summary: 'No broken links or missing sections', id: 'cr:5701' },
        { name: 'build', state: 'passed', summary: 'Built.', id: null },
      ],
      recommendation: { verdict: 'wait', why: 'Its job has not finished, so what you see may still change. Wait for it to finish before you accept it.' },
      may_accept: false, blockers: ['trace is still working on this change. Wait for its job to finish.'],
    }),
    // a change whose database edits an accepted requirement nothing asked to change (test-esp32 log #112)
    summary(19, {
      title: 'OLED connector pin-order note', from: 'the Verification specialist', opened_at: ago(5 * MIN), updated_at: ago(3 * MIN),
      checks: { total: 3, passed: 3, failed: 0, running: 0, skipped: 0, failing: [] }, verdict: 'ready',
      summary: ['Only the note string changed: J2\'s pin order (GND, 3V3, SCL, SDA) is now a project rule.', 'Did not change any wiring, symbol or net.'],
      files: [{ path: '.trace/project.db', status: 'modified', additions: 0, deletions: 0, kind: 'binary' }],
      checks_list: [{ name: 'build', state: 'passed', summary: 'Built.' }, { name: 'trace-prs', state: 'passed', summary: null }, { name: 'Electrical rules check', state: 'passed', summary: 'No errors' }],
      requirements: ['REQ-367d71'],
      requirement_edits: {
        ids: ['REQ-367d71'], reopens: true, asked: null,
        says: 'Changes a requirement (REQ-367d71): accepting it reopens Define and every gate after it.',
        edits: [{ id: 'REQ-367d71', what: 'REQ-367d71: its acceptance criterion changes from "J2 pins in the order GND, VCC, SCL, SDA, checked against the OLED module\'s datasheet" to "J2 pin order matches the OLED module (GND, 3V3, SCL, SDA), as the project rule says".' }],
      },
      recommendation: { verdict: 'ask', why: 'Changes a requirement (REQ-367d71): accepting it reopens Define and every gate after it. Nothing asked for that: no answer said it changes a requirement, and no change request did. Ask for changes so it leaves the requirement as agreed. If the new wording is right, you can still accept it, then agree it in Requirements review and sign the gates again.' },
      may_accept: true,
    }),
  ],
}

// ------------------------------------------------------------------ one check in full (change.check)

const ERC_LOG = `2026-11-03T09:41:02Z ##[group]Run kicad-cli sch erc hardware/power.kicad_sch
2026-11-03T09:41:02Z kicad-cli 9.0.4
2026-11-03T09:41:03Z Loading schematic hardware/power.kicad_sch
2026-11-03T09:41:04Z Running electrical rules check on 3 sheets
2026-11-03T09:41:05Z   Sheet /            0 errors, 0 warnings
2026-11-03T09:41:05Z   Sheet /Power/      0 errors, 0 warnings
2026-11-03T09:41:05Z   Sheet /USB/        0 errors, 0 warnings
2026-11-03T09:41:05Z Found 0 violations
2026-11-03T09:41:05Z Report written to erc-report.json
2026-11-03T09:41:05Z ##[endgroup]
2026-11-03T09:41:06Z Post job cleanup.`

const CLEAR_LOG = `2026-11-03T09:58:10Z ##[group]Run trace check enclosure-clearance
2026-11-03T09:58:10Z Reading hardware/sensor.kicad_sch and enclosure/outline.step
2026-11-03T09:58:12Z Placed parts: 23; parts near the wall: 4
2026-11-03T09:58:12Z   J1  USB-C        2.4 mm  ok
2026-11-03T09:58:12Z   J2  battery      1.8 mm  ok
2026-11-03T09:58:12Z   J3  probe        0.6 mm  FAIL (needs 1.0 mm)
2026-11-03T09:58:12Z   TP1 test point   1.2 mm  ok
2026-11-03T09:58:13Z ##[error]1 part closer to the enclosure wall than 1.0 mm
2026-11-03T09:58:13Z ##[endgroup]
2026-11-03T09:58:13Z Error: Process completed with exit code 1.`

type CheckMock = Partial<import('@/lib/types').CheckDetail> & { /** minutes ago */ started?: number; /** seconds */ took?: number }
const CHECK_DETAIL: Record<string, CheckMock> = {
  'job:9101': {
    text: '## Electrical rules check\n\nKiCad checked **3 sheets** of the power and USB-C schematic.\n\n| Sheet | Errors | Warnings |\n|---|---|---|\n| Root | 0 | 0 |\n| Power | 0 | 0 |\n| USB | 0 | 0 |\n\nEvery pin that needs a driver has one, and no two outputs drive the same net.',
    log: { text: ERC_LOG, truncated: false }, started: 6, took: 4,
  },
  'cr:5502': {
    text: 'All **31 lines** of the parts list are in stock at LCSC for 10 boards.\n\nThe tightest is **U3, AP2112K-3.3**: 4,812 in stock, 10 needed. The MCP1700 it replaces has no stock until February.',
    started: 8, took: 22,
  },
  'cr:5503': { text: 'The schematic and the firmware agree on all **18 used pins**. Four spare pins go to test points TP3 to TP6.', started: 8, took: 9 },
  'cr:5504': {
    text: 'Each part was checked against its datasheet limits: 0 conflicts.',
    annotations: [{ path: 'hardware/power.kicad_sch', line: null, level: 'notice', title: 'Close to a limit', message: 'C4 sees 4.2 V at most; it is rated 6.3 V (67%). Within the 80% rule.' }],
    started: 9, took: 41,
  },
  'cr:5505': { text: 'Power names R-004 and R-008; USB names R-008.', started: 9, took: 2 },
  'job:9106': { text: 'All 27 footprints are in the project library.', log: { text: '2026-11-03T09:40:58Z Checked 27 footprints\n2026-11-03T09:40:58Z 0 missing', truncated: false }, started: 9, took: 3 },
  'job:9201': { text: 'KiCad checked 1 sheet: 0 errors, 0 warnings.', log: { text: ERC_LOG.replace(/power/g, 'sensor').replace('3 sheets', '1 sheet'), truncated: false }, started: 5, took: 4 },
  'cr:5602': { text: '0 conflicts.', started: 5, took: 30 },
  'job:9203': { text: 'All 23 footprints are in the project library.', started: 5, took: 3 },
  'cr:5604': { text: 'The parts list matches the schematic: 23 parts.', started: 5, took: 2 },
  'job:9207': {
    text: '## Enclosure clearance\n\n**1 part** sits closer to the enclosure wall than the 1 mm the enclosure maker asks for.\n\n- **J3** (the moisture probe connector) is **0.6 mm** from the inside wall.\n\nMoving J3 a further 0.5 mm toward the board centre clears it. trace has asked the analog specialist to do that.',
    annotations: [
      { path: 'hardware/sensor.kicad_sch', line: null, level: 'failure', title: 'J3 too close to the wall', message: 'J3 is 0.6 mm from the enclosure wall; at least 1.0 mm is needed.' },
      { path: 'hardware/sensor.kicad_sch', line: null, level: 'warning', title: 'TP1 near the wall', message: 'TP1 is 1.2 mm from the wall: inside the rule, but a probe tip may not reach it.' },
    ],
    log: { text: CLEAR_LOG, truncated: true }, started: 4, took: 3,
  },
  'job:9401': { text: 'KiCad checked the board: 0 violations, 0 unconnected pads.', started: 3, took: 38 },
  'job:9402': {
    annotations: [{ path: '.github', line: null, level: 'failure', title: null, message: 'Unhandled error: HttpError: API rate limit exceeded for user ID 1817657.' }],
    log: { text: 'Run actions/github-script\nGitHub was busy: it limited trace\'s requests, and would take 2140 s to allow more, longer than this job may wait.\nError: Unhandled error: HttpError: API rate limit exceeded for user ID 1817657.', truncated: false }, started: 2, took: 4,
  },
  'job:9403': { annotations: [{ path: '.github', line: null, level: 'failure', title: null, message: 'Unhandled error: HttpError: API rate limit exceeded for user ID 1817657.' }], started: 2, took: 3 },
  'cr:5605': { started: 2 },
  'cr:5606': { started: 2 },
}

function checkDetail(c: ChangeDetail, id: string, admin: boolean) {
  const line = c.checks_list.find((k) => k.id === id)
  if (!line) return null
  const x: CheckMock = CHECK_DETAIL[id] ?? {}
  const startedAt = x.started !== undefined ? ago(x.started * MIN) : null
  return {
    id, name: line.name, state: line.state, summary: line.summary, text: x.text ?? null,
    started_at: startedAt, completed_at: line.state === 'running' || !startedAt || x.took === undefined ? null : new Date(Date.parse(startedAt) + x.took * 1000).toISOString(),
    annotations: x.annotations ?? [], log: x.log ?? null,
    ...(admin ? { url: id.startsWith('job:') ? `https://github.com/acme/soil-sensor/actions/runs/1/job/${id.slice(4)}` : `https://github.com/acme/soil-sensor/runs/${id.slice(3)}` } : {}),
  }
}

const partOf = (repo: string) => PROJECTS.find((p) => p.repo === repo)?.part ?? 'contributor'
const open = (repo: string) => (CHANGES[repo] ?? []).filter((c) => c.state === 'open')
const SUMMARY_KEYS = ['number', 'title', 'url', 'draft', 'held', 'from', 'job_id', 'stage', 'opened_at', 'updated_at', 'state', 'mergeable', 'checks', 'verdict', 'kind', 'by_name', 'mine', 'applies', 'builds_on', 'built_on_by', 'answers', 'working'] as const
const toSummary = (c: ChangeDetail) => Object.fromEntries(SUMMARY_KEYS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]))

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
    case 'change.check': {
      const x = checkDetail(c, String(a.id ?? ''), true)
      return x ? later(ok(x), 300) : fail('That check is not on this change\'s latest version.')
    }
    case 'change.diff': {
      const f = c.files.find((x) => x.path === a.path)
      if (!f) return fail(`no file ${String(a.path)} in this change`)
      return ok({ path: f.path, kind: f.kind, patch: null, before: f.status === 'added' ? null : { ref: BASE }, after: f.status === 'removed' ? null : { ref: HEAD }, binary: f.kind === 'binary' })
    }
    case 'change.accept':
      if (reviewer) return fail('Only contributors can accept a change.')
      // as the API: the head the person was shown, or nothing is merged
      if (a.head_sha !== c.head.sha) return fail('It changed since you looked at it. Look again before accepting.')
      if (!c.may_accept) return fail(c.blockers[0] ?? 'This change cannot be accepted yet.')
      c.state = 'merged'
      // as the harness restacks: the changes built on it move onto the design, and can be accepted on their own checks
      for (const up of CHANGES[repo] ?? []) {
        if (up.builds_on?.number !== c.number) continue
        delete up.builds_on
        up.base = { ref: 'main', sha: BASE }
        up.verdict = 'ready'; up.may_accept = true; up.blockers = []
        up.recommendation = { verdict: 'accept', why: `All its checks passed and it is on the design now that "${c.title}" is accepted.` }
      }
      delete c.built_on_by
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
    case 'change.resolve':
      if (reviewer) return fail('Only contributors can bring a change up to date.')
      if (c.verdict !== 'conflict') return later(ok({ text: 'It does not conflict with the newest design any more: nothing to bring up to date.', remade: false, worker: false, conflict: false }))
      c.verdict = 'checking'
      c.mergeable = 'clean'
      c.blockers = ['trace is merging the newest design into it; its checks run again after.']
      c.checks = c.checks ? { ...c.checks, passed: 0, running: c.checks.total } : null
      return later(ok({ text: 'trace is bringing it up to date with the newest design now. Its checks run again once it has, and it comes back to you.', remade: false, worker: true, conflict: true }))
    case 'change.rerun': {
      if (reviewer) return fail('Only contributors can run a check again.')
      const again = c.infra_failed?.checks ?? []
      if (!again.length) return fail('None of its checks failed for a reason outside the work, so there is nothing to run again here.')
      // as GitHub: the failed jobs run again, so the change is checking until they pass
      const ids = new Set(again.map((x) => x.id))
      c.checks_list = c.checks_list.map((k) => (k.id && ids.has(k.id) ? { ...k, state: 'running' as const } : k))
      c.checks = c.checks ? { ...c.checks, failed: 0, running: again.length, failing: [] } : null
      c.mergeable = 'unknown'
      c.verdict = 'checking'
      delete c.infra_failed
      c.blockers = [`${again.length === 1 ? '1 check is' : `${again.length} checks are`} still running.`]
      c.recommendation = { verdict: 'wait', why: `${again.length === 1 ? '1 check is' : `${again.length} checks are`} still running. Wait for ${again.length === 1 ? 'it' : 'them'} to finish.` }
      return later(ok({ checks: again.map((x) => x.name), runs: 1 }))
    }
    case 'change.discard':
      if (reviewer) return fail('Only contributors can discard a change.')
      c.state = 'closed'
      done(repo, c.number)
      return later(ok({ closed: true }))
    default:
      return undefined
  }
}
