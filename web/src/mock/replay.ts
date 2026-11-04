/**
 * Mock journey.replay for the soil sensor: its record from intent to the design gate, as events, a page at a time.
 */
const S = 'acme/soil-sensor'
const MARC = 'marc@acme.example'
const PRIYA = 'priya@acme.example'
const ELEC = 'electrical specialist'
const VER = 'verification specialist'

type E = { kind: string; node: string | null; status?: string; links?: string[]; who: string | null; stage: string; caption: string; source: string; cls: string; mins: number }
const START = Date.UTC(2026, 8, 1, 9, 0) / 1000

const RAW: E[] = [
  { mins: 0, kind: 'journey.started', node: 'intent:I-1', who: MARC, stage: 'define', caption: 'The journey started: Soil sensor', source: 'journey.journey', cls: 'Journey' },
  { mins: 30, kind: 'intent.recorded', node: 'intent:I-1', status: 'active', who: MARC, stage: 'define', caption: `${MARC} wrote the intent: a soil sensor that reaches the farm gateway 2 km away`, source: 'project.intent_statements', cls: 'IntentStatement' },
  { mins: 90, kind: 'requirement.recorded', node: 'requirement:R-002', status: 'untested', links: ['intent:I-1'], who: MARC, stage: 'define', caption: 'R-002 recorded: two years on 2×AA', source: 'project.requirements', cls: 'Requirement' },
  { mins: 95, kind: 'requirement.recorded', node: 'requirement:R-006', status: 'untested', links: ['intent:I-1'], who: MARC, stage: 'define', caption: 'R-006 recorded: reaches a gateway 2 km away', source: 'project.requirements', cls: 'Requirement' },
  { mins: 120, kind: 'question.asked', node: 'decision:q-4', links: ['requirement:R-002'], who: ELEC, stage: 'define', caption: 'The electrical specialist asked: one reading an hour, or one every 15 minutes?', source: 'journey.questions', cls: 'Question' },
  { mins: 300, kind: 'question.answered', node: 'decision:q-4', links: [`person:${MARC}`], who: MARC, stage: 'define', caption: `${MARC} answered: one reading an hour`, source: 'journey.questions', cls: 'Question' },
  { mins: 320, kind: 'criterion.met', node: 'criterion:define.intent', status: 'verified', links: ['gate:define'], who: 'trace', stage: 'define', caption: 'Define: the intent is written down — met', source: 'journey.criterion_history', cls: 'Criterion' },
  { mins: 330, kind: 'criterion.met', node: 'criterion:define.requirements', status: 'verified', links: ['gate:define'], who: 'trace', stage: 'define', caption: 'Define: every requirement is measurable — met', source: 'journey.criterion_history', cls: 'Criterion' },
  { mins: 340, kind: 'criterion.met', node: 'criterion:define.accepted', status: 'verified', links: ['gate:define'], who: MARC, stage: 'define', caption: `${MARC} accepted the requirements — met`, source: 'journey.criterion_history', cls: 'Criterion' },
  { mins: 345, kind: 'gate.signed', node: 'gate:define', status: 'verified', links: [`person:${MARC}`, 'criterion:define.intent', 'criterion:define.requirements', 'criterion:define.accepted'], who: MARC, stage: 'define', caption: `${MARC} signed the define gate with 3 criteria met`, source: 'journey.gate_signatures', cls: 'GateSignature' },
  { mins: 346, kind: 'stage.started', node: null, who: 'trace', stage: 'architect', caption: 'Architecture started', source: 'journey.stage_history', cls: 'Stage' },
  { mins: 600, kind: 'job.started', node: null, who: ELEC, stage: 'architect', caption: 'The electrical specialist started an architecture job: three options for the radio', source: 'jobs.jobs', cls: 'Job' },
  { mins: 900, kind: 'decision.recorded', node: 'decision:A-B', links: ['requirement:R-006'], who: ELEC, stage: 'architect', caption: 'Option B chosen: SX1262 with an external antenna', source: 'project.design_decisions', cls: 'DesignDecision' },
  { mins: 905, kind: 'block.recorded', node: 'block:radio', links: ['requirement:R-006'], who: ELEC, stage: 'architect', caption: 'The radio block serves R-006', source: 'project.arch_blocks', cls: 'Block' },
  { mins: 910, kind: 'block.recorded', node: 'block:antenna', links: ['requirement:R-006'], who: ELEC, stage: 'architect', caption: 'The antenna block serves R-006', source: 'project.arch_blocks', cls: 'Block' },
  { mins: 940, kind: 'run.passed', node: 'run:run_c19e', status: 'verified', links: ['requirement:R-006'], who: ELEC, stage: 'architect', caption: 'Link budget: 153 dB margin at +20 dBm — passed', source: 'project.runs', cls: 'Run' },
  { mins: 960, kind: 'criterion.met', node: 'criterion:architect.options', status: 'verified', links: ['gate:architect'], who: 'trace', stage: 'architect', caption: 'Architecture: options compared — met', source: 'journey.criterion_history', cls: 'Criterion' },
  { mins: 1300, kind: 'criterion.checked_met', node: 'criterion:architect.budget', status: 'verified', links: ['gate:architect', 'run:run_c19e'], who: VER, stage: 'architect', caption: 'The verification specialist checked the power budget — met, from run_c19e', source: 'facts.criterion_checks', cls: 'CriterionCheck' },
  { mins: 1320, kind: 'gate.signed', node: 'gate:architect', status: 'verified', links: [`person:${PRIYA}`, 'criterion:architect.options', 'criterion:architect.budget'], who: PRIYA, stage: 'architect', caption: `${PRIYA} signed the architecture gate with 2 criteria met`, source: 'journey.gate_signatures', cls: 'GateSignature' },
  { mins: 1321, kind: 'stage.started', node: null, who: 'trace', stage: 'design', caption: 'Schematic design started', source: 'journey.stage_history', cls: 'Stage' },
  { mins: 2000, kind: 'commit.built', node: null, who: ELEC, stage: 'design', caption: 'Commit 4be1a0c built: the schematic, first pass', source: 'project.runs', cls: 'Commit' },
  { mins: 2100, kind: 'run.failed', node: 'run:run_erc1', status: 'failing', links: ['block:radio'], who: ELEC, stage: 'design', caption: 'ERC on the radio sheet — failed: 2 unconnected pins', source: 'project.runs', cls: 'Run' },
  { mins: 2160, kind: 'run.passed', node: 'run:run_erc2', status: 'verified', links: ['block:radio', 'run:run_erc1'], who: ELEC, stage: 'design', caption: 'ERC on the radio sheet — passed', source: 'project.runs', cls: 'Run' },
  { mins: 2200, kind: 'waiver.taken', node: 'waiver:W-5', status: 'waived', links: ['criterion:design.clearance', `person:${PRIYA}`], who: PRIYA, stage: 'design', caption: `${PRIYA} waived 4 mm of antenna clearance for Rev A`, source: 'journey.waivers', cls: 'Waiver' },
  { mins: 2210, kind: 'criterion.waived', node: 'criterion:design.clearance', status: 'waived', links: ['gate:design'], who: PRIYA, stage: 'design', caption: 'Design: antenna keep-out — waived', source: 'journey.criterion_history', cls: 'Criterion' },
  { mins: 2600, kind: 'run.failed', node: 'run:run_8e14', status: 'failing', links: ['requirement:R-006'], who: VER, stage: 'design', caption: 'Bench range test: 1.4 km against 2 km — failed', source: 'project.runs', cls: 'Run' },
  { mins: 2601, kind: 'test.failing', node: 'requirement:R-006', status: 'failing', links: ['run:run_8e14'], who: VER, stage: 'design', caption: 'R-006 is failing on the bench range test', source: 'project.test_results', cls: 'TestResult' },
  { mins: 2700, kind: 'gate.returned', node: 'gate:architect', status: 'failing', links: [`person:${MARC}`], who: MARC, stage: 'design', caption: `${MARC} returned architecture: the range falls short`, source: 'journey.gates', cls: 'Gate' },
  { mins: 2701, kind: 'stage.reopened', node: null, who: MARC, stage: 'architect', caption: 'Architecture was reopened', source: 'journey.stage_history', cls: 'Stage' },
  { mins: 2900, kind: 'decision.recorded', node: 'decision:CR-3', links: ['requirement:R-006', 'requirement:R-002'], who: ELEC, stage: 'architect', caption: 'CR-3: raise TX power to +20 dBm; battery life drops about 6%', source: 'project.design_decisions', cls: 'DesignDecision' },
  { mins: 3000, kind: 'run.passed', node: 'run:run_9a02', status: 'verified', links: ['requirement:R-006'], who: VER, stage: 'architect', caption: 'Bench range test at +20 dBm: 2.3 km — passed', source: 'project.runs', cls: 'Run' },
  { mins: 3001, kind: 'test.verified', node: 'requirement:R-006', status: 'verified', links: ['run:run_9a02'], who: VER, stage: 'architect', caption: 'R-006 verified by the bench range test at +20 dBm', source: 'project.test_results', cls: 'TestResult' },
  { mins: 3050, kind: 'gate.signed', node: 'gate:architect', status: 'verified', links: [`person:${MARC}`, 'criterion:architect.options', 'criterion:architect.budget'], who: MARC, stage: 'architect', caption: `${MARC} signed the architecture gate again, revision 2`, source: 'journey.gate_signatures', cls: 'GateSignature' },
]

