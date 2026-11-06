/**
 * A job's own limits (src/agents/runtime/job.ts, src/core/config.ts agents.<kind>.max_usd and max_turns): each
 * specialist job runs with a spend limit (the Agent SDK's maxBudgetUsd) and a turn limit, and one that reaches either
 * stops and asks, with its work kept, rather than running on (test-esp32 #72, #100: a stuck documentation job spent on)
 * or failing so that its work is done again from the start. A person's task pauses (Resume carries it on); a job that
 * cannot be paused ends saying where its work is.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { type ClaudeOptions, type Exec, type RunnerDeps, createRunner, limitWords } from '../../src/agents/runtime/job.js'
import { JobPaused, type JobRunner, createJobs } from '../../src/agents/runtime/jobs.js'
import type { HandoffTaskJob, JobPayload } from '../../src/agents/runtime/schemas.js'
import { SPECIALIST_MAX_TURNS, SPECIALIST_MAX_USD } from '../../src/core/config.js'
import { cfgOf, fakeGithub } from '../harness/fake.js'

const root = mkdtempSync(join(tmpdir(), 'trace-spend-limit-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const REPO = 'acme/board'
const SESSION = '11111111-2222-3333-4444-555555555555'
const docsTask = (request = 'Bring the documents up to date.'): JobPayload => ({ kind: 'task', repository: REPO, request, requestedBy: 'm@example.com', requestedBySub: 'sub-m', agent: 'docs' })

/** A runner whose Claude ends with `result` (the SDK's result message), recording its options, git commands and saves. */
function rig(result: Record<string, unknown>, cfg = cfgOf()) {
  const ws = mkdtempSync(join(root, 'ws-'))
  const cmds: string[] = []
  const saved: string[] = []
  const got: { options?: ClaudeOptions } = {}
  const exec: Exec = async (_c, args) => { cmds.push(args.join(' ')); return { stdout: args[0] === 'status' ? ' M docs/design/high-level-design.md\n' : args[0] === 'rev-parse' ? 'abc1234\n' : '', stderr: '' } }
  const d: RunnerDeps = {
    exec, getToken: async () => 'ghs_TESTTOKEN1234567890abcdef', github: () => fakeGithub({ 'repos.get': { default_branch: 'main' }, 'issues.listComments': [] }).gh,
    claude: (a) => {
      got.options = a.options
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: SESSION }
        yield { type: 'result', num_turns: 30, session_id: SESSION, ...result }
      })()
    },
    settingsOf: () => cfg, remoteSettings: async () => cfg, workspace: ws, persistent: false, cli: '/app/dist/cli.js', timeoutS: 60, env: {}, now: Date.now,
    paused: { save: async (job, session) => { saved.push(`${job}:${session}`); return true }, restore: async () => false, read: async () => null },
  }
  const ctx = { jobId: 'job-d', signal: new AbortController().signal, pauseSignal: new AbortController().signal, log: () => undefined, startJob: () => ({ accepted: true, jobId: 'x' }) }
  return { run: (p: JobPayload) => createRunner(d)(p, ctx), cmds, saved, got }
}

describe('each specialist\'s limits', () => {
  it('a documentation job may spend US$5 and take 60 turns; the others keep 120 turns, the layout\'s specialist US$25', () => {
    const cfg = cfgOf()
    expect(cfg.agents.docs).toMatchObject({ max_usd: 5, max_turns: 60 })
    expect(cfg.agents.impl).toMatchObject({ max_usd: 25, max_turns: 120 })
    expect(cfg.agents.verify).toMatchObject({ max_usd: 10, max_turns: 120 })
    expect(SPECIALIST_MAX_USD.impl).toBeGreaterThan(17.74) // the dearest job of run 2: the layout, US$17.74 (#145)
    expect(SPECIALIST_MAX_TURNS.docs).toBeGreaterThan(41) // the longest documentation job of the run: 41 turns (#73)
    // a project sets its own, or none
    expect(cfgOf({ agents: { docs: { max_usd: 0, max_turns: 90 } } }).agents.docs).toMatchObject({ max_usd: 0, max_turns: 90 })
  })

  it('says the limit as what paused the job', () => {
    expect(limitWords({ kind: 'spend', limit: 5, spent: 5.03 })).toBe('its spend limit of US$5 a job')
    expect(limitWords({ kind: 'spend', limit: 2.5, spent: null })).toBe('its spend limit of US$2.50 a job')
    expect(limitWords({ kind: 'turns', limit: 60, spent: null })).toBe('its limit of 60 turns')
  })
})

