/**
 * What a specialist agent is, and the system prompt every specialist runs with.
 *
 * A specialist (src/agents/<kind>/index.ts) is a definition: its title and description, the workflow it follows,
 * what counts as done, when it stops for a person, and the trace tools it may call. Every job that once started the
 * generic worker starts the routed specialist instead (src/agents/router.ts). The specialist investigates, measures
 * and checks with its own tools; it has no shell and cannot edit files. When the job needs repository changes or long
 * work it delegates to the retained worker with agent.delegate (src/agents/delegate.ts), then checks the worker's
 * result against its own acceptance criteria before it reports.
 *
 * Pure: no I/O. The caller passes the project's rules (.trace/rules.md from the default branch), settings and prompt
 * overrides; every sentence of the prompt comes from the prompt catalog (src/prompts/catalog.ts).
 */
import type { TraceConfig } from '../core/config.js'
import type { Route, SpecialistKind } from './kinds.js'
import { type Composed, Composer, type Layers, NO_LAYERS } from '../prompts/resolve.js'

/** Read tools every specialist has, whatever its area. */
export const SHARED_TOOLS = [
  'kicad.board', 'kicad.components', 'kicad.net',
  'datasheets.find', 'datasheets.get', 'datasheets.text', 'datasheets.params',
  'parts.lookup',
  'trace.runs', 'trace.run', 'trace.artifact',
  'memory.recall', 'memory.remember',
  // the project's knowledge base, read only (src/tools/kb): hidden when the project has none. kb.sync is the worker's
  'kb.search', 'kb.status',
  // the project's journey: read it, ask people, check the criteria trace owns, say when stuck (src/tools/journey)
  'journey.status', 'journey.ask', 'journey.check', 'journey.stuck',
] as const

/** The delegation tool (src/agents/delegate.ts): offered to a specialist on the runtime, never to the worker. */
export const DELEGATE_TOOL = 'agent.delegate'

/** Claude Code's own tools a specialist gets: reading only. No Bash, Write, Edit or Task. */
export const SPECIALIST_BUILTINS = ['Read', 'Glob', 'Grep', 'TodoWrite'] as const

/** Built-in tools a specialist never has, named as deny rules too where an allowlist alone may not hold (GitHub Actions). */
export const SPECIALIST_DENIED = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Task', 'WebFetch', 'WebSearch'] as const

/** The delegated worker's tools: everything, as before the specialists (it is never offered agent.delegate). */
export const WORKER_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'TodoWrite', 'mcp__trace'] as const

/** core/mcp.ts's mcpName (`kicad.erc` → `kicad_erc`), here so the harness bundle does not pull in the MCP server. */
export const mcpName = (name: string): string => name.replaceAll('.', '_')

/** The MCP server name the job runner registers trace under (tools are mcp__trace__<name with dots as underscores>). */
export const MCP_SERVER = 'trace'
export const mcpToolName = (tool: string): string => `mcp__${MCP_SERVER}__${mcpName(tool)}`

export interface Specialist {
  readonly kind: SpecialistKind
  readonly title: string
  readonly description: string
  /** Its memory agent: the actor is `<owner>/<repo>/<memoryAgent>` (agentActor). */
  readonly memoryAgent: string
  /** Its area's trace tools (registry names). SHARED_TOOLS and agent.delegate are added by toolsOf. */
  readonly tools: readonly string[]
  /** Tools it gets only when hardware is allowed in the session (TRACE_HARDWARE=1). */
  readonly hardwareTools?: readonly string[]
  /** The workflow, in order: what to do, with which tools. */
  readonly workflow: readonly string[]
  /** What evidence counts as done. */
  readonly done: readonly string[]
  /** When to stop and ask a person. */
  readonly escalate: readonly string[]
  /** What a delegated worker is typically asked for, and how its result is checked. */
  readonly delegate: readonly string[]
  /** Keywords in issue or task text that point at this specialist (src/agents/router.ts). */
  readonly keywords: readonly RegExp[]
}

