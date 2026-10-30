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
 *                                  job, or the installer (src/installer/pending.ts; cloudWait says which, and when)
 *                             and answers each step's outcome, plus that last part as a wait. A step that fails stops
 *                             the ones that depend on it and says so; the request can be sent again (every step is
 *                             safe to repeat).
 *   project.update    admin   change what a project is after it is made: its name, description, icon, build plan
 *                             (quantity, unit cost, budget) and later stages, in the journey record (Settings). The
 *                             template and repository stay fixed
 *
 * Onboarding runs `git` (clone, commit, push) with the token in git's environment, never in a URL or a file: the API
 * runtime's image is the agents' image, which has git. Without it, step 1 fails with "install git" and nothing else
 * is changed.
 */
import { z } from 'zod'
import { GROUPS, PARTS, type Part, PartRefused, type PersonClass, RepoSlug, assign, classOf, membersOf, setClass } from '../core/access.js'
import { Conflict } from '../core/central.js'
import { AboutSchema, BuildSchema, LATER_STAGES, TEMPLATES, type Template, TEMPLATE_NAMES, journeyView, startJourney, updateAbout } from '../core/journey.js'
import { forgetNoJourney } from '../core/journey-store.js'
import { register } from '../core/onboard.js'
import { projectSlug } from '../core/project.js'
import { FLAT_UPDATE_MAX } from '../installer/pending.js'
import { ActionError, type Context, Repo, def, hashOf, label, storeAt, writeJourney } from './action-kit.js'

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
      step('repository', a.new ? 'Create the repository' : 'Connect the repository', 'done', [what, ...r.settings.map((x) => `${x[0]?.toUpperCase()}${x.slice(1)}.`)].join(' '))
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

    // 5. the project's own cloud resources: at the next update of the installation
    try {
      await recordPending(ctx, repo, {
        repo, name: a.name, template: a.template, requested_by: label(ctx.principal), requested_at: new Date().toISOString(),
        needs: ['worker runtime', 'memory', 'knowledge base', 'build runner'],
      })
      step('cloud', 'Set up the project\'s agent and knowledge base', 'waiting', cloudWait())
    } catch (e) {
      step('cloud', 'Set up the project\'s agent and knowledge base', 'failed', message(e))
    }

    return {
      repo, ok: !steps.some((s) => s.state === 'failed'), steps, people,
      waits: [{ id: 'installation-update', what: 'the project\'s agent and knowledge base', text: cloudWait() }],
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
