/**
 * The job runner: does one job (a work item, a free-form task, or a sweep) inside the AgentCore container.
 *
 * For an item: the project's GitHub token from Secrets Manager (TRACE_GITHUB_SECRET_ARN, its own secret; never logged, never in argv or a URL —
 * git gets it as an http.extraHeader through GIT_CONFIG_* environment variables scoped to each command); a shallow
 * clone of the default branch (the settings are read from it, never from a PR's tree), then the item's branch; the
 * git identity and the trace-db merge driver; then Claude (Agent SDK) as the routed specialist (below), the trace MCP
 * server, unattended permissions (the container is the sandbox) and a timeout below the session's maxLifetime. If
 * Claude left no comment on the item, or the job failed, a final comment says so (marker trace-agent-done).
 *
 * SPECIALISTS. A work item or a person's task is routed (src/agents/router.ts; a pick may have routed it already) to
 * one specialist (src/agents/<kind>), which runs with its own prompt (the default branch's .trace/rules.md and its
 * agents.<kind>.instructions included), its own tool allowlist (built-ins: reading only; trace tools: its area's,
 * enforced by the SDK's tools/allowedTools and by the MCP server's TRACE_MCP_TOOLS) and its own memory actor
 * (<owner>/<repo>/<kind>). It delegates repository changes to the retained worker through agent.delegate
 * (delegation.ts): a delegated task runs the worker's own prompt in the specialist's checkout (runDelegated). The
 * specialist's report is posted on the item with which specialist acted and why it was routed there.
 *
 * Memory (memory.ts, when TRACE_MEMORY_ID is set): each job is one agent (the specialist, or the worker for a
 * delegation, which continues its specialist's session) on one project, in one session
 * (pr-<n>, issue-<n>, or the task's branch). At the start its long-term memory, and the session's earlier turns when
 * it continues one, are appended to the prompt as a fenced data block; the request, key tool outcomes and the result
 * are recorded as events, scrubbed and bounded. A memory failure is logged once and never fails the job.
 *
 * A sweep runs the worker-pick scan for each repository (same claims and attempt markers as the workflows) and starts
 * one work-item job per claimed item.
 *
 * Everything with side effects is injected (RunnerDeps), so tests check the commands without git, GitHub or a model.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { Octokit } from '@octokit/rest'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { type TraceConfig, load } from '../../core/config.js'
import { loadConfig } from '../../harness/index.js'
import type { Context, Core, GitHub } from '../../harness/types.js'
import { type WorkItem, WorkItemSchema, pick } from '../../harness/worker.js'
import type { JobContext, JobRunner } from './jobs.js'
import { addSecret } from '../../core/telemetry.js'
import { claudeTelemetry } from './observe.js'
import { type AgentMemory, type Actor, type JobMemory, NO_MEMORY, agentActor, memoryFromEnv, openJobMemory, personActor, sessionIdFor } from './memory.js'
import { taskBranch, taskPrompt } from '../worker/prompt.js'
import { SPECIALISTS, SPECIALIST_BUILTINS, type Specialist, allowedToolsOf, specialistPrompt, toolsOf } from '../index.js'
import { WORKER_TOOLS } from '../specialist.js'
import { type Route, WORKER } from '../kinds.js'
import { type Classifier, type QueryFn, type RouteInput, routeJob, sdkClassifier } from '../router.js'
import { readRules } from '../rules.js'
import type { SpecialistJob } from '../specialist.js'
import { type Delegations, defaultDelegations } from './delegation.js'
import { BranchSchema, type DelegatedTaskJob, type JobPayload, type SweepJob, type TaskJob, type WorkItemJob, checkProject, isDelegated } from './schemas.js'

// ------------------------------------------------------------------ injected pieces

export interface ExecOptions { cwd?: string; env?: Record<string, string>; signal?: AbortSignal }
export interface ExecResult { stdout: string; stderr: string }
/** Runs one program with an argv (no shell). Rejects on a non-zero exit. */
export type Exec = (cmd: string, args: readonly string[], opts?: ExecOptions) => Promise<ExecResult>

/** The subset of the Agent SDK's query() options the runner sets (structurally compatible with the SDK's Options). */
export interface ClaudeOptions {
  model?: string
  cwd: string
  permissionMode: 'bypassPermissions'
  allowDangerouslySkipPermissions: true
  allowedTools: string[]
  /** The built-in tools available at all (a specialist: reading only); absent = Claude Code's default set. */
  tools?: string[]
  mcpServers: Record<string, { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }>
  maxTurns: number
  abortController: AbortController
  env: Record<string, string | undefined>
  settingSources: ('project')[]
  systemPrompt: { type: 'preset'; preset: 'claude_code'; append: string }
  stderr: (data: string) => void
}
export type RunClaude = (args: { prompt: string; options: ClaudeOptions }) => AsyncIterable<unknown>

