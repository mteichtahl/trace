/**
 * One tool call the API forwarded (invocation kind `tool`, schemas.ts ToolPayload), done on the project's worker
 * runtime: the API runtime has no GPU or CPU queue rights and runs nothing heavy itself.
 *
 *   the API      checks the person's access (read, or write for WRITE_TOOLS), then InvokeAgentRuntime on the
 *                project's own worker runtime, in one session per project (src/api/workers.ts)
 *   this module  refuses hardware tools and the session-scoped ones (memory.*, agent.*, journey.*), refuses paths outside the
 *                clone, clones (or fetches) the default branch, and runs the tool through the registry there: no
 *                model, no job. Calls run one at a time, since tools resolve the project from the working directory.
 *   its log      a call that came with a run id (ToolJob.runId, the API's run_id) writes its stream
 *                tool/<owner>/<repo>/<runId> in the runs log group (src/agents/runtime/log-stream.ts toolRun): `▸ <tool>`
 *                once it is accepted, what the tool and the programs it runs report (src/core/progress.ts), then
 *                `✓ done in 12 s` or `✗ <why>`; its quiet gaps are learned when it ends. Without the group, or without
 *                a run id, nothing is written and the call is unchanged
 *
 * Everything with side effects is injected (ToolDeps), so tests run it without git or a token.
 */
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import type { RunLogWriter } from '../../core/cw-writer.js'
import { withProgress } from '../../core/progress.js'
import type { Registry } from '../../core/registry.js'
import type { Exec } from './job.js'
import type { LearnQuiet, ToolRunLog } from './log-stream.js'
import type { ToolJob } from './schemas.js'

/** Tools scoped by a job's environment (its project, agent, session or delegation token): never through the API. The
 * journey.* tools record what an agent contributes (src/tools/journey); people act through question.answer and the
 * other journey actions instead. */
export const API_HIDDEN_TOOLS: ReadonlySet<string> = new Set(['memory.recall', 'memory.remember', 'agent.delegate', 'journey.status', 'journey.ask', 'journey.check', 'journey.stuck', 'journey.handoff', 'journey.handoff_answer'])

/** Tool arguments that name files: they must stay inside the clone. `library` (another store) is refused outright. */
export const PATH_KEYS: ReadonlySet<string> = new Set(['path', 'file', 'files', 'schematic', 'project', 'board', 'pcb', 'out_dir', 'models', 'include_dirs', 'dir', 'root'])
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['library'])

/** A tool call refused before it ran (the API answers it as ok: false). */
export class ToolRefused extends Error {
  override name = 'ToolRefused'
}

/** Refuse a path argument that leaves `root` (absolute, or climbing out), and any FORBIDDEN_KEYS argument. */
export function checkPaths(args: unknown, root: string, key = ''): void {
  if (Array.isArray(args)) { for (const v of args) checkPaths(v, root, key); return }
  if (args !== null && typeof args === 'object') {
    for (const [k, v] of Object.entries(args)) {
      if (FORBIDDEN_KEYS.has(k)) throw new ToolRefused(`${k}: not available through the API`)
      checkPaths(v, root, PATH_KEYS.has(k) ? k : key)
    }
    return
  }
  if (key && typeof args === 'string') {
    const full = resolvePath(root, args)
    const rel = relative(root, full)
    if (isAbsolute(args) || rel.startsWith('..') || isAbsolute(rel)) throw new ToolRefused(`${key}: must be a path inside the repository`)
  }
}

/** Whether the API may offer this tool at all (the same rule on both sides). */
export const apiTool = (t: { name: string; hardware: boolean } | undefined): boolean => Boolean(t && !t.hardware && !API_HIDDEN_TOOLS.has(t.name))

export interface ToolCheckout { dir: string; cleanup(): void }

export interface ToolDeps {
  registry: () => Registry | Promise<Registry>
  /** The project's default branch, checked out (a kept clone is fetched and reset). */
  checkout: (repository: string) => Promise<ToolCheckout>
  /**
   * The project record's fingerprint in a clone (src/agents/runtime/record-guard.ts), and preparing it so a tool's own
   * open changes no rows. With it, a call that changes the record is refused (RecordChanged): the clone is never
   * committed, so its "saved" would be lost. Left out, nothing is checked.
   */
  record?: { prepare: (dir: string) => void; fingerprint: (dir: string) => string }
  /** the runs log group's writer (a call with a run id writes its stream there); absent: nothing is written */
  runLogs?: RunLogWriter | null
  /** fold a finished call's gaps into its project's quiet profile; absent: not learned */
  learn?: LearnQuiet | null
}

/** What a refused record change tells the caller, and through the chat the person: nothing was kept, and how to keep it. */
export const recordChangedMessage = (name: string): string =>
  `${name} would change the project record, and a tool run here cannot: it runs on a copy of the default branch that is ` +
  'never committed, so nothing was saved. To record it, start a task (start_task) for the agent: it makes the change ' +
  'on a branch and opens a pull request, and the record has it once that is merged.'

/** A tool call refused because it changed the project record (see ToolDeps.record). */
export class RecordChanged extends ToolRefused {
  override name = 'RecordChanged'
}

export type ToolRunner = (p: ToolJob) => Promise<unknown>

