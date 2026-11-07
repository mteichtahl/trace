/**
 * Projects as a whole: who is on one, and creating one (docs/ui-design.md "Creating a project").
 *
 *   project.members   read    everyone on the project with their part: the people assigned to it, and every admin
 *                             (marked, and listed as a contributor who may sign gates). Emails are shown to people
 *                             on the project, as the design's people lists do; never to anyone else
 *   projects.create   admin   put a repository under trace and start its journey, in order:
 *                               1. onboard it (src/installer/onboard-api.ts with the API's own GitHub token): a new
 *                                  repository is created, scaffolded and pushed; an existing one gets the held
 *                                  onboarding pull request (or its workflows refreshed when it is onboarded already)
 *                               2. register it in the central registry of projects
 *                               3. assign people with their parts, inviting new emails (a guest only as a reviewer)
 *                               4. write the journey's first state from the chosen template, in the journey store
 *                                  (the central bucket: src/core/journey-store.ts)
 *                               5. record the request under installation/pending-projects/ for the next update of the
 *                                  installation, which adds the project's own agent, memory, knowledge base and build
 *                                  runner (per-project cloud resources need the stack deployed again): the self-update
 *                                  job, or the installer (src/installer/pending.ts; cloudWait says which, and when).
 *                                  With the self-update on, the API starts that job now (startUpdate: trace's ci
 *                                  workflow on its branch, by hand, with add_projects so it skips trace's own tests),
 *                                  so the project's agent arrives in minutes instead of at the next merge; until then
 *                                  its tools answer that it is being set up
 *                             and answers each step's outcome, plus that last part as a wait. A step that fails stops
 *                             the ones that depend on it and says so; the request can be sent again (every step is
 *                             safe to repeat).
 *   project.agent     read    whether the project's own agent (its worker runtime) is set up in this installation yet,
 *                             and, while it is not, how its setting up stands: from the request projects.create
 *                             recorded under installation/pending-projects/ (pending, added by an update, or failed),
 *                             and, with the self-update on, the installation update's run on GitHub (queued, running,
 *                             finished). Answers when it should be ready (from how long this installation's recent
 *                             updates took, typicalUpdateMs; within the hour when none finished yet) and when to look
 *                             again. The update marking the request added (or failed) is an event: the bucket's write
 *                             of the record reaches the app as `record.changed { what: 'agent' }`
 *                             (src/web/journey-events.ts); the run on GitHub sends none, so while it runs the app also
 *                             looks again at next_check_s (agentSetup). The link to the update's run and how
 *                             to start it again (trace's own repository) are an admin's only
 *   projects.repo_check
 *                     admin   whether a repository is free for a new project: whether it is on GitHub already, and, when
 *                             trace knows it, the project that holds it (a retired one too: retiring keeps the
 *                             repository and its record), with a free name to suggest. projects.create asks the same
 *                             before it creates one, and refuses a new repository that is there already (it would put
 *                             the new project on top of another's files and record) and a retired project's repository
 *                             (that project is restored, not made again)
 *   project.update    admin   change what a project is after it is made: its name, description, icon, build plan
 *                             (quantity, unit cost, budget) and later stages, in the journey record (Settings). The
 *                             template and repository stay fixed
 *
 * Onboarding runs `git` (clone, commit, push) with the token in git's environment, never in a URL or a file: the API
 * runtime's image is the agents' image, which has git. Without it, step 1 fails with "install git" and nothing else
 * is changed.
 */
import { TemplateStore } from '../core/template-store.js'
import { z } from 'zod'
import { GROUPS, PARTS, type Part, PartRefused, type PersonClass, RepoSlug, assign, classOf, isAdmin, membersOf, setClass } from '../core/access.js'
import { Conflict } from '../core/central.js'
import { AboutSchema, BuildSchema, LATER_STAGES, TEMPLATES, type Template, TEMPLATE_NAMES, journeyView, loadJourney, startJourney, updateAbout } from '../core/journey.js'
import { forgetNoJourney } from '../core/journey-store.js'
import { lifecycleOf } from '../core/lifecycle.js'
import { projects as registered, register } from '../core/onboard.js'
import { PROJECTS_PREFIX, projectSlug } from '../core/project.js'
import { FLAT_UPDATE_MAX, type PendingRecord, PendingRecordSchema } from '../installer/pending.js'
import { GitHubError, type GitHubApi, type RunSummary } from './github.js'
import { cached } from './github-cache.js'
import { ActionError, type Context, Repo, def, hashOf, label, storeAt, withJourneyDb, writeJourney } from './action-kit.js'
import { appliesOf } from '../core/app-edits.js'
import type { ApiOnboardResult } from '../installer/onboard-api.js'
import { editStore, editorName } from './edits.js'
import { startQueued } from './agent-queue.js'

export interface Member { sub: string; email: string | null; class: PersonClass | null; part: Part; admin: boolean; can_sign: boolean }

const Person = z.object({
  /** an email or a sub; an email nobody has yet is invited */
  who: z.string().min(1).max(320),
  part: z.enum(PARTS).optional(),
  /** the class a new person is invited with (default user; guest makes them a reviewer) */
  class: z.enum(['user', 'guest']).optional(),
})

const Create = z.object({
  repo: RepoSlug,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  icon: z.string().trim().max(200).optional(),
  start: z.enum(['idea', 'import']).default('idea'),
  template: z.enum(TEMPLATES),
  /** a new repository (created and scaffolded) or an existing one (absent) */
  new: z.object({ private: z.boolean().default(true), scaffold: z.enum(['empty', 'python', 'kicad', 'rust']).optional() }).optional(),
  people: z.array(Person).max(100).default([]),
  build: BuildSchema.partial().optional(),
  later: z.array(z.enum(LATER_STAGES)).max(3).default([]),
  /** apply the repository settings the loop needs (auto-merge, labels, ruleset) */
  apply: z.boolean().default(true),
})