export interface RunnerDeps {
  exec: Exec
  /** The GitHub token (Secrets Manager). */
  getToken: () => Promise<string>
  /** An Octokit client authenticated with the token. */
  github: (token: string) => GitHub
  claude: RunClaude
  /** The resolved settings of a checkout (its .trace/project.db). */
  settingsOf: (dir: string) => TraceConfig
  /** The settings from the default branch through the API (a sweep has no clone). */
  remoteSettings: (github: GitHub, context: Context, core: Core) => Promise<TraceConfig>
  workspace: string
  /** True when the workspace survives the session (/mnt/workspace): clones are kept and fetched next time. */
  persistent: boolean
  /** The trace CLI (dist/cli.js), for the MCP server and the merge driver. */
  cli: string
  /** Seconds before Claude is stopped. */
  timeoutS: number
  model?: string
  env: Record<string, string | undefined>
  now: () => number
  /** The agents' memory (TRACE_MEMORY_ID); absent or null: jobs run without memory. */
  memory?: AgentMemory | null
  /** The one project this runtime serves (TRACE_PROJECT): jobs for any other are refused, and the memory actor is
   * this project's whatever the payload says. */
  project?: string | undefined
  /** The model classifier for routing, given the job's settings (null or absent: no model, the default decides). */
  classifier?: ((cfg: TraceConfig) => Classifier | null) | undefined
  /** This process's delegations (src/agents/runtime/delegation.ts); absent: specialists cannot delegate. */
  delegations?: Delegations | undefined
  /** Where agent.delegate reaches this runtime (http://127.0.0.1:<port>); absent: no delegation. */
  delegateUrl?: string | undefined
  /** Hardware is allowed in this runtime (TRACE_HARDWARE): the specialists' hardware tools are offered. */
  hardware?: boolean | undefined
}

/** The delegated worker's tools: everything, as before the specialists (the MCP server offers no agent.delegate to it). */
export const TOOLS: string[] = [...WORKER_TOOLS]
export const DONE = (jobId: string): string => `<!-- trace-agent-done: ${jobId} -->`
const MAX_LIFETIME_S = 28_800

// ------------------------------------------------------------------ secrets and redaction

/** The extraheader value git sends: basic auth as x-access-token, the way actions/checkout does it. */
export const authHeader = (token: string): string => `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`

/** Environment that gives one git command (or Claude's shell) access to github.com, without touching any config file. */
export function gitAuthEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: authHeader(token),
    GIT_TERMINAL_PROMPT: '0',
  }
}

export function redactor(token: string): (s: string) => string {
  const secrets = [token, Buffer.from(`x-access-token:${token}`).toString('base64')].filter((s) => s.length >= 8)
  return (s) => secrets.reduce((acc, t) => acc.split(t).join('***'), s)
}

const SecretJson = z.object({ token: z.string().min(1) }).loose()

/** The secret string is the token (a JSON {"token": …} is accepted too). */
export function parseSecret(secret: string | undefined): string {
  const s = (secret ?? '').trim()
  if (!s) throw new Error('the GitHub token secret is empty')
  if (s.startsWith('{')) {
    const r = SecretJson.safeParse(JSON.parse(s))
    if (!r.success) throw new Error('the GitHub token secret is JSON without a "token" field')
    return r.data.token.trim()
  }
  return s
}

// ------------------------------------------------------------------ the clone

export interface Checkout { dir: string; reused: boolean; defaultBranch: string; branch: string }

/** Where an item's clone lives: one per repository and item, so parallel jobs on one repository never share a tree. */
export function cloneDir(workspace: string, repository: string, slot: string): string {
  return join(workspace, repository.replace('/', '__'), slot.replace(/[^A-Za-z0-9._-]/g, '-'))
}

interface GitOpts { exec: Exec; dir: string; auth: Record<string, string>; signal?: AbortSignal | undefined; log: (l: string) => void }

const gitIn = (o: GitOpts) => (args: string[], cwd: string | undefined = o.dir): Promise<ExecResult> =>
  o.exec('git', args, { ...(cwd ? { cwd } : {}), env: o.auth, ...(o.signal ? { signal: o.signal } : {}) })

/**
 * Clone (or, in a kept workspace, fetch and reset) `repository` at its default branch into `dir`, and set the git
 * identity and the trace-db merge driver. The token reaches git only through `auth` (environment), never argv or URL.
 */
