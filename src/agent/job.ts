/**
 * The job runner: does one job (a work item, a free-form task, or a sweep) inside the AgentCore container.
 *
 * For an item: the GitHub token from Secrets Manager (TRACE_GITHUB_SECRET_ARN; never logged, never in argv or a URL —
 * git gets it as an http.extraHeader through GIT_CONFIG_* environment variables scoped to each command); a shallow
 * clone of the default branch (the settings are read from it, never from a PR's tree), then the item's branch; the
 * git identity and the trace-db merge driver; then Claude (Agent SDK) with the harness's own prompt, the trace MCP
 * server, unattended permissions (the container is the sandbox) and a timeout below the session's maxLifetime. If
 * Claude left no comment on the item, or the job failed, a final comment says so (marker trace-agent-done).
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
import { type TraceConfig, load } from '../core/config.js'
import { loadConfig } from '../harness/index.js'
import type { Context, Core, GitHub } from '../harness/types.js'
import { type WorkItem, WorkItemSchema, pick } from '../harness/worker.js'
import type { JobContext, JobRunner } from './jobs.js'
import { taskBranch, taskPrompt, workItemPrompt } from './prompt.js'
import { BranchSchema, type JobPayload, type SweepJob, type TaskJob, type WorkItemJob } from './schemas.js'

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
  mcpServers: Record<string, { type: 'stdio'; command: string; args: string[] }>
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
}

export const TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'TodoWrite', 'mcp__trace']
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
}): Promise<ClaudeOutcome> {
  const abort = new AbortController()
  const stop = (why: string): void => { if (!abort.signal.aborted) { o.log(why); abort.abort(new Error(why)) } }
  const onAbort = (): void => stop('stopping Claude: the job was aborted')
  o.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => stop(`stopping Claude: it ran longer than ${d.timeoutS} s`), d.timeoutS * 1000)
  timer.unref()
  const model = d.model || o.cfg.worker.model || undefined
  const options: ClaudeOptions = {
    ...(model ? { model } : {}),
    cwd: o.cwd,
    // The container is the sandbox: nobody is there to answer a permission prompt.
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    allowedTools: [...TOOLS],
    mcpServers: { trace: { type: 'stdio', command: 'node', args: [d.cli, 'mcp'] } },
    maxTurns: o.cfg.worker.max_turns,
    abortController: abort,
    env: { ...d.env, GH_TOKEN: o.token, GITHUB_TOKEN: o.token, ...gitAuthEnv(o.token), CLAUDE_AGENT_SDK_CLIENT_APP: 'trace-agent/1' },
    settingSources: ['project'],
    systemPrompt: {
      type: 'preset', preset: 'claude_code',
      append: 'You run unattended in a disposable container on Amazon Bedrock AgentCore Runtime. git and gh are authenticated through the environment; never print, echo or write the token anywhere.',
    },
    stderr: (s) => { const l = s.trim(); if (l) o.log(`claude: ${o.redact(l).slice(0, 500)}`) },
  }
  let last: z.infer<typeof ResultMessage> | null = null
  try {
    for await (const m of d.claude({ prompt: o.prompt, options })) {
      const r = ResultMessage.safeParse(m)
      if (r.success) last = r.data
    }
  } catch (e) {
    if (abort.signal.aborted) return { ok: false, text: errText(abort.signal.reason), turns: last?.num_turns ?? 0 }
    throw e
  } finally {
    clearTimeout(timer)
    o.signal.removeEventListener('abort', onAbort)
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

/** Post the final comment unless Claude commented since the job started (a failure is always reported). */
async function finalComment(gh: GitHub, repository: string, n: number, jobId: string, startedAt: number, ok: boolean, text: string, link?: string): Promise<void> {
  const { owner, repo } = split(repository)
  const cs = await gh.paginate(gh.rest.issues.listComments, { owner, repo, issue_number: n, per_page: 100 })
  if (cs.some((c) => (c.body ?? '').includes(DONE(jobId)))) return
  if (ok && cs.some((c) => Date.parse(c.created_at) >= startedAt - 1000)) return
  const head = ok
    ? `The trace agent finished (job \`${jobId}\`) without leaving a summary here. Its last words:`
    : `The trace agent could not finish this (job \`${jobId}\`):`
  const quoted = (text.trim() || '(nothing)').slice(0, 3000).split('\n').map((l) => `> ${l}`).join('\n')
  await gh.rest.issues.createComment({ owner, repo, issue_number: n, body: `${head}\n\n${quoted}${link ? `\n\n[dispatching run](${link})` : ''}\n${DONE(jobId)}` })
}

