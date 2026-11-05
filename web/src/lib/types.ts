/**
 * The shapes the app reads from the web backend and the API runtime (docs/web-build.md). Existing actions mirror
 * src/api/actions.ts; the new ones (journey.get, inbox, chats.*, me.*, project.members, …) follow the build contract.
 * Where the contract leaves a shape open, the choice made here is marked "assumed" so the backend can match it or
 * this file can follow the backend.
 */

export type PersonClass = 'admin' | 'user' | 'guest'
export type Part = 'contributor' | 'reviewer'
export type Role = 'read' | 'write'

export interface User {
  sub: string
  email: string
  name?: string
  class: PersonClass | null
}

// ------------------------------------------------------------------ /api/config and /api/auth

export interface AppConfig {
  region: string
  prefix: string
  userPoolId: string
  clientId: string
  events: { http: string; realtime: string }
  features: { passkeys: boolean; email: boolean; voice: boolean; ops: boolean }
  /** AWS WAF in front of the app (absent: an installation from before it) */
  waf?: { enabled: boolean; own: boolean; apiRequestsPer10Minutes: number; authRequestsPer10Minutes: number }
}

export type SignInChoice = 'passkey' | 'email_code' | 'password'
export type RespondKind = 'password' | 'email_code' | 'passkey' | 'totp' | 'new_password'

export interface SignedIn {
  signedIn: true
  accessToken: string
  idToken: string
  /** seconds */
  expiresIn: number
  user: User
}
export interface NextChallenge {
  signedIn: false
  next: 'email_code' | 'totp' | 'new_password' | 'passkey'
  session: string
  /** WebAuthn request options (JSON form) when next is passkey */
  options?: PublicKeyCredentialRequestOptionsJSONish
}
export type RespondResult = SignedIn | NextChallenge

/** WebAuthn options as JSON (base64url strings in place of buffers), as Cognito returns them. */
export interface PublicKeyCredentialRequestOptionsJSONish {
  challenge: string
  rpId?: string
  timeout?: number
  userVerification?: string
  allowCredentials?: { id: string; type: string; transports?: string[] }[]
  [k: string]: unknown
}
export interface PublicKeyCredentialCreationOptionsJSONish {
  challenge: string
  rp: { id?: string; name: string }
  user: { id: string; name: string; displayName: string }
  pubKeyCredParams: { type: string; alg: number }[]
  excludeCredentials?: { id: string; type: string; transports?: string[] }[]
  [k: string]: unknown
}

// ------------------------------------------------------------------ projects and the journey

/** Who paused or retired a project, when (seconds since the epoch) and why. */
export interface LifecycleMark { at: number; by: string; reason: string | null }

export interface ProjectRef {
  repo: string
  role: Role
  part?: Part
  /** set while the project is paused (project.pause): nothing changes and no work starts until it is resumed */
  paused?: LifecycleMark | null
}

/** project.lifecycle: whether the project is paused, and (admins only) retired, with its recent changes. */
export interface Lifecycle {
  repo: string
  paused: LifecycleMark | null
  retired: LifecycleMark | null
  history?: { at: number; change: 'paused' | 'resumed' | 'retired' | 'restored'; by: string; reason: string | null }[]
  summary?: string
}

/** projects.retired: a retired project as admins see it. */
export interface RetiredProject { repo: string; name: string | null; icon: string | null; description: string | null; retired: LifecycleMark; paused: LifecycleMark | null }

export interface Member {
  sub: string
  email: string
  name?: string
  class: PersonClass
  part: Part
  admin?: boolean
}

export type Template = 'board' | 'fpga' | 'firmware' | 'mixed'
export type StageState = 'done' | 'current' | 'queued' | 'reopened' | 'skipped'
export type GateState = 'locked' | 'open' | 'ready' | 'signed' | 'returned'
export type CriterionStatus = 'met' | 'not_met' | 'waived'

export interface EvidenceRef {
  kind: 'run' | 'datasheet' | 'requirement' | 'file' | 'record' | 'memory' | 'part' | 'chat'
  /** what the chip says: "TLV755 datasheet p.12", "run_4a11" */
  label: string
  id?: string
  /** an in-app address that opens it */
  to?: string
  summary?: string
}

