/**
 * Mock jobs: each project's job index as jobs.list answers it (the same jobs journey.get carries), and job.control's
 * four ops, in memory for the session, so Home's Running now, a project's "trace is doing" and Queued, and Agents and
 * tools show running, paused, held and queued work and react to Pause, Resume, Move up and Cancel.
 */
import type { AgentState, ProjectJobs, RunSummary } from '@/lib/types'

const MIN = 60_000
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()

const JOBS: Record<string, RunSummary[]> = {
  'acme/soil-sensor': [
    { id: 'job_r1', title: 'Rendering the board for the gate', state: 'running', agent: 'render', agentName: 'Rendering', where: 'On a graphics card', step: 'Rendering the top view', startedAt: ago(4 * MIN), typicalS: 420, controls: ['pause', 'cancel'], yours: true, startedBy: 'marc@example.com' },
    { id: 'job_p1', title: 'Route the power nets', state: 'paused', agent: 'impl', agentName: 'Implementation', pausedBy: 'priya@example.com', branch: 'claude/task-route-the-power-nets-3f2a1c', controls: ['resume', 'cancel'], startedBy: 'priya@example.com' },
    { id: 'job_q1', title: 'Write the test plan for Prove', state: 'queued', agent: 'verify', agentName: 'Verification', position: 1, startsWhen: 'the Verification agent is already working on this project ("Check the ERC")', controls: ['pause', 'cancel'], startedBy: 'marc@example.com', yours: true },
    { id: 'job_q2', title: 'Run SPICE corners on the LDO', state: 'queued', agent: 'verify', agentName: 'Verification', position: 2, startsWhen: '"Write the test plan for Prove" is ahead of it in the queue', controls: ['pause', 'move_up', 'cancel'], startedBy: 'priya@example.com' },
    { id: 'job_v1', title: 'Check the ERC', state: 'running', agent: 'verify', agentName: 'Verification', step: 'Running ERC on the power sheet', startedAt: ago(9 * MIN), typicalS: 600, controls: ['pause', 'cancel'], startedBy: 'priya@example.com' },
  ],
  'acme/panel-controller': [
    { id: 'job_t1', title: 'checking timing on the FPGA', state: 'running', agent: 'impl', agentName: 'Implementation', stepIndex: 2, stepCount: 4, etaS: 900, progress: 0.45, controls: ['cancel'] },
  ],
}

const AGENT_IDS = ['verify', 'impl', 'ams', 'emc', 'render', 'thermal', 'worker'] as const
const NAMES: Record<string, string> = { verify: 'Verification', impl: 'Implementation', ams: 'Analog and mixed-signal', emc: 'EMC', render: 'Rendering', thermal: 'Thermal', worker: 'Worker' }

function agentsOf(repo: string, jobs: RunSummary[]): AgentState[] {
  return AGENT_IDS.map((id) => {
    const now = jobs.filter((j) => j.agent === id && j.state === 'running')
    const queue = jobs.filter((j) => j.agent === id && j.state === 'queued').sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    const stuck = repo === 'acme/motor-driver' && id === 'thermal'
    const status: AgentState['status'] = stuck ? 'stuck' : now.length ? 'working' : queue.length ? 'queued' : 'idle'
    const says = stuck ? 'Stuck: No ambient temperature is in the requirements.' : now.length ? `Working on ${now.map((j) => `"${j.title}"`).join(', ')}` : queue.length ? `${queue.length} queued` : 'Idle'
    return { id, name: NAMES[id] ?? id, status, says, now: now.map((j) => j.id), queue: queue.map((j) => j.id), today: { runs: id === 'verify' ? 3 : 0, succeeded: id === 'verify' ? 2 : 0, medianS: id === 'verify' ? 540 : null } }
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
    return { ok: true, result: { repo, jobs, agents: agentsOf(repo, jobs), batch: [], updatedAt: new Date().toISOString() } satisfies ProjectJobs }
  }
  if (name !== 'job.control') return undefined
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