export type StepState = 'done' | 'skipped' | 'failed' | 'waiting'
export interface Step { id: string; title: string; state: StepState; detail: string }

/** Where the installation picks up projects that need their own cloud resources (read by the installer's update). */
export const PENDING_PREFIX = 'installation'
export const pendingKey = (repo: string): string => `pending-projects/${projectSlug(repo)}.json`

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 400)

/** Record (or refresh) a pending project for the next update of the installation: a conditional write, retried. */
async function recordPending(ctx: Context, repo: string, body: Record<string, unknown>): Promise<void> {
  const store = storeAt(ctx, PENDING_PREFIX)
  const key = pendingKey(repo)
  const bytes = new TextEncoder().encode(JSON.stringify(body, null, 2))
  for (let i = 0; i < 4; i++) {
    const etag = await store.head(key)
    try {
      await store.put(key, bytes, { ...(etag === null ? { ifNoneMatch: true } : { ifMatch: etag }), contentType: 'application/json' })
      return
    } catch (e) {
      if (!(e instanceof Conflict)) throw e
    }
  }
  throw new ActionError('the list of pending projects kept changing; try again')
}

/**
 * When the project's own cloud resources arrive (src/installer/pending.ts): with the self-update on (TRACE_SELF_UPDATE,
 * `owner/repo@branch` of trace's own repository), the next run of its update-installation job, which a change to that
 * branch starts (or an admin, running its ci workflow on that branch by hand); without it, the next run of the installer.
 */
export function cloudWait(selfUpdate: string | undefined = process.env.TRACE_SELF_UPDATE, layout: string | undefined = process.env.TRACE_LAYOUT): string {
  const m = /^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)@(.+)$/.exec(selfUpdate?.trim() ?? '')
  // a flat installation (every project in one stack): no knowledge base, and the update adds projects only up to a point
  const flat = layout === 'flat'
    ? ` This installation keeps every project in one stack (the flat layout): the project gets no knowledge base, and ${m ? `the update adds it only while there are fewer than ${FLAT_UPDATE_MAX} projects, else the next installer run does` : 'about 20 projects fit'}. Admin › Installation says how to move to one nested stack per project.`
    : ''
  if (m && flat) return `The project's agent is added at the next update of the installation: when ${m[1]}'s ${m[2]} branch next changes, its ci workflow deploys the installation with this project (usually within an hour of the merge).${flat}`
  if (!m && flat) return `The project's agent is added the next time an admin runs the installer (\`tracectl install\`), which takes in every project created here.${flat}`
  if (!m) return 'The project\'s agent and knowledge base are added the next time an admin runs the installer (`tracectl install`), which takes in every project created here.'
  return `The project's agent and knowledge base are added at the next update of the installation: when ${m[1]}'s ${m[2]} branch next changes, its ci workflow deploys the installation with this project (usually within an hour of the merge). An admin can start it now by running that workflow on ${m[2]} by hand (Actions → ci → Run workflow), or by running the installer.`
}

/** The workflow whose update-installation job deploys the installation (.github/workflows/ci.yml). */
export const UPDATE_WORKFLOW = 'ci.yml'
/**
 * The ci workflow's input that makes a run started by hand only add projects: it skips trace's own tests and goes
 * straight to the update. What it deploys is main as it is, and every commit on main passed those tests in its pull
 * request; the tests were about half of the update's time (test-esp32 run 1, log #2: 15 minutes in all).
 */
export const ADD_PROJECTS_INPUT = 'add_projects'

/**
 * Start the self-update now (a workflow_dispatch run of trace's ci workflow on the self-update's branch, with
 * ADD_PROJECTS_INPUT: its update-installation job runs on workflow_dispatch too), and say what the project waits for.
 * A branch whose ci workflow does not know the input yet (GitHub answers 422) gets a plain run, tests and all. Without
 * the self-update, or when GitHub refuses (the API's token may not run workflows in trace's repository), the wait is
 * cloudWait's. Several projects created close together each start a run; the job's concurrency group runs one deploy
 * at a time and keeps only the newest waiting, which takes in every pending project.
 */
export async function startUpdate(gh: Pick<GitHubApi, 'dispatchWorkflow' | 'dispatchWorkflowWith'>, selfUpdate: string | undefined = process.env.TRACE_SELF_UPDATE, layout: string | undefined = process.env.TRACE_LAYOUT): Promise<{ started: boolean; text: string }> {
  const m = /^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)@(.+)$/.exec(selfUpdate?.trim() ?? '')
  if (!m || (!gh.dispatchWorkflow && !gh.dispatchWorkflowWith)) return { started: false, text: cloudWait(selfUpdate, layout) }
  const [, repo = '', branch = ''] = m
  try {
    if (gh.dispatchWorkflowWith) {
      try {
        await gh.dispatchWorkflowWith(repo, UPDATE_WORKFLOW, branch, { [ADD_PROJECTS_INPUT]: 'true' })
      } catch (e) {
        // "Unexpected inputs provided": that branch's ci workflow is older than the input
        if (!(e instanceof GitHubError && e.status === 422) || !gh.dispatchWorkflow) throw e
        await gh.dispatchWorkflow(repo, UPDATE_WORKFLOW, branch)
      }
    } else {
      await gh.dispatchWorkflow!(repo, UPDATE_WORKFLOW, branch)
    }
  } catch (e) {
    return { started: false, text: `${cloudWait(selfUpdate, layout)} (trace could not start it itself: ${message(e)}.)` }
  }
  const flat = layout === 'flat' ? ` This installation keeps every project in one stack (the flat layout): the project gets no knowledge base, and the update adds it only while there are fewer than ${FLAT_UPDATE_MAX} projects. Admin › Installation says how to move to one nested stack per project.` : ''
  // plain words (log #4): the run on GitHub is in the admins' More menu on the project page, not named here
  return { started: true, text: `trace is updating itself to add this project's agent${layout === 'flat' ? '' : ' and knowledge base'}. The project page shows how far it has got and about when it will be ready.${flat}` }
}