export async function cloneDefault(o: GitOpts & { repository: string; defaultBranch: string; cli: string }): Promise<Checkout> {
  const db = BranchSchema.parse(o.defaultBranch)
  const git = gitIn(o)
  const url = `https://github.com/${o.repository}.git`
  const reused = existsSync(join(o.dir, '.git'))
  if (reused) {
    o.log(`reusing the clone in ${o.dir}`)
    await git(['remote', 'set-url', 'origin', url])
    await git(['fetch', '--depth=300', '--prune', 'origin', `+refs/heads/${db}:refs/remotes/origin/${db}`])
    await git(['reset', '--hard'])
    await git(['clean', '-fd'])
    await git(['checkout', '-B', db, `origin/${db}`])
  } else {
    o.log(`cloning ${o.repository} (${db})`)
    mkdirSync(join(o.dir, '..'), { recursive: true })
    await git(['clone', '--depth=300', '--branch', db, '--', url, o.dir], undefined)
    await git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
  }
  await git(['config', 'user.name', 'trace worker (Claude)'])
  await git(['config', 'user.email', 'noreply@anthropic.com'])
  await git(['config', 'merge.trace-db.driver', `node ${o.cli} db merge %O %A %B`])
  await git(['config', 'merge.trace-db.name', 'trace project database'])
  return { dir: o.dir, reused, defaultBranch: db, branch: db }
}

/**
 * Check out `branch` in a clone made by cloneDefault: 'remote' = the existing remote branch (a PR's head, fetched),
 * 'maybe' = the remote branch when it exists, else a new branch off the default branch.
 */
export async function checkoutBranch(o: GitOpts & { defaultBranch: string; branch: string; from: 'remote' | 'maybe' }): Promise<string> {
  const git = gitIn(o)
  const branch = BranchSchema.parse(o.branch)
  const remote = o.from === 'remote' || (await git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])).stdout.trim() !== ''
  if (remote) {
    await git(['fetch', '--depth=300', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
    await git(['checkout', '-B', branch, '--track', `origin/${branch}`])
  } else if (branch !== o.defaultBranch) {
    await git(['checkout', '-B', branch, `origin/${o.defaultBranch}`])
  }
  return branch
}

// ------------------------------------------------------------------ Claude

const ResultMessage = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  num_turns: z.number().optional(),
  errors: z.array(z.string()).optional(),
}).loose()

export interface ClaudeOutcome { ok: boolean; text: string; turns: number }

export async function runClaude(d: Pick<RunnerDeps, 'claude' | 'cli' | 'timeoutS' | 'model' | 'env'>, o: {
  prompt: string; cwd: string; cfg: TraceConfig; token: string; signal: AbortSignal; log: (l: string) => void; redact: (s: string) => string
  /** Extra environment for Claude and the trace MCP server (the memory tools' scope). */
  extraEnv?: Record<string, string>
  /** Sees every SDK message (memory records the key tool outcomes). */
  onMessage?: (m: unknown) => void
  /** The agent doing it (a specialist kind, or worker), for telemetry. */
  agent?: string
  /** Overrides: the model, the turn limit (else worker.max_turns), and the tools (a specialist's; else TOOLS). */
  model?: string | undefined
  maxTurns?: number
  tools?: { builtins: string[]; allowed: string[] }
}): Promise<ClaudeOutcome> {
  const abort = new AbortController()
  const stop = (why: string): void => { if (!abort.signal.aborted) { o.log(why); abort.abort(new Error(why)) } }
  const onAbort = (): void => stop('stopping Claude: the job was aborted')
  o.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => stop(`stopping Claude: it ran longer than ${d.timeoutS} s`), d.timeoutS * 1000)
  timer.unref()
  const model = o.model || d.model || o.cfg.worker.model || undefined
  // Spans for the query, each model response and each tool use (a no-op without an OpenTelemetry SDK); the MCP
  // server gets the trace context so its tool spans join this trace.
  const tel = await claudeTelemetry({ model, agent: o.agent })
  const mcpEnv = { ...o.extraEnv, ...tel.env }
  const options: ClaudeOptions = {
    ...(model ? { model } : {}),
    cwd: o.cwd,
    // The container is the sandbox: nobody is there to answer a permission prompt.
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    allowedTools: o.tools ? [...o.tools.allowed] : [...TOOLS],
    ...(o.tools ? { tools: [...o.tools.builtins] } : {}),
    mcpServers: { trace: { type: 'stdio', command: 'node', args: [...tel.nodeArgs, d.cli, 'mcp'], ...(Object.keys(mcpEnv).length ? { env: mcpEnv } : {}) } },
    maxTurns: o.maxTurns ?? o.cfg.worker.max_turns,
    abortController: abort,
    env: { ...d.env, ...o.extraEnv, GH_TOKEN: o.token, GITHUB_TOKEN: o.token, ...gitAuthEnv(o.token), CLAUDE_AGENT_SDK_CLIENT_APP: 'trace-agent/1' },
    settingSources: ['project'],
    systemPrompt: {
      type: 'preset', preset: 'claude_code',
      append: 'You run unattended in a disposable container on Amazon Bedrock AgentCore Runtime. git and gh are authenticated through the environment; never print, echo or write the token anywhere.',
    },
    stderr: (s) => { const l = s.trim(); if (l) o.log(`claude: ${o.redact(l).slice(0, 500)}`) },
  }
  let last: z.infer<typeof ResultMessage> | null = null
  let thrown: unknown
  try {
    for await (const m of d.claude({ prompt: o.prompt, options })) {
      try { o.onMessage?.(m) } catch { /* an observer never stops the job */ }
      tel.observe(m)
      const r = ResultMessage.safeParse(m)
      if (r.success) last = r.data
    }
  } catch (e) {
    thrown = e
    if (abort.signal.aborted) return { ok: false, text: errText(abort.signal.reason), turns: last?.num_turns ?? 0 }
    throw e
  } finally {
    clearTimeout(timer)
    o.signal.removeEventListener('abort', onAbort)
    tel.end({ aborted: abort.signal.aborted, ...(abort.signal.aborted ? { error: abort.signal.reason } : thrown !== undefined ? { error: thrown } : {}) })
  }
  if (abort.signal.aborted) return { ok: false, text: errText(abort.signal.reason), turns: last?.num_turns ?? 0 }
  if (!last) return { ok: false, text: 'Claude ended without a result', turns: 0 }
  const ok = last.subtype === 'success' && !last.is_error
  const text = ok ? (last.result ?? '') : [`Claude stopped (${last.subtype})`, ...(last.errors ?? []), last.is_error ? last.result ?? '' : ''].filter(Boolean).join(': ')
  return { ok, text, turns: last.num_turns ?? 0 }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ------------------------------------------------------------------ the jobs

