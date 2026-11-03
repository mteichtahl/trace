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
 *                                  workflow on its branch, by hand), so the project's agent arrives within the hour
 *                                  instead of at the next merge; until then its tools answer that it is being set up
 *                             and answers each step's outcome, plus that last part as a wait. A step that fails stops
 *                             the ones that depend on it and says so; the request can be sent again (every step is
 *                             safe to repeat).
 *   project.agent     read    whether the project's own agent (its worker runtime) is set up in this installation yet,
 *                             and, while it is not, how its setting up stands: from the request projects.create
 *                             recorded under installation/pending-projects/ (pending, added by an update, or failed),
 *                             and, with the self-update on, the installation update's run on GitHub (queued, running,
 *                             finished). Answers when it should be ready (usually within the hour of the request or
 *                             of the update starting) and when to look again: nothing announces the update's end, so
 *                             the app looks again at next_check_s (agentSetup). The link to the update's run and how
 *                             to start it again (trace's own repository) are an admin's only
 *   project.update    admin   change what a project is after it is made: its name, description, icon, build plan
 *                             (quantity, unit cost, budget) and later stages, in the journey record (Settings). The
 *                             template and repository stay fixed
 *
 * Onboarding runs `git` (clone, commit, push) with the token in git's environment, never in a URL or a file: the API
 * runtime's image is the agents' image, which has git. Without it, step 1 fails with "install git" and nothing else
 * is changed.
 */
import { z } from 'zod'
import { GROUPS, PARTS, type Part, PartRefused, type PersonClass, RepoSlug, assign, classOf, isAdmin, membersOf, setClass } from '../core/access.js'
import { Conflict } from '../core/central.js'
import { AboutSchema, BuildSchema, LATER_STAGES, TEMPLATES, type Template, TEMPLATE_NAMES, journeyView, startJourney, updateAbout } from '../core/journey.js'
import { forgetNoJourney } from '../core/journey-store.js'
import { register } from '../core/onboard.js'
import { projectSlug } from '../core/project.js'
import { FLAT_UPDATE_MAX, type PendingRecord, PendingRecordSchema } from '../installer/pending.js'
import type { GitHubApi, RunSummary } from './github.js'
import { cached } from './github-cache.js'
import { ActionError, type Context, Repo, def, hashOf, label, storeAt, writeJourney } from './action-kit.js'
import { appliesOf } from '../core/app-edits.js'
import type { ApiOnboardResult } from '../installer/onboard-api.js'
import { editStore, editorName } from './edits.js'

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
 * Start the self-update now (a workflow_dispatch run of trace's ci workflow on the self-update's branch: its
 * update-installation job runs on workflow_dispatch too), and say what the project waits for. Without the self-update,
 * or when GitHub refuses (the API's token may not run workflows in trace's repository), the wait is cloudWait's.
 * Several projects created close together each start a run; the job's concurrency group runs one deploy at a time and
 * keeps only the newest waiting, which takes in every pending project.
 */
export async function startUpdate(gh: Pick<GitHubApi, 'dispatchWorkflow'>, selfUpdate: string | undefined = process.env.TRACE_SELF_UPDATE, layout: string | undefined = process.env.TRACE_LAYOUT): Promise<{ started: boolean; text: string }> {
  const m = /^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)@(.+)$/.exec(selfUpdate?.trim() ?? '')
  if (!m || !gh.dispatchWorkflow) return { started: false, text: cloudWait(selfUpdate, layout) }
  const [, repo = '', branch = ''] = m
  try {
    await gh.dispatchWorkflow(repo, UPDATE_WORKFLOW, branch)
  } catch (e) {
    return { started: false, text: `${cloudWait(selfUpdate, layout)} (trace could not start it itself: ${message(e)}.)` }
  }
  const flat = layout === 'flat' ? ` This installation keeps every project in one stack (the flat layout): the project gets no knowledge base, and the update adds it only while there are fewer than ${FLAT_UPDATE_MAX} projects. Admin › Installation says how to move to one nested stack per project.` : ''
  return { started: true, text: `Started the installation update: ${repo}'s ci workflow on ${branch} tests trace and then deploys the installation with this project's agent${layout === 'flat' ? '' : ' and knowledge base'}, usually within the hour. Until it finishes, the project's tools answer that its agent is being set up.${flat}` }
}

// ------------------------------------------------------------------ project.agent

/** How long a new project's agent usually takes: the update's tests and deploy (startUpdate's "within the hour"). */
export const SETUP_MS = 60 * 60_000
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
   * repository) for admins only */
  update: { status: 'queued' | 'running' | 'finished' | 'failed'; started_at: string; url?: string } | null
  /** when it should be ready (an estimate), or null */
  expected_by: string | null
  /** how many seconds until the app should look again (nothing announces the update's end); null once ready */
  next_check_s: number | null
}

/** The update's run on GitHub for a request: the newest run of trace's ci workflow on the self-update's branch started
 * after the request (a minute's slack for clocks). Pure. */
export function updateRunFor(runs: readonly RunSummary[], branch: string, requestedAt: string | null): RunSummary | null {
  const after = requestedAt ? Date.parse(requestedAt) - 60_000 : -Infinity
  return [...runs]
    .filter((r) => r.path.endsWith(`/${UPDATE_WORKFLOW}`) && (r.branch ?? '') === branch && Date.parse(r.created_at) >= after)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
}

const runStatus = (r: RunSummary): NonNullable<AgentSetup['update']>['status'] =>
  r.status !== 'completed' ? (r.status === 'in_progress' ? 'running' : 'queued') : r.conclusion === 'success' ? 'finished' : 'failed'