// ------------------------------------------------------------------ project.agent

/** How long a new project's agent takes when nothing better is known (no finished update to go by): "within the hour". */
export const SETUP_MS = 60 * 60_000
/** How many of the latest successful update runs the estimate is taken from (typicalUpdateMs). */
export const TYPICAL_RUNS = 5
/** The estimate is never under this: a deploy alone takes a few minutes. */
export const TYPICAL_MIN_MS = 5 * 60_000
/** How far past its estimate an update may run before the notice says it is taking longer than usual. */
export const LATE_SLACK_MS = 10 * 60_000

/**
 * How long the update usually takes in this installation: the median of the latest TYPICAL_RUNS successful runs of the
 * ci workflow on the self-update's branch (created to last updated), those started by hand first (projects.create's,
 * which skip the tests), else any; null when none finished yet. The log's run took 15 minutes while the notice said an
 * hour (test-esp32 run 1, log #2 and #5). Pure.
 */
export function typicalUpdateMs(runs: readonly RunSummary[], branch: string): number | null {
  const ok = runs.filter((r) => r.path.endsWith(`/${UPDATE_WORKFLOW}`) && (r.branch ?? '') === branch && r.status === 'completed' && r.conclusion === 'success')
    .map((r) => ({ event: r.event, ms: Date.parse(r.updated_at ?? '') - Date.parse(r.created_at), at: r.created_at }))
    .filter((r) => Number.isFinite(r.ms) && r.ms > 0)
    .sort((a, b) => b.at.localeCompare(a.at))
  const byHand = ok.filter((r) => r.event === 'workflow_dispatch')
  const pick = (byHand.length ? byHand : ok).slice(0, TYPICAL_RUNS).map((r) => r.ms).sort((a, b) => a - b)
  if (!pick.length) return null
  const mid = pick.length % 2 ? pick[(pick.length - 1) / 2]! : (pick[pick.length / 2 - 1]! + pick[pick.length / 2]!) / 2
  return Math.max(TYPICAL_MIN_MS, Math.round(mid / 60_000) * 60_000)
}

/** "about 15 minutes", or "under an hour" without an estimate. Pure. */
const usualWords = (ms: number | null | undefined): string => (ms ? `about ${Math.round(ms / 60_000)} minutes` : 'under an hour')
/** How often the app looks again while the agent is being set up, and once the update has finished (the API picks up
 * the new runtime within a few minutes of the deploy). */
export const SETUP_CHECK_S = 60
export const ADDED_CHECK_S = 20
/** While only a person can move it on (no request, a failed one): looked at less often, so the notice still clears
 * itself once an admin has run the installer. */
export const STALLED_CHECK_S = 300
/** How long trace's service usually takes to start using a runtime an update added (it reads the stack's list again). */
export const ADDED_MS = 10 * 60_000
/** How long after the update's run succeeded a request still pending means the update left it out (it marks the
 * records it added straight after its deploy). */
export const LEFT_OUT_MS = 10 * 60_000

/** How long the update's run on GitHub is kept between looks: every open project page asks. */
const RUN_TTL_MS = 30_000

export type AgentState = 'ready' | 'setting_up' | 'finishing' | 'failed' | 'missing'

export interface AgentSetup {
  repo: string
  ready: boolean
  state: AgentState
  /** one or two sentences a person reads: what is happening and what happens next */
  text: string
  requested_at: string | null
  /** the installation update's run on GitHub, when the self-update is on and it could be read; `url` (trace's own
   * repository) for admins only. `steps`: its jobs' steps as they stand (updateSteps), so the app shows its progress
   * without GitHub; `failed_log`: the failing step's last FAILED_LOG_LINES lines, once it failed, for admins only (else null) */
  update: { status: 'queued' | 'running' | 'finished' | 'failed'; started_at: string; url?: string; steps?: UpdateStep[]; failed_log?: string | null } | null
  /** when it should be ready (an estimate), or null */
  expected_by: string | null
  /** how many seconds until the app should look again (the run on GitHub announces nothing; the record's change does,
   * as a live event); null once ready */
  next_check_s: number | null
}

/** One step of the update's run, as the app shows it: done, running, waiting (not started yet) or failed. */
export interface UpdateStep { name: string; state: 'done' | 'running' | 'waiting' | 'failed' }

/** How many lines of the failing step's log the app shows. */
export const FAILED_LOG_LINES = 40

/** A run's jobs as GitHub answers GET …/actions/runs/<id>/jobs (only what is read). */
export interface RunJob {
  id: number; name: string; status: string; conclusion: string | null
  steps?: { name: string; status: string; conclusion: string | null; number: number }[]
}

/** GitHub's own bookkeeping steps ("Set up job", "Post Run actions/checkout@v4", "Complete job"): not shown. */
const BOOKKEEPING = /^(Set up job|Complete job|Post .+)$/