describe('a job that reaches its limit stops and asks, with its work kept', () => {
  it('runs a documentation job with its spend and turn limits', async () => {
    const r = rig({ subtype: 'success', is_error: false, result: 'Wrote Overview.' })
    await r.run(docsTask())
    expect(r.got.options).toMatchObject({ maxBudgetUsd: 5, maxTurns: 60 })
  })

  it('no spend limit when the project set none', async () => {
    const r = rig({ subtype: 'success', is_error: false, result: 'ok' }, cfgOf({ agents: { docs: { max_usd: 0 } } }))
    await r.run(docsTask())
    expect(r.got.options).not.toHaveProperty('maxBudgetUsd')
  })

  it('pauses at its spend limit: the work committed and pushed, the conversation kept, Resume offered', async () => {
    const r = rig({ subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 5.03, errors: ['Reached maximum budget ($5)'] })
    const err = await r.run(docsTask()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JobPaused)
    expect((err as JobPaused).by).toBe('its spend limit of US$5 a job')
    expect((err as Error).message).toMatch(/^The Documentation specialist stopped at its spend limit of US\$5 a job \(it spent about US\$5\.03\), before it finished\. Paused at a safe point: its work is on claude\/task-[^ ]+ \(abc1234, with a "paused" commit .*Resume continues it\. Resume it to carry on, or leave it\.$/)
    expect(r.cmds.some((c) => c.startsWith('commit -m trace: paused (job-d)\n\nStopped at its spend limit of US$5 a job.'))).toBe(true)
    expect(r.cmds.some((c) => c.startsWith('push origin HEAD:refs/heads/claude/task-'))).toBe(true)
    expect(r.saved).toEqual([`job-d:${SESSION}`])
  })

  it('pauses at its turn limit too, rather than failing and being done again from the start', async () => {
    const r = rig({ subtype: 'error_max_turns', is_error: true, num_turns: 60 })
    const err = await r.run(docsTask()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JobPaused)
    expect((err as JobPaused).by).toBe('its limit of 60 turns')
    expect((err as Error).message).toMatch(/^The Documentation specialist stopped at its limit of 60 turns, before it finished\./)
  })

  it('a job that cannot be paused (a hand-off) ends saying where its work is, and that a new job carries it on', async () => {
    const handoff: HandoffTaskJob = {
      kind: 'task', repository: REPO, request: 'Write the Board section.', requestedBy: 'm@example.com', agent: 'docs',
      handoff: { id: 'ho0123456789abcd', from: 'impl', fromJob: 'job-i', question: 'Write the Board section.', blocks: 'the Layout gate', evidence: [{ kind: 'run', ref: 'r1' }], recommendation: null, acceptance: ['docs_check passes'], depth: 1 },
    }
    const r = rig({ subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 5.2 })
    const err = await r.run(handoff).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(JobPaused)
    expect((err as Error).message).toMatch(/stopped at its spend limit of US\$5 a job \(it spent about US\$5\.20\), before it finished\. Its work so far: its work is on claude\/handoff-ho0123456789abcd \(abc1234.*\)\. Start it again to carry on from there\.$/)
    expect((err as Error).message).not.toMatch(/Resume/)
    expect(r.saved).toEqual([])
  })

  it('the job ends paused, and what paused it is its limit, not a person', async () => {
    const runner: JobRunner = async () => { throw new JobPaused('The Documentation specialist stopped at its spend limit of US$5 a job.', 'its spend limit of US$5 a job') }
    const jobs = createJobs(runner, { echo: () => undefined })
    try {
      const t = jobs.startJob(docsTask())
      await jobs.waitForEnd(t.jobId!, { timeoutMs: 3000 })
      expect(jobs.jobStatus(t.jobId)[0]).toMatchObject({ state: 'paused', summary: expect.stringMatching(/spend limit/), pause: { by: 'its spend limit of US$5 a job' } })
    } finally {
      jobs.dispose()
    }
  })
})