export const REPLAY_EVENTS = RAW.map((e, i) => {
  const t = START + e.mins * 60
  return {
    id: `${e.source}:${i}:${e.kind}`, t, at: new Date(t * 1000).toISOString(), kind: e.kind, class: `trace:${e.cls}`,
    record: `urn:trace:trace:${S}:${e.cls.toLowerCase()}:${i}`, source: e.source, node: e.node,
    ...(e.status ? { status: e.status } : {}), ...(e.links ? { links: e.links } : {}), who: e.who, stage: e.stage, caption: e.caption,
  }
})

const N = (id: string, kind: string, label: string, title: string, to?: string) => ({ id, kind, label, title, repo: S, ...(to ? { to } : {}) })
export const REPLAY_NODES: Record<string, unknown> = Object.fromEntries([
  N('intent:I-1', 'intent', '2 km line of sight', 'Intent: reach the farm gateway 2 km away'),
  N('requirement:R-002', 'requirement', 'R-002', '2 years on 2×AA', '/p/acme~soil-sensor/requirements/R-002'),
  N('requirement:R-006', 'requirement', 'R-006', 'Reaches a gateway 2 km away', '/p/acme~soil-sensor/requirements/R-006'),
  N('decision:q-4', 'decision', 'Reading interval', 'Question: how often to read?'),
  N('criterion:define.intent', 'criterion', 'Intent written', 'The intent is written down'),
  N('criterion:define.requirements', 'criterion', 'Measurable', 'Every requirement is measurable'),
  N('criterion:define.accepted', 'criterion', 'Accepted', 'The requirements are accepted'),
  N('gate:define', 'gate', 'Define gate', 'The define gate', '/p/acme~soil-sensor/journey?gate=define'),
  N('gate:architect', 'gate', 'Architecture gate', 'The architecture gate', '/p/acme~soil-sensor/journey?gate=architect'),
  N('gate:design', 'gate', 'Design gate', 'The design gate', '/p/acme~soil-sensor/journey?gate=design'),
  N('criterion:architect.options', 'criterion', 'Options compared', 'Options compared'),
  N('criterion:architect.budget', 'criterion', 'Power budget', 'The power budget closes'),
  N('criterion:design.clearance', 'criterion', 'Antenna keep-out', 'Antenna keep-out respected'),
  N('decision:A-B', 'decision', 'Option B', 'Architecture option B'),
  N('decision:CR-3', 'decision', 'CR-3 TX power', 'Change request CR-3 · Raise TX power'),
  N('block:radio', 'block', 'Radio', 'Radio block'),
  N('block:antenna', 'block', 'Antenna', 'Antenna block'),
  N('run:run_c19e', 'run', 'Link budget', 'Link budget', '/p/acme~soil-sensor/runs/run_c19e'),
  N('run:run_erc1', 'run', 'ERC radio', 'ERC on the radio sheet', '/p/acme~soil-sensor/runs/run_erc1'),
  N('run:run_erc2', 'run', 'ERC radio (2)', 'ERC on the radio sheet', '/p/acme~soil-sensor/runs/run_erc2'),
  N('run:run_8e14', 'run', 'Range test', 'Bench range test', '/p/acme~soil-sensor/runs/run_8e14'),
  N('run:run_9a02', 'run', 'Range test +20', 'Bench range test at +20 dBm', '/p/acme~soil-sensor/runs/run_9a02'),
  N('waiver:W-5', 'waiver', 'W-5', 'Waiver W-5: antenna clearance'),
  N(`person:${MARC}`, 'person', 'MT', MARC),
  N(`person:${PRIYA}`, 'person', 'PS', PRIYA),
].map((n) => [n.id, n]))

const CHAPTERS = [
  { stage: 'define', name: 'Define' },
  { stage: 'architect', name: 'Architecture' },
  { stage: 'design', name: 'Schematic design' },
].map((c) => {
  const e = REPLAY_EVENTS.find((x) => x.stage === c.stage)!
  return { ...c, t: e.t, at: e.at }
})

export function replayAction(a: Record<string, unknown>): unknown {
  const all = REPLAY_EVENTS
  const from = a.after ? all.findIndex((e) => e.id === a.after) + 1 : 0
  const limit = Number(a.limit ?? 500)
  const page = all.slice(from, from + limit)
  const nodes: Record<string, unknown> = {}
  for (const e of page) for (const id of [e.node, ...(e.links ?? [])]) if (id && REPLAY_NODES[id]) nodes[id] = REPLAY_NODES[id]
  return {
    repo: a.repo, events: page, next: from + page.length < all.length ? page.at(-1)!.id : null, total: all.length,
    range: { from: all[0]!.at, to: all.at(-1)!.at }, chapters: CHAPTERS, people: [...new Set(all.map((e) => e.who).filter(Boolean))].sort(), nodes,
  }
}
