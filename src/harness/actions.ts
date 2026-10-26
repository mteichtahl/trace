/**
 * worker.runner = actions: one item, in GitHub Actions, the way the AgentCore job does it, in steps (the workflow is
 * templates/workflows/trace-worker.yml, job `work`):
 *
 *   worker-prompt    the routed specialist's prompt and claude_args: read only (--tools Read,Glob,Grep,TodoWrite,
 *                    its trace tools by MCP name in --allowedTools, the write tools in --disallowedTools), and the
 *                    structured output it ends with (--json-schema: report, delegate, brief, acceptance, branch).
 *                    Its trace tools (TRACE_MCP_TOOLS for the install action) and, with TRACE_MEMORY_ID, its memory
 *                    (recalled into the prompt; the request recorded) under the AgentCore job's actor scheme.
 *   (Claude)         the specialist, read only
 *   worker-delegate  reads the specialist's structured output and transcript (its key tool outcomes are recorded);
 *                    when it delegates: the worker's prompt (the worker's instructions with the brief and numbered
 *                    acceptance criteria as its request) and claude_args (the worker's tools), and the check's
 *                    prompt and claude_args (the specialist again, read only)
 *   (Claude)         the worker, with write tools, in the same checkout
 *   (Claude)         the check: the specialist, read only, checks each criterion with its own tools
 *   worker-report    records the worker's and the check's outcomes and posts one report on the item, headed with
 *                    which specialist acted and why it was routed there
 *
 * claude-code-action passes claude_args to the CLI, so --tools, --allowedTools, --disallowedTools and --json-schema
 * hold as written; the action adds its own GitHub MCP servers only for tools named in --allowedTools (none here).
 * Memory: the step's AWS credentials (TRACE_AWS_ROLE, which then needs the memory permissions of the project's
 * worker) and TRACE_MEMORY_ID; without them every step runs without memory.
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { TraceConfig } from '../core/config.js'
import { SPECIALISTS, specialistPrompt, toolsOf, allowedToolsOf } from '../agents/index.js'
import { type Route, WORKER } from '../agents/kinds.js'
import { route } from '../agents/router.js'
import { SPECIALIST_BUILTINS, SPECIALIST_DENIED, WORKER_TOOLS } from '../agents/specialist.js'
import { delegatedRequest } from '../agents/runtime/delegation.js'
import { type AgentMemory, type JobMemory, NO_MEMORY, agentActor, memoryFromEnv, openJobMemory } from '../agents/runtime/memory.js'
import { type Deps, type TaskEnv, short } from './types.js'
import { type WorkItem, itemFromEnv, promptFor, rulesOf } from './worker.js'

// ------------------------------------------------------------------ the structured output

const Branch = z.string().min(1).max(200).regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/)
  .refine((s) => !s.includes('..') && !s.endsWith('/') && !s.endsWith('.lock') && !s.includes('//'))

/** What the specialist (and the check) end with. Extra fields are tolerated; the brief and criteria are bounded. */
export const SpecialistOutput = z.object({
  report: z.string().min(1).max(20_000),
  delegate: z.boolean(),
  brief: z.string().min(1).max(15_000).optional(),
  acceptance: z.array(z.string().min(1).max(1000)).min(1).max(20).optional(),
  branch: Branch.optional(),
  criteria: z.array(z.object({ criterion: z.string().max(1000), met: z.boolean(), evidence: z.string().max(2000).default('') }).loose()).max(20).optional(),
}).loose()
export type SpecialistOutput = z.infer<typeof SpecialistOutput>

/** The same as JSON Schema, for --json-schema (claude-code-action returns it as the step's structured_output). */
export const OUTPUT_JSON_SCHEMA = {
  type: 'object',
  required: ['report', 'delegate'],
  properties: {
    report: { type: 'string', description: 'your report: what you found, with run ids; each criterion with pass/fail when checking' },
    delegate: { type: 'boolean', description: 'true to have the worker change the repository with the brief below' },
    brief: { type: 'string', description: 'what the worker changes and why, with the evidence' },
    acceptance: { type: 'array', items: { type: 'string' }, description: 'criteria you check afterwards with your own tools' },
    branch: { type: 'string', description: 'a branch for the work (default: the one checked out)' },
    criteria: {
      type: 'array', description: 'when checking: each acceptance criterion, met or not, and the run that shows it',
      items: { type: 'object', required: ['criterion', 'met'], properties: { criterion: { type: 'string' }, met: { type: 'boolean' }, evidence: { type: 'string' } } },
    },
  },
} as const