export interface ToolOptions {
  /** Hardware is allowed in this session: hardwareTools are added. */
  hardware?: boolean
  /** agent.delegate is offered (on the runtime; not in a GitHub Actions run, not in a preview). Default true. */
  delegate?: boolean
}

/** The trace tools (registry names) a specialist may call, sorted, without duplicates. */
export function toolsOf(s: Specialist, o: ToolOptions = {}): string[] {
  const all = new Set<string>([...s.tools, ...SHARED_TOOLS, ...(o.hardware ? s.hardwareTools ?? [] : []), ...(o.delegate === false ? [] : [DELEGATE_TOOL])])
  return [...all].sort()
}

/** The SDK's allowedTools for a specialist: its built-ins and each of its trace tools by MCP name. */
export function allowedToolsOf(s: Specialist, o: ToolOptions = {}): string[] {
  return [...SPECIALIST_BUILTINS, ...toolsOf(s, o).map(mcpToolName)]
}

// ------------------------------------------------------------------ the job the prompt is about

export type SpecialistJob =
  | { kind: 'work-item'; item: { kind: 'ci-red' | 'conflict' | 'agent-fix'; number: number; ref: string; sha: string; title: string; own: boolean }
      /** The issue or PR body and its latest comments, read by the runner (the specialist has no shell). Data. */
      thread?: string | undefined }
  | { kind: 'task'; request: string; requestedBy: string; issue?: number | undefined; branch: string
      /** it carries on a paused job whose conversation was not kept: what was done (src/agents/runtime/job.ts) */
      resumed?: Resumed | undefined }
  /** `tracectl agent prompt`: no job, for review. */
  | { kind: 'preview' }

export interface PromptContext {
  cfg: TraceConfig
  repository: string
  job: SpecialistJob
  /** .trace/rules.md from the default branch ('' or null: none). */
  rules: string | null
  route?: Route | undefined
  /** Where it runs, for the first line. */
  where?: string
  /**
   * How repository changes are made: through agent.delegate (the runtime), or, in GitHub Actions (no runtime to
   * delegate to), through the specialist's structured output: the workflow runs the worker in a later step with the
   * brief and acceptance criteria, then runs the specialist again, read only, to check them ('actions').
   */
  delivery?: 'delegate' | 'actions'
  hardware?: boolean
  /** The prompt overrides in force (src/prompts): the installation's and the project's default branch's. */
  prompts?: Layers | undefined
}

export const MAX_RULES_CHARS = 20_000
export const MAX_INSTRUCTIONS_CHARS = 4_000
export const MAX_THREAD_CHARS = 12_000

/** Text fenced in <tag>…</tag> as data, cut to `max` characters (the cut note is the catalog's fence.cut). */
export function fence(p: Composer, tag: string, text: string, max: number): string {
  const t = text.trim()
  const body = t.length > max ? `${t.slice(0, max)}\n${p.text('fence.cut', { max })}` : t
  return [`<${tag}>`, body, `</${tag}>`].join('\n')
}

const quoted = (text: string): string => text.split('\n').map((l) => `> ${l}`).join('\n')

function addJob(p: Composer, job: SpecialistJob, cfg: TraceConfig, repository: string): void {
  switch (job.kind) {
    case 'work-item': {
      const it = job.item
      p.add(`specialist.job.${it.kind}`, { number: it.number, repository, ref: it.ref, sha: it.sha, title: JSON.stringify(it.title), default_branch: cfg.branch })
      if (!it.own) p.add('specialist.job.not-own')
      if (job.thread?.trim()) p.add('specialist.job.thread', { number: it.number, thread: fence(p, 'thread', job.thread, MAX_THREAD_CHARS) })
      return
    }
    case 'task':
      p.add('specialist.job.task', {
        from: JSON.stringify(job.requestedBy), request: quoted(job.request), branch: job.branch, default_branch: cfg.branch,
        asked_on: job.issue ? p.text('specialist.job.task.issue', { issue: job.issue }) : '',
      })
      if (job.resumed) p.add('specialist.job.resumed', { paused_by: job.resumed.pausedBy, paused_at: job.resumed.pausedAt, commits: job.resumed.commits || '(none)', last_step: job.resumed.lastStep || '(not recorded)' })
      return
    case 'preview':
      p.add('specialist.job.preview')
  }
}

