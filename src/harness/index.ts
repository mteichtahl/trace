/**
 * Entry point for the harness's composite action (harness/actions/run): runs the task named in TRACE_TASK with the
 * project's settings. github-script calls the bundled harness/dist/index.cjs with its Octokit client and context.
 *
 * The settings are read from the repository's DEFAULT branch copy of .trace/project.db through the API, never from the
 * checked-out tree, so a pull request can't switch the harness off or change the commands a deploy runs.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TraceConfig, readSettings, resolve } from '../core/config.js'
import * as ci from './ci-doctor.js'
import * as deploy from './deploy.js'
import { dispatchTask } from './dispatch.js'
import * as prs from './prs.js'
import type { Context, Core, Deps, GitHub, TaskEnv } from './types.js'
import * as worker from './worker.js'

export const TASKS: Record<string, (d: Deps) => Promise<void> | void> = {
  'open-pr': prs.openPr,
  automerge: prs.automerge,
  'update-queue': prs.updateQueue,
  'ci-doctor': ci.ciDoctor,
  'worker-pick': (d) => worker.pick(d),
  'worker-prompt': worker.prompt,
  'worker-dispatch': (d) => dispatchTask(d),
  'deploy-request': deploy.request,
  'deploy-approve': deploy.approve,
  'deploy-commands': deploy.commands,
  'deploy-guard': deploy.guard,
  'deploy-hold': deploy.hold,
  'deploy-report': deploy.report,
  'rollback-report': deploy.rollbackReport,
}

/** The project's settings from the default branch's .trace/project.db (the defaults, with a warning, if absent). */
export async function loadConfig(github: GitHub, context: Context, core: Core): Promise<TraceConfig> {
  const { owner, repo } = context.repo
  const repository = context.payload.repository as { default_branch?: string } | undefined
  const branch = repository?.default_branch ?? (await github.rest.repos.get({ owner, repo })).data.default_branch
  let bytes: Uint8Array | null = null
  try {
    // The contents API inlines files up to 1 MB as base64; a larger database is read as its git blob (to 100 MB).
    const meta = (await github.rest.repos.getContent({ owner, repo, path: '.trace/project.db', ref: branch })).data
    if (Array.isArray(meta) || meta.type !== 'file') throw new Error('.trace/project.db is not a file')
    const b64 = meta.content && meta.encoding === 'base64'
      ? meta.content
      : (await github.rest.git.getBlob({ owner, repo, file_sha: meta.sha })).data.content
    bytes = new Uint8Array(Buffer.from(b64, 'base64'))
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e
  }
  let settings: Record<string, unknown> = {}
  if (bytes?.length) {
    const dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'trace-cfg-'))
    try {
      const db = join(dir, 'project.db')
      writeFileSync(db, bytes)
      settings = readSettings(db)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  } else {
    core.warning('No .trace/project.db on the default branch: using the defaults.')
  }
  const { config, errors } = resolve(settings)
  if (errors.length) throw new Error(`The project's settings (.trace/project.db) are invalid:\n- ${errors.join('\n- ')}`)
  return config
}

export async function run(args: { github: GitHub; context: Context; core: Core; getOctokit: (token: string) => GitHub }): Promise<void> {
  const env = process.env as TaskEnv & { TRACE_TASK?: string; JOB_TOKEN?: string }
  const task = env.TRACE_TASK ? TASKS[env.TRACE_TASK] : undefined
  if (!task) throw new Error(`Unknown trace task "${env.TRACE_TASK}" (one of: ${Object.keys(TASKS).join(', ')})`)
  const jobApi = env.JOB_TOKEN ? args.getOctokit(env.JOB_TOKEN) : args.github
  const cfg = await loadConfig(jobApi, args.context, args.core)
  await task({ github: args.github, jobApi, context: args.context, core: args.core, cfg, env })
}