/**
 * A step left unnamed in the workflow: GitHub names it "Run " and the first line of its script ("Run for r in
 * $RESULTS; do"), shell that means nothing to a person (test-esp32 log R4). Shown by its job's name instead.
 */
const UNNAMED = /^Run (?!actions\/|[\w.-]+\/[\w.-]+@)/

/** A step's or job's state from GitHub's status and conclusion. Pure. */
const stepState = (status: string, conclusion: string | null): UpdateStep['state'] =>
  status !== 'completed' ? (status === 'in_progress' ? 'running' : 'waiting')
    : conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'cancelled' ? 'failed' : 'done'

/**
 * The update's steps in order: each job's steps (bookkeeping left out), named "job › step" when the run has several
 * jobs; a job GitHub lists without steps yet is one step of its own. A skipped step or job counts as done. Pure.
 */
export function updateSteps(jobs: readonly RunJob[]): UpdateStep[] {
  const many = jobs.length > 1
  return jobs.flatMap((j) => {
    // the deploy job skipped is no update at all: it is what adds the project (test-esp32 log R7, where the run
    // "succeeded", every line had a tick, and trace waited for an agent that was never added)
    if (j.name === DEPLOY_JOB && j.status === 'completed' && j.conclusion === 'skipped') return [{ name: `${j.name} (skipped: nothing was deployed)`, state: 'failed' as const }]
    const steps = (j.steps ?? []).filter((s) => !BOOKKEEPING.test(s.name)).sort((a, b) => a.number - b.number)
    if (!steps.length) return [{ name: j.name, state: stepState(j.status, j.conclusion) }]
    // an unnamed step is its job when it is the job's only step, else "step n" of the job
    const own = (s: { name: string }, i: number): string | null => !UNNAMED.test(s.name) ? s.name : steps.length === 1 ? null : `step ${i + 1}`
    return steps.map((s, i) => {
      const n = own(s, i)
      return { name: n === null ? j.name : many ? `${j.name} › ${n}` : n, state: stepState(s.status, s.conclusion) }
    })
  })
}

/** The first failed job (the one whose log is read), or null. Pure. */
export const failedJob = (jobs: readonly RunJob[]): RunJob | null => jobs.find((j) => stepState(j.status, j.conclusion) === 'failed') ?? null

/** The job in trace's ci workflow that deploys the installation, and so adds new projects. */
export const DEPLOY_JOB = 'update-installation'

/** A job log's last `n` lines, GitHub's timestamps taken off the front of each line. Pure. */
export function logTail(text: string, n: number = FAILED_LOG_LINES): string {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  return lines.slice(-n).map((l) => l.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z ?/, '')).join('\n')
}

/**
 * The update's run on GitHub for a request: of the runs of trace's ci workflow on the self-update's branch started
 * after the request (a minute's slack for clocks), every one of which takes in the pending projects, the first that
 * succeeded (it is the one that added the project); else the first still queued or running (the one that will); else
 * the newest (it failed, or was cancelled). Not simply the newest: a merge to that branch after the update finished
 * starts another run, still queued, and the notice followed that one, "queued" with nothing started, half an hour after
 * the update that mattered had finished (test-esp32 log #5). Pure.
 */
export function updateRunFor(runs: readonly RunSummary[], branch: string, requestedAt: string | null): RunSummary | null {
  const after = requestedAt ? Date.parse(requestedAt) - 60_000 : -Infinity
  const mine = [...runs]
    .filter((r) => r.path.endsWith(`/${UPDATE_WORKFLOW}`) && (r.branch ?? '') === branch && Date.parse(r.created_at) >= after)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)
  return mine.find((r) => r.status === 'completed' && r.conclusion === 'success')
    ?? mine.find((r) => r.status !== 'completed')
    ?? mine.at(-1) ?? null
}

/**
 * The run's state as the notice says it. A run GitHub still calls queued whose jobs have begun is running: the steps
 * are read apart from the run (updateProgress), and the notice never says "queued" above a step that is done. Pure.
 */
export function runStatus(r: RunSummary, steps?: readonly UpdateStep[]): NonNullable<AgentSetup['update']>['status'] {
  if (r.status === 'completed') return r.conclusion === 'success' && !steps?.some((s) => s.state === 'failed') ? 'finished' : 'failed'
  if (r.status === 'in_progress' || steps?.some((s) => s.state !== 'waiting')) return 'running'
  return 'queued'
}

/**
 * How a project's agent stands, from what the API knows: whether it has the project's runtime (ready), the pending
 * request, and the update's run. Pure (the reads are project.agent's).
 */
