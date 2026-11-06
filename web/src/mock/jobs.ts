/**
 * Mock jobs: each project's job index as jobs.list answers it (the same jobs journey.get carries), and job.control's
 * ops, in memory for the session, so Home's Running now, a project's "trace is doing", Ended without finishing and
 * Queued, and Agents and tools show running, paused, held, queued and lost work and react to Pause, Resume, Move up,
 * Cancel, Start again and Dismiss. A lost job holds up the next step until it is settled (lostStepOf).
 */
import type { AgentState, Handoff, Journey, ProjectJobs, RunSummary } from '@/lib/types'

const MIN = 60_000
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()

const JOBS: Record<string, RunSummary[]> = {
  'acme/soil-sensor': [
    { id: 'job_r1', title: 'Rendering the board for the gate', state: 'running', agent: 'render', agentName: 'Rendering', where: 'On a graphics card', step: 'Rendering the top view', startedAt: ago(4 * MIN), typicalS: 420, controls: ['pause', 'cancel'], yours: true, startedBy: 'marc@example.com' },
    { id: 'job_p1', title: 'Route the power nets', state: 'paused', agent: 'impl', agentName: 'Implementation', pausedBy: 'priya@example.com', branch: 'claude/task-route-the-power-nets-3f2a1c', controls: ['resume', 'cancel'], startedBy: 'priya@example.com' },
    { id: 'job_q1', title: 'Write the test plan for Prove', state: 'queued', agent: 'verify', agentName: 'Verification', position: 1, startsWhen: 'the Verification agent is already working on this project ("Check the ERC")', controls: ['pause', 'cancel'], startedBy: 'marc@example.com', yours: true },
    { id: 'job_s1', title: 'Check stock for 10 boards', state: 'queued', agent: 'parts', agentName: 'Parts', position: 1, startsWhen: 'starts when the power and USB-C input sheet is accepted', controls: ['pause', 'cancel'], startedBy: 'trace' },
    { id: 'job_q2', title: 'Run SPICE corners on the LDO', state: 'queued', agent: 'verify', agentName: 'Verification', position: 2, startsWhen: '"Write the test plan for Prove" is ahead of it in the queue', controls: ['pause', 'move_up', 'cancel'], startedBy: 'priya@example.com' },
    // waiting on the OLED header question (fixtures.ts aq0e1ed2c4a7b9f31): its step is the tool it waits in (#197)
    { id: 'job_sch1', title: 'Draw the OLED header J2', state: 'running', agent: 'impl', agentName: 'Implementation', step: 'still running: journey.ask (24 min so far)', startedAt: ago(31 * MIN), typicalS: 1200, controls: ['pause', 'cancel'], startedBy: 'trace' },
    { id: 'job_v1', title: 'Check the ERC', state: 'running', agent: 'verify', agentName: 'Verification', step: 'Running ERC on the power sheet', stepIndex: 2, stepCount: 5, startedAt: ago(9 * MIN), typicalS: 600, controls: ['pause', 'cancel'], startedBy: 'priya@example.com' },
    { id: 'job_d1', title: 'Update the user guide with the new renders', state: 'running', agent: 'docs', agentName: 'Documentation', step: 'Writing the assembly chapter', stepIndex: 3, stepCount: 4, startedAt: ago(12 * MIN), typicalS: 1500, controls: ['pause', 'cancel'], startedBy: 'trace' },
    { id: 'job_h1', title: 'Asked by the Thermal specialist: What is the worst-case dissipation of the LDO U3 at 85 °C with a 500 mA load?', state: 'queued', agent: 'ams', agentName: 'Analog and mixed-signal', position: 1, startsWhen: 'starts when it is its turn', controls: ['pause', 'cancel'], startedBy: 'the Thermal specialist (job job_th1)', handoff: { id: 'ho_mock_1', from: 'thermal', fromName: 'Thermal' } },
  ],
  // VITE_MOCK_AGENT=setting_up: Flasher's drafting, queued until its agent is set up (src/api/agent-queue.ts)
  ...(import.meta.env.VITE_MOCK_AGENT === 'setting_up' ? { 'acme/flasher': [
    { id: 'queued~acme~flasher~3f2a9c1d0e4b', title: 'Draft the candidate requirements from the intent', state: 'queued' as const, agent: 'verify', agentName: 'Verification', position: 1, startsWhen: 'starts once this project\'s agent is set up', controls: ['cancel' as const], startedBy: 'marc@example.com', yours: true },
  ] } : {}),
  'acme/panel-controller': [
    { id: 'job_t1', title: 'checking timing on the FPGA', state: 'running', agent: 'impl', agentName: 'Implementation', stepIndex: 2, stepCount: 4, etaS: 900, progress: 0.45, controls: ['cancel'] },
    { id: 'job_w1', title: 'Asked by the Implementation specialist: Move the LED driver pins to bank 2', state: 'running', agent: 'worker', agentName: 'Worker', step: 'Editing the pin constraints', stepIndex: 1, stepCount: 3, startedAt: ago(2 * MIN), typicalS: 300, controls: ['pause', 'cancel'], startedBy: 'the Implementation specialist (job job_t1)', handoff: { id: 'ho_mock_2', from: 'impl', fromName: 'Implementation' } },
    { id: 'job_fit1', title: 'Fit the board to the case', state: 'running', agent: 'mech', agentName: 'Mechanical', step: 'still running: journey.ask (14 min so far)', startedAt: ago(22 * MIN), typicalS: 900, controls: ['pause', 'cancel'], startedBy: 'trace' },
    { id: 'job_v2', title: 'Simulate the LED current limit', state: 'running', agent: 'verify', agentName: 'Verification', step: 'Running the transient corners', startedAt: ago(40 * MIN), typicalS: 900, controls: ['pause', 'cancel'], startedBy: 'trace' },
    { id: 'job_e1', title: 'Asked by the Implementation specialist: Check the antenna keep-out once routing is done', state: 'queued', agent: 'emc', agentName: 'EMC', position: 1, startsWhen: 'starts when the routing job ends', controls: ['pause', 'cancel'], startedBy: 'the Implementation specialist (job job_t1)', handoff: { id: 'ho_mock_3', from: 'impl', fromName: 'Implementation' } },
    // a job that ended without finishing (test-esp32 log #45, #46): Start again or Dismiss, and the next step says so
    { id: 'job_l1', title: 'Write the timing constraints for the LED driver', state: 'lost', agent: 'impl', agentName: 'Implementation', startedAt: ago(40 * MIN), branch: 'claude/task-led-timing-constraints', controls: ['restart', 'dismiss'], startedBy: 'marc@example.com', yours: true,
      step: 'trace lost contact with it: its runtime stopped without a word for more than 15 minutes. Its last lines: "running the impl specialist on acme/panel-controller (max 120 turns, 73 tools)".' },
  ],
  'acme/motor-driver': [
    { id: 'job_a1', title: 'Size the current-sense amplifier', state: 'paused', agent: 'ams', agentName: 'Analog and mixed-signal', stepIndex: 4, stepCount: 6, pausedBy: 'trace (waiting on your answer)', controls: ['resume', 'cancel'], startedBy: 'trace' },
    { id: 'job_v3', title: 'Write the gate-drive test plan', state: 'queued', agent: 'verify', agentName: 'Verification', position: 1, startsWhen: 'starts when the architecture gate is signed', controls: ['pause', 'cancel'], startedBy: 'trace' },
  ],
}