function split(repository: string): { owner: string; repo: string } {
  const [owner = '', repo = ''] = repository.split('/')
  return { owner, repo }
}

const quote = (text: string): string => (text.trim() || '(nothing)').slice(0, 3000).split('\n').map((l) => `> ${l}`).join('\n')

/** Post the final comment unless Claude commented since the job started (a failure is always reported). */
async function finalComment(gh: GitHub, repository: string, n: number, jobId: string, startedAt: number, ok: boolean, text: string, link?: string): Promise<void> {
  const { owner, repo } = split(repository)
  const cs = await gh.paginate(gh.rest.issues.listComments, { owner, repo, issue_number: n, per_page: 100 })
  if (cs.some((c) => (c.body ?? '').includes(DONE(jobId)))) return
  if (ok && cs.some((c) => Date.parse(c.created_at) >= startedAt - 1000)) return
  const head = ok
    ? `The trace agent finished (job \`${jobId}\`) without leaving a summary here. Its last words:`
    : `The trace agent could not finish this (job \`${jobId}\`):`
  await gh.rest.issues.createComment({ owner, repo, issue_number: n, body: `${head}\n\n${quote(text)}${link ? `\n\n[dispatching run](${link})` : ''}\n${DONE(jobId)}` })
}

/** Which specialist acted and why it was routed there: the first line of everything a specialist posts. */
export function specialistHeader(s: Specialist, r: Route, jobId: string): string {
  return `**trace ${s.title} specialist** (\`${s.kind}\`, job \`${jobId}\`). Routed here: ${r.reason} (${r.source}, confidence ${r.confidence.toFixed(2)}).`
}

/** A report that starts "ESCALATE:" asks for a person. */
export const escalation = (text: string): boolean => /^\s*ESCALATE:/i.test(text)

/** The specialist's report on the item: always posted (once per job), since a delegated worker may have commented too. */
async function specialistComment(gh: GitHub, repository: string, n: number, jobId: string, s: Specialist, r: Route, ok: boolean, text: string,
  escalateTo: string, link?: string): Promise<void> {
  const { owner, repo } = split(repository)
  const cs = await gh.paginate(gh.rest.issues.listComments, { owner, repo, issue_number: n, per_page: 100 })
  if (cs.some((c) => (c.body ?? '').includes(DONE(jobId)))) return
  const lead = !ok ? 'It could not finish:' : escalation(text) ? `${escalateTo ? `${escalateTo} ` : ''}it needs a person:` : 'Its report:'
  const body = `${specialistHeader(s, r, jobId)}\n\n${lead}\n\n${quote(text)}${link ? `\n\n[dispatching run](${link})` : ''}\n${DONE(jobId)}`
  await gh.rest.issues.createComment({ owner, repo, issue_number: n, body })
}

