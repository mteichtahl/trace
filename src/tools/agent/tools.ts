/**
 * agent.delegate (MCP: agent_delegate): a specialist hands repository changes or long work to the retained worker,
 * waits for it, and gets its result back. It reaches the runtime it runs in (src/agents/runtime/delegation.ts)
 * through the environment the job runner gives a specialist's MCP server only: TRACE_DELEGATE_URL (loopback) and
 * TRACE_DELEGATE_TOKEN (that job's). Without them (a delegated worker, a GitHub Actions run, a local `trace mcp`) the
 * tool is not offered, which is what limits delegation to depth 1; the runtime refuses any other token too.
 *
 * The call blocks: it polls the worker job's status every TRACE_DELEGATE_POLL_MS (default 15 s) until it ends or
 * TRACE_DELEGATE_TIMEOUT_S passes (agents.delegate_timeout_minutes).
 */
import { z } from 'zod'
import { ToolError, defineTool } from '../../core/registry.js'

const BranchArg = z.string().min(1).max(200).regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/, 'not a valid branch name')
  .refine((s) => !s.includes('..') && !s.endsWith('/') && !s.endsWith('.lock') && !s.includes('//'), 'not a valid branch name')

const Started = z.object({ accepted: z.boolean(), jobId: z.string(), reason: z.string().optional() }).loose()
const Status = z.object({
  job: z.object({
    id: z.string(), state: z.enum(['running', 'succeeded', 'failed', 'aborted']),
    summary: z.string().optional(), error: z.string().optional(), endedAt: z.string().optional(), log: z.array(z.string()).default([]),
  }).loose(),
}).loose()
const ErrorBody = z.object({ error: z.string() }).loose()

export interface DelegateEnv {
  url: string
  token: string
  timeoutS: number
  pollMs: number
}

export function delegateEnv(env: NodeJS.ProcessEnv = process.env): DelegateEnv | null {
  const url = env.TRACE_DELEGATE_URL?.trim()
  const token = env.TRACE_DELEGATE_TOKEN?.trim()
  if (!url || !token) return null
  const t = Number(env.TRACE_DELEGATE_TIMEOUT_S)
  const p = Number(env.TRACE_DELEGATE_POLL_MS)
  return { url: url.replace(/\/+$/, ''), token, timeoutS: Number.isFinite(t) && t > 0 ? t : 4 * 3600, pollMs: Number.isFinite(p) && p > 0 ? p : 15_000 }
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

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))

export const delegate = defineTool({
  name: 'agent.delegate',
  description: 'Hand repository changes or long mechanical work to the trace worker (shell, git, the electronics tools; the same rules and guardrails), and wait for it. The worker works in your checkout on the branch you are on (or the one given), commits and pushes. Returns its state, its summary and commits. Then check every acceptance criterion yourself with your own tools before you report. Specialists only; one delegation at a time.',
  input: z.object({
    brief: z.string().min(1).max(20_000).describe('what to change and why, with the evidence: run ids, files, lines, measured values'),
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
    for (;;) {
      const s = Status.parse(await post(e, '/delegate/status', { token: e.token, jobId: started.jobId })).job
      if (s.state !== 'running') {
        return {
          job_id: s.id, state: s.state, summary: s.summary ?? null, error: s.error ?? null,
          next: s.state === 'succeeded'
            ? 'Check every acceptance criterion now with your own tools, in this checkout; report each with its run id.'
            : 'The worker did not finish: read the error, then delegate once more with what went wrong, or escalate.',
        }
      }
      if (Date.now() >= end) {
        return {
          job_id: s.id, state: 'timeout', summary: null, error: `still running after ${e.timeoutS} s`, log: s.log.slice(-10),
          next: 'The worker is still running and no further delegation is possible while it does: escalate with this job id.',
        }
      }
      await sleep(e.pollMs)
    }
  },
})

export const tools = [delegate]