interface Prepared { slot: string; branch: string; from: 'remote' | 'maybe' | 'none'; prompt: (cfg: TraceConfig) => string; issue?: number; runUrl?: string }

function prepared(p: WorkItemJob | TaskJob): Prepared {
  if (p.kind === 'work-item') {
    const it: WorkItem = p.item
    const pr = it.kind !== 'agent-fix'
    if (pr && !BranchSchema.safeParse(it.ref).success) throw new Error(`#${it.number} has no usable head ref (${JSON.stringify(it.ref)})`)
    return {
      slot: String(it.number), branch: it.ref, from: pr ? 'remote' : 'none', issue: it.number,
      prompt: (cfg) => workItemPrompt(it, cfg, p.repository), ...(p.runUrl ? { runUrl: p.runUrl } : {}),
    }
  }
  return {
    slot: `task-${(p.branch ?? p.request).replace(/[^A-Za-z0-9]+/g, '-').slice(0, 30)}`,
    branch: '', from: 'maybe', ...(p.issue ? { issue: p.issue } : {}),
    prompt: (cfg) => taskPrompt(p, cfg, taskBranch(p, cfg)),
  }
}

export async function runItem(d: RunnerDeps, p: WorkItemJob | TaskJob, ctx: JobContext): Promise<string> {
  const startedAt = d.now()
  const token = await d.getToken()
  const redact = redactor(token)
  const log = (l: string): void => ctx.log(redact(l))
  const gh = d.github(token)
  const { owner, repo } = split(p.repository)
  let prep: Prepared | null = null
  let dir: string | null = null
  try {
    prep = prepared(p)
    const defaultBranch = (await gh.rest.repos.get({ owner, repo })).data.default_branch
    dir = cloneDir(d.workspace, p.repository, prep.slot)
    // The default branch first: the settings come from it, never from a PR's tree.
    const g: GitOpts = { exec: d.exec, dir, auth: gitAuthEnv(token), signal: ctx.signal, log }
    const base = await cloneDefault({ ...g, repository: p.repository, defaultBranch, cli: d.cli })
    const cfg = d.settingsOf(base.dir)
    let branch = p.kind === 'task' ? taskBranch(p, cfg) : prep.branch
    if (prep.from !== 'none') branch = await checkoutBranch({ ...g, defaultBranch: base.defaultBranch, branch, from: prep.from })
    else branch = base.defaultBranch
    log(`running Claude on ${p.repository} ${branch} (max ${cfg.worker.max_turns} turns)`)
    const out = await runClaude(d, { prompt: prep.prompt(cfg), cwd: dir, cfg, token, signal: ctx.signal, log, redact })
    const summary = redact(out.text)
    if (prep.issue) await finalComment(gh, p.repository, prep.issue, ctx.jobId, startedAt, out.ok, summary, prep.runUrl)
    if (!out.ok) throw new Error(summary)
    return `done in ${out.turns} turns`
  } catch (e) {
    const msg = redact(errText(e))
    if (prep?.issue) {
      await finalComment(gh, p.repository, prep.issue, ctx.jobId, startedAt, false, msg, prep.runUrl)
        .catch((ce: unknown) => log(`could not post the final comment: ${redact(errText(ce))}`))
    }
    throw new Error(msg)
  } finally {
    if (dir && !d.persistent) rmSync(dir, { recursive: true, force: true })
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
  return (p: JobPayload, ctx: JobContext) => (p.kind === 'sweep' ? runSweep(d, p, ctx) : runItem(d, p, ctx))
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
  })
}