interface Prepared {
  slot: string; branch: string; from: 'remote' | 'maybe' | 'none'; issue?: number; runUrl?: string
  /** The route a pick already made, or what to route on. */
  route: Route | null; routeInput: RouteInput
  /** The job as the specialist's prompt describes it, given the branch it runs on and the item's thread. */
  job: (branch: string, thread?: string) => SpecialistJob
  /** Memory: the session (given the branch it runs on), what it is about, and what was asked. */
  session: (branch: string) => string; query: string; request: string
}

const ITEM_WHAT: Readonly<Record<WorkItem['kind'], string>> = {
  'ci-red': 'The required check failed on pull request', conflict: 'Merge conflict on pull request', 'agent-fix': 'Issue for the agent',
}

function prepared(p: WorkItemJob | TaskJob): Prepared {
  if (p.kind === 'work-item') {
    const it: WorkItem = p.item
    const pr = it.kind !== 'agent-fix'
    if (pr && !BranchSchema.safeParse(it.ref).success) throw new Error(`#${it.number} has no usable head ref (${JSON.stringify(it.ref)})`)
    const { route: r, ...item } = it
    return {
      slot: String(it.number), branch: it.ref, from: pr ? 'remote' : 'none', issue: it.number, ...(p.runUrl ? { runUrl: p.runUrl } : {}),
      route: r ?? null, routeInput: { text: it.title },
      job: (_b, thread) => ({ kind: 'work-item', item, thread }),
      session: () => `${pr ? 'pr' : 'issue'}-${it.number}`, query: it.title,
      request: `${ITEM_WHAT[it.kind]} #${it.number}: ${it.title}${pr ? ` (branch ${it.ref})` : ''}`,
    }
  }
  return {
    slot: `task-${(p.branch ?? p.request).replace(/[^A-Za-z0-9]+/g, '-').slice(0, 30)}`,
    branch: '', from: 'maybe', ...(p.issue ? { issue: p.issue } : {}),
    route: null, routeInput: { kind: p.agent, text: p.request },
    job: (branch) => ({ kind: 'task', request: p.request, requestedBy: p.requestedBy, issue: p.issue, branch }),
    session: (branch) => (p.issue ? `issue-${p.issue}` : sessionIdFor(branch)), query: p.request,
    request: `A person asked: ${p.request}`,
  }
}

/** The job's memory, or none: memory never stops a job. */
async function jobMemory(d: RunnerDeps, o: { repository: string; agent: string; person?: string | undefined; session: string; query: string; request: string },
  log: (l: string) => void, redact: (s: string) => string): Promise<JobMemory> {
  if (!d.memory) return NO_MEMORY
  try {
    // the runtime's own project (TRACE_PROJECT), never the payload's: its role may use no other actor anyway
    const project = d.project || o.repository
    const person: Actor | undefined = o.person ? personActor(project, o.person) : undefined
    return await openJobMemory(d.memory, { actor: agentActor(project, o.agent), person, session: o.session, query: o.query, request: o.request }, { log, redact })
  } catch (e) {
    log(`memory: not used for this job: ${redact(errText(e)).slice(0, 300)}`)
    return NO_MEMORY
  }
}

/** An issue's or PR's labels, body and latest comments (the runner reads them; a specialist has no shell). Never fails the job. */
async function threadOf(gh: GitHub, repository: string, n: number, log: (l: string) => void): Promise<{ labels: string[]; body: string; text: string } | null> {
  const { owner, repo } = split(repository)
  try {
    const issue = (await gh.rest.issues.get({ owner, repo, issue_number: n })).data
    const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean)
    const body = (issue.body ?? '').slice(0, 8000)
    const cs = await gh.paginate(gh.rest.issues.listComments, { owner, repo, issue_number: n, per_page: 100 })
    const recent = cs.slice(-8).map((c) => `--- ${c.user?.login ?? 'someone'} at ${c.created_at}:\n${(c.body ?? '').replace(/<!--[\s\S]*?-->/g, '').trim().slice(0, 1500)}`)
    return { labels, body, text: [body || '(no body)', ...recent].join('\n\n') }
  } catch (e) {
    log(`could not read #${n}'s thread: ${errText(e).slice(0, 200)}`)
    return null
  }
}

/** The environment that lets a specialist's MCP server delegate (agent.delegate) and limits it to its own tools. */
export function specialistEnv(o: { tools: readonly string[]; delegateUrl?: string | undefined; token?: string | undefined; timeoutMinutes: number }): Record<string, string> {
  const timeoutS = o.timeoutMinutes * 60
  return {
    TRACE_MCP_TOOLS: o.tools.join(','),
    ...(o.delegateUrl && o.token ? { TRACE_DELEGATE_URL: o.delegateUrl, TRACE_DELEGATE_TOKEN: o.token, TRACE_DELEGATE_TIMEOUT_S: String(timeoutS) } : {}),
    ...mcpWaitEnv(timeoutS + 600),
  }
}

