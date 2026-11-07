/**
 * `call(action, args)`: the API runtime through POST /api/call, typed per action. Adds the bearer token (lib/auth)
 * and the body hash (lib/http); on a 401 it refreshes once and tries again. The API answers `{ ok, result }` or
 * `{ ok: false, error }`; `call` returns the result (read into the app's shape by lib/readers.ts where the API's differs)
 * or throws an ApiError carrying the words to show.
 */
import { refresh, token } from './auth'
import { HttpError, isUpdating, request } from './http'
import { READERS } from './readers'
import type {
  ChatMessage, ChatThread, InboxItem, Journey, JobView, Member, MeDoc, Part, PersonClass, ProjectRef, Wait,
} from './types'

export class ApiError extends Error {
  override name = 'ApiError'
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
  }
  /** the one answer for a project that is not yours, whether or not it exists */
  get noAccess(): boolean {
    return this.status === 403 || this.message === 'no access'
  }
}

type Repo = { repo: string }

/** What job.control can do; a job's view lists the ones the API can do for it now (`controls`). */
export type JobOp = 'pause' | 'resume' | 'cancel' | 'move_up' | 'restart' | 'dismiss'

/** Every action the app calls: its arguments and its answer. */
export interface Actions {
  // existing (src/api/actions.ts)
  whoami: { args: Record<string, never>; result: { sub: string; email: string; groups: string[]; class: PersonClass | null } }
  projects: { args: Record<string, never>; result: ProjectRef[] }
  status: { args: Repo; result: { repo: string; default_branch: string; pulls: unknown[]; agent_fix_issues: unknown[]; runs: unknown[]; last_deploy: unknown } }
  'pull.status': { args: Repo & { number: number }; result: import('./types').PullStatus }
  'settings.get': { args: Repo; result: { repo: string; set: Record<string, unknown>; config: Record<string, unknown>; errors: string[] } }
  'settings.set': { args: Repo & { key: string; value?: unknown; unset?: boolean }; result: { branch: string; commit: string; /** the change it opened */ change?: number | null } }
  runs: { args: Repo & { kind?: string; limit?: number; agent?: string }; result: Record<string, unknown>[] }
  run: { args: Repo & { id: string }; result: Record<string, unknown> }
  artifact: { args: Repo & { id: string; name: string }; result: { id: string; name: string; mime: string | null; size: number; base64: string } }
  'tools.list': { args: Repo; result: { name: string; description: string; needs: 'read' | 'write'; input: unknown }[] }
  tool: { args: Repo & { name: string; args?: Record<string, unknown> }; result: unknown }
  task: { args: Repo & { request: string; agent?: string; branch?: string }; result: { accepted: boolean; jobId: string; reason?: string; queued?: boolean } }
  'memory.list': { args: Repo & { agent?: string; limit?: number; includeInactive?: boolean }; result: { repo: string; enabled: boolean; records: Record<string, unknown>[] } }
  'memory.recall': { args: Repo & { query: string; top_k?: number }; result: { repo: string; enabled: boolean; records: Record<string, unknown>[] } }
  'memory.remember': { args: Repo & { text: string; scope: 'personal' | 'project'; thread?: string }; result: { repo: string; recorded: boolean; scope: 'personal' | 'project'; actor: string; session: string; note: string } }
  'memory.deactivate': { args: Repo & { recordId: string; reason: string }; result: Record<string, unknown> }
  'memory.reactivate': { args: Repo & { recordId: string }; result: Record<string, unknown> }
  'kb.search': { args: Repo & { query: string; top_k?: number }; result: { repo: string; enabled: boolean; results?: unknown[] } }
  'kb.sync': { args: Repo & { force?: boolean }; result: unknown }
  job: { args: { id: string; afterVersion?: number; waitS?: number }; result: JobView & { controls?: JobOp[] } }
  'job.check_now': { args: { id: string; waitId: string }; result: { ok: boolean } }
  'tools.waits': { args: Repo & { afterVersion?: number; waitS?: number }; result: { repo: string; version: number | null; waits: Wait[] } }
  'tools.check_now': { args: Repo & { waitId: string }; result: { ok: boolean } }
  'users.list': { args: Record<string, never>; result: import('./admin-types').UserRow[] }
  'users.invite': { args: { email: string; class?: PersonClass }; result: { sub: string; email: string; class: PersonClass } }
  'users.class': { args: { who: string; class: PersonClass }; result: { sub: string; class: PersonClass } }
  assign: { args: { who: string; repo: string; part?: Part }; result: unknown }
  unassign: { args: { who: string; repo: string }; result: { removed: boolean } }
  assignments: { args: { repo?: string }; result: { sub: string; email?: string; repo: string; part?: Part }[] }
  // new (docs/web-build.md)
  'project.members': { args: Repo; result: Member[] }
  /** whether the project's own agent is set up yet (a new project's arrives with the next installation update) */
  'project.agent': { args: Repo; result: import('./types').AgentSetup }
  'projects.create': {
    args: {
      repo: string; name: string; description?: string; icon?: string; start?: 'idea' | 'import'; template: 'board' | 'fpga' | 'firmware' | 'mixed'
      new?: { private: boolean; scaffold?: 'empty' | 'python' | 'kicad' | 'rust' }; people?: { who: string; part?: Part; class?: 'user' | 'guest' }[]
      build?: { quantity?: number; unit_cost?: number | null; budget?: number | null; cloud_budget?: number | null; currency?: string; fab?: string }; later?: ('certify' | 'produce' | 'sustain')[]; apply?: boolean
    }
    /** read from the API's steps (lib/readers.ts readCreated): what was done, what failed, what waits */
    result: { repo: string; ok: boolean; done: string[]; failed: string[]; waits: Wait[] }
  }
  /** admin: whether a repository is free for a new project: on GitHub already (null: GitHub could not be asked), the
   * project trace knows there (retired too), a free name beside it, and the line to show when it is taken */
  'projects.repo_check': { args: Repo; result: import('@/components/new-project/rules').RepoCheck }
  /** admin: what the project is (Settings): written to the journey record, not the repository */
  'project.update': {
    args: Repo & { name?: string; description?: string; icon?: string; build?: { quantity?: number; unit_cost?: number | null; budget?: number | null; cloud_budget?: number | null; hardware?: boolean }; later?: ('certify' | 'produce' | 'sustain')[] }
    result: { repo: string; version: number }
  }
  // a project's lifecycle (src/api/actions-lifecycle.ts): paused holds it as it is; retired hides it until an admin restores it
  'project.lifecycle': { args: Repo; result: import('./types').Lifecycle }
  'project.pause': { args: Repo & { reason?: string }; result: import('./types').Lifecycle & { summary: string } }
  'project.resume': { args: Repo; result: import('./types').Lifecycle & { summary: string } }
  'project.retire': { args: Repo & { reason?: string }; result: import('./types').Lifecycle & { summary: string } }
  'project.restore': { args: Repo; result: import('./types').Lifecycle & { summary: string } }
  'projects.retired': { args: Record<string, never>; result: { projects: import('./types').RetiredProject[] } }
  'journey.get': { args: Repo; result: Journey }
  'journey.criterion.open': { args: Repo & { gate?: string; criterion?: string; waiver?: string }; result: { repo: string; opened: string; at: string; version: number } }
  'gate.sign': { args: Repo & { gate: string; notes?: string; acknowledge?: string[]; time_zone?: string }; result: { ok: true; started?: string[]; advanced_to: string | null; released: boolean; summary: string; snapshot: unknown } }
  'gate.return': { args: Repo & { gate: string; reason: string; reopen?: string }; result: { repo: string; reopened: string | null; summary: string } }
  'question.answer': { args: Repo & { question: string; option?: string; answer?: string; reason?: string; lasts?: 'once' | 'rule' | 'requirement' }; result: { repo: string; summary: string; jobId?: string; jobError?: string; started?: string[]; rule?: RuleProposed; rule_error?: string } }
  /** `job`: the stuck agent's job id, or the stuck item's own id (an inbox item's questionId) */
  'stuck.dismiss': { args: Repo & { job: string; reason: string }; result: { repo: string; dismissed: { id: string; job_id: string | null; reason: string; by: string; at: string }; summary: string } }
  'waiver.add': { args: Repo & { target: { kind: 'criterion' | 'requirement' | 'finding' | 'test'; id: string }; reason: string; risk: string; severity: 'cosmetic' | 'degraded' | 'failure' | 'safety'; caught_where: string | null; scope?: string; replaces?: string }; result: { repo: string; waiver: { id: string } } }
  /** withdraw a waiver in force with a reason kept in the record: its author or an admin (test-esp32 #149) */
  'waiver.withdraw': { args: Repo & { waiver: string; reason: string }; result: { repo: string; waiver: { id: string; closed: boolean }; summary: string } }
  inbox: { args: Record<string, never>; result: InboxItem[] }
  /** where a project's time went, by stage (Operations' Process tab) */
  'journey.time': { args: Repo; result: import('./admin-types').JourneyTime }
  // the API's own shapes are read by lib/readers.ts (readThreads, readThread, readAppended, readRecall)
  'chats.list': { args: Repo & { query?: string; limit?: number }; result: ChatThread[] }
  'chats.get': { args: Repo & { thread: string; before?: string; limit?: number }; result: { thread: ChatThread; messages: ChatMessage[]; more?: boolean } }
  /** the person's own messages only (the API stores them as theirs whatever is sent); trace's replies are kept by the
   * chat agent itself (chats.reply, never callable from the app) */
  'chats.append': { args: Repo & { thread?: string; title?: string; messages: { text: string }[] }; result: { id: string; messageId: string; created?: boolean } }
  'chats.rename': { args: Repo & { thread: string; title: string }; result: unknown }
  'chats.recall': { args: Repo & { limit?: number }; result: string[] }
  'me.get': { args: Record<string, never>; result: MeDoc & { locks: Record<string, string> } }
  'me.set': { args: { key: string; value?: unknown; unset?: boolean }; result: { changed: boolean } }
  /** push notifications on this device (src/api/actions-push.ts, docs/push.md) */
  'push.subscribe': { args: { subscription: PushSubscriptionJSON; tz?: string | null; label?: string | null }; result: { subscribed: boolean; devices: number } }
  'push.unsubscribe': { args: { endpoint: string }; result: { removed: boolean } }
  'push.devices': { args: Record<string, never>; result: { devices: { endpoint: string; label: string | null; tz: string | null; since: string }[] } }
  /** the project's record played back for the graph view's player (src/api/actions-replay.ts) */
  'journey.replay': { args: Repo & { after?: string; limit?: number }; result: import('./replay').ReplayPage }
  'graph.neighbourhood': { args: Repo & { focus: string; depth?: 1 | 2 | 3; memory?: boolean }; result: { focus: string; nodes: unknown[]; links: unknown[]; groups: unknown[]; truncated: boolean } }
  'files.list': { args: Repo; result: import('@/components/files/data').ListedFile[] }
  'files.url': { args: Repo & { path: string; commit?: string }; result: { url: string; mime?: string | null; size?: number } }
  /** a text file edited in the app (CLAUDE.md): a change for review */
  'files.edit': { args: Repo & { path: string; text: string; note?: string }; result: { repo: string; path: string; change: number | null; branch: string; commit: string } }
  /** KiCad files handed in: one change of the ones that differ from the design */
  'design.handin': { args: Repo & { files: { path: string; base64: string }[]; note?: string }; result: { repo: string; change: number | null; changed: string[]; same: string[]; branch: string; commit: string } }
  /** The project logo (src/api/actions-logo.ts): each variant kept beside the documents, checked before it is saved */
  /** The project's rules (src/api/rule-answers.ts): .trace/rules.md on the default branch, and each answer made a rule */
  'project.rules': { args: Repo; result: ProjectRules }
  'project.rule_from_answer': { args: Repo & { question: string }; result: RuleProposed & { repo: string; question: string; summary: string } }
  'project.logo': { args: Repo; result: { repo: string; light: StoredLogo | null; dark: StoredLogo | null } }
  'project.logo_check': { args: Repo & { base64: string }; result: LogoCheck & { repo: string } }
  'project.logo_set': { args: Repo & { light?: { base64: string } | null; dark?: { base64: string } | null }; result: { repo: string; change: number | null; branch: string; commit: string; written: string[]; removed: string[] } }
  // Operations, Admin and Preferences (src/api/actions.ts: integrations.*, prompts.*; shapes in lib/admin-types.ts)
  'integrations.list': { args: Record<string, never>; result: import('./admin-types').IntegrationStatus[] }
  'integrations.set': { args: { name: import('./admin-types').IntegrationName; values: Record<string, string> }; result: { name: string; secret: string; check: { ok: boolean; detail: string }; note?: string } }
  'integrations.remove': { args: { name: import('./admin-types').IntegrationName }; result: { name: string; removed: boolean } }
  'prompts.list': { args: { repo?: string }; result: import('./admin-types').PromptList }
  'prompts.get': { args: { repo?: string; id: string }; result: import('./admin-types').PromptView }
  'prompts.preview': { args: Repo & { target: string; job?: import('./admin-types').PreviewJob }; result: import('./admin-types').PromptPreview }
  'prompts.set': { args: { id: string; scope: 'installation' | 'project'; repo?: string; text: string; reason: string }; result: import('./admin-types').PromptWriteResult }
  'prompts.reset': { args: { id: string; scope: 'installation' | 'project'; repo?: string; reason: string }; result: import('./admin-types').PromptWriteResult }
  'prompts.revert': { args: { id: string; scope: 'installation' | 'project'; repo?: string; version: number | string; reason?: string }; result: import('./admin-types').PromptWriteResult }
  'prompts.history': { args: { id: string; scope: 'installation' | 'project'; repo?: string }; result: { id: string; scope: string; repo?: string; history: import('./admin-types').PromptHistoryEntry[] } }
  // gates, guided skills, new project and project tabs (src/api/actions-record.ts, actions-skills.ts, actions-jobs.ts)
  /** a skill's state for this person: steps, the quality bar from the record, the draft, and what the skill reads */
  'skill.get': { args: Repo & { skill: string; question?: string }; result: import('./types-s1').SkillView }
  /** keep (data) or discard (null) this person's draft of a skill, in the journey store */
  'skill.draft': { args: Repo & { skill: string; step: number; data: Record<string, unknown> | null }; result: { kept: boolean; saved: string | null } }
  /** this person's drafts on the project, newest first */
  'skill.drafts': { args: Repo; result: { drafts: { skill: string; name: string; step: number; steps: number; saved: string }[] } }
  /** submit a skill's result: refused with what is missing unless every check is met or waived */
  'requirements.draft': { args: Repo; result: { repo: string; jobId: string; attempt: number; started: string[] } }
  /** start trace's work on its criterion that nothing works on (the next step's Start it; src/api/owned-work.ts) */
  'journey.start_work': { args: Repo & { criterion?: string }; result: { repo: string; criterion: string; jobId: string | null; started: string[] } }
  // recorded: the decisions it recorded, in words; criteria: every gate criterion it set (one not met with why and the
  // skill's step that fixes it); draft_kept: one is still not met, so the draft was kept (src/api/actions-skills.ts)
  'skill.submit': { args: Repo & { skill: string; draft: unknown }; result: { ok: true; id?: string; ref?: string; jobId?: string; started?: string[]; rule?: RuleProposed; rule_error?: string; recorded?: string; criteria?: SubmitCriterion[]; draft_kept?: boolean } }
  /** each requirement's evidence status and the intent lines it is derived from */
  'requirements.trace': { args: Repo; result: import('./types-s1').TraceView }
  /** the architecture, the sheets with their drawings and requirements, the pin plan, the board; what is not recorded, in notes */
  'design.get': { args: Repo; result: import('./types-s1').DesignView }
  /** a person's decision about the design record: accept, edit or reject intent; strike a requirement; fix the criteria; choose an architecture; agree a pin plan */
  'design.decide': { args: Repo & { decision: import('./types-s1').DesignDecisionInput }; result: { ok: true; decision: { id: string; kind: string; target: string; choice: string; by: string; at: string }; summary: string } }
  /** releases, orders, boards */
  'build.get': { args: Repo; result: import('./types-s1').BuildView }
  'renders.list': { args: Repo; result: import('./types-renders').RendersView }
  'renders.seen': { args: Repo & { revision: string }; result: { repo: string; revision: string; seen: boolean } }
  /** the project's documents: how current each is, its newest print, each revision's release copies, the next check */
  'documents.get': { args: Repo; result: import('./types-docs').DocumentsView }
  /** one printed copy, by its hash: the PDF as base64 (at most 8 MB) */
  'documents.pdf': { args: Repo & { sha256: string }; result: { repo: string; sha256: string; bytes: number; mime: string; base64: string } }
  /** record a placed order (number, paid cost, ship date) */
  'order.record': { args: Repo & { order?: string; number: string; paid: number | null; ship: string | null; quote?: string }; result: { ok: true; wait?: Wait; quote?: { id: string; on: string; total: number; currency: string; difference: number | null } | null } }
  /** record a JLCPCB quote the person read off JLCPCB (any time at Fabricate); every one is kept */
  'quote.record': { args: Repo & import('./types-s1').QuoteInput; result: { ok: true; quote: import('./types-s1').QuoteView } }
  /** the stage timeline; money for admins (cloud estimates and actuals from the cost ledger, orders); notes */
  'cost.get': { args: Repo; result: import('./types-s1').CostView }
  // the build after payment and cloud cost (src/api/actions-build.ts, actions-cost.ts)
  'order.update': { args: Repo & { order: string; state?: 'shipped' | 'delivered' | 'cancelled'; carrier?: import('./types-s1').Carrier; tracking?: string; ship?: string | null; note?: string }; result: { ok: true; wait: Wait | null; note?: string } }
  'order.check_now': { args: Repo & { order: string }; result: { ok: boolean; reason?: string } }
  'board.record': { args: Repo & { serial: string; order?: string; status?: string; notes?: string; photos?: string[] }; result: { ok: true; created: boolean } }
  'board.check': { args: Repo & { serial: string; check: string; kind: 'count' | 'visual' | 'fault' | 'hand' | 'label'; result: 'pass' | 'fail' | 'marked'; ref?: string; note?: string; photo?: string }; result: { ok: true } }
  'usage.month': { args: { month?: string }; result: import('./types-s1').UsageMonth }
  /** pause (a running task stops at its next safe point; a queued one is held), resume, move up, cancel */
  'job.control': { args: { id: string; op: JobOp; reason?: string; repo?: string }; result: { ok: boolean; kept?: string; reason?: string; state?: string | null; pausing?: boolean; held?: boolean; dismissed?: boolean; jobId?: string; position?: number } }
  /** the project's jobs (its job index), each agent's status, the hand-offs between its specialists, the remote jobs running */
  'jobs.list': { args: Repo; result: import('./types').ProjectJobs }
  /** decline a pending hand-off between specialists, with a reason in one line (contributors and admins) */
  'handoff.decline': { args: Repo & { id: string; reason: string }; result: { repo: string; declined: { id: string; reason: string; by: string; at: string }; job?: { cancelled: boolean; note: string }; summary: string } }
  // installation policy and people (src/api/actions-me.ts, actions-people.ts)
  'policy.get': { args: Record<string, never>; result: { locks: Record<string, string>; updated: string | null; by: string | null } }
  'installation.layout': { args: Record<string, never>; result: import('@/components/installation/layout').LayoutView }
  'policy.set': { args: { key: string; reason: string | null }; result: { locks: Record<string, string>; changed: boolean } }
  // the installation's project templates (src/api/actions-templates.ts)
  'templates.list': { args: Record<string, never>; result: { templates: import('./types').TemplateView[] } }
  'templates.get': { args: { template: import('./types').TemplateId }; result: { template: import('./types').TemplateView; history: import('./types').TemplateHistoryEntry[]; catalog: import('./types').TemplateCatalogStage[]; code: import('./types').TemplateDoc } }
  'templates.check': { args: { doc: import('./types').TemplateDoc }; result: { ok: boolean; problems: string[] } }
  'templates.save': { args: { doc: import('./types').TemplateDoc; reason: string }; result: { template: import('./types').TemplateView; saved: boolean; summary: string } }
  'templates.reset': { args: { template: import('./types').TemplateId; reason: string }; result: { template: import('./types').TemplateView; saved: boolean; summary: string } }
  // a criterion an admin added to the template, signed off by a person saying what they checked
  'criterion.confirm': { args: Repo & { criterion: string; met?: boolean; note?: string }; result: { repo: string; criterion: string; met: boolean; summary: string } }
  'users.history': { args: { who: string; limit?: number }; result: { sub: string; email: string | null; entries: { at: string; by: string; repo: string | null; action: 'assign' | 'unassign' | 'class'; detail: string | null; text: string }[] } }
  // connected systems, admins only (docs/external-access.md "Managing connected systems"; shapes in lib/services.ts)
  'services.list': { args: Record<string, never>; result: import('./services').ServiceList }
  'services.create': { args: { name: string; description?: string; scopes: import('./services').Scope[]; projects?: { repo: string; part: Part }[] }; result: import('./services').ServiceCreated }
  'services.update': { args: { name: string; description?: string; scopes?: import('./services').Scope[]; disabled?: boolean }; result: { service: import('./services').Service } }
  'services.assign': { args: { name: string; repo: string; part?: Part }; result: { name?: string; repo: string; part: Part } }
  'services.unassign': { args: { name: string; repo: string }; result: { removed: boolean } }
  'services.rotate': { args: { name: string }; result: { secret: string; secret_id: string } & import('./services').ServiceAddresses }
  'services.retire_secret': { args: { name: string; secret_id: string }; result: { removed: boolean } }
  'services.delete': { args: { name: string }; result: { deleted: true } }
  'services.history': { args: { name: string }; result: { entries: import('./services').ServiceHistoryEntry[] } }
  // changes: the pull requests trace's jobs opened, reviewed and accepted in the app (docs/guided-flow.md)
  'changes.list': { args: Repo; result: { repo: string; changes: import('./types').ChangeSummary[] } }
  'change.get': { args: Repo & { number: number }; result: import('./types').ChangeDetail }
  /** one check of the change's head commit in full; id from checks_list */
  'change.check': { args: Repo & { number: number; id: string }; result: import('./types').CheckDetail }
  'change.diff': { args: Repo & { number: number; path: string }; result: import('./types').ChangeDiff }
  /** head_sha: the head commit the person looked at (change.get's head.sha); the API refuses a change that moved since */
  'change.accept': { args: Repo & { number: number; head_sha: string; note?: string }; result: import('./types').ChangeAccepted }
  'change.ask': { args: Repo & { number: number; note: string }; result: { job_id: string } }
  'change.discard': { args: Repo & { number: number; reason: string }; result: { closed: true; jobs?: string[] } }
  /** checks that did not run properly run again; checks no runner picked up (stuck) are cancelled and run again, with
   * what happened in `summary` */
  'change.rerun': { args: Repo & { number: number }; result: { checks: string[]; runs: number; summary?: string } }
  /** every open change's checks no runner picked up, cancelled and run again once an admin fixed the runner */
  'changes.rerun_stuck': { args: Repo; result: { repo: string; changes: number[]; cancelled: number; rerun: number; later: number; summary: string } }
  /** a change in conflict brought up to date now (src/api/conflicts.ts): an edit made in trace is made again, anything
   * else goes to trace's worker with its earlier attempts set aside. `text`: what happens next, in plain words */
  'change.resolve': { args: Repo & { number: number }; result: { text: string; remade: boolean; worker: boolean; conflict: boolean } }
  /** admins: put the repository's rule back to passing checks only (docs/stay-in-trace.md "5. Fixing the repository rule") */
  'repo.rules.fix': { args: Repo; result: { done: string[]; left: string[] } }
  // deploys, decided in the app (docs/stay-in-trace.md "2. Deploys"); the three writes: an admin or a person in deploy.people
  'deploys.get': { args: Repo; result: import('./types').DeploysView }
  /** sha: the commit the person was shown (the request's); the API refuses one that moved since */
  'deploy.approve': { args: Repo & { sha: string }; result: { started: true; approval: string; next: string } }
  'deploy.skip': { args: Repo & { reason: string }; result: { skipped: true } }
  /** to: a commit that ran before (a deployed entry of recent) */
  'deploy.rollback': { args: Repo & { to: string }; result: { started: true; approval: string } }
  // the build's health (docs/stay-in-trace.md "3. A broken build"): asking trace for a fix is `task`
  'health.get': { args: Repo; result: import('./types').HealthView }
  /** job_id: a failing job of health.get (its build.failing[].job_id) */
  'health.log': { args: Repo & { job_id: number }; result: import('./types').HealthLog }
  // progress and logs (docs/progress-and-logs.md, src/api/actions-progress.ts)
  /** a run's lines from its cursor (`after`: the last answer's `next`) */
  'run.log': { args: Repo & { run: string; after?: string | null; limit?: number }; result: import('./types').RunLogResult }
  /** a change's checks as GitHub's jobs: steps, the step now, time against the usual, the newest line */
  'change.runs': { args: Repo & { number: number }; result: import('./types').ChangeRuns }
  /** what trace is doing now, across every project the person can see */
  'activity.list': { args: Record<string, never>; result: import('./types').ActivityList }
}