/** Each project's hand-offs between specialists, newest first: one queued (declinable), one answered. */
const HANDOFFS: Record<string, Handoff[]> = {
  'acme/soil-sensor': [
    {
      id: 'ho_mock_1', from: 'thermal', fromName: 'Thermal', to: 'ams', toName: 'Analog and mixed-signal', question: 'What is the worst-case dissipation of the LDO U3 at 85 °C with a 500 mA load?',
      blocks: 'the junction temperature check of U3', evidence: [{ kind: 'run', id: 'run_th7', label: 'thermal corners, run_th7', to: '/p/acme~soil-sensor/runs/run_th7' }],
      recommendation: 'About 0.9 W from the 5 V to 3.3 V drop.', acceptance: ['the dissipation in watts at 500 mA and 85 °C, with the run id', 'the input voltage it assumes'],
      summary: 'Thermal → Analog and mixed-signal: What is the worst-case dissipation of the LDO U3 at 85 °C with a 500 mA load?', state: 'queued',
      says: 'Queued for the Analog and mixed-signal specialist: it starts at its turn in the project\'s queue.', createdAt: ago(6 * MIN), jobId: 'job_h1', workerJobId: 'job_h1', fromWorkerJobId: 'job_th1',
    },
    {
      id: 'ho_mock_0', from: 'verify', fromName: 'Verification', to: 'emc', toName: 'EMC', question: 'Does the 2 MHz switcher on the 5 V rail pass the class B limit at 30 MHz?',
      blocks: 'the interference item T7 of the test plan', evidence: [{ kind: 'run', id: 'run_v3', label: 'test plan, run_v3', to: '/p/acme~soil-sensor/runs/run_v3' }],
      acceptance: ['the margin to the class B limit at 30 MHz, in dB, with the run id'], summary: 'Verification → EMC: Does the 2 MHz switcher on the 5 V rail pass the class B limit at 30 MHz?',
      state: 'answered', says: 'Answered.', createdAt: ago(90 * MIN), fromWorkerJobId: 'job_v1',
      answer: { answered: true, text: 'Yes: 6.2 dB below the class B limit at 30 MHz in the precheck (run_e2), with the input filter as drawn.', summary: 'Yes: 6.2 dB below the class B limit at 30 MHz in the precheck (run_e2), with the input filter as drawn.', evidence: [{ kind: 'run', id: 'run_e2', label: 'run_e2', to: '/p/acme~soil-sensor/runs/run_e2' }], confidence: 0.7, acceptanceMet: true, at: ago(70 * MIN) },
    },
  ],
}