/** What a stage is for, in plain words (journey.get `guide`, src/core/stage-guides.ts). */
export interface StageGuide {
  purpose: string
  you_do: string
  trace_does: string
  you_get: string
  typical_time: string
  /** "Prove: simulate the circuit and write the test plan." (null for the last stage) */
  next: string | null
}

export type StepOwner = 'you' | 'trace' | 'admins' | 'contributors' | 'person'
export type StepState = 'done' | 'now' | 'next' | 'later' | 'waived'

/** One step of a stage (journey.get `steps`): who does it, where it stands, and what it is about. */
export interface StageStep {
  id: string
  text: string
  owner: StepOwner
  state: StepState
  ref: { kind: 'criterion' | 'gate' | 'question' | 'change'; id: string } | null
  /** a named person's name, when owner is person */
  who?: string
  /** an in-app address that does the step (its guided skill, gate or change), worked out by the reader */
  to?: string
}

export interface Stage {
  id: string
  name: string
  state: StageState
  criteria: { met: number; total: number }
  /** absent from an API before the guided flow */
  guide?: StageGuide
  steps?: StageStep[]
  /** a reopened stage: why ("datasheet conflict found in Prove") */
  reopened?: { reason: string }
  /** what trace has prepared for a queued stage */
  prepared?: string
  /** optional later stages (Certify, Produce, Sustain) */
  optional?: boolean
  /** firmware track status under this stage, when the template has one */
  firmware?: { text: string; ok: boolean }
}

export interface Criterion {
  id: string
  text: string
  status: CriterionStatus
  evidence?: EvidenceRef
  opened?: boolean
  /** met on evidence that has since gone out of date: why, in words (not met until trace checks it again) */
  stale?: string
  /** not met by its shape (shape.check): each thing still needed, in words naming what to fix, with the id a waiver
   *  of that one finding names */
  findings?: { id: string; text: string }[]
  /** an admin added it to the template: a person signs it off by saying what they checked (criterion.confirm) */
  added?: boolean
}

export interface Waiver {
  id: string
  title: string
  reason: string
  risk: 'minor' | 'degraded' | 'major'
  caught: string
  acknowledged?: boolean
  /** the record's own words: its severity (cosmetic | degraded | failure | safety), its risk, its scope */
  severity?: string
  riskText?: string
  scope?: string
}

export interface Gate {
  id: string
  name: string
  /** the stage this gate closes */
  after: string
  state: GateState
  criteria: Criterion[]
  waivers: Waiver[]
  signature?: { by: string; at: string }
}

/** `review`: trace finished a change; review it and accept it into the design */
export type NextStepKind = 'task' | 'gate' | 'review' | 'working' | 'waiting_person' | 'waiting_outside' | 'failed' | 'none'

export interface NextStep {
  kind: NextStepKind
  /** whose move: the person reading (accent), trace, another person, or outside (a supplier) */
  owner: 'you' | 'trace' | 'person' | 'outside'
  /** one or two sentences; **bold** marks the recommendation */
  summary: string
  /** the short form for Home's project rows ("you sign the schematic gate") */
  short?: string
  why?: string
  /** primary action: an address, or an API action the button calls (`call`: requirements.draft) */
  action?: { label: string; to?: string; call?: string }
  secondary?: { label: string; to?: string }
  /** for kind working */
  jobId?: string
  wait?: Wait
  /** reading form for reviewers */
  reviewer?: { summary: string; action?: { label: string; to?: string } }
  /** the summary without the recommendation folded into it (shown when `recommend` has its own box) */
  lead?: string
  /** trace's recommendation and its reason, for the card's recommendation box */
  recommend?: { text: string; why?: string }
  /** the now-step's place in its stage: "Step 3 of 5 in Capture" */
  step?: { index: number; total: number } | null
  /** one sentence: what happens once this is done */
  after?: string | null
  /** what the step is about; a change opens its review page */
  ref?: { kind: string; id: string } | null
}

// ------------------------------------------------------------------ changes (src/api/actions-changes.ts)

export type ChangeVerdict = 'ready' | 'checking' | 'failing' | 'conflict' | 'blocked' | 'unfinished' | 'applying'
/** 'work': a specialist's change; otherwise an edit a person made in the app (docs/stay-in-trace.md) */
export type ChangeKind = 'work' | 'setting' | 'prompt' | 'release' | 'join' | 'workflows' | 'handin'
export type ChangeFileKind = 'schematic' | 'board' | 'parts' | 'text' | 'image' | 'binary'