export type ActionName = keyof Actions
export type ArgsOf<A extends ActionName> = Actions[A]['args']
export type ResultOf<A extends ActionName> = Actions[A]['result']

type Envelope<T> = { ok: true; result: T } | { ok: false; error: string; code?: string }

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const go = () => request<T>(path, { method: 'POST', body, token: token(), signal })
  try {
    return await go()
  } catch (e) {
    if (e instanceof HttpError && e.status === 401 && (await refresh())) return go()
    throw e
  }
}

/** Call one API action. */
/** A rule from an answer, as trace added it (src/api/rule-answers.ts ProposedRule): proposed now, or already there. */
/** A gate criterion a skill's Submit set: not met, with why and the skill's step that fixes it (skill.submit `criteria`). */
export interface SubmitCriterion { id: string; text: string; status: 'met' | 'not_met'; why?: string; step?: string }
export interface RuleProposed { state: 'proposed' | 'in_rules' | 'waiting'; change: number | null; branch?: string; applies?: 'auto' | 'review'; words?: string }
/** One answer made a rule for the project (src/api/rule-answers.ts RuleAnswerView). */
export interface RuleAnswer {
  question: string; asked: string; asked_by: string; rule: string; reason: string | null; by: string | null; at: string | null
  /** in_rules: in the rules file on the default branch; waiting: its change is open; missing: neither yet */
  state: 'in_rules' | 'waiting' | 'missing'
  change: number | null
}
/** The project's rules: the rules file on the default branch (null: there is none) and the answers made rules. */
export interface ProjectRules { repo: string; branch: string; path: string; text: string | null; answers: RuleAnswer[] }