export function toolRunner(d: ToolDeps): ToolRunner {
  let queue: Promise<unknown> = Promise.resolve()
  const serialised = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn)
    queue = next.catch(() => undefined)
    return next
  }
  return async (p) => {
    const registry = await d.registry()
    const t = registry.get(p.name)
    if (!apiTool(t)) throw new ToolRefused(`no tool ${p.name}`)
    // before anything is cloned, then again against the clone itself
    checkPaths(p.args, '/repository')
    // its stream, opened once the call is accepted: a refused call has no log
    // (loaded only then: the API imports this module for its policy alone)
    const log: ToolRunLog | null = p.runId && d.runLogs
      ? (await import('./log-stream.js')).toolRun(d.runLogs, { repository: p.repository, runId: p.runId, name: p.name, learn: d.learn ?? undefined })
      : null
    const call = (): Promise<unknown> => registry.call(p.name, p.args, { hardware: false, via: 'mcp' })
    const run = serialised(async () => {
      const co = await d.checkout(p.repository)
      const cwd = process.cwd()
      const db = process.env.TRACE_PROJECT_DB
      try {
        checkPaths(p.args, co.dir)
        process.chdir(co.dir)
        process.env.TRACE_PROJECT_DB = join(co.dir, '.trace', 'project.db')
        if (d.record) d.record.prepare(co.dir)
        const before = d.record?.fingerprint(co.dir)
        const result = await (log ? withProgress(log.sink, call) : call())
        if (d.record && d.record.fingerprint(co.dir) !== before) throw new RecordChanged(recordChangedMessage(p.name))
        return result
      } finally {
        process.chdir(cwd)
        if (db === undefined) delete process.env.TRACE_PROJECT_DB
        else process.env.TRACE_PROJECT_DB = db
        co.cleanup()
      }
    })
    if (!log) return run
    try {
      const result = await run
      log.done()
      return result
    } catch (e) {
      log.failed(e)
      throw e
    }
  }
}

/** The worker runtime's checkout for tool calls: its own slot, kept and fetched in a persistent workspace. */
export function runtimeCheckout(o: { exec: Exec; getToken: () => Promise<string>; workspace: string; persistent: boolean; cli: string }): (repository: string) => Promise<ToolCheckout> {
  return async (repository) => {
    // the job runner's git helpers and Octokit only here: the API imports this module for its policy alone
    const [{ cloneDefault, cloneDir, gitAuthEnv, redactor, removeDir }, { Octokit }] = await Promise.all([import('./job.js'), import('@octokit/rest')])
    const token = await o.getToken()
    const redact = redactor(token)
    const [owner = '', repo = ''] = repository.split('/')
    const defaultBranch = (await new Octokit({ auth: token, userAgent: 'trace-agent' }).rest.repos.get({ owner, repo })).data.default_branch
    const dir = cloneDir(o.workspace, repository, 'api-tool')
    try {
      await cloneDefault({ exec: o.exec, dir, auth: gitAuthEnv(token), log: () => undefined, repository, defaultBranch, cli: o.cli })
    } catch (e) {
      // never let the removal's own failure hide why the checkout failed
      removeDir(dir)
      throw new Error(`cannot check out ${repository}: ${redact(e instanceof Error ? e.message : String(e)).split('\n')[0] ?? 'git failed'}`)
    }
    return { dir, cleanup: () => { if (!o.persistent) removeDir(dir) } }
  }
}

/**
 * Where tool calls keep their clone: the container's own disk (/tmp), kept for the life of the session, never AgentCore's
 * session storage (/mnt/workspace). The tools open the project database (SQLite, .trace/project.db in the clone), and
 * on session storage its locks never come free: every call that touched it waited out the 30-second busy timeout and
 * failed with "database is locked" (the API's scratch moved off it for the same reason: src/api/actions.ts). Losing the
 * clone when the session ends costs one fresh clone.
 */
export const TOOL_WORKSPACE = '/tmp/trace-tools'

/** The real runner: the registry of every tool, and the runtime's own clone (TRACE_GITHUB_SECRET_ARN). */
export async function realToolRunner(env: Record<string, string | undefined> = process.env): Promise<ToolRunner> {
  const [{ execReal, secretsToken }, { prepareRecord, recordFingerprint }, { processRunLogs, workerQuiet }] = await Promise.all([import('./job.js'), import('./record-guard.js'), import('./log-stream.js')])
  return toolRunner({
    registry: async () => (await import('../../tools/index.js')).allTools(),
    record: { prepare: prepareRecord, fingerprint: recordFingerprint },
    // the call's log (a run id from the API, TRACE_RUNS_LOG_GROUP here) and its quiet gaps (src/agents/runtime/log-stream.ts)
    runLogs: processRunLogs(), learn: workerQuiet(env as NodeJS.ProcessEnv),
    checkout: runtimeCheckout({ exec: execReal, getToken: secretsToken(env.TRACE_GITHUB_SECRET_ARN, env.AWS_REGION), workspace: env.TRACE_TOOL_WORKSPACE || TOOL_WORKSPACE, persistent: true, cli: env.TRACE_CLI || '/app/dist/cli.js' }),
  })
}