/** A pull request a trace job opened, or an edit a person made in the app, as people read it: a change. */
export interface ChangeSummary {
  number: number
  title: string
  /** GitHub's page for it: only in the admins' More menu */
  url: string
  draft: boolean
  held: boolean
  /** absent from an older API: a specialist's change */
  kind?: ChangeKind
  /** an edit: who made it */
  by_name?: string
  /** an edit: the viewer made it */
  mine?: boolean
  /** an edit: trace applies it (auto), or an admin who did not make it accepts it (review) */
  applies?: 'auto' | 'review'
  /** "the schematic specialist", or "a trace job" */
  from: string
  job_id: string | null
  stage: string | null
  opened_at: string
  updated_at: string
  state: 'open' | 'merged' | 'closed'
  /** GitHub's mergeable_state */
  mergeable: string
  checks: { total: number; passed: number; failed: number; running: number; skipped: number; failing: string[] } | null
  /** GitHub refused every way of reading the checks: trace's token lacks Actions and Commit statuses */
  checks_denied?: boolean
  verdict: ChangeVerdict
  /** the gate criteria it says it waits on a person's approval of ("layout.renders") */
  awaiting?: string[]
  /** a stacked change: the open change it builds on, which is accepted first (docs/stacked-changes.md) */
  builds_on?: ChangeLink
  /** the open changes built on this one, which follow it into the design */
  built_on_by?: ChangeLink[]
}

/** One change of a stack, as another names it. */
export interface ChangeLink { number: number; title: string }

export interface ChangeFile {
  path: string
  status: 'added' | 'modified' | 'removed' | 'renamed'
  additions: number
  deletions: number
  kind: ChangeFileKind
}

/** `id`: what change.check opens ("cr:<check run id>", "job:<actions job id>"); null or absent: a commit status, nothing more to open */
export interface ChangeCheck { name: string; state: 'passed' | 'failed' | 'running' | 'skipped'; summary: string | null; id?: string | null }

/** change.check: one check in full (docs/ui/phone-results.md) */
export interface CheckAnnotation { path: string; line: number | null; level: 'failure' | 'warning' | 'notice'; title: string | null; message: string }
export interface CheckDetail {
  id: string
  name: string
  state: ChangeCheck['state']
  /** one line, as in checks_list */
  summary: string | null
  /** the check's own report, markdown */
  text: string | null
  started_at: string | null
  completed_at: string | null
  annotations: CheckAnnotation[]
  /** the end of the Actions job's log, when the check is one */
  log: { text: string; truncated: boolean } | null
  /** admins only: the check on GitHub */
  url?: string
}

export interface ChangeDetail extends ChangeSummary {
  /** what trace did, plain bullets */
  summary: string[]
  files: ChangeFile[]
  checks_list: ChangeCheck[]
  /** requirement ids the change names: ["R4", "R7"] */
  requirements: string[]
  recommendation: { verdict: 'accept' | 'ask' | 'wait' | 'none'; why: string }
  /** this person, now */
  may_accept: boolean
  /** plain words, when may_accept is false */
  blockers: string[]
  base: { ref: string; sha: string }
  head: { ref: string; sha: string }
  /** its checks passed but the repository asks for a review trace cannot give (admins: repo.rules.fix) */
  rule_blocks?: boolean
  /** whether this person may discard it; absent from an older API: as may_accept's contributor rule */
  may_discard?: boolean
  /** whether this person may ask for changes (never for an edit: there is no specialist) */
  may_ask?: boolean
}

/** change.diff: one file's two sides. */
export interface ChangeDiff {
  path: string
  kind: ChangeFileKind
  patch: string | null
  /** a renamed file's before side carries its old path */
  before: { ref: string; path?: string } | null
  after: { ref: string } | null
  binary: boolean
}

/** `warning`: it is merged, but something after it (the decisions log) did not happen */
export interface ChangeAccepted { merged: true; sha: string; stage: string; next: string; warning?: string }

// ------------------------------------------------------------------ deploys (docs/stay-in-trace.md "2. Deploys")

export type DeployResult = 'deployed' | 'failed' | 'rolled_back' | 'skipped'