export function agentSetup(o: {
  repo: string; hasAgent: boolean; record: PendingRecord | null; run: RunSummary | null; selfUpdate: boolean; admin: boolean; now?: number
  /** the stack's layout (TRACE_LAYOUT): in a flat one an update adds projects only up to FLAT_UPDATE_MAX */
  layout?: string | undefined
  /** the run's steps and, once it failed, the failing step's log tail (updateProgress); absent: not read */
  progress?: { steps: UpdateStep[]; failed_log: string | null } | null
  /** how long this installation's update usually takes (typicalUpdateMs); absent or null: SETUP_MS */
  typicalMs?: number | null
  /** GitHub could not be asked how the update stands (updateRun): said so, never guessed */
  unread?: boolean
}): AgentSetup {
  const now = o.now ?? Date.now()
  const base = { repo: o.repo, requested_at: o.record?.requested_at ?? null, update: null, expected_by: null }
  if (o.hasAgent) return { ...base, ready: true, state: 'ready', text: 'This project\'s agent is set up.', next_check_s: null }
  const r = o.record
  if (!r) {
    return { ...base, ready: false, state: 'missing', next_check_s: STALLED_CHECK_S,
      text: 'This project\'s agent is not set up in this installation, and no update is waiting to add it. An admin can add it by running the installer.' }
  }
  if (r.status === 'failed') {
    return { ...base, ready: false, state: 'failed', next_check_s: STALLED_CHECK_S,
      text: `The installation update could not add this project's agent${o.admin && r.last_error ? ` (last: ${r.last_error})` : ''}. An admin can add it by running the installer.` }
  }
  const update = o.run ? {
    status: runStatus(o.run, o.progress?.steps), started_at: o.run.created_at, ...(o.admin ? { url: o.run.url } : {}),
    // the log of trace's own update is an admin's, like its link: everyone else sees the steps
    ...(o.progress ? { steps: o.progress.steps, failed_log: o.admin ? o.progress.failed_log : null } : {}),
  } : null
  if (r.status === 'added') {
    // from when the update marked it added (a record from before added_at: from now, as before)
    const by = (Date.parse(r.added_at ?? '') || now) + ADDED_MS
    const late = now > by
    return {
      // the update's run as it ended, its steps done, when it could be read: the notice moves on from it, not back to none
      ...base, ready: false, state: 'finishing', update, expected_by: new Date(by).toISOString(),
      // once it is late only a person can move it on (the service may need restarting): looked at less often
      next_check_s: late ? STALLED_CHECK_S : ADDED_CHECK_S,
      text: late
        ? 'The installation update added this project\'s agent, but trace\'s service is taking longer than usual to start using it. If it is still not ready soon, an admin can run the installer.'
        : 'The installation update has added this project\'s agent. trace\'s service starts using it within a few minutes.',
    }
  }
  // the update finished well ago and still did not mark this request added: it left the project out (in a flat
  // installation, most likely for its project limit); only the installer, or an admin, adds it now
  // (when it finished: GitHub's updated_at; without it nothing is concluded)
  const finishedAt = o.run?.status === 'completed' ? Date.parse(o.run.updated_at ?? '') : NaN
  if (update?.status === 'finished' && Number.isFinite(finishedAt) && now - finishedAt > LEFT_OUT_MS) {
    const why = o.layout === 'flat'
      ? ` This installation keeps every project in one stack, and an update adds projects to it only while there are fewer than ${FLAT_UPDATE_MAX}.`
      : ''
    return {
      ...base, ready: false, state: 'failed', update, next_check_s: STALLED_CHECK_S,
      text: `The installation update finished without adding this project's agent.${why} An admin can add it by running the installer.`,
    }
  }
  const from = Date.parse(o.run?.created_at ?? r.requested_at ?? '') || now
  // from this installation's own recent updates when there are any (typicalUpdateMs), else the hour
  const usual = o.typicalMs ?? null
  const expected = from + (usual ?? SETUP_MS)
  const late = now > expected + (usual ? LATE_SLACK_MS : 0)
  const progress = !update && o.unread
    // nothing from GitHub: said so, not a guess at "queued" or "asked for" (test-esp32 log #5)
    ? 'trace can\'t read how the installation update stands on GitHub just now, so it can\'t say how far it has got. It keeps looking; the notice clears by itself once the agent is set up.'
    : !update
    ? (o.selfUpdate ? `trace has asked for the installation update that adds this project's agent; it usually takes ${usualWords(usual)}.` : 'The agent is added the next time an admin runs the installer.')
    : update.status === 'queued' ? `The installation update is waiting for its turn to start; once it starts it usually takes ${usualWords(usual)}.`
      : update.status === 'running' ? 'The installation update is running: it is adding this project\'s agent to the installation.'
        : update.status === 'finished' ? 'The installation update has finished; trace is checking that it added this project\'s agent.'
          : `The installation update failed, so this project's agent is not set up yet. ${o.admin ? 'You can start the update again (Actions → ci → Run workflow on trace\'s repository) or run the installer.' : 'An admin can start the update again or run the installer.'}`
  const retried = r.attempts > 0 && update?.status !== 'failed' ? ' An earlier update with it failed; this one tries again.' : ''
  return {
    ...base, ready: false, state: 'setting_up', update,
    expected_by: o.selfUpdate ? new Date(expected).toISOString() : null,
    // a failed run waits for a person to start another; the app still looks again, less often. A finished one is
    // marked added within a minute or so: looked at sooner (the live event usually comes first)
    next_check_s: update?.status === 'failed' ? STALLED_CHECK_S : update?.status === 'finished' ? ADDED_CHECK_S : SETUP_CHECK_S,
    text: `${progress}${retried}${o.selfUpdate && late && update?.status !== 'failed' ? ' It is taking longer than usual.' : ''}`,
  }
}

/** The pending request projects.create recorded for this project, or null (none, or unreadable). */
async function pendingRecord(ctx: Context, repo: string): Promise<PendingRecord | null> {
  const got = await storeAt(ctx, PENDING_PREFIX).get(pendingKey(repo))
  if (!got) return null
  const r = PendingRecordSchema.safeParse(JSON.parse(new TextDecoder().decode(got.body)) as unknown)
  return r.success ? r.data : null
}

/** The self-update's update run for this request on GitHub, and how long its updates usually take (typicalUpdateMs);
 * nulls when there is no self-update, and `unread` too when GitHub would not say. Only the ci workflow's runs on the
 * self-update's branch are asked for: every run of trace's repository (each pull request's checks, the stack's own
 * workflow) pushed the update's run out of the newest 30 on a busy day. */
