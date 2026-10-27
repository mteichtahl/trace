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

/** assumed: GET /api/auth/invite/:token */
export interface InviteInfo {
  email: string
  invitedBy: string
  projects?: { name: string; part: Part }[]
  class: PersonClass
}

// ------------------------------------------------------------------ projects and the journey

export interface ProjectRef {
  repo: string
  role: Role
  part?: Part
}

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

export interface Stage {
  id: string
  name: string
  state: StageState
  criteria: { met: number; total: number }
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

export type NextStepKind = 'task' | 'gate' | 'working' | 'waiting_person' | 'waiting_outside' | 'failed' | 'none'

export interface NextStep {
  kind: NextStepKind
  /** whose move: the person reading (accent), trace, another person, or outside (a supplier) */
  owner: 'you' | 'trace' | 'person' | 'outside'
  /** one or two sentences; **bold** marks the recommendation */
  summary: string
  /** the short form for Home's project rows ("you sign the schematic gate") */
  short?: string
  why?: string
  /** primary action */
  action?: { label: string; to?: string }
  secondary?: { label: string; to?: string }
  /** for kind working */
  jobId?: string
  wait?: Wait
  /** reading form for reviewers */
  reviewer?: { summary: string; action?: { label: string; to?: string } }
}

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
  state: 'running' | 'queued' | 'paused' | 'done' | 'failed' | 'cancelled'
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
}

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
  recent: RecentItem[]
  /** has an agent session happened yet (the Memory tab appears) */
  hasMemory?: boolean
  /** small summaries for the side column (assumed) */
  summary?: {
    requirements?: { accepted: number; verified: number; failing: number; untested: number }
    cost?: { cloudToDate: number; forecast: number; bom?: number; currency: string; quantity?: number }
  }
}

// ------------------------------------------------------------------ jobs and waits (src/api/actions.ts)

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

export type InboxKind = 'gate' | 'question' | 'spend' | 'stuck'

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
  action: { label: string; to?: string }
  /** a question with a clear recommendation: its answer as a button */
  recommended?: { id: string; label: string }
  questionId?: string
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
  author?: string
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
  | { type: 'record.changed'; repo: string; what: 'journey' | 'settings' | 'memory' | 'chats' | 'people' | 'prompts' | 'kb'; at: string }
  | { type: 'job.updated'; repo: string; jobId: string; state: string; at: string }
  | { type: 'notification'; id: string; kind: InboxKind; repo: string; summary: string; at: string }