/** deploys.get: the project's deploys as the app shows them (src/api/actions-deploys.ts DeploysView). */
export interface DeploysView {
  enabled: boolean; environment: string; url: string | null; auto: boolean
  /** this person may approve, skip or roll back, now */
  may_approve: boolean
  /** what the environment runs */
  running: { sha: string; at: string | null } | null
  /** the open request, or null */
  request: {
    sha: string; opened_at: string; held: boolean; held_reasons: string[]
    /** since the running one, newest first */
    commits: { sha: string; subject: string }[]
    build_passed: boolean
  } | null
  in_progress: { sha: string; started_at: string; by: string; step: string | null } | null
  recent: { sha: string; result: DeployResult; at: string; by: string }[]
  recommendation: { verdict: 'deploy' | 'wait' | 'none'; why: string }
}

// ------------------------------------------------------------------ build health (docs/stay-in-trace.md "3. A broken build")

/** health.get: the default branch's build, trace's fix for it, and the open requests for a fix (src/api/actions-health.ts). */
export interface HealthView {
  build: {
    state: 'passing' | 'failing' | 'running' | 'none'; sha: string | null; at: string | null
    /** each failing job: its id (health.log's job_id), name, failing step, and the last 40 lines of its log */
    failing: { job_id: number; name: string; step: string | null; tail: string }[]
    /** plain words: trace's own look at the failure, else the failing step */
    why: string | null
    /** trace's work on it: its job (RunSummary.id) when known, and which attempt of how many */
    fixing: { job_id: string | null; attempt: number; of: number } | null
  }
  asks: { number: number; title: string; state: 'waiting' | 'working' | 'stuck'; job_id: string | null; opened_at: string }[]
}

/** health.log: one build job's log, its last 200 KB. */
export interface HealthLog { name: string; text: string; truncated: boolean }

export interface Question {
  id: string
  /** who it waits on */
  to: string
  text: string
  askedAt: string
  blocks?: string
  recommended?: { id: string; label: string }
  options?: { id: string; label: string }[]
  sources?: EvidenceRef[]
}

export interface RunSummary {
  id: string
  repo?: string
  /** "checking timing on the FPGA" */
  title: string
  state: 'running' | 'queued' | 'paused' | 'done' | 'failed' | 'cancelled' | 'lost'
  step?: string
  stepIndex?: number
  stepCount?: number
  /** 0..1 when the work has a known size */
  progress?: number
  startedAt?: string
  /** typical seconds for this kind of run on this project */
  typicalS?: number
  /** seconds left, estimated */
  etaS?: number
  where?: string
  /** queued: what it waits for ("starts when the schematic gate is signed") */
  startsWhen?: string
  /** what job.control can do for it now (the job view's `controls`); absent: not known, the screen's own choice */
  controls?: ('pause' | 'resume' | 'cancel' | 'move_up')[]
  /** the agent doing it (verify, impl, …, worker) and its name in words (jobs.list) */
  agent?: string
  agentName?: string
  /** who asked, and whether it is the person looking */
  startedBy?: string
  yours?: boolean
  /** queued: held by a person (it starts when someone resumes it) */
  held?: boolean
  /** queued: its place in its agent's queue (1 is next) */
  position?: number
  /** paused: who paused it */
  pausedBy?: string
  branch?: string
  summary?: string
  /** why it failed, or what a lost job was last doing (jobs.list `error`) */
  error?: string
  endedAt?: string
  /** a job another specialist asked for: the hand-off it answers and who asked (its title says so too) */
  handoff?: { id: string; from?: string; fromName?: string }
  /** running: when trace last heard from it, when that is late (overdue), and when it is declared lost if still silent */
  heard?: { at: string; overdueAt: string; lostAt: string }
}

/** Where a hand-off between specialists stands (src/core/handoffs.ts). */
export type HandoffState = 'requested' | 'queued' | 'running' | 'answered' | 'unanswered' | 'declined' | 'failed'