/**
 * How a project's agent stands, from what the API knows: whether it has the project's runtime (ready), the pending
 * request, and the update's run. Pure (the reads are project.agent's).
 */
export function agentSetup(o: {
  repo: string; hasAgent: boolean; record: PendingRecord | null; run: RunSummary | null; selfUpdate: boolean; admin: boolean; now?: number
  /** the stack's layout (TRACE_LAYOUT): in a flat one an update adds projects only up to FLAT_UPDATE_MAX */
  layout?: string | undefined
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
  if (r.status === 'added') {
    // from when the update marked it added (a record from before added_at: from now, as before)
    const by = (Date.parse(r.added_at ?? '') || now) + ADDED_MS
    const late = now > by
    return {
      ...base, ready: false, state: 'finishing', expected_by: new Date(by).toISOString(),
      // once it is late only a person can move it on (the service may need restarting): looked at less often
      next_check_s: late ? STALLED_CHECK_S : ADDED_CHECK_S,
      text: late
        ? 'The installation update added this project\'s agent, but trace\'s service is taking longer than usual to start using it. If it is still not ready soon, an admin can run the installer.'
        : 'The installation update has added this project\'s agent. trace\'s service starts using it within a few minutes.',
    }
  }
  const update = o.run ? { status: runStatus(o.run), started_at: o.run.created_at, ...(o.admin ? { url: o.run.url } : {}) } : null
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
  const expected = from + SETUP_MS
  const late = now > expected
  const progress = !update
    ? (o.selfUpdate ? 'The installation update was asked for; it tests trace and then deploys this project\'s agent, usually within the hour.' : 'The agent is added the next time an admin runs the installer.')
    : update.status === 'queued' ? 'The installation update is queued on GitHub; once it starts it usually takes under an hour.'
      : update.status === 'running' ? 'The installation update is running: it tests trace and then deploys this project\'s agent.'
        : update.status === 'finished' ? 'The installation update has finished; trace is checking that it added this project\'s agent.'
          : `The installation update failed, so this project's agent is not set up yet. ${o.admin ? 'You can start the update again (Actions → ci → Run workflow on trace\'s repository) or run the installer.' : 'An admin can start the update again or run the installer.'}`
  const retried = r.attempts > 0 && update?.status !== 'failed' ? ' An earlier update with it failed; this one tries again.' : ''
  return {
    ...base, ready: false, state: 'setting_up', update,
    expected_by: o.selfUpdate ? new Date(expected).toISOString() : null,
    // a failed run waits for a person to start another; the app still looks again, less often
    next_check_s: update?.status === 'failed' ? STALLED_CHECK_S : SETUP_CHECK_S,
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

/** The self-update's update run for this request on GitHub, or null (no self-update, or GitHub would not say). */
async function updateRun(ctx: Context, requestedAt: string | null, selfUpdate: string | undefined): Promise<RunSummary | null> {
  const m = /^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)@(.+)$/.exec(selfUpdate?.trim() ?? '')
  if (!m?.[1] || !m[2]) return null
  const [repo, branch] = [m[1], m[2]]
  try {
    const gh = await ctx.deps.github()
    const runs = await cached(ctx.deps.githubCache, repo, 'update-runs', () => gh.workflowRuns(repo, 30), RUN_TTL_MS)
    return updateRunFor(runs, branch, requestedAt)
  } catch {
    return null
  }
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
    const record = hasAgent ? null : await pendingRecord(ctx, repo).catch(() => null)
    const run = !hasAgent && record?.status === 'pending' ? await updateRun(ctx, record.requested_at ?? null, selfUpdate) : null
    return agentSetup({ repo, hasAgent, record, run, selfUpdate: Boolean(selfUpdate?.includes('@')), admin: isAdmin(ctx.principal), layout: ctx.deps.layout ?? process.env.TRACE_LAYOUT })
  }),

  'projects.create': def('admin', Create, async (a, ctx) => {
    const steps: Step[] = []
    const step = (id: string, title: string, state: StepState, detail: string): void => { steps.push({ id, title, state, detail }) }
    const repo = a.repo

    // 1. onboard
    if (!ctx.deps.onboard) throw new ActionError('This installation cannot put repositories under trace from the API.')
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
      const r = await writeJourney(ctx, repo, (db) => {
        const rec = startJourney(db, {
          template: a.template, later: a.later, start: a.start, name: a.name, description: a.description ?? null, icon: a.icon ?? null,
          build: a.build ?? {}, by: label(ctx.principal),
        })
        return { result: { view: journeyView(rec, { hash: hashOf(ctx.principal), label: label(ctx.principal), admin: true, part: 'contributor' }) } }
      })
      journey = r.view
      step('journey', 'Start the journey', 'done', `Started from the ${TEMPLATE_NAMES[a.template]} template at ${r.view.stages[0]?.name ?? 'the first stage'}.`)
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
      waits: [{ id: 'installation-update', what: 'the project\'s agent and knowledge base', text: cloud }],
      journey,
    }
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
  const kind = r.state === 'refreshed' ? 'workflows' as const : 'join' as const
  const title = kind === 'join' ? 'Put this repository under trace' : 'Refresh trace\'s workflows'
  await editStore(ctx).put({
    repo, branch: pull.head.ref, kind, title, by: label(ctx.principal), by_sub: ctx.principal.sub, by_name: await editorName(ctx),
    applies: appliesOf(kind, isAdmin(ctx.principal)), commit: pull.head.sha, number, at: new Date().toISOString(), redo: null,
  })
  return kind === 'join' ? `Its change "${title}" is on the project's Changes: trace applies it once it can.` : `Its change "${title}" is on the project's Changes: trace applies it once its checks pass.`
}