HANDOFFS['acme/panel-controller'] = [
  {
    id: 'ho_mock_2', from: 'impl', fromName: 'Implementation', to: 'worker', toName: 'Worker', question: 'Move the LED driver pins to bank 2, so they share the 3.3 V bank with the display.',
    blocks: 'the routing of the LED driver', evidence: [], acceptance: ['the constraints file changed', 'the timing check still passes'],
    summary: 'Implementation → Worker: Move the LED driver pins to bank 2', state: 'running', says: 'Being worked on by the Worker.', createdAt: ago(3 * MIN), jobId: 'job_w1', workerJobId: 'job_w1', fromWorkerJobId: 'job_t1',
  },
  {
    id: 'ho_mock_3', from: 'impl', fromName: 'Implementation', to: 'emc', toName: 'EMC', question: 'Check the antenna keep-out once routing is done.',
    blocks: 'the layout review', evidence: [], acceptance: ['the keep-out clear of copper, or the parts that intrude'],
    summary: 'Implementation → EMC: Check the antenna keep-out once routing is done', state: 'queued', says: 'Queued for the EMC specialist: it starts when the routing job ends.', createdAt: ago(8 * MIN), jobId: 'job_e1', workerJobId: 'job_e1', fromWorkerJobId: 'job_t1',
  },
]
HANDOFFS['acme/motor-driver'] = [
  {
    id: 'ho_mock_4', from: 'thermal', fromName: 'Thermal', to: 'ams', toName: 'Analog and mixed-signal', question: 'How much does the current-sense amplifier dissipate at full load?',
    blocks: 'the heat model of the driver stage', evidence: [], acceptance: ['the dissipation in watts at 10 A'],
    summary: 'Thermal → Analog and mixed-signal: How much does the current-sense amplifier dissipate at full load?', state: 'requested', says: 'Waiting for the Analog and mixed-signal specialist, which is waiting on a person.', createdAt: ago(20 * MIN), fromWorkerJobId: 'job_th2',
  },
]

/** The project's hand-offs as journey.get carries them. */
export const handoffsOf = (repo: string): Handoff[] => HANDOFFS[repo] ?? []

const AGENT_IDS = ['verify', 'impl', 'ams', 'emc', 'render', 'thermal', 'docs', 'worker'] as const
const NAMES: Record<string, string> = { verify: 'Verification', impl: 'Implementation', ams: 'Analog and mixed-signal', emc: 'EMC', render: 'Rendering', thermal: 'Thermal', docs: 'Documentation', worker: 'Worker' }

/** each agent's last 24 hours on the busiest project: runs, and how many passed */
const TODAY: Record<string, [number, number]> = { verify: [9, 8], impl: [6, 6], worker: [11, 11], ams: [3, 3], emc: [2, 2], render: [1, 1], docs: [4, 4] }

function agentsOf(repo: string, jobs: RunSummary[]): AgentState[] {
  return AGENT_IDS.map((id) => {
    const now = jobs.filter((j) => j.agent === id && (j.state === 'running' || j.state === 'paused'))
    const queue = jobs.filter((j) => j.agent === id && j.state === 'queued').sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    const stuck = repo === 'acme/motor-driver' && id === 'thermal'
    const waiting = repo === 'acme/motor-driver' && id === 'ams'
    const status: AgentState['status'] = stuck ? 'stuck' : waiting ? 'waiting_person' : now.length ? 'working' : queue.length ? 'queued' : 'idle'
    const says = stuck ? 'Stuck: No ambient temperature is in the requirements.' : waiting ? 'Waiting on a person: Which current-sense amplifier should the driver use?' : now.length ? `Working on ${now.map((j) => `"${j.title}"`).join(', ')}` : queue.length ? `${queue.length} queued` : 'Idle'
    const runs = TODAY[id] ?? [0, 0]
    return { id, name: NAMES[id] ?? id, status, says, now: now.map((j) => j.id), queue: queue.map((j) => j.id), today: { runs: repo === 'acme/soil-sensor' ? runs[0] : 0, succeeded: repo === 'acme/soil-sensor' ? runs[1] : 0, medianS: runs[0] ? 540 : null } }
  })
}