/** One hand-off between specialists (jobs.list and journey.get `handoffs`): who asked whom, for what, and the answer. */
export interface Handoff {
  id: string
  from: string
  fromName: string
  to: string
  toName: string
  question: string
  blocks: string
  evidence: EvidenceRef[]
  recommendation?: string
  acceptance: string[]
  /** "Thermal → Analog and mixed-signal: …" */
  summary: string
  state: HandoffState
  /** what happens next, or why it ended, in words */
  says: string
  createdAt: string
  /** the receiving job (RunSummary.id when the index lists it), and its worker job id */
  jobId?: string
  workerJobId?: string
  /** the asking job (RunSummary.id when the index lists it), and its worker job id */
  fromJobId?: string
  fromWorkerJobId: string
  answer?: { answered: boolean; text: string; summary: string; evidence: EvidenceRef[]; confidence?: number; acceptanceMet?: boolean; unmet?: string; at: string }
  declined?: { reason: string; by: string; at: string }
  why?: string
}

/** One agent's state on a project (jobs.list `agents`). */
export interface AgentState {
  id: string
  name: string
  status: 'working' | 'queued' | 'waiting_person' | 'stuck' | 'idle'
  says: string
  /** job ids (RunSummary.id) */
  now: string[]
  queue: string[]
  today: { runs: number; succeeded: number; medianS: number | null }
}

/** jobs.list, as the app reads it. */
export interface ProjectJobs { repo: string; jobs: RunSummary[]; agents: AgentState[]; handoffs: Handoff[]; batch: { id: string; job: string | null; pool: 'gpu' | 'cpu'; state: string | null; submittedAt: string | null }[]; updatedAt: string }

export interface RecentItem {
  id: string
  who: string
  text: string
  ref?: string
  at: string
  to?: string
}

export interface Journey {
  repo: string
  name: string
  description?: string
  template: Template
  revision: string
  stages: Stage[]
  gates: Gate[]
  current: string
  next: NextStep
  questions: Question[]
  waivers: Waiver[]
  /** live and queued jobs for this project (assumed part of journey.get) */
  jobs: RunSummary[]
  /** the hand-offs between its specialists (journey.get `handoffs`; absent in older answers and mocks) */
  handoffs?: Handoff[]
  recent: RecentItem[]
  /** has an agent session happened yet (the Memory tab appears) */
  hasMemory?: boolean
  /** GitHub could not be reached, so open changes are left out (journey.get `changes_unavailable`) */
  changesUnavailable?: string
  /** criteria met on evidence that has since gone out of date, each with its gate and why (journey.get `stale_evidence`) */
  staleEvidence?: { criterion: string; gate: string; text: string; why: string }[]
  /**
   * Define before the requirements exist (journey.get `drafting`, src/api/drafting.ts): the intent not submitted yet,
   * trace drafting them (its job), stopped (lost, failed, cancelled or never started: requirements.draft starts it
   * again, `why` says what happened), drafted (waiting in a change) or done
   */
  drafting?: { state: 'intent' | 'drafting' | 'stopped' | 'drafted' | 'done'; jobId?: string; jobState?: string; why?: string }
  /** small summaries for the side column (assumed) */
  summary?: {
    requirements?: { accepted: number; verified: number; failing: number; untested: number }
    cost?: { cloudToDate: number; forecast: number; bom?: number; currency: string; quantity?: number }
  }
}

// ------------------------------------------------------------------ jobs and waits (src/api/actions.ts)

/** project.agent (src/api/actions-projects.ts agentSetup): whether the project's own agent is set up yet, and how its
 * setting up stands while it is not. */
export interface AgentSetup {
  repo: string
  ready: boolean
  state: 'ready' | 'setting_up' | 'finishing' | 'failed' | 'missing'
  text: string
  requested_at: string | null
  /** `url`: the update's run on GitHub, given to admins only (their More menu). `steps`: the run's steps as they
   * stand; `failed_log`: the failing step's last 40 lines (admins only, else null) */
  update: {
    status: 'queued' | 'running' | 'finished' | 'failed'; started_at: string; url?: string
    steps?: { name: string; state: 'done' | 'running' | 'waiting' | 'failed' }[]; failed_log?: string | null
  } | null
  expected_by: string | null
  next_check_s: number | null
}

export interface Wait {
  id: string
  what: string
  source?: string
  /** "Waiting for JLCPCB to confirm the order. … next check in 4 minutes" */
  text: string
  lastCheckedAt?: string | null
  nextCheckAt?: string | null
  /** checks have slowed because nothing changed */
  slowed?: boolean
  repo?: string
  jobId?: string
}

export interface JobView {
  id: string
  kind: string
  repository?: string
  state: string
  version?: number | null
  waits?: Wait[]
  [k: string]: unknown
}

