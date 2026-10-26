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
import type { Layers, Override } from '../prompts/resolve.js'
import { InstallationPrompts, loadLayers, projectOverrides, promptsHome } from '../prompts/store.js'
import { delegateStep, reportStep, specialistStep } from './actions.js'
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
  'worker-prompt': (d) => specialistStep(d),
  'worker-delegate': (d) => delegateStep(d),
  'worker-report': (d) => reportStep(d),
  'worker-dispatch': (d) => dispatchTask(d),
  'deploy-request': deploy.request,
  'deploy-approve': deploy.approve,
  'deploy-commands': deploy.commands,
  'deploy-guard': deploy.guard,
  'deploy-hold': deploy.hold,
  'deploy-report': deploy.report,
  'rollback-report': deploy.rollbackReport,
}

/** The default branch's .trace/project.db, or null when it has none. */
async function defaultDb(github: GitHub, context: Context): Promise<Uint8Array | null> {
  const { owner, repo } = context.repo
  const repository = context.payload.repository as { default_branch?: string } | undefined
  const branch = repository?.default_branch ?? (await github.rest.repos.get({ owner, repo })).data.default_branch
  try {
    // The contents API inlines files up to 1 MB as base64; a larger database is read as its git blob (to 100 MB).
    const meta = (await github.rest.repos.getContent({ owner, repo, path: '.trace/project.db', ref: branch })).data
    if (Array.isArray(meta) || meta.type !== 'file') throw new Error('.trace/project.db is not a file')
    const b64 = meta.content && meta.encoding === 'base64'
      ? meta.content
      : (await github.rest.git.getBlob({ owner, repo, file_sha: meta.sha })).data.content
    return new Uint8Array(Buffer.from(b64, 'base64'))
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e
    return null
  }
}

function withDb<T>(bytes: Uint8Array, fn: (db: string) => T): T {
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'trace-cfg-'))
  try {
    const db = join(dir, 'project.db')
    writeFileSync(db, bytes)
    return fn(db)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function configOf(settings: Record<string, unknown>): TraceConfig {
  const { config, errors } = resolve(settings)
  if (errors.length) throw new Error(`The project's settings (.trace/project.db) are invalid:\n- ${errors.join('\n- ')}`)
  return config
}

/** The project's settings from the default branch's .trace/project.db (the defaults, with a warning, if absent). */
export async function loadConfig(github: GitHub, context: Context, core: Core): Promise<TraceConfig> {
  const bytes = await defaultDb(github, context)
  if (!bytes?.length) core.warning('No .trace/project.db on the default branch: using the defaults.')
  return configOf(bytes?.length ? withDb(bytes, readSettings) : {})
}

/**
 * The project's settings and its prompt overrides, both from the default branch's .trace/project.db, and the
 * installation's prompt overrides when this step can read them (TRACE_HOME set, and the step's AWS credentials
 * allowed to read prompts/*). A layer that cannot be read is left out, with a notice: the defaults below it decide.
 */
export async function loadProject(github: GitHub, context: Context, core: Core,
  env: Record<string, string | undefined> = process.env): Promise<{ cfg: TraceConfig; prompts: Layers }> {
  const bytes = await defaultDb(github, context)
  let settings: Record<string, unknown> = {}
  let project = new Map<string, Override>()
  if (bytes?.length) {
    ;({ settings, project } = withDb(bytes, (db) => ({ settings: readSettings(db), project: projectOverrides(db) })))
  } else {
    core.warning('No .trace/project.db on the default branch: using the defaults.')
  }
  const cfg = configOf(settings)
  const installation = env.TRACE_HOME || env.TRACE_PROMPTS_HOME
    ? await loadLayers({ installation: new InstallationPrompts({ home: promptsHome(env) }) })
    : { unavailable: [{ layer: 'installation' as const, reason: 'TRACE_HOME is not set for this step' }] }
  for (const u of installation.unavailable ?? []) core.info(`The installation's prompt overrides are not used here: ${u.reason}`)
  return { cfg, prompts: { project, ...(installation.installation ? { installation: installation.installation } : {}), ...(installation.unavailable ? { unavailable: installation.unavailable } : {}) } }
}

export async function run(args: { github: GitHub; context: Context; core: Core; getOctokit: (token: string) => GitHub }): Promise<void> {
  const env = process.env as TaskEnv & { TRACE_TASK?: string; JOB_TOKEN?: string }
  const task = env.TRACE_TASK ? TASKS[env.TRACE_TASK] : undefined
  if (!task) throw new Error(`Unknown trace task "${env.TRACE_TASK}" (one of: ${Object.keys(TASKS).join(', ')})`)
  const jobApi = env.JOB_TOKEN ? args.getOctokit(env.JOB_TOKEN) : args.github
  // prompt overrides matter only to the steps that build prompts: the others need not read the installation's store
  const prompting = ['worker-prompt', 'worker-delegate'].includes(env.TRACE_TASK ?? '')
  const { cfg, prompts } = prompting ? await loadProject(jobApi, args.context, args.core) : { cfg: await loadConfig(jobApi, args.context, args.core), prompts: undefined }
  await task({ github: args.github, jobApi, context: args.context, core: args.core, cfg, env, ...(prompts ? { prompts } : {}) })
}