/** The project's jobs as journey.get carries them. */
export const jobsOf = (repo: string): RunSummary[] => JOBS[repo] ?? []

const renumber = (jobs: RunSummary[]): void => {
  for (const agent of new Set(jobs.map((j) => j.agent))) {
    jobs.filter((j) => j.agent === agent && j.state === 'queued').sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).forEach((j, i) => {
      j.position = i + 1
      j.controls = [j.held ? 'resume' : 'pause', ...(i > 0 ? ['move_up' as const] : []), 'cancel']
    })
  }
}

type Answer = { ok: true; result: unknown } | { ok: false; error: string }

/** jobs.list and job.control; undefined for any other action. */
export function jobsAction(name: string, a: Record<string, unknown>): Answer | undefined {
  if (name === 'jobs.list') {
    const repo = String(a.repo)
    const jobs = jobsOf(repo)
    return { ok: true, result: { repo, jobs, agents: agentsOf(repo, jobs), handoffs: handoffsOf(repo), batch: [], updatedAt: new Date().toISOString() } satisfies ProjectJobs }
  }
  if (name === 'handoff.decline') {
    const repo = String(a.repo)
    const h = handoffsOf(repo).find((x) => x.id === a.id)
    if (!h) return { ok: false, error: 'There is no such hand-off in this project.' }
    if (h.state !== 'requested' && h.state !== 'queued') return { ok: false, error: h.state === 'running' ? 'Its job is already running: cancel that job instead.' : 'This hand-off has already ended.' }
    Object.assign(h, { state: 'declined', declined: { reason: String(a.reason), by: 'you', at: new Date().toISOString() }, says: `Declined by you: ${String(a.reason)}` })
    const list = JOBS[repo] ?? []
    const j = list.findIndex((x) => x.id === h.jobId)
    if (j >= 0) { list.splice(j, 1); renumber(list) }
    return { ok: true, result: { repo, declined: { id: h.id, reason: String(a.reason), by: 'you', at: new Date().toISOString() }, job: { cancelled: true, note: 'Its queued job was cancelled.' }, summary: `Declined: the ${h.toName} specialist will not answer it, and the asking specialist is told why.` } }
  }
  if (name !== 'job.control') return undefined
  if (a.op === 'restart' || a.op === 'dismiss') return lostControl(String(a.id), a.op, typeof a.reason === 'string' ? a.reason : null)
  const all = Object.values(JOBS).flat()
  const j = all.find((x) => x.id === a.id)
  const list = Object.values(JOBS).find((l) => l.some((x) => x.id === a.id))
  if (!j || !list) return { ok: true, result: { ok: false, reason: 'There is no such job.' } }
  if (!j.controls?.includes(a.op as 'pause')) return { ok: true, result: { ok: false, reason: 'That cannot be done for this job now.' } }
  switch (a.op) {
    case 'pause':
      if (j.state === 'queued') { j.held = true; j.startsWhen = 'held by you: it starts when someone resumes it'; renumber(list); return { ok: true, result: { ok: true, held: true, kept: 'It stays in the queue, held: it does not start until someone resumes it.' } } }
      Object.assign(j, { state: 'paused', pausedBy: 'you', branch: j.branch ?? 'claude/task-in-progress', controls: ['resume', 'cancel'] })
      return { ok: true, result: { ok: true, pausing: true, kept: 'It stops before its next step: the step in progress finishes, its work so far is committed and pushed on its branch, and Resume carries on from there with what it has done.' } }
    case 'resume':
      if (j.state === 'queued') { j.held = false; j.startsWhen = 'starts when it is its turn'; renumber(list); return { ok: true, result: { ok: true, held: false, kept: 'Released: it starts at its turn.' } } }
      Object.assign(j, { state: 'running', step: 'Carrying on from its branch', startedAt: new Date().toISOString(), controls: ['pause', 'cancel'], pausedBy: undefined })
      return { ok: true, result: { ok: true, kept: `It carries on from ${j.branch ?? 'its branch'}, with its conversation.` } }
    case 'move_up': {
      const ahead = list.find((x) => x.agent === j.agent && x.state === 'queued' && x.position === (j.position ?? 1) - 1)
      if (ahead) { ahead.position = (ahead.position ?? 1) + 1; j.position = (j.position ?? 2) - 1 }
      renumber(list)
      return { ok: true, result: { ok: true, position: j.position } }
    }
    case 'cancel': {
      const was = j.state
      list.splice(list.indexOf(j), 1)
      renumber(list)
      return { ok: true, result: { ok: true, state: 'aborted', kept: was === 'paused' ? `Its work stays on ${j.branch ?? 'its branch'}; it will not be resumed.` : 'Commits the agent had already pushed stay on their branch.' } }
    }
    default:
      return { ok: true, result: { ok: false, reason: 'Unknown control.' } }
  }
}