// ------------------------------------------------------------------ inbox

/** `review`: a change a trace job made, to review and accept in the app; `renders`: a revision's renders are ready */
export type InboxKind = 'gate' | 'question' | 'spend' | 'stuck' | 'review' | 'renders'

export interface InboxItem {
  id: string
  kind: InboxKind
  repo: string
  project: string
  revision?: string
  stage?: string
  /** one sentence; **bold** marks the recommendation */
  summary: string
  createdAt: string
  action: { label: string; to?: string; href?: string }
  /** a question with a clear recommendation: its answer as a button */
  recommended?: { id: string; label: string }
  questionId?: string
  /** a review item's pull request on GitHub (kept for older screens) */
  pull?: { repo: string; number: number }
  /** a review item's change: the card shows its status, Review and (when this person may) Accept */
  change?: { repo: string; number: number; /** GitHub's page, for "View on GitHub" only */ url?: string }
  sources?: EvidenceRef[]
  blocks?: string
  read?: boolean
}

// ------------------------------------------------------------------ chats

export interface ChatThread {
  id: string
  repo: string
  title: string
  updatedAt: string
  author?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  at: string
  /** who wrote it (a person's email; "trace" for trace's replies): display only */
  author?: string
  /** the viewer's own turn, or trace's reply to one of theirs; false: someone else's (quoted, never replayed as theirs).
   * Absent: theirs (mock mode and messages of this session) */
  yours?: boolean
  /** AG-UI tool calls on an assistant message, kept so a thread replays with its cards */
  toolCalls?: { id: string; name: string; args: string }[]
  toolCallId?: string
}

// ------------------------------------------------------------------ preferences (me.get / me.set)

export interface TableView {
  sorting?: { id: string; desc: boolean }[]
  filters?: { id: string; value: unknown }[]
  sizing?: Record<string, number>
  visibility?: Record<string, boolean>
  order?: string[]
}

export interface Prefs {
  profile: { name?: string; timeZone?: string; language?: string }
  display: { theme: 'system' | 'light' | 'dark'; density: 'comfortable' | 'compact'; textSize: number; motion: 'system' | 'reduced' | 'full'; contrast: 'standard' | 'high' }
  chat: {
    dock: 'always' | 'asked'
    enter: 'enter' | 'mod-enter'
    recall: boolean
    toolRows: 'folded' | 'open'
    reasoning: 'hidden' | 'folded'
    terms: 'always' | 'first' | 'never'
    recommendations: 'short' | 'full'
  }
  voice: {
    /** trace's replies can be read aloud (speaker buttons, Read aloud, voice choice) */
    speech: boolean
    /** the microphone button for dictating messages */
    dictation: boolean
    voice?: string
    rate: number
    readAloud: 'off' | 'summary' | 'all'
    language: string
    mic: 'hold' | 'tap'
    sendOnStop: boolean
    commands: boolean
  }
  formats: { units: 'mm' | 'mil' | 'in'; currency: string; numbers: 'engineering' | 'plain'; hour12?: boolean }
  work: { start: 'home' | 'last'; pinned: string[]; hideFinished: boolean }
}

export interface MeDoc {
  prefs: Partial<{ [K in keyof Prefs]: Partial<Prefs[K]> }>
  views: Record<string, TableView>
}

// ------------------------------------------------------------------ voice

export interface Voice { id: string; name: string; gender: string; engines: string[] }
export interface SpeechMark { time: number; type: 'word' | 'sentence'; start: number; end: number; value: string }

// ------------------------------------------------------------------ live events

export type LiveEvent =
  | { type: 'record.changed'; repo: string; what: 'journey' | 'settings' | 'memory' | 'chats' | 'people' | 'prompts' | 'kb' | 'projects' | 'agent'; at: string }
  | { type: 'job.updated'; repo: string; jobId: string; state: string; at: string }
  | { type: 'notification'; id: string; kind: InboxKind; repo: string; summary: string; at: string }
  /** a run's log grew (docs/progress-and-logs.md, decision C): a count, never the text */
  | { type: 'log.appended'; repo: string; kind: RunKind; id: string; lines: number; at: string }