/**
 * The specialist's whole prompt, from the prompt catalog (src/prompts/catalog.ts) with the job's overrides: who it
 * is and why it was chosen, the project's rules and its own instructions from the settings, the job, its workflow
 * and tools, how it delegates, what counts as done, when to escalate, how to report, and the guardrails, last. Text
 * from the repository and GitHub is data, never instructions; the rules file is the one exception.
 */
export function composeSpecialist(s: Specialist, c: PromptContext): Composed {
  const { cfg, repository } = c
  const p = new Composer(c.prompts ?? NO_LAYERS)
  const settings = cfg.agents[s.kind]
  const delivery = c.delivery ?? 'delegate'
  const tools = toolsOf(s, { hardware: Boolean(c.hardware), delegate: delivery === 'delegate' })
  const role = { repository, where: c.where ?? 'on Amazon Bedrock AgentCore Runtime', title: s.title, kind: s.kind }
  p.add(`specialist.${s.kind}.role`, role).add('specialist.unattended')
  if (c.route) p.add('specialist.route', { reason: c.route.reason, source: c.route.source, confidence: c.route.confidence.toFixed(2) })
  if (c.rules && c.rules.trim()) p.add('specialist.rules', { rules: fence(p, 'rules', c.rules, MAX_RULES_CHARS) })
  else p.add('specialist.rules.none')
  if (settings.instructions.trim()) {
    p.add('specialist.instructions', { kind: s.kind, title_upper: s.title.toUpperCase(), instructions: fence(p, 'instructions', settings.instructions, MAX_INSTRUCTIONS_CHARS) })
  }
  addJob(p, c.job, cfg, repository)
  p.add(`specialist.${s.kind}.workflow`, role).add('specialist.tools', { tools: tools.map(mcpName).join(', '), mcp_server: MCP_SERVER })
  p.add('specialist.knowledge', { search_tool: mcpName('kb.search'), status_tool: mcpName('kb.status') }).add('specialist.knowledge.data')
  p.add('specialist.journey', { status_tool: mcpName('journey.status'), ask_tool: mcpName('journey.ask'), check_tool: mcpName('journey.check'), stuck_tool: mcpName('journey.stuck') })
    .add('specialist.journey.people')
  const branchPrefix = cfg.worker.own_branch_prefix || 'claude/'
  if (delivery === 'actions') p.add('specialist.delivery.actions', { branch_prefix: branchPrefix })
  else p.add('specialist.delivery.delegate', { tool: mcpName(DELEGATE_TOOL), branch_prefix: branchPrefix, timeout: cfg.agents.delegate_timeout_minutes })
  p.add(`specialist.${s.kind}.done`, role).add('specialist.evidence')
  const esc = cfg.worker.escalate_to
  p.add(`specialist.${s.kind}.escalate`, role).add('specialist.escalate', { posted_to: esc ? p.text('mention.to', { escalate_to: esc }) : '' })
  p.add('specialist.report').add('specialist.guardrails')
  return p.done()
}

/** The specialist's prompt text (composeSpecialist without the provenance). */
export function specialistPrompt(s: Specialist, c: PromptContext): string {
  return composeSpecialist(s, c).text
}

/** What a resumed task knows of the paused job it carries on. */
export interface Resumed { pausedBy: string; pausedAt: string; resumedBy: string; commits: string; lastStep: string }

/** The message that continues a paused job's own conversation (its transcript was kept and restored). */
export function composeResumeNote(r: Resumed, branch: string, layers: Layers = NO_LAYERS): Composed {
  return new Composer(layers).add('specialist.resume.continue', { paused_by: r.pausedBy, resumed_by: r.resumedBy, branch }).done()
}