/** A logo variant as the repository keeps it (src/api/actions-logo.ts StoredLogo). */
export interface StoredLogo { path: string; format: 'svg' | 'png'; base64: string }
/** What trace says of a logo file (src/docs/logo.ts LogoCheck). */
export interface LogoCheck { ok: boolean; format: 'svg' | 'png' | null; width: number | null; height: number | null; problems: string[] }

/** Told of every ok answer `call` gets, with the action and its arguments (lib/after-write.ts: what an act changed). */
export type CallListener = (action: ActionName, args: Record<string, unknown>) => void
const listeners = new Set<CallListener>()

/** Hear of every ok answer from now on; returns the function that stops it. */
export function onAnswer(l: CallListener): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

const told = (action: ActionName, args: unknown): void => {
  for (const l of listeners) {
    try {
      l(action, (args ?? {}) as Record<string, unknown>)
    } catch {
      // a listener's failure is never the call's: the answer has come
    }
  }
}

export async function call<A extends ActionName>(action: A, args: ArgsOf<A>, o: { signal?: AbortSignal } = {}): Promise<ResultOf<A>> {
  let env: Envelope<ResultOf<A>>
  try {
    env = await post<Envelope<ResultOf<A>>>('/api/call', { action, ...args }, o.signal)
  } catch (e) {
    if (e instanceof HttpError) throw new ApiError(e.message, e.status, e.code)
    throw e
  }
  if (!env || typeof env !== 'object' || !('ok' in env)) {
    told(action, args)
    return env as ResultOf<A>
  }
  if (!env.ok) throw new ApiError(env.error, 200, env.code)
  told(action, args)
  const read = READERS[action]
  if (!read) return env.result
  try {
    return read(env.result, args as Record<string, unknown>) as ResultOf<A>
  } catch (e) {
    throw e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : String(e), 200)
  }
}