/** pull.status: one pull request now (src/api/github.ts PullStatus). */
export interface PullStatus {
  repo: string; number: number; title: string; url: string; state: 'open' | 'merged' | 'closed'; draft: boolean
  /** GitHub's mergeable_state: clean, blocked, behind, dirty, unstable, unknown */
  mergeable: string; head: string; sha: string; updated_at: string
  checks: { total: number; passed: number; failed: number; running: number; skipped: number; failing: string[] } | null
}

// ------------------------------------------------------------------ progress and logs (src/api/actions-progress.ts)

export type RunKind = 'job' | 'tool' | 'check'
/** How the app and the API name a run: job:<jobId>, tool:<runId>, check:<GitHub job id>. */
export type RunRef = `${RunKind}:${string}`
/** step: "▸ name" opens a step; ok "✓", warn "⚠", error "✗" (src/core/run-logs.ts markOf) */
export type LogMark = 'step' | 'ok' | 'warn' | 'error' | null
export interface LogLine { at: string; text: string; mark: LogMark }

/** run.log: a run's lines from a cursor, masked. */
export interface RunLogResult {
  repo: string; run: string; source: 'cloudwatch' | 'github' | 'tail' | 'none'
  lines: LogLine[]
  /** the cursor for the following call (opaque, passed back as `after`) */
  next: string | null
  /** the run has ended and every line was given */
  done: boolean
  heardAt: string | null; step: string | null; usualQuietS: number
  /** why there are no lines yet, in words */
  note?: string
  /** admins only: the CloudWatch console's page for the stream */
  cloudwatch?: string
}

export type CheckState = 'queued' | 'running' | 'passed' | 'failed' | 'skipped' | 'cancelled'
export interface CheckStep { name: string; state: Exclude<CheckState, 'cancelled'>; startedAt: string | null; completedAt: string | null }
/** change.runs: one GitHub Actions job checking a change. */
export interface CheckJob {
  id: number; run: RunRef; name: string; workflow: string; state: CheckState
  startedAt: string | null; completedAt: string | null
  steps: CheckStep[]; step: string | null; stepIndex: number | null; stepCount: number
  /** the job's usual length on this project, null: no history */
  typicalS: number | null
  /** queued: how long it has waited for a machine */
  queuedS: number | null
  heardAt: string | null; newest: string | null; usualQuietS: number; runner: 'aws' | 'github' | null
}
export interface ChangeRuns { repo: string; number: number; sha: string; jobs: CheckJob[]; updatedAt: string }

/** activity.list: one thing trace is doing, across the person's projects. */
export interface ActivityItem {
  kind: RunKind; repo: string; run: RunRef; title: string; state: 'running' | 'queued' | 'paused'
  step: string | null; stepIndex: number | null; stepCount: number | null
  startedAt: string | null; typicalS: number | null
  heardAt: string | null; newest: string | null; usualQuietS: number
  /** jobs: their heartbeat limits */
  overdueAt?: string; lostAt?: string
  /** checks: the change it checks */
  change?: number
}
export interface ActivityList { items: ActivityItem[]; waits: number; updatedAt: string; unreadable?: string[] }

// ------------------------------------------------------------------ project templates (src/api/actions-templates.ts)

export type TemplateId = 'board' | 'fpga' | 'firmware' | 'mixed'
export interface TemplateGuide { purpose: string; you_do: string; trace_does: string; you_get: string; typical_time: string }
export interface TemplateCriterionDoc { id: string; text: string; custom?: boolean; evidence?: string }
export interface TemplateStageDoc { id: string; gates: { id: string; criteria: TemplateCriterionDoc[] }[]; guide: TemplateGuide }
/** A template's definition as the installation keeps it (src/core/templates.ts TemplateDoc). */
export interface TemplateDoc { id: TemplateId; name: string; stages: TemplateStageDoc[] }
/** templates.list / templates.get: a template as a new project starts from it (version 0: trace's own). */
export interface TemplateView { id: TemplateId; name: string; version: number; doc: TemplateDoc; changed: boolean; updated: string | null; by: string | null }
export interface TemplateHistoryEntry { version: number; action: 'save' | 'reset'; by: string | null; at: string; reason: string | null }
/** Every stage, its gates, and every criterion trace knows for each gate: what an admin chooses from. */
export interface TemplateCatalogStage {
  id: string; name: string; later: boolean
  gates: { id: string; name: string; criteria: { id: string; text: string; owner: 'person' | 'trace'; evidence: string; templates: TemplateId[] }[] }[]
}