async function updateRun(ctx: Context, requestedAt: string | null, selfUpdate: string | undefined): Promise<{ run: RunSummary | null; typicalMs: number | null; unread: boolean }> {
  const m = /^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)@(.+)$/.exec(selfUpdate?.trim() ?? '')
  if (!m?.[1] || !m[2]) return { run: null, typicalMs: null, unread: false }
  const [repo, branch] = [m[1], m[2]]
  try {
    const gh = await ctx.deps.github()
    const runs = await cached(ctx.deps.githubCache, repo, `update-runs-${branch}`, () => gh.workflowRuns(repo, 30, { workflow: UPDATE_WORKFLOW, branch }), RUN_TTL_MS)
    return { run: updateRunFor(runs, branch, requestedAt), typicalMs: typicalUpdateMs(runs, branch), unread: false }
  } catch {
    return { run: null, typicalMs: null, unread: true }
  }
}

/**
 * The update run's steps (its jobs, through GitHubApi.request) and, when a job failed, the last FAILED_LOG_LINES lines
 * of its log (requestText). Kept RUN_TTL_MS like the run. Best effort: null when this installation's client cannot ask
 * or GitHub would not say; a log that cannot be read is null.
 */
async function updateProgress(ctx: Context, run: RunSummary, selfUpdate: string | undefined): Promise<{ steps: UpdateStep[]; failed_log: string | null } | null> {
  const repo = /^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)@/.exec(selfUpdate?.trim() ?? '')?.[1]
  if (!repo) return null
  try {
    const gh = await ctx.deps.github()
    if (!gh.request) return null
    return await cached(ctx.deps.githubCache, repo, `update-steps-${run.id}`, async () => {
      const r = await gh.request!('GET', `/repos/${repo}/actions/runs/${run.id}/jobs?per_page=50`) as { jobs?: RunJob[] } | null
      const jobs = Array.isArray(r?.jobs) ? r.jobs : []
      const failed = failedJob(jobs)
      let failed_log: string | null = null
      if (failed && gh.requestText) {
        failed_log = await gh.requestText(`/repos/${repo}/actions/jobs/${failed.id}/logs`, 64 * 1024).then((t) => logTail(t.text)).catch(() => null)
      }
      return { steps: updateSteps(jobs), failed_log }
    }, RUN_TTL_MS)
  } catch {
    return null
  }
}

/** Whether a repository is free for a new project (projects.repo_check). */
export interface RepoCheck {
  repo: string
  /** on GitHub already; null when GitHub could not be asked (projects.create asks again) */
  exists: boolean | null
  /** the project trace knows there, retired or not */
  project: { name: string | null; retired: boolean } | null
  /** a free name beside it, when it is taken */
  suggestion: string | null
}

const SUGGESTIONS = 8

async function existsOnGitHub(gh: GitHubApi, repo: string): Promise<boolean | null> {
  if (!gh.repoExists) return null
  return gh.repoExists(repo).catch(() => null)
}

/** What trace and GitHub know of a repository, and a free name beside it when it is taken. */
export async function repoCheck(ctx: Context, repo: string): Promise<RepoCheck> {
  const key = repo.toLowerCase()
  const known = await registered().then((all) => all.some((r) => r.toLowerCase() === key)).catch(() => false)
  const life = await lifecycleOf(repo).catch(() => null)
  let project: RepoCheck['project'] = null
  if (known || life?.retired) {
    const j = await withJourneyDb(ctx, repo, (db) => loadJourney(db)?.journey ?? null).catch(() => null)
    project = { name: j?.name ?? null, retired: Boolean(life?.retired) }
  }
  const gh = await ctx.deps.github()
  // a project trace knows has its repository, whatever GitHub answers this token
  const asked = await existsOnGitHub(gh, repo)
  const exists = asked === true || project ? true : asked
  let suggestion: string | null = null
  if (exists) {
    const [owner, name] = repo.split('/') as [string, string]
    const base = name.replace(/-\d+$/, '')
    const all = await registered().catch(() => [] as string[])
    for (let n = 2; n < 2 + SUGGESTIONS && !suggestion; n++) {
      const next = `${owner}/${base}-${n}`
      if (next.toLowerCase() === key || all.some((r) => r.toLowerCase() === next.toLowerCase()) || (await lifecycleOf(next).catch(() => null))?.retired) continue
      if ((await existsOnGitHub(gh, next)) !== true) suggestion = next
    }
  }
  return { repo, exists, project, suggestion }
}

/** What a person reads when the repository is taken: whose it is, and the name to use instead. */
export function takenWords(c: RepoCheck): string {
  const whose = c.project
    ? `${c.repo} already exists: it holds the ${c.project.retired ? 'retired ' : ''}project ${c.project.name ?? projectSlug(c.repo)}.`
    : `${c.repo} already exists on GitHub.`
  return `${whose}${c.suggestion ? ` ${c.suggestion} is free.` : ''}`
}

const DEFAULT_SCAFFOLD: Readonly<Record<Template, 'empty' | 'kicad'>> = { board: 'kicad', mixed: 'kicad', fpga: 'empty', firmware: 'empty' }