/**
 * Claude Code's limits on one MCP tool call, raised above agent.delegate's wait (code.claude.com/docs/en/env-vars):
 * MCP_TOOL_TIMEOUT is the wall-clock limit in milliseconds (default about 28 hours); CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT
 * (milliseconds, capped at MCP_TOOL_TIMEOUT) cuts off a stdio server that sends no response or progress for 30 minutes
 * by default, which a blocked agent.delegate would otherwise hit; CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS 0 keeps the call
 * in the foreground (non-interactive runs do not background it today, this keeps it so).
 */
export function mcpWaitEnv(seconds: number): Record<string, string> {
  const ms = String(Math.ceil(seconds) * 1000)
  return { MCP_TOOL_TIMEOUT: ms, CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: ms, CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0' }
}

/** A work item or a person's task: routed to a specialist, which runs with its own prompt, tools and memory. */
export async function runItem(d: RunnerDeps, p: WorkItemJob | TaskJob, ctx: JobContext): Promise<string> {
  const startedAt = d.now()
  const token = await d.getToken()
  const redact = redactor(token)
  const log = (l: string): void => ctx.log(redact(l))
  const gh = d.github(token)
  const { owner, repo } = split(p.repository)
  const delegations = d.delegations ?? null
  let prep: Prepared | null = null
  let dir: string | null = null
  let mem: JobMemory = NO_MEMORY
  let acting: { s: Specialist; r: Route; escalateTo: string } | null = null
  try {
    prep = prepared(p)
    const defaultBranch = (await gh.rest.repos.get({ owner, repo })).data.default_branch
    dir = cloneDir(d.workspace, p.repository, prep.slot)
    // The default branch first: the settings and the rules come from it, never from a PR's tree.
    const g: GitOpts = { exec: d.exec, dir, auth: gitAuthEnv(token), signal: ctx.signal, log }
    const base = await cloneDefault({ ...g, repository: p.repository, defaultBranch, cli: d.cli })
    const cfg = d.settingsOf(base.dir)
    const rules = readRules(base.dir)
    let branch = p.kind === 'task' ? taskBranch(p, cfg) : prep.branch
    if (prep.from !== 'none') branch = await checkoutBranch({ ...g, defaultBranch: base.defaultBranch, branch, from: prep.from })
    else branch = base.defaultBranch

    // the item's labels, body and latest comments: for the router (when the pick did not route it) and the prompt
    const thread = p.kind === 'work-item' ? await threadOf(gh, p.repository, p.item.number, log) : null
    const input: RouteInput = thread ? { ...prep.routeInput, labels: thread.labels, text: `${p.kind === 'work-item' ? p.item.title : ''}\n\n${thread.body}`.trim() } : prep.routeInput
    const r = prep.route ?? await routeJob(input, cfg, d.classifier?.(cfg) ?? null)
    ctx.route?.(r)
    const s = SPECIALISTS[r.kind]
    const settings = cfg.agents[r.kind]
    acting = { s, r, escalateTo: cfg.worker.escalate_to }
    const session = prep.session(branch)
    mem = await jobMemory(d, {
      repository: p.repository, agent: s.memoryAgent, person: p.kind === 'task' ? p.requestedBy : undefined, session, query: prep.query, request: prep.request,
    }, log, redact)

    const hardware = Boolean(d.hardware)
    const delegate = Boolean(delegations && d.delegateUrl)
    const tools = toolsOf(s, { hardware, delegate })
    const dtoken = delegate && delegations
      ? delegations.register({ jobId: ctx.jobId, kind: r.kind, repository: p.repository, dir, cfg, branch, defaultBranch: base.defaultBranch, session })
      : undefined
    try {
      const prompt = specialistPrompt(s, { cfg, repository: p.repository, job: prep.job(branch, thread?.text), rules, route: r, hardware, delivery: 'delegate' })
      log(`running the ${r.kind} specialist on ${p.repository} ${branch} (max ${settings.max_turns} turns, ${tools.length} tools)`)
      const out = await runClaude(d, {
        prompt: `${prompt}${mem.context}`, cwd: dir, cfg, token, signal: ctx.signal, log, redact,
        extraEnv: { ...mem.env, ...specialistEnv({ tools, delegateUrl: d.delegateUrl, token: dtoken, timeoutMinutes: cfg.agents.delegate_timeout_minutes }) },
        onMessage: (m) => mem.observe(m), agent: r.kind,
        model: settings.model || d.model || cfg.worker.model || undefined, maxTurns: settings.max_turns,
        tools: { builtins: [...SPECIALIST_BUILTINS], allowed: allowedToolsOf(s, { hardware, delegate }) },
      })
      const summary = redact(out.text)
      await mem.finish(out.ok, summary)
      mem = NO_MEMORY
      if (prep.issue) await specialistComment(gh, p.repository, prep.issue, ctx.jobId, s, r, out.ok, summary, cfg.worker.escalate_to, prep.runUrl)
      if (!out.ok) throw new Error(summary)
      return `${r.kind}: done in ${out.turns} turns${escalation(summary) ? ' (escalated)' : ''}${prep.issue ? '' : `: ${summary.slice(0, 2000)}`}`
    } finally {
      if (dtoken) delegations?.unregister(ctx.jobId)
    }
  } catch (e) {
    const msg = redact(errText(e))
    await mem.finish(false, msg)
    if (prep?.issue) {
      const n = prep.issue
      const post = acting
        ? specialistComment(gh, p.repository, n, ctx.jobId, acting.s, acting.r, false, msg, acting.escalateTo, prep.runUrl)
        : finalComment(gh, p.repository, n, ctx.jobId, startedAt, false, msg, prep.runUrl)
      await post.catch((ce: unknown) => log(`could not post the final comment: ${redact(errText(ce))}`))
    }
    throw new Error(msg)
  } finally {
    if (dir && !d.persistent) rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * A worker job a specialist delegated (agent.delegate): the retained worker's own prompt (taskPrompt) with the
 * specialist's brief and acceptance criteria as its request, in the specialist's checkout, with the specialist's
 * settings. No route, no final comment (the specialist reports), no agent.delegate (depth 1).
 */
export async function runDelegated(d: RunnerDeps, p: DelegatedTaskJob, ctx: JobContext): Promise<string> {
  const parent = d.delegations?.parent(p.delegation.parentJobId)
  if (!parent) throw new Error(`the specialist job ${p.delegation.parentJobId} is not running: nothing to delegate for`)
  if (parent.repository.toLowerCase() !== p.repository.toLowerCase()) throw new Error('a delegation is for its specialist\'s repository only')
  const token = await d.getToken()
  const redact = redactor(token)
  const log = (l: string): void => ctx.log(redact(l))
  let mem: JobMemory = NO_MEMORY
  try {
    const g: GitOpts = { exec: d.exec, dir: parent.dir, auth: gitAuthEnv(token), signal: ctx.signal, log }
    const branch = p.branch && p.branch !== parent.branch
      ? await checkoutBranch({ ...g, defaultBranch: parent.defaultBranch, branch: p.branch, from: 'maybe' })
      : parent.branch
    mem = await jobMemory(d, { repository: p.repository, agent: WORKER, session: parent.session, query: p.request.slice(0, 2000), request: p.request }, log, redact)
    log(`running the worker for the ${parent.kind} specialist (job ${parent.jobId}) on ${branch} (max ${parent.cfg.worker.max_turns} turns)`)
    const out = await runClaude(d, {
      prompt: `${taskPrompt(p, parent.cfg, branch)}${mem.context}`, cwd: parent.dir, cfg: parent.cfg, token, signal: ctx.signal, log, redact,
      extraEnv: mem.env, onMessage: (m) => mem.observe(m), agent: WORKER,
    })
    const summary = redact(out.text)
    await mem.finish(out.ok, summary)
    mem = NO_MEMORY
    const commits = await d.exec('git', ['log', '--format=%h %s', '-n', '20', `origin/${parent.defaultBranch}..HEAD`], { cwd: parent.dir })
      .then((r) => r.stdout.trim()).catch(() => '')
    if (!out.ok) throw new Error(summary)
    return [`branch ${branch}, done in ${out.turns} turns`, ...(commits ? [`commits:\n${commits}`] : []), summary.slice(0, 6000)].join('\n')
  } catch (e) {
    const msg = redact(errText(e))
    await mem.finish(false, msg)
    throw new Error(msg)
  }
}

/** The worker-pick scan for each repository; each claimed item becomes its own work-item job. */
export async function runSweep(d: RunnerDeps, p: SweepJob, ctx: JobContext): Promise<string> {
  const token = await d.getToken()
  const redact = redactor(token)
  const log = (l: string): void => ctx.log(redact(l))
  const gh = d.github(token)
  const started: string[] = []
  const failed: string[] = []
  for (const repository of p.repositories) {
    if (ctx.signal.aborted) break
    const { owner, repo } = split(repository)
    const outputs: Record<string, string> = {}
    const core: Core = {
      info: (s) => log(`${repository}: ${s}`),
      warning: (s) => log(`${repository}: warning: ${s}`),
      setFailed: (s) => log(`${repository}: failed: ${s}`),
      setOutput: (k, v) => { outputs[k] = v },
      summary: { addRaw: () => ({ write: async () => undefined }) },
    }
    const context: Context = { repo: { owner, repo }, serverUrl: 'https://github.com', runId: 0, eventName: 'schedule', ref: '', sha: '', actor: 'trace-agent', payload: {} }
    try {
      const cfg = await d.remoteSettings(gh, context, core)
      if (cfg.worker.runner !== 'agentcore') { log(`${repository}: worker.runner is ${cfg.worker.runner}: left to its workflow`); continue }
      await pick({ github: gh, jobApi: gh, context, core, cfg, env: {} }, d.now(), `the trace agent on AgentCore (sweep \`${ctx.jobId}\`)`)
      const items = z.array(WorkItemSchema).parse(JSON.parse(outputs.items ?? '[]'))
      for (const item of items) {
        const r = ctx.startJob({ kind: 'work-item', repository, item })
        started.push(`${repository}#${item.number}${r.accepted ? '' : ' (already running)'}`)
      }
    } catch (e) {
      failed.push(repository)
      log(`${repository}: sweep failed: ${redact(errText(e))}`)
    }
  }
  const s = `${started.length ? `started ${started.join(', ')}` : 'nothing to do'}${failed.length ? `; failed: ${failed.join(', ')}` : ''}`
  if (failed.length === p.repositories.length) throw new Error(s)
  return s
}

export function createRunner(d: RunnerDeps): JobRunner {
  return async (p: JobPayload, ctx: JobContext) => {
    checkProject(p, d.project)
    if (p.kind === 'sweep') return runSweep(d, p, ctx)
    if (isDelegated(p)) return runDelegated(d, p, ctx)
    return runItem(d, p, ctx)
  }
}

// ------------------------------------------------------------------ the real dependencies

export const execReal: Exec = (cmd, args, opts = {}) => new Promise((res, rej) => {
  execFile(cmd, [...args], {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env: { ...process.env, ...opts.env },
    ...(opts.signal ? { signal: opts.signal } : {}),
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  }, (err, stdout, stderr) => {
    if (err) rej(new Error(`${cmd} ${args[0] ?? ''} failed: ${(stderr || err.message).trim().slice(-2000)}`))
    else res({ stdout, stderr })
  })
})

export function workspaceDir(env: Record<string, string | undefined> = process.env): { dir: string; persistent: boolean } {
  if (env.TRACE_WORKSPACE) return { dir: env.TRACE_WORKSPACE, persistent: env.TRACE_WORKSPACE.startsWith('/mnt/workspace') }
  if (existsSync('/mnt/workspace')) return { dir: '/mnt/workspace/trace', persistent: true }
  return { dir: '/tmp/trace-work', persistent: false }
}

export function secretsToken(arn: string | undefined, region?: string): () => Promise<string> {
  let cached: { token: string; at: number } | null = null
  return async () => {
    if (cached && Date.now() - cached.at < 300e3) return cached.token
    if (!arn) throw new Error('TRACE_GITHUB_SECRET_ARN is not set')
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager')
    const sm = new SecretsManagerClient(region ? { region } : {})
    const out = await sm.send(new GetSecretValueCommand({ SecretId: arn }))
    cached = { token: parseSecret(out.SecretString), at: Date.now() }
    addSecret(cached.token) // never in a span, whatever goes wrong upstream
    return cached.token
  }
}

export function realRunner(env: Record<string, string | undefined> = process.env): JobRunner {
  const ws = workspaceDir(env)
  const requested = Number(env.TRACE_JOB_TIMEOUT_S ?? '')
  const timeoutS = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_LIFETIME_S - 600) : MAX_LIFETIME_S - 1800
  return createRunner({
    exec: execReal,
    getToken: secretsToken(env.TRACE_GITHUB_SECRET_ARN, env.AWS_REGION),
    github: (token) => new Octokit({ auth: token, userAgent: 'trace-agent' }),
    claude: (args) => query(args),
    settingsOf: (dir) => load(dir),
    remoteSettings: loadConfig,
    workspace: ws.dir,
    persistent: ws.persistent,
    cli: env.TRACE_CLI || '/app/dist/cli.js',
    timeoutS,
    ...(env.ANTHROPIC_MODEL ? { model: env.ANTHROPIC_MODEL } : {}),
    env,
    now: Date.now,
    memory: memoryFromEnv(env),
    project: env.TRACE_PROJECT || undefined,
    classifier: (cfg) => sdkClassifier(query as unknown as QueryFn, {
      model: cfg.agents.router_model || env.ANTHROPIC_MODEL || cfg.worker.model || undefined,
      env: { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: 'trace-agent/1' },
    }),
    delegations: defaultDelegations(),
    delegateUrl: `http://127.0.0.1:${Number(env.PORT || 8080)}`,
    hardware: ['1', 'true', 'yes'].includes(env.TRACE_HARDWARE ?? ''),
  })
}