/** Any other authenticated /api endpoint (voice, ops, passkeys): JSON, with the same token and retry. */
export async function api<T>(path: string, o: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const go = () => request<T>(path, { ...o, token: token() })
  try {
    return await go()
  } catch (e) {
    if (e instanceof HttpError && e.status === 401 && (await refresh())) return go()
    if (e instanceof HttpError) throw new ApiError(e.message, e.status, e.code)
    throw e
  }
}

/**
 * How a screen's read is tried again (every query's default, main.tsx). Never on a 401, no access or a 429 (trace's
 * firewall counts every request, so a retry only keeps it shut longer). While trace is updating (the API runtime
 * replaced by a deploy, test-esp32 #223) for about a minute, waiting longer each time; anything else twice.
 */
export function readRetry(n: number, e: unknown): boolean {
  if (e instanceof ApiError && (e.noAccess || e.status === 401 || e.status === 429)) return false
  return n < (isUpdating(e) ? UPDATING_DELAYS_MS.length : 2)
}

/** The waits between tries of a read while trace is updating: about a minute in all. */
export const UPDATING_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 15_000, 15_000] as const

/** How long before the next try of a read: TanStack Query's own (1 s, 2 s, …) unless trace is updating. */
export function readRetryDelay(n: number, e: unknown): number {
  if (isUpdating(e)) return UPDATING_DELAYS_MS[Math.min(n, UPDATING_DELAYS_MS.length - 1)]!
  return Math.min(1000 * 2 ** n, 30_000)
}

/** A project's display name from its repo slug (owner/soil-sensor → Soil sensor). */
export function projectName(repo: string): string {
  const name = repo.split('/').pop() ?? repo
  const words = name.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The project id used in addresses (/p/:id): the repo with its slash encoded as `~`. */
export const projectId = (repo: string): string => repo.replace('/', '~')
export const repoOf = (id: string): string => id.replace('~', '/')