export const PROJECT_ACTIONS = {
  'project.members': def('read', Repo, async ({ repo }, ctx) => {
    const assigned = await membersOf(repo)
    const admins = await ctx.deps.cognito().usersInGroup(GROUPS.admin)
    const adminSubs = new Set(admins.map((a) => a.sub))
    const out: Member[] = admins.map((a) => ({ sub: a.sub, email: a.email, class: 'admin', part: 'contributor', admin: true, can_sign: true }))
    for (const m of assigned) {
      if (adminSubs.has(m.sub)) continue
      out.push({ sub: m.sub, email: m.email, class: m.class, part: m.part, admin: false, can_sign: false })
    }
    return { repo, members: out.sort((a, b) => Number(b.admin) - Number(a.admin) || (a.email ?? a.sub).localeCompare(b.email ?? b.sub)) }
  }),

  'project.agent': def('read', Repo, async ({ repo }, ctx): Promise<AgentSetup> => {
    const jobs = await ctx.deps.jobs()
    const hasAgent = jobs.hasAgent ? jobs.hasAgent(repo) : true
    const selfUpdate = process.env.TRACE_SELF_UPDATE
    // the agent is there: the work asked for while it was being set up starts now (src/api/agent-queue.ts), not only
    // at the next look at the project's jobs (the new project's finished screen asks for none)
    if (hasAgent && jobs.hasAgent) await startQueued(jobs, storeAt(ctx, PROJECTS_PREFIX), repo).catch(() => [])
    const record = hasAgent ? null : await pendingRecord(ctx, repo).catch(() => null)
    // the run is read while the request is pending, and once the update marked it added (its steps then show done)
    const follow = !hasAgent && (record?.status === 'pending' || record?.status === 'added')
    const { run, typicalMs, unread } = follow ? await updateRun(ctx, record?.requested_at ?? null, selfUpdate) : { run: null, typicalMs: null, unread: false }
    const progress = run ? await updateProgress(ctx, run, selfUpdate) : null
    return agentSetup({ repo, hasAgent, record, run, progress, typicalMs, unread, selfUpdate: Boolean(selfUpdate?.includes('@')), admin: isAdmin(ctx.principal), layout: ctx.deps.layout ?? process.env.TRACE_LAYOUT })
  }),

  'projects.create': def('admin', Create, async (a, ctx) => {
    const steps: Step[] = []
    const step = (id: string, title: string, state: StepState, detail: string): void => { steps.push({ id, title, state, detail }) }
    const repo = a.repo

    // 1. onboard
    if (!ctx.deps.onboard) throw new ActionError('This installation cannot put repositories under trace from the API.')
    // nothing is created on top of what is there: onboarding a "new" repository that exists would push the starter
    // onto its files, and a retired project's repository still holds that project's record (test-esp32 log #78)
    const free = await repoCheck(ctx, repo)
    if (a.new && free.exists) throw new ActionError(`${takenWords(free)} Choose another name, or choose "An existing repository" to put this one under trace.`)
    if (free.project?.retired) throw new ActionError(`${takenWords(free)} To carry on with it, restore it from Admin, Retired projects; otherwise choose another repository.`)
    try {
      const r = await ctx.deps.onboard(repo, { create: a.new ? { template: a.new.scaffold ?? DEFAULT_SCAFFOLD[a.template], private: a.new.private } : null, apply: a.apply })
      const what = {
        created: 'Created the repository and put it under trace.',
        opened: `Opened the onboarding pull request${r.pr ? ` (${r.pr})` : ''}. It is held for a person to merge.`,
        updated: `Updated the open onboarding pull request${r.pr ? ` (${r.pr})` : ''}.`,
        refreshed: `The repository was already under trace; opened a pull request refreshing its workflows${r.pr ? ` (${r.pr})` : ''}.`,
        unchanged: 'The repository was already under trace, with current workflows.',
      }[r.state]
      // the joining (or workflow refresh) pull request is an edit the admin made in the app: recorded so the app shows
      // it as a change and trace applies it (docs/stay-in-trace.md "Writers"); nobody goes to GitHub to merge it
      const joining = await recordJoin(ctx, repo, r).catch(() => null)
      step('repository', a.new ? 'Create the repository' : 'Connect the repository', 'done', [joining ? what.replace(/ It is held for a person to merge\./, '').replace(/ \(https:[^)]*\)/, '') : what, ...(joining ? [joining] : []), ...r.settings.map((x) => `${x[0]?.toUpperCase()}${x.slice(1)}.`)].join(' '))
    } catch (e) {
      step('repository', a.new ? 'Create the repository' : 'Connect the repository', 'failed', message(e))
      for (const [id, title] of [['registry', 'Add it to trace\'s list of projects'], ['people', 'Add people'], ['journey', 'Start the journey'], ['cloud', 'Set up the project\'s agent and knowledge base']] as const) {
        step(id, title, 'skipped', 'Waits for the repository step. Send the request again once it is fixed; every step is safe to repeat.')
      }
      return { repo, ok: false, steps, waits: [] }
    }

    // 2. the registry
    try {
      await register(repo, null)
      step('registry', 'Add it to trace\'s list of projects', 'done', 'Registered.')
    } catch (e) {
      step('registry', 'Add it to trace\'s list of projects', 'failed', message(e))
    }

    // 3. people
    const cog = ctx.deps.cognito()
    const people: { who: string; sub: string | null; part: Part | null; invited: boolean; error: string | null }[] = []
    for (const p of a.people) {
      try {
        let u = await cog.find(p.who)
        let invited = false
        let cls: PersonClass | null
        if (!u) {
          if (!z.string().email().safeParse(p.who).success) throw new ActionError(`No one is called ${p.who}; give an email to invite them.`)
          cls = p.class ?? (p.part === 'reviewer' ? 'guest' : 'user')
          if (cls === 'guest' && p.part === 'contributor') throw new ActionError(`${p.who} would be a guest, and a guest can only be a reviewer.`)
          u = await cog.createUser(p.who)
          await cog.addToGroup(u.username, GROUPS[cls])
          await setClass(ctx.principal, { sub: u.sub, email: p.who }, cls)
          invited = true
        } else {
          const groups = await cog.groupsFor(u.username)
          cls = classOf({ sub: u.sub, email: u.email, groups })
        }
        if (cls === 'admin') {
          people.push({ who: p.who, sub: u.sub, part: 'contributor', invited, error: null })
          continue
        }
        const asg = await assign(ctx.principal, { sub: u.sub, email: u.email }, repo, { part: p.part, class: cls })
        people.push({ who: p.who, sub: u.sub, part: asg.part, invited, error: null })
      } catch (e) {
        people.push({ who: p.who, sub: null, part: null, invited: false, error: e instanceof PartRefused ? e.message : message(e) })
      }
    }
    const failed = people.filter((p) => p.error)
    const ok = people.filter((p) => !p.error)
    step('people', 'Add people', a.people.length === 0 ? 'skipped' : failed.length ? 'failed' : 'done',
      a.people.length === 0 ? 'No one was named; admins are on every project.'
        : [
          ...ok.map((p) => `${p.who}: ${p.part === 'contributor' ? 'contributor' : 'reviewer'}${p.invited ? ', invited by email' : ''}.`),
          ...failed.map((p) => `${p.who}: ${p.error}`),
        ].join(' '))

    // 4. the journey
    let journey: unknown = null
    try {
      forgetNoJourney(repo)
      // the installation's definition of the template, as its admins keep it (src/core/template-store.ts): the
      // journey keeps this version, whatever is saved later
      const definition = await new TemplateStore().definition(a.template)
      const r = await writeJourney(ctx, repo, (db) => {
        const rec = startJourney(db, {
          template: a.template, later: a.later, start: a.start, name: a.name, description: a.description ?? null, icon: a.icon ?? null,
          build: a.build ?? {}, by: label(ctx.principal), definition,
        })
        return { result: { view: journeyView(rec, { hash: hashOf(ctx.principal), label: label(ctx.principal), admin: true, part: 'contributor' }) } }
      })
      journey = r.view
      step('journey', 'Start the journey', 'done', `Started from the ${TEMPLATE_NAMES[a.template]} template${definition.version ? ` (version ${definition.version})` : ''} at ${r.view.stages[0]?.name ?? 'the first stage'}.`)
    } catch (e) {
      const already = e instanceof Error && /already has a journey/.test(e.message)
      step('journey', 'Start the journey', already ? 'skipped' : 'failed', message(e))
    }

    // 5. the project's own cloud resources: at the next update of the installation, started now when it can be
    let cloud = cloudWait()
    try {
      await recordPending(ctx, repo, {
        repo, name: a.name, template: a.template, requested_by: label(ctx.principal), requested_at: new Date().toISOString(),
        needs: ['worker runtime', 'memory', 'knowledge base', 'build runner'],
      })
      cloud = (await startUpdate(await ctx.deps.github())).text
      step('cloud', 'Set up the project\'s agent and knowledge base', 'waiting', cloud)
    } catch (e) {
      step('cloud', 'Set up the project\'s agent and knowledge base', 'failed', message(e))
    }

    return {
      repo, ok: !steps.some((s) => s.state === 'failed'), steps, people,
      waits: [{ id: 'installation-update', what: 'The project\'s agent and knowledge base', text: cloud }],
      journey,
    }
  }),

  'projects.repo_check': def('admin', Repo, async ({ repo }, ctx) => {
    const c = await repoCheck(ctx, repo)
    return { ...c, text: c.exists ? takenWords(c) : null }
  }),

  'project.update': def('admin', Repo.extend(AboutSchema.shape), async ({ repo, ...patch }, ctx) => {
    if (!Object.values(patch).some((v) => v !== undefined)) throw new ActionError('give at least one of name, description, icon, build or later')
    return writeJourney(ctx, repo, (db) => {
      const rec = updateAbout(db, patch, label(ctx.principal))
      return { result: { repo, view: journeyView(rec, { hash: hashOf(ctx.principal), label: label(ctx.principal), admin: true, part: 'contributor' }) } }
    })
  }),
}


