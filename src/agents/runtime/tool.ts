/**
 * One tool call the API forwarded (invocation kind `tool`, schemas.ts ToolPayload), done on the project's worker
 * runtime: the API runtime has no GPU or CPU queue rights and runs nothing heavy itself.
 *
 *   the API      checks the person's access (read, or write for WRITE_TOOLS), then InvokeAgentRuntime on the
 *                project's own worker runtime, in one session per project (src/api/workers.ts)
 *   this module  refuses hardware tools and the session-scoped ones (memory.*, agent.*), refuses paths outside the
 *                clone, clones (or fetches) the default branch, and runs the tool through the registry there: no
 *                model, no job. Calls run one at a time, since tools resolve the project from the working directory.
 *
 * Everything with side effects is injected (ToolDeps), so tests run it without git or a token.
 */
import { Octokit } from '@octokit/rest'
import { rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import type { Registry } from '../../core/registry.js'
import { type Exec, cloneDefault, cloneDir, execReal, gitAuthEnv, redactor, secretsToken, workspaceDir } from './job.js'
import type { ToolJob } from './schemas.js'

/** Tools scoped by a job's environment (its project, agent, session or delegation token): never through the API. */
export const API_HIDDEN_TOOLS: ReadonlySet<string> = new Set(['memory.recall', 'memory.remember', 'agent.delegate'])

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
    return serialised(async () => {
      const co = await d.checkout(p.repository)
      const cwd = process.cwd()
      const db = process.env.TRACE_PROJECT_DB
      try {
        checkPaths(p.args, co.dir)
        process.chdir(co.dir)
        process.env.TRACE_PROJECT_DB = join(co.dir, '.trace', 'project.db')
        return await registry.call(p.name, p.args, { hardware: false, via: 'mcp' })
      } finally {
        process.chdir(cwd)
        if (db === undefined) delete process.env.TRACE_PROJECT_DB
        else process.env.TRACE_PROJECT_DB = db
        co.cleanup()
      }
    })
  }
}

/** The worker runtime's checkout for tool calls: its own slot, kept and fetched in a persistent workspace. */
export function runtimeCheckout(o: { exec: Exec; getToken: () => Promise<string>; workspace: string; persistent: boolean; cli: string }): (repository: string) => Promise<ToolCheckout> {
  return async (repository) => {
    const token = await o.getToken()
    const redact = redactor(token)
    const [owner = '', repo = ''] = repository.split('/')
    const defaultBranch = (await new Octokit({ auth: token, userAgent: 'trace-agent' }).rest.repos.get({ owner, repo })).data.default_branch
    const dir = cloneDir(o.workspace, repository, 'api-tool')
    try {
      await cloneDefault({ exec: o.exec, dir, auth: gitAuthEnv(token), log: () => undefined, repository, defaultBranch, cli: o.cli })
    } catch (e) {
      rmSync(dir, { recursive: true, force: true })
      throw new Error(`cannot check out ${repository}: ${redact(e instanceof Error ? e.message : String(e)).split('\n')[0] ?? 'git failed'}`)
    }
    return { dir, cleanup: () => { if (!o.persistent) rmSync(dir, { recursive: true, force: true }) } }
  }
}

/** The real runner: the registry of every tool, and the runtime's own clone (TRACE_GITHUB_SECRET_ARN). */
export function realToolRunner(env: Record<string, string | undefined> = process.env): ToolRunner {
  const ws = workspaceDir(env)
  return toolRunner({
    registry: async () => (await import('../../tools/index.js')).allTools(),
    checkout: runtimeCheckout({ exec: execReal, getToken: secretsToken(env.TRACE_GITHUB_SECRET_ARN, env.AWS_REGION), workspace: ws.dir, persistent: ws.persistent, cli: env.TRACE_CLI || '/app/dist/cli.js' }),
  })
}
