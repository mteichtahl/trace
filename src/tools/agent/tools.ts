/**
 * agent.delegate (MCP: agent_delegate): a specialist hands repository changes or long work to the retained worker,
 * waits for it, and gets its result back. It reaches the runtime it runs in (src/agents/runtime/delegation.ts)
 * through the environment the job runner gives a specialist's MCP server only: TRACE_DELEGATE_URL (loopback) and
 * TRACE_DELEGATE_TOKEN (that job's). Without them (a delegated worker, a GitHub Actions run, a local `trace mcp`) the
 * tool is not offered, which is what limits delegation to depth 1; the runtime refuses any other token too.
 *
 * The call blocks, on an event, not a timer: it asks POST /delegate/wait { token, jobId, timeoutS }, which the runtime
 * holds until the worker job ends (jobs.ts waitForEnd) and answers that instant, or answers "still running" after
 * timeoutS (at most 240 s a call, below undici's 300 s headers timeout); then it asks again with the time left. When
 * TRACE_DELEGATE_TIMEOUT_S (agents.delegate_timeout_minutes) has passed it cancels the worker (POST /delegate/cancel)
 * and returns, and the specialist may delegate again. While it waits, the wait is on the process's record
 * (src/core/wait.ts trackEventWait: "the worker job <id>", its latest log line as the state). Claude Code waits for it: the job runner sets
 * MCP_TOOL_TIMEOUT (ms, the wall-clock limit of one MCP call) and CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT (ms; a stdio
 * server that answers nothing for 30 minutes is otherwise cut off) above the wait (src/agents/runtime/job.ts).
 */
import { z } from 'zod'
import { ToolError, defineTool } from '../../core/registry.js'
import { trackEventWait } from '../../core/wait.js'

const BranchArg = z.string().min(1).max(200).regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/, 'not a valid branch name')
  .refine((s) => !s.includes('..') && !s.endsWith('/') && !s.endsWith('.lock') && !s.includes('//'), 'not a valid branch name')

const Started = z.object({ accepted: z.boolean(), jobId: z.string(), reason: z.string().optional() }).loose()
const DelegationStateSchema = z.enum(['running', 'succeeded', 'failed', 'cancelled'])
const Status = z.object({
  job: z.object({
    id: z.string(), state: z.enum(['running', 'succeeded', 'failed', 'aborted']),
    delegation: DelegationStateSchema.optional(),
    summary: z.string().optional(), error: z.string().optional(), endedAt: z.string().optional(), log: z.array(z.string()).default([]),
  }).loose(),
}).loose()
const Cancelled = z.object({ jobId: z.string(), delegation: DelegationStateSchema }).loose()
const ErrorBody = z.object({ error: z.string() }).loose()

export interface DelegateEnv {
  url: string
  token: string
  timeoutS: number
}

/** The longest one /delegate/wait is held (the runtime caps it there too: delegation.ts MAX_WAIT_S). */
const WAIT_S = 240

export function delegateEnv(env: NodeJS.ProcessEnv = process.env): DelegateEnv | null {
  const url = env.TRACE_DELEGATE_URL?.trim()
  const token = env.TRACE_DELEGATE_TOKEN?.trim()
  if (!url || !token) return null
  const t = Number(env.TRACE_DELEGATE_TIMEOUT_S)
  return { url: url.replace(/\/+$/, ''), token, timeoutS: Number.isFinite(t) && t > 0 ? t : 4 * 3600 }
}

async function post(e: DelegateEnv, path: string, body: unknown): Promise<unknown> {
  let r: Response
  try {
    r = await fetch(`${e.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  } catch (err) {
    throw new ToolError(`agent.delegate: the runtime could not be reached (${err instanceof Error ? err.message : String(err)})`)
  }
  const json: unknown = await r.json().catch(() => ({}))
  if (!r.ok) throw new ToolError(`agent.delegate: ${ErrorBody.safeParse(json).data?.error ?? `the runtime answered ${r.status}`}`)
  return json
}

/** A log line without its timestamp, as the wait's state. */
const lastLine = (log: readonly string[]): string | null => {
  const l = log.at(-1)
  return l ? l.replace(/^\S+Z /, '').slice(0, 200) : null
}

export const delegate = defineTool({
  name: 'agent.delegate',
  description: 'Hand repository changes or long mechanical work to the trace worker (shell, git, the electronics tools; the same rules and guardrails), and wait for it. The worker works in your checkout on the branch you are on (or the one given), commits and pushes. Returns its state, its summary and commits. Then check every acceptance criterion yourself with your own tools before you report. Specialists only; one delegation at a time.',
  input: z.object({
    brief: z.string().min(1).max(15_000).describe('what to change and why, with the evidence: run ids, files, lines, measured values'),
    acceptance: z.array(z.string().min(1).max(1000)).min(1).max(20).describe('criteria you will check afterwards with your own tools: the tool, its arguments, the expected outcome'),
    branch: BranchArg.optional().describe('a branch for the work (default: the branch you are on; a new claude/ branch when that is the default branch)'),
  }),
  available: () => delegateEnv() !== null,
  run: async (a) => {
    const e = delegateEnv()
    if (!e) throw new ToolError('agent.delegate is offered to specialists on the trace runtime only')
    const started = Started.parse(await post(e, '/delegate', { token: e.token, brief: a.brief, acceptance: a.acceptance, ...(a.branch ? { branch: a.branch } : {}) }))
    if (!started.accepted) throw new ToolError(`agent.delegate: not started (${started.reason ?? 'refused'}); the running job is ${started.jobId}`)
    const end = Date.now() + e.timeoutS * 1000
    const wait = trackEventWait({ what: `the worker job ${started.jobId}`, state: 'running' })
    try {
      for (;;) {
        const left = Math.max(0, (end - Date.now()) / 1000)
        // held by the runtime until the worker ends (answered that instant) or `left` passes: no timer here
        const s = Status.parse(await post(e, '/delegate/wait', { token: e.token, jobId: started.jobId, timeoutS: Math.min(WAIT_S, left) })).job
        const state = s.delegation ?? (s.state === 'aborted' ? 'cancelled' : s.state)
        if (state !== 'running') {
          return {
            job_id: s.id, state, summary: s.summary ?? null, error: s.error ?? null,
            next: state === 'succeeded'
              ? 'Check every acceptance criterion now with your own tools, in this checkout; report each with its run id.'
              : 'The worker did not finish: read the error, then delegate once more with what went wrong, or escalate.',
          }
        }
        const line = lastLine(s.log)
        if (line) wait.update(line)
        if (Date.now() >= end) {
          // a worker that outran the wait is stopped, so it cannot keep changing the checkout under the specialist
          const c = Cancelled.parse(await post(e, '/delegate/cancel', { token: e.token, jobId: s.id, reason: `agent.delegate waited ${e.timeoutS} s` }))
          return {
            job_id: s.id, state: 'timeout', delegation: c.delegation, summary: null, error: `still running after ${e.timeoutS} s: the worker was stopped`, log: s.log.slice(-10),
            next: 'The worker ran out of time and was stopped. Look at what it committed (git log), then delegate again with a smaller brief, or escalate with this job id.',
          }
        }
      }
    } finally {
      wait.end()
    }
  },
})

export const tools = [delegate]