/** Start again (a new queued attempt on the same branch) or Dismiss a lost job, as job.control does. */
function lostControl(id: string, op: 'restart' | 'dismiss', reason: string | null): Answer {
  const list = Object.values(JOBS).find((l) => l.some((x) => x.id === id))
  const j = list?.find((x) => x.id === id)
  if (!j || !list) return { ok: true, result: { ok: false, reason: 'There is no such job.' } }
  if (j.state !== 'lost' || j.settled || !j.controls?.includes(op)) return { ok: true, result: { ok: false, reason: j.settled ? 'It was settled already.' : 'Only a job that ended without finishing can be started again or dismissed.' } }
  const at = new Date().toISOString()
  j.controls = []
  if (op === 'dismiss') {
    j.settled = { how: 'dismissed', by: 'you', at, ...(reason ? { reason } : {}) }
    return { ok: true, result: { ok: true, dismissed: true, kept: 'Dismissed: it leaves the overview, and the decision is in the project\'s history.' } }
  }
  j.settled = { how: 'restarted', by: 'you', at }
  const again: RunSummary = { id: `${j.id}_2`, title: j.title, state: 'queued', agent: j.agent, agentName: j.agentName, position: 1, startsWhen: 'starts when it is its turn', controls: ['pause', 'cancel'], startedBy: j.startedBy, yours: j.yours, branch: j.branch }
  list.push(again)
  return { ok: true, result: { ok: true, state: 'queued', jobId: again.id, kept: `It starts again on ${j.branch ?? 'its branch'}, from what the lost attempt left there.` } }
}

/**
 * The next step while a job of the project ended without finishing (src/api/actions-jobs.ts lostJobStep): it names the
 * job and offers Start again, in place of a step that would have the person carry on or say trace is working.
 */
export function lostStepOf(repo: string, next: Journey['next']): Journey['next'] {
  const j = jobsOf(repo).find((x) => x.state === 'lost' && !x.settled)
  if (!j || (next.kind !== 'task' && next.kind !== 'working')) return next
  const can = j.controls?.includes('restart') ?? false
  return {
    kind: 'task', owner: 'you', short: `you start "${j.title}" again`,
    summary: `The ${j.agentName ?? 'trace'} job "${j.title}" ended without finishing: trace lost contact with it, and nothing is doing its work now.${can ? ' **trace recommends starting it again: it carries on from what the lost attempt left on its branch.**' : ''}`,
    lead: `The ${j.agentName ?? 'trace'} job "${j.title}" ended without finishing: trace lost contact with it, and nothing is doing its work now.`,
    ...(can ? { recommend: { text: 'trace recommends starting it again: it carries on from what the lost attempt left on its branch.' } } : {}),
    why: 'Until it is started again, nothing does its work, and the steps that wait on it wait too.',
    action: { label: can ? 'Start it again' : 'Dismiss it', call: can ? 'job.restart' : 'job.dismiss' },
    reviewer: { summary: `The ${j.agentName ?? 'trace'} job "${j.title}" ended without finishing; it waits for a contributor to start it again.` },
    step: null, after: 'Once it is started again, trace carries on with the work. If it is no longer needed, dismiss it on the overview instead.',
    ref: { kind: 'action', id: can ? 'job.restart' : 'job.dismiss' }, jobId: j.id,
  }
}

/** The stage's steps while a lost job holds up the next step: trace's step now reads as stopped. */
export function stoppedStepsOf(repo: string, stages: Journey['stages']): Journey['stages'] {
  if (!jobsOf(repo).some((x) => x.state === 'lost' && !x.settled)) return stages
  return stages.map((s) => (s.steps ? { ...s, steps: s.steps.map((x) => (x.state === 'now' && x.owner === 'trace' ? { ...x, stopped: true } : x)) } : s))
}