/**
 * Record the onboarding's pull request as an app edit (src/api/edits.ts): `join` for the pull request that puts an
 * existing repository under trace, `workflows` for one refreshing its workflows. Answers the words for the step, or null
 * when there is no pull request (a new repository, or nothing to change).
 */
async function recordJoin(ctx: Context, repo: string, r: ApiOnboardResult): Promise<string | null> {
  if (!r.pr || !['opened', 'updated', 'refreshed'].includes(r.state)) return null
  const number = Number(/\/pull\/(\d+)/.exec(r.pr)?.[1] ?? 0)
  const gh = await ctx.deps.github()
  if (!number || !gh.pullDetail) return null
  const pull = await gh.pullDetail(repo, number)
  if (!pull || pull.state !== 'open') return null
  // only the commit onboarding itself pushed: a branch that moved since (someone pushed in between) is not recorded,
  // so it is never applied without checks as trace's own scaffold
  if (!r.commit || pull.head.sha !== r.commit) return null
  const kind = r.state === 'refreshed' ? 'workflows' as const : 'join' as const
  const title = kind === 'join' ? 'Put this repository under trace' : 'Refresh trace\'s workflows'
  await editStore(ctx).put({
    repo, branch: pull.head.ref, kind, title, by: label(ctx.principal), by_sub: ctx.principal.sub, by_name: await editorName(ctx),
    applies: appliesOf(kind, isAdmin(ctx.principal)), commit: pull.head.sha, number, at: new Date().toISOString(), redo: null,
  })
  return kind === 'join' ? `Its change "${title}" is on the project's Changes: trace applies it once it can.` : `Its change "${title}" is on the project's Changes: trace applies it once its checks pass.`
}