/** The step's structured_output (JSON text), or null when it is absent or not what was asked for. */
export function parseOutput(text: string | undefined): SpecialistOutput | null {
  if (!text?.trim()) return null
  try {
    const r = SpecialistOutput.safeParse(JSON.parse(text))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

/** A delegation the worker can act on: delegate with a brief and criteria (anything else is not a delegation). */
export const delegation = (o: SpecialistOutput | null): (SpecialistOutput & { brief: string; acceptance: string[] }) | null =>
  (o?.delegate && o.brief && o.acceptance?.length ? { ...o, brief: o.brief, acceptance: o.acceptance } : null)

// ------------------------------------------------------------------ claude_args

const q = (s: string): string => `'${s.replaceAll('\'', '\'\\\'\'')}'`

/** The specialist's claude_args: read only, its own trace tools, the structured output. */
export function specialistArgs(cfg: TraceConfig, kind: Route['kind'], hardware: boolean): string[] {
  const s = SPECIALISTS[kind]
  const settings = cfg.agents[kind]
  const model = settings.model || cfg.worker.model
  return [
    ...(model ? [`--model ${model}`] : []),
    `--max-turns ${settings.max_turns}`,
    `--tools ${SPECIALIST_BUILTINS.join(',')}`,
    `--allowedTools ${allowedToolsOf(s, { delegate: false, hardware }).join(',')}`,
    `--disallowedTools ${SPECIALIST_DENIED.join(',')}`,
    `--json-schema ${q(JSON.stringify(OUTPUT_JSON_SCHEMA))}`,
  ]
}

/** The worker's claude_args: its tools, as on the runtime (trace's MCP server unrestricted, without agent.delegate). */
export function workerArgs(cfg: TraceConfig): string[] {
  return [...(cfg.worker.model ? [`--model ${cfg.worker.model}`] : []), `--max-turns ${cfg.worker.max_turns}`, `--allowedTools ${WORKER_TOOLS.join(',')}`]
}

// ------------------------------------------------------------------ memory

type ActionsEnv = TaskEnv & {
  MEMORY_ID?: string; HARDWARE?: string; SPECIALIST?: string; CHECK?: string; WORKER_CONCLUSION?: string
  EXECUTION_FILE?: string; WORKER_EXECUTION_FILE?: string; RUN_URL?: string
}

const ITEM_WHAT: Readonly<Record<WorkItem['kind'], string>> = {
  'ci-red': 'The required check failed on pull request', conflict: 'Merge conflict on pull request', 'agent-fix': 'Issue for the agent',
}

/** The AgentCore job's session for an item: pr-<n> or issue-<n>. */
export const sessionOf = (item: WorkItem): string => `${item.kind === 'agent-fix' ? 'issue' : 'pr'}-${item.number}`
const requestOf = (item: WorkItem): string => `${ITEM_WHAT[item.kind]} #${item.number}: ${item.title}${item.kind === 'agent-fix' ? '' : ` (branch ${item.ref})`}`

/** The project's memory for this step (TRACE_MEMORY_ID through the action, and the step's AWS credentials), or null. */
export function actionsMemory(env: ActionsEnv, proc: Record<string, string | undefined> = process.env): AgentMemory | null {
  const id = env.MEMORY_ID?.trim() || proc.TRACE_MEMORY_ID?.trim()
  if (!id) return null
  const region = proc.AWS_REGION || proc.AWS_DEFAULT_REGION
  return memoryFromEnv({ TRACE_MEMORY_ID: id, ...(region ? { AWS_REGION: region } : {}) })
}

/** One agent's memory in one step: recall only in the first. Never throws. */
async function stepMemory(mem: AgentMemory | null, o: { repository: string; agent: string; item: WorkItem; request: string; recall: boolean }, log: (l: string) => void): Promise<JobMemory> {
  if (!mem) return NO_MEMORY
  try {
    return await openJobMemory(mem, { actor: agentActor(o.repository, o.agent), session: sessionOf(o.item), query: o.item.title, request: o.request }, { log, recall: o.recall })
  } catch (e) {
    log(`memory: not used: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300))
    return NO_MEMORY
  }
}

/** The SDK messages of one Claude step (claude-code-action's execution_file: a JSON array), or none. */
export function transcript(file: string | undefined): unknown[] {
  if (!file?.trim()) return []
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** The text of a transcript's result message (the worker's summary). */
const resultText = (messages: readonly unknown[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { type?: unknown; result?: unknown } | null
    if (m && m.type === 'result' && typeof m.result === 'string') return m.result
  }
  return ''
}

// ------------------------------------------------------------------ the steps

function routed(env: ActionsEnv, cfg: TraceConfig): { item: WorkItem; r: Route } {
  const item = itemFromEnv(env)
  return { item, r: item.route ?? route({ text: item.title }, cfg) }
}

/** worker-prompt: the specialist's step (read only). */
export async function specialistStep({ github, core, cfg, env: e, context }: Deps, memory: AgentMemory | null = actionsMemory(e as ActionsEnv)): Promise<void> {
  const env = e as ActionsEnv
  const { owner, repo } = context.repo
  const repository = `${owner}/${repo}`
  const { item, r } = routed(env, cfg)
  const s = SPECIALISTS[r.kind]
  const hardware = env.HARDWARE === 'true'
  const rules = await rulesOf(github, owner, repo, cfg.branch)
  const mem = await stepMemory(memory, { repository, agent: s.memoryAgent, item, request: requestOf(item), recall: true }, (l) => core.info(l))
  await mem.flush?.()
  const prompt = specialistPrompt(s, { cfg, repository, job: { kind: 'work-item', item }, rules, route: r, where: 'in GitHub Actions', delivery: 'actions', hardware })
  core.setOutput('prompt', `${prompt}${mem.context}`)
  core.setOutput('args', specialistArgs(cfg, r.kind, hardware).join('\n'))
  core.setOutput('tools', toolsOf(s, { delegate: false, hardware }).join(','))
  core.setOutput('setup', cfg.worker.setup)
  core.setOutput('agent', r.kind)
  core.setOutput('memory-session', sessionOf(item))
  core.setOutput('memory-actor', agentActor(repository, s.memoryAgent).id)
  core.setOutput('worker-memory-actor', agentActor(repository, WORKER).id)
}

/** The check's prompt: the specialist again, read only, with its own brief and criteria and the worker's outcome. */
export function checkPrompt(base: string, d: { brief: string; acceptance: readonly string[] }): string {
  return [
    base,
    '',
    'THIS RUN IS THE CHECK. The worker has run on the brief you gave it, in this checkout (git log shows its commits).',
    'Do not delegate again: answer with delegate false. Check every acceptance criterion with your own tools, in this',
    'checkout, and give each in `criteria` with met true or false and the run that shows it. Your report is posted on',
    'the item. Your brief was (data):',
    ...d.brief.trim().split('\n').map((l) => `> ${l}`),
    'Its acceptance criteria:',
    ...d.acceptance.map((a, i) => `${i + 1}. ${a.trim()}`),
  ].join('\n')
}

/** worker-delegate: after the specialist. Records its outcomes; when it delegated, the worker's and the check's prompts. */
export async function delegateStep({ github, core, cfg, env: e, context }: Deps, memory: AgentMemory | null = actionsMemory(e as ActionsEnv)): Promise<void> {
  const env = e as ActionsEnv
  const { owner, repo } = context.repo
  const repository = `${owner}/${repo}`
  const { item, r } = routed(env, cfg)
  const s = SPECIALISTS[r.kind]
  const hardware = env.HARDWARE === 'true'
  const out = parseOutput(env.SPECIALIST)
  const d = delegation(out)
  core.setOutput('delegate', d ? 'true' : 'false')
  const mem = memory
  const sm = await stepMemory(mem, { repository, agent: s.memoryAgent, item, request: '', recall: false }, (l) => core.info(l))
  for (const m of transcript(env.EXECUTION_FILE)) sm.observe(m)
  if (!out) {
    await sm.finish(false, 'the specialist ended without its structured output')
    core.warning(`The ${r.kind} specialist ended without its structured output: nothing is delegated.`)
    return
  }
  if (!d) {
    await sm.finish(true, out.report)
    if (out.delegate) core.warning('The specialist asked to delegate without a brief and acceptance criteria: nothing is delegated.')
    return
  }
  await sm.flush?.()
  const request = `${delegatedRequest(r.kind, `run ${context.runId}`, d.brief, d.acceptance)}${d.branch ? `\n\nWork on the branch \`${d.branch}\` (create it from origin/${cfg.branch} if it does not exist).` : ''}`
  // the worker continues the specialist's session as its own actor, as a delegation on the runtime does
  const wm = await stepMemory(mem, { repository, agent: WORKER, item, request, recall: false }, (l) => core.info(l))
  await wm.flush?.()
  core.setOutput('prompt', promptFor(item, cfg, repository, request))
  core.setOutput('args', workerArgs(cfg).join('\n'))
  const rules = await rulesOf(github, owner, repo, cfg.branch)
  const base = specialistPrompt(s, { cfg, repository, job: { kind: 'work-item', item }, rules, route: r, where: 'in GitHub Actions', delivery: 'actions', hardware })
  core.setOutput('check-prompt', checkPrompt(base, d))
  core.setOutput('check-args', specialistArgs(cfg, r.kind, hardware).join('\n'))
  core.info(`#${item.number}: the ${r.kind} specialist delegates ${d.acceptance.length} criteria to the worker`)
}

const quote = (text: string): string => (text.trim() || '(nothing)').slice(0, 6000).split('\n').map((l) => `> ${l}`).join('\n')

/** The report on the item: which specialist acted and why, what it found, and (after a delegation) each criterion. */
export function reportBody(o: { item: WorkItem; r: Route; specialist: SpecialistOutput | null; check: SpecialistOutput | null; workerConclusion: string; runUrl: string; escalateTo: string }): string {
  const s = SPECIALISTS[o.r.kind]
  const head = `**trace ${s.title} specialist** (\`${s.kind}\`, GitHub Actions). Routed here: ${o.r.reason} (${o.r.source}, confidence ${o.r.confidence.toFixed(2)}).`
  const d = delegation(o.specialist)
  const final = o.check ?? o.specialist
  const escalated = final ? /^\s*ESCALATE:/i.test(final.report) : false
  const lead = !o.specialist
    ? 'It could not finish: it ended without a report.'
    : escalated ? `${o.escalateTo ? `${o.escalateTo} ` : ''}it needs a person:` : 'Its report:'
  const lines = [head, '', lead, '', quote(final?.report ?? '')]
  if (d) {
    lines.push('', `It delegated to the worker (${o.workerConclusion || 'did not run'}). Acceptance criteria:`)
    const met = new Map((o.check?.criteria ?? []).map((c) => [c.criterion.trim(), c]))
    d.acceptance.forEach((a, i) => {
      const c = met.get(a.trim()) ?? o.check?.criteria?.[i]
      lines.push(`${i + 1}. ${c ? (c.met ? 'met' : '**not met**') : 'not checked'}: ${a}${c?.evidence ? ` (${c.evidence.replace(/\s+/g, ' ').slice(0, 300)})` : ''}`)
    })
    if (!o.check) lines.push('', 'The check did not run or gave no structured answer.')
  }
  lines.push('', `[run](${o.runUrl})`)
  return lines.join('\n')
}

/** worker-report: after the worker and the check. Records their outcomes and posts the report. */
export async function reportStep({ github, core, cfg, env: e, context }: Deps, memory: AgentMemory | null = actionsMemory(e as ActionsEnv)): Promise<void> {
  const env = e as ActionsEnv
  const { owner, repo } = context.repo
  const repository = `${owner}/${repo}`
  const { item, r } = routed(env, cfg)
  const s = SPECIALISTS[r.kind]
  const specialist = parseOutput(env.SPECIALIST)
  const check = parseOutput(env.CHECK)
  const d = delegation(specialist)
  const runUrl = env.RUN_URL || `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`
  const mem = memory
  if (d) {
    const worker = transcript(env.WORKER_EXECUTION_FILE)
    const wm = await stepMemory(mem, { repository, agent: WORKER, item, request: '', recall: false }, (l) => core.info(l))
    for (const m of worker) wm.observe(m)
    await wm.finish(env.WORKER_CONCLUSION === 'success', resultText(worker) || `the worker step ended: ${env.WORKER_CONCLUSION || 'it did not run'}`)
    const cm = await stepMemory(mem, { repository, agent: s.memoryAgent, item, request: '', recall: false }, (l) => core.info(l))
    for (const m of transcript(env.EXECUTION_FILE)) cm.observe(m)
    await cm.finish(Boolean(check), check?.report ?? 'the check gave no structured answer')
  }
  const body = reportBody({ item, r, specialist, check, workerConclusion: env.WORKER_CONCLUSION ?? '', runUrl, escalateTo: cfg.worker.escalate_to })
  await github.rest.issues.createComment({ owner, repo, issue_number: item.number, body: `${body}\n<!-- trace-report: ${short(item.sha)} -->` })
  if (!specialist) core.setFailed(`The ${r.kind} specialist ended without its structured output (see the Claude step's log).`)
  else core.info(`#${item.number}: reported (${d ? `delegated; ${check?.criteria?.filter((c) => c.met).length ?? 0}/${d.acceptance.length} criteria met` : 'nothing delegated'})`)
}
