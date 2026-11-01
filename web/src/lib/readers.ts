/**
 * What the API runtime answers, read into the shapes the screens use. `call()` (lib/api.ts) passes every answer
 * through READERS[action] when there is one. The API's shapes stay as they are because other callers read them too
 * (the `tracectl` CLI, the chat agent's tools); the reading is here, once, rather than in each screen.
 *
 * Each reader accepts an answer already in the app's shape and returns it unchanged, so mock mode (src/mock, which
 * answers in the app's shapes) and the tests keep working.
 */
import type {
  AgentState, ChangeCheck, ChangeDetail, ChangeDiff, ChangeFile, ChangeFileKind, ChangeSummary, ChangeVerdict, ChatMessage, ChatThread, EvidenceRef, Gate, Handoff,
  HandoffState, InboxItem, Journey, Member, MeDoc, NextStep, ProjectJobs, Question, RunSummary, Stage, StageGuide, StageStep, StepOwner, StepState, Waiver,
} from './types'
import type { DecisionEntry, JourneyMore, ProjectIcon } from './types-s1'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])
const pid = (repo: string): string => repo.replace('/', '~')
const projectName = (repo: string): string => { const n = (repo.split('/').pop() ?? repo).replace(/[-_]+/g, ' ').trim(); return n.charAt(0).toUpperCase() + n.slice(1) }

// ------------------------------------------------------------------ journey.get

const EVIDENCE_KINDS = new Set(['run', 'datasheet', 'requirement', 'file', 'record', 'memory', 'part', 'chat'])

/** The API's evidence ({ kind, ref, label }) as a chip, with an address for runs. */
export function readEvidence(e: Obj, repo: string): EvidenceRef {
  const kind = (EVIDENCE_KINDS.has(String(e.kind)) ? e.kind : 'record') as EvidenceRef['kind']
  const ref = str(e.ref) ?? str(e.id) ?? ''
  return { kind, label: str(e.label) ?? ref, id: ref, ...(kind === 'run' && ref ? { to: `/p/${pid(repo)}/runs/${ref}` } : {}) }
}

/** The API's severity (cosmetic | degraded | failure | safety) as the app's risk word. */
const riskOf = (severity: unknown): Waiver['risk'] => (severity === 'cosmetic' ? 'minor' : severity === 'degraded' ? 'degraded' : 'major')

function readWaiver(w: Obj): Waiver {
  const target = isObj(w.target) ? w.target : {}
  return {
    id: String(w.id), title: `${str(target.kind) ?? 'item'} ${str(target.id) ?? ''}`.trim(), reason: String(w.reason ?? ''),
    risk: riskOf(w.severity), caught: str(w.caught_where) ?? 'Nowhere: accepted for good', acknowledged: Boolean(w.acknowledged),
    severity: str(w.severity), riskText: str(w.risk), scope: str(w.scope),
  }
}

const STAGE_STATES = new Set(['done', 'current', 'queued', 'reopened', 'skipped'])

/** The address of what a next step or an inbox item is about. */
function refTo(repo: string, ref: unknown, criteria?: Map<string, string>): string | undefined {
  if (!isObj(ref)) return undefined
  const id = String(ref.id ?? '')
  switch (ref.kind) {
    case 'gate': return `/p/${pid(repo)}/gates/${id}`
    case 'question': return `/p/${pid(repo)}/do/question-answer`
    case 'criterion': { const g = criteria?.get(id); return g ? `/p/${pid(repo)}/gates/${g}` : undefined }
    case 'change': return Number(id) > 0 ? `/p/${pid(repo)}/changes/${id}` : undefined
    default: return undefined
  }
}

// ------------------------------------------------------------------ the guided flow (stage guide, steps, changes)

const STEP_OWNERS = new Set<StepOwner>(['you', 'trace', 'admins', 'contributors', 'person'])
const STEP_STATES = new Set<StepState>(['done', 'now', 'next', 'later', 'waived'])
const REF_KINDS = new Set(['criterion', 'gate', 'question', 'change'])

/** A stage's guide (journey.get `stages[].guide`), or nothing when the API does not give one yet. */
export function readGuide(g: unknown): StageGuide | undefined {
  if (!isObj(g) || !str(g.purpose)) return undefined
  return {
    purpose: String(g.purpose), you_do: str(g.you_do) ?? '', trace_does: str(g.trace_does) ?? '', you_get: str(g.you_get) ?? '',
    typical_time: str(g.typical_time) ?? '', next: str(g.next) ?? null,
  }
}

/** A stage's steps (journey.get `stages[].steps`): unknown owners read as contributors, unknown states as later. */
export function readSteps(v: unknown): StageStep[] | undefined {
  if (!Array.isArray(v)) return undefined
  return arr(v).filter((s) => str(s.text)).map((s, i) => {
    const ref = isObj(s.ref) && REF_KINDS.has(String(s.ref.kind)) ? { kind: s.ref.kind as NonNullable<StageStep['ref']>['kind'], id: String(s.ref.id ?? '') } : null
    return {
      id: str(s.id) ?? `step-${i + 1}`, text: String(s.text),
      owner: STEP_OWNERS.has(s.owner as StepOwner) ? (s.owner as StepOwner) : 'contributors',
      state: STEP_STATES.has(s.state as StepState) ? (s.state as StepState) : 'later',
      ref, ...(str(s.who) ? { who: String(s.who) } : {}),
    }
  })
}

/**
 * The recommendation box's two parts: "trace recommends accepting it." and its reason. The API's review step gives
 * both in one string ("trace recommends accepting it. All 7 checks passed, …"); other steps give the reason as `why`.
 */
export function splitRecommendation(rec: string, why?: string): { text: string; why?: string } {
  const m = /^(trace recommends[^.]*\.)\s+(.+)$/s.exec(rec.trim())
  if (m) return { text: m[1]!, why: m[2]! }
  return { text: rec, ...(why ? { why } : {}) }
}

const VERDICTS = new Set<ChangeVerdict>(['ready', 'checking', 'failing', 'conflict', 'blocked'])
const FILE_KINDS = new Set<ChangeFileKind>(['schematic', 'board', 'parts', 'text', 'image', 'binary'])

/** One change's checks, or null when GitHub has none. */
function readChecks(c: unknown): ChangeSummary['checks'] {
  if (!isObj(c)) return null
  const n = (k: string) => (typeof c[k] === 'number' ? (c[k] as number) : 0)
  return { total: n('total'), passed: n('passed'), failed: n('failed'), running: n('running'), skipped: n('skipped'), failing: (Array.isArray(c.failing) ? c.failing : []).map(String) }
}

/** The list pill's word, worked out from the facts when the API does not say it. */
export function verdictOf(c: Pick<ChangeSummary, 'checks' | 'mergeable'> & { verdict?: unknown }): ChangeVerdict {
  if (VERDICTS.has(c.verdict as ChangeVerdict)) return c.verdict as ChangeVerdict
  if (c.checks?.failed) return 'failing'
  if (c.checks?.running) return 'checking'
  if (c.mergeable === 'dirty' || c.mergeable === 'behind') return 'conflict'
  if (c.mergeable === 'clean' || c.mergeable === 'unstable') return 'ready'
  return 'blocked'
}

/** One ChangeSummary (changes.list, change.get), tolerant of missing fields. */
export function readChangeSummary(c: Obj): ChangeSummary {
  const state = c.state === 'merged' || c.state === 'closed' ? c.state : 'open'
  const checks = readChecks(c.checks)
  const mergeable = str(c.mergeable) ?? 'unknown'
  return {
    number: Number(c.number ?? 0), title: str(c.title) ?? `Change ${String(c.number ?? '')}`, url: /^https:\/\/github\.com\//.test(str(c.url) ?? '') ? String(c.url) : '',
    draft: Boolean(c.draft), held: Boolean(c.held), from: str(c.from) ?? 'a trace job', job_id: str(c.job_id) ?? null, stage: str(c.stage) ?? null,
    opened_at: str(c.opened_at) ?? '', updated_at: str(c.updated_at) ?? str(c.opened_at) ?? '', state, mergeable, checks,
    verdict: verdictOf({ checks, mergeable, verdict: c.verdict }),
  }
}

/** changes.list: `{ repo, changes }`, oldest first. */
export function readChanges(raw: unknown, args?: { repo?: string }): { repo: string; changes: ChangeSummary[] } {
  if (Array.isArray(raw)) return { repo: args?.repo ?? '', changes: arr(raw).map(readChangeSummary) }
  if (!isObj(raw)) return { repo: args?.repo ?? '', changes: [] }
  return { repo: str(raw.repo) ?? args?.repo ?? '', changes: arr(raw.changes).map(readChangeSummary).sort((a, b) => a.opened_at.localeCompare(b.opened_at)) }
}

/** change.get: a ChangeDetail; what an older answer leaves out reads as nothing (and may_accept as false). */
export function readChange(raw: unknown): ChangeDetail {
  const c = isObj(raw) ? raw : {}
  const rec = isObj(c.recommendation) ? c.recommendation : {}
  const verdict = ['accept', 'ask', 'wait', 'none'].includes(String(rec.verdict)) ? (rec.verdict as ChangeDetail['recommendation']['verdict']) : 'none'
  const ref = (v: unknown) => (isObj(v) ? { ref: str(v.ref) ?? '', sha: str(v.sha) ?? '' } : { ref: '', sha: '' })
  return {
    ...readChangeSummary(c),
    summary: (Array.isArray(c.summary) ? c.summary : []).map(String).filter(Boolean),
    files: arr(c.files).map((f) => ({
      path: String(f.path ?? ''), status: (['added', 'modified', 'removed', 'renamed'].includes(String(f.status)) ? f.status : 'modified') as ChangeFile['status'],
      additions: Number(f.additions ?? 0), deletions: Number(f.deletions ?? 0), kind: FILE_KINDS.has(f.kind as ChangeFileKind) ? (f.kind as ChangeFileKind) : 'binary',
    })),
    checks_list: arr(c.checks_list).map((k) => ({ name: String(k.name ?? ''), state: (['passed', 'failed', 'running', 'skipped'].includes(String(k.state)) ? k.state : 'running') as ChangeCheck['state'], summary: str(k.summary) ?? null })),
    requirements: (Array.isArray(c.requirements) ? c.requirements : []).map(String),
    recommendation: { verdict, why: str(rec.why) ?? '' },
    may_accept: c.may_accept === true,
    blockers: (Array.isArray(c.blockers) ? c.blockers : []).map(String),
    base: ref(c.base), head: ref(c.head),
  }
}

/** change.diff: one file's two sides. */
export function readChangeDiff(raw: unknown): ChangeDiff {
  const d = isObj(raw) ? raw : {}
  // a renamed file's before side names its old path
  const side = (v: unknown) => (isObj(v) && str(v.ref) ? { ref: String(v.ref), ...(str(v.path) ? { path: String(v.path) } : {}) } : null)
  return {
    path: str(d.path) ?? '', kind: FILE_KINDS.has(d.kind as ChangeFileKind) ? (d.kind as ChangeFileKind) : 'binary',
    patch: str(d.patch) ?? null, before: side(d.before), after: side(d.after), binary: Boolean(d.binary),
  }
}

const DECISION_KIND: Record<string, DecisionEntry['kind']> = { 'gate.signed': 'gate', 'gate.returned': 'gate', 'question.answered': 'question', 'waiver.added': 'waiver', 'skill.submitted': 'decision' }
const DECISION_STATE: Record<string, DecisionEntry['state']> = { 'gate.signed': 'signed', 'gate.returned': 'returned', 'question.answered': 'answered', 'waiver.added': 'active' }

/** The journey's icon: its JSON (glyph and colour), as projects.create keeps it. */
function readIcon(v: unknown): { icon?: ProjectIcon } {
  if (typeof v !== 'string') return {}
  try {
    const o = JSON.parse(v) as unknown
    return isObj(o) && typeof o.colour === 'string' ? { icon: { colour: o.colour, ...(typeof o.glyph === 'string' ? { glyph: o.glyph } : {}) } as ProjectIcon } : {}
  } catch {
    return {}
  }
}

/** journey.get: the API's journey view (src/core/journey.ts journeyView) as the app's Journey. */
export function readJourney(raw: unknown, args?: { repo?: string }): Journey {
  if (!isObj(raw) || (!('current_stage' in raw) && 'stages' in raw)) return raw as unknown as Journey
  const repo = str(raw.repo) ?? args?.repo ?? ''
  const name = str(raw.name) ?? projectName(repo)
  if (raw.started === false) {
    return {
      repo, name, template: 'board', revision: '', stages: [], gates: [], current: '', questions: [], waivers: [], jobs: [], recent: [],
      next: { kind: 'none', owner: 'person', summary: `${str(raw.summary) ?? ''} ${str(raw.next) ?? ''}`.trim() }, started: false,
    } as Journey
  }
  const waivers = arr(raw.waivers).map(readWaiver)
  const waiverById = new Map(waivers.map((w) => [w.id, w]))
  const criterionGate = new Map<string, string>()
  const gates: Gate[] = arr(raw.gates).map((g) => {
    const signature = isObj(g.signature) ? g.signature : null
    const returned = isObj(g.returned) ? g.returned : null
    const state = String(g.state)
    for (const c of arr(g.criteria)) criterionGate.set(String(c.id), String(g.id))
    return {
      id: String(g.id), name: str(g.title) ?? `the ${String(g.name)} gate`, after: String(g.stage),
      state: (state === 'queued' ? 'locked' : returned && state !== 'signed' ? 'returned' : state) as Gate['state'],
      criteria: arr(g.criteria).map((c) => {
        const ev = arr(c.evidence)[0]
        return {
          id: String(c.id), text: String(c.text), status: (c.status === 'met' || c.status === 'waived' ? c.status : 'not_met') as 'met' | 'waived' | 'not_met',
          ...(ev ? { evidence: readEvidence(ev, repo) } : str(c.evidence_label) ? { evidence: { kind: 'record' as const, label: String(c.evidence_label) } } : {}),
          opened: Boolean(c.opened_by_you),
        }
      }),
      waivers: (Array.isArray(g.waivers) ? g.waivers : []).map((id) => waiverById.get(String(id))).filter((w): w is Waiver => !!w),
      ...(signature ? { signature: { by: String(signature.by), at: String(signature.at) } } : {}),
      // the receipt and what still stops this person signing (GateMore)
      record: { ...(signature?.notes ? { notes: String(signature.notes) } : {}), ...(returned ? { returned: { by: String(returned.by ?? ''), at: String(returned.at), reason: String(returned.reason ?? '') } } : {}) },
      missing: Array.isArray(g.missing) ? g.missing.map(String) : [],
      maySign: Boolean(g.may_sign),
    } as Gate
  })
  const stages: Stage[] = arr(raw.stages).map((s) => {
    const guide = readGuide(s.guide)
    const steps = readSteps(s.steps)?.map((st) => { const to = refTo(repo, st.ref, criterionGate); return to ? { ...st, to } : st })
    return {
      id: String(s.id), name: String(s.name), state: (STAGE_STATES.has(String(s.state)) ? s.state : 'queued') as Stage['state'],
      criteria: { met: Number(s.met ?? 0), total: Number(s.total ?? 0) },
      ...(isObj(s.reopened) ? { reopened: { reason: str(s.reopened.reason) ?? 'reopened' } } : {}),
      ...(s.optional ? { optional: true } : {}),
      ...(guide ? { guide } : {}), ...(steps ? { steps } : {}),
    }
  })
  const n = isObj(raw.next) ? raw.next : {}
  const belongs = String(n.belongs_to ?? 'trace')
  const owner: NextStep['owner'] = n.yours ? 'you' : belongs === 'trace' ? 'trace' : belongs === 'outside' ? 'outside' : 'person'
  const kind = String(n.kind)
  const recommendation = str(n.recommendation)
  const summary = `${String(n.summary ?? '')}${recommendation && !String(n.summary ?? '').includes(recommendation) ? ` **${recommendation}**` : ''}`
  const to = refTo(repo, n.ref, criterionGate)
  const stepAt = isObj(n.step) && Number(n.step.total) > 0 ? { index: Number(n.step.index), total: Number(n.step.total) } : null
  const next: NextStep = {
    kind: (kind === 'answer' ? 'task' : kind === 'done' ? 'none' : kind) as NextStep['kind'], owner, summary,
    ...(str(n.why) ? { why: String(n.why) } : {}),
    ...(str(n.button) ? { action: { label: String(n.button), ...(to ? { to } : {}) } } : {}),
    // the API words the step for whoever asks, so the reading form is the same words
    reviewer: { summary, ...(str(n.button) ? { action: { label: String(n.button), ...(to ? { to } : {}) } } : {}) },
    // the guided flow's additions: the recommendation in its own box, where the step sits in its stage, what comes after
    ...(recommendation ? { lead: String(n.summary ?? ''), recommend: splitRecommendation(recommendation, str(n.why)) } : {}),
    step: stepAt, after: str(n.after) ?? null,
    ...(isObj(n.ref) ? { ref: { kind: String(n.ref.kind), id: String(n.ref.id ?? '') } } : {}),
  }
  const questions: Question[] = arr(raw.questions).filter((q) => !q.answered).map((q) => {
    const rec = isObj(q.recommended) ? q.recommended : null
    return {
      id: String(q.id), to: q.for === 'you' ? 'you' : q.for === 'contributors' ? 'the contributors' : q.for === 'admins' ? 'the admins' : 'a person on the project', text: String(q.text),
      askedAt: String(q.asked_at), ...(str(q.blocks) ? { blocks: String(q.blocks) } : {}),
      ...(rec ? { recommended: { id: String(rec.id), label: String(rec.label) } } : {}),
      options: arr(q.options).map((o) => ({ id: String(o.id), label: String(o.label) })),
      sources: arr(q.sources).map((e) => readEvidence(e, repo)),
    }
  })
  const decisions = arr(raw.decisions)
  const out: JourneyMore = {
    repo, name, ...(str(raw.description) ? { description: String(raw.description) } : {}),
    template: String(raw.template) as Journey['template'],
    revision: /^rev/i.test(String(raw.revision)) ? String(raw.revision) : `Rev ${String(raw.revision)}`,
    stages, gates, current: String(raw.current_stage), next, questions, waivers,
    // the project's jobs (jobs.list's, from its job index), and the hand-offs between its specialists
    jobs: arr(raw.jobs).map(readJob),
    handoffs: arr(raw.handoffs).map((h) => readHandoff(h, repo)),
    recent: decisions.slice(0, 5).map((d) => ({ id: String(d.id), who: str(d.by) ?? 'trace', text: String(d.summary), at: String(d.at) })),
    hasMemory: Boolean(raw.has_memory),
    ...(str(raw.changes_unavailable) ? { changesUnavailable: String(raw.changes_unavailable) } : {}),
    ...readIcon(raw.icon),
    ...(isObj(raw.build) ? { build: {
      quantity: Number(raw.build.quantity ?? 10), unit_cost: typeof raw.build.unit_cost === 'number' ? raw.build.unit_cost : null,
      budget: typeof raw.build.budget === 'number' ? raw.build.budget : null, currency: str(raw.build.currency) ?? 'USD', fab: str(raw.build.fab) ?? 'JLCPCB',
    } } : {}),
    ...(Array.isArray(raw.later) ? { later: raw.later.map(String).filter((s): s is 'certify' | 'produce' | 'sustain' => ['certify', 'produce', 'sustain'].includes(s)) } : {}),
    decisions: decisions.map((d) => ({
      id: String(d.id), kind: DECISION_KIND[String(d.kind)] ?? 'decision', title: String(d.summary), by: str(d.by) ?? 'trace', at: String(d.at),
      ...(DECISION_STATE[String(d.kind)] ? { state: DECISION_STATE[String(d.kind)] } : {}),
      ...(String(d.kind).startsWith('gate.') && d.ref ? { to: `/p/${pid(repo)}/gates/${String(d.ref)}` } : {}),
    })),
  }
  return out
}

// ------------------------------------------------------------------ jobs (jobs.list, journey.get's jobs)

const RUN_STATE: Record<string, RunSummary['state']> = { running: 'running', queued: 'queued', paused: 'paused', succeeded: 'done', failed: 'failed', aborted: 'cancelled', lost: 'lost' }
const OPS = new Set(['pause', 'resume', 'cancel', 'move_up'])

/** One job view of the API (src/api/actions-jobs.ts IndexedJob) as a run line's summary. */
export function readJob(j: Obj): RunSummary {
  if ('title' in j && !('workerJobId' in j)) return j as unknown as RunSummary
  const q = isObj(j.queue) ? j.queue : null
  const state = RUN_STATE[String(j.state)] ?? 'running'
  const step = str(j.step)
  return {
    id: String(j.id), title: String(j.title), state, repo: str(j.repository),
    ...(step && state !== 'queued' ? { step } : {}),
    ...(str(j.startedAt) ? { startedAt: String(j.startedAt) } : {}),
    ...(typeof j.typicalS === 'number' ? { typicalS: j.typicalS } : {}),
    ...(str(j.where) ? { where: String(j.where) } : {}),
    ...(q ? { startsWhen: String(q.startsWhen), position: Number(q.position) } : {}),
    controls: (Array.isArray(j.controls) ? j.controls : []).filter((c): c is 'pause' | 'resume' | 'cancel' | 'move_up' => OPS.has(String(c))),
    ...(str(j.agent) ? { agent: String(j.agent) } : {}), ...(str(j.agentName) ? { agentName: String(j.agentName) } : {}),
    ...(str(j.startedBy) ? { startedBy: String(j.startedBy) } : {}), yours: Boolean(j.yours), held: Boolean(j.held),
    ...(str(j.pausedBy) ? { pausedBy: String(j.pausedBy) } : {}), ...(str(j.branch) ? { branch: String(j.branch) } : {}),
    ...(str(j.summary) ? { summary: String(j.summary) } : {}), ...(str(j.error) ? { error: String(j.error) } : {}), ...(str(j.endedAt) ? { endedAt: String(j.endedAt) } : {}),
    ...(isObj(j.handoff) && str(j.handoff.id) ? { handoff: { id: String(j.handoff.id), ...(str(j.handoff.from) ? { from: String(j.handoff.from) } : {}), ...(str(j.handoff.fromName) ? { fromName: String(j.handoff.fromName) } : {}) } } : {}),
  }
}

const HANDOFF_STATES = new Set<HandoffState>(['requested', 'queued', 'running', 'answered', 'unanswered', 'declined', 'failed'])

/** One hand-off of the API (src/core/handoffs.ts HandoffView) as the app reads it. */
export function readHandoff(h: Obj, repo: string): Handoff {
  if ('fromName' in h) return h as unknown as Handoff
  const a = isObj(h.answer) ? h.answer : null
  const d = isObj(h.declined) ? h.declined : null
  const job = isObj(h.job) ? h.job : null
  const state = String(h.state) as HandoffState
  return {
    id: String(h.id), from: String(h.from), fromName: String(h.from_name ?? h.from), to: String(h.to), toName: String(h.to_name ?? h.to),
    question: String(h.question ?? ''), blocks: String(h.blocks ?? ''), evidence: arr(h.evidence).map((e) => readEvidence(e, repo)),
    ...(str(h.recommendation) ? { recommendation: String(h.recommendation) } : {}),
    acceptance: (Array.isArray(h.acceptance) ? h.acceptance : []).map(String),
    summary: String(h.summary ?? ''), state: HANDOFF_STATES.has(state) ? state : 'failed', says: String(h.says ?? ''), createdAt: String(h.created_at ?? ''),
    ...(job && (str(job.handle) ?? str(job.id)) ? { jobId: String(job.handle ?? job.id) } : {}),
    ...(job && str(job.id) ? { workerJobId: String(job.id) } : {}),
    ...(str(h.from_job_handle) ? { fromJobId: String(h.from_job_handle) } : {}),
    fromWorkerJobId: String(h.from_job ?? ''),
    ...(a ? {
      answer: {
        answered: Boolean(a.answered), text: String(a.text ?? ''), summary: String(a.summary ?? a.text ?? ''), evidence: arr(a.evidence).map((e) => readEvidence(e, repo)), at: String(a.at ?? ''),
        ...(typeof a.confidence === 'number' ? { confidence: a.confidence } : {}), ...(typeof a.acceptance_met === 'boolean' ? { acceptanceMet: a.acceptance_met } : {}),
        ...(str(a.unmet) ? { unmet: String(a.unmet) } : {}),
      },
    } : {}),
    ...(d ? { declined: { reason: String(d.reason), by: String(d.by), at: String(d.at) } } : {}),
    ...(str(h.why) ? { why: String(h.why) } : {}),
  }
}

/** jobs.list: the jobs as run lines, the agents and the remote jobs as they are. */
export function readJobs(raw: unknown, args?: { repo?: string }): ProjectJobs {
  if (!isObj(raw)) return { repo: args?.repo ?? '', jobs: [], agents: [], handoffs: [], batch: [], updatedAt: '' }
  const repo = str(raw.repo) ?? args?.repo ?? ''
  return {
    repo, jobs: arr(raw.jobs).map(readJob), agents: arr(raw.agents) as unknown as AgentState[], handoffs: arr(raw.handoffs).map((h) => readHandoff(h, repo)),
    batch: arr(raw.batch) as unknown as ProjectJobs['batch'], updatedAt: str(raw.updatedAt) ?? '',
  }
}

// ------------------------------------------------------------------ inbox

/**
 * An older API's review summary in the app's words: `X: The Verification agent opened pull request #1, "Title". Its
 * work counts once it is merged.` → `X: The Verification agent finished "Title". Review it and accept it into the design.`
 * Anything else is kept as it is.
 */
export function changeWords(summary: string): string {
  const m = /^(.*?)opened pull request #\d+, "(.*)"( \(a draft\))?\.(?: Its work counts once it is merged\.)?$/.exec(summary)
  if (!m) return summary.replace(/\bpull requests?\b/gi, (w) => (/s$/i.test(w) ? 'changes' : 'change'))
  return `${m[1]}finished "${m[2]}"${m[3] ? ' (a draft)' : ''}. Review it and accept it into the design.`
}

/** inbox: `{ summary, items, unavailable }` with the API's items, as the app's list. */
export function readInbox(raw: unknown): InboxItem[] {
  if (Array.isArray(raw)) return raw as InboxItem[]
  if (!isObj(raw)) return []
  return arr(raw.items).map((i) => {
    const repo = String(i.repo)
    const ref = isObj(i.ref) ? i.ref : {}
    // a review item is a change: it opens in the app (`ref.kind` change, or an older API's pull with its number)
    const number = (ref.kind === 'change' || ref.kind === 'pull') && Number(ref.id) > 0 ? Number(ref.id) : 0
    const change = i.kind === 'review' && number > 0
    // the API's in-app link (`ref.to`), only when it is an address inside the app
    const own = str(ref.to) && /^\/p\/[^/]+\/changes\/\d+$/.test(String(ref.to)) ? String(ref.to) : undefined
    const to = change ? (own ?? `/p/${pid(repo)}/changes/${number}`) : refTo(repo, ref)
    const label = String(i.action)
    return {
      id: String(i.id), kind: i.kind as InboxItem['kind'], repo, project: String(i.project), stage: str(i.stage),
      summary: change ? changeWords(String(i.summary)) : String(i.summary),
      createdAt: String(i.since), action: { label: change && /github/i.test(label) ? 'Review the change' : label, ...(to ? { to } : {}) },
      ...(isObj(i.recommended) ? { recommended: { id: String(i.recommended.id), label: String(i.recommended.label) } } : {}),
      ...(ref.kind === 'question' ? { questionId: String(ref.id) } : {}),
      ...(number && ref.kind === 'pull' ? { pull: { repo, number } } : {}),
      ...(change ? { change: { repo, number, ...(typeof ref.url === 'string' && /^https:\/\/github\.com\//.test(ref.url) ? { url: ref.url } : {}) } } : {}),
    }
  })
}

// ------------------------------------------------------------------ people and preferences

/** me.get: `{ preferences, updated, bytes, limit, locks }` as the app's document (prefs, views and the rest), with locks. */
export function readMe(raw: unknown): MeDoc & { locks: Record<string, string> } {
  if (!isObj(raw) || !('preferences' in raw)) return raw as MeDoc & { locks: Record<string, string> }
  const doc = isObj(raw.preferences) ? raw.preferences : {}
  return { ...doc, prefs: isObj(doc.prefs) ? doc.prefs : {}, views: isObj(doc.views) ? doc.views : {}, locks: isObj(raw.locks) ? raw.locks as Record<string, string> : {} } as MeDoc & { locks: Record<string, string> }
}

/** project.members: `{ repo, members }`. */
export const readMembers = (raw: unknown): Member[] => (Array.isArray(raw) ? raw : isObj(raw) ? arr(raw.members) : []) as unknown as Member[]

/** users.list: each row's last_seen as lastSeen. */
export const readUsers = (raw: unknown): unknown => (Array.isArray(raw) ? raw.map((u) => (isObj(u) && 'last_seen' in u ? { ...u, lastSeen: u.last_seen } : u)) : raw)

// ------------------------------------------------------------------ files

/** files.list: `{ files, groups, … }` as the flat list; nulls left out. */
export function readFiles(raw: unknown): unknown {
  if (Array.isArray(raw) || !isObj(raw)) return raw
  const files = Array.isArray(raw.files) ? arr(raw.files) : arr(raw.groups).flatMap((g) => arr(g.files))
  return files.map((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null)))
}

const blobs = new Map<string, string>()

/** files.url: a file's bytes (base64, at most 8 MB) or GitHub's link, as an address the viewers can open. */
export function readFileUrl(raw: unknown): unknown {
  if (!isObj(raw) || typeof raw.url === 'string' || typeof raw.base64 !== 'string') return raw
  const mime = str(raw.mime) ?? 'application/octet-stream'
  // one address per version of the file: asking again (every few minutes) does not make another copy
  const key = `${str(raw.repo) ?? ''}|${str(raw.path) ?? ''}|${str(raw.sha) ?? str(raw.commit) ?? ''}|${(raw.base64 as string).length}`
  let url = blobs.get(key)
  if (!url) {
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof atob === 'function') {
      const bin = atob(raw.base64 as string)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      url = URL.createObjectURL(new Blob([bytes], { type: mime }))
    } else {
      url = `data:${mime};base64,${raw.base64 as string}`
    }
    blobs.set(key, url)
  }
  return { ...raw, url, mime, size: raw.size }
}

// ------------------------------------------------------------------ acts

/** gate.sign: what started, from the signature's answer. */
export function readSigned(raw: unknown): unknown {
  if (!isObj(raw) || !('advanced_to' in raw)) return raw
  const started = raw.advanced_to ? [String(raw.summary ?? '').replace(/^Gate signed\.\s*/, '') || String(raw.advanced_to)] : []
  return { ...raw, ok: true, started }
}

/** projects.create: its steps as what was done, or an error naming the steps that failed. */
export function readCreated(raw: unknown): unknown {
  if (!isObj(raw) || !Array.isArray(raw.steps)) return raw
  const steps = arr(raw.steps)
  const failed = steps.filter((s) => s.state === 'failed')
  if (raw.ok === false && failed.length) throw new Error(failed.map((s) => `${String(s.title)}: ${String(s.detail)}`).join(' '))
  return { ...raw, done: steps.filter((s) => s.state === 'done').map((s) => String(s.detail || s.title)), failed: failed.map((s) => `${String(s.title)}: ${String(s.detail)}`), waits: Array.isArray(raw.waits) ? raw.waits : [] }
}

// ------------------------------------------------------------------ chats

/** chats.list: { threads: [{ id, title, updated, by }] } → the threads, newest first. */
export function readThreads(raw: unknown, args?: { repo?: string }): ChatThread[] {
  if (Array.isArray(raw)) return raw as ChatThread[]
  const repo = (isObj(raw) ? str(raw.repo) : undefined) ?? args?.repo ?? ''
  return arr(isObj(raw) ? raw.threads : []).map((t) => ({ id: String(t.id), repo, title: str(t.title) ?? 'Conversation', updatedAt: str(t.updated) ?? str(t.updatedAt) ?? '', ...(str(t.by) ? { author: str(t.by) } : {}) }))
}

/** One stored message (text, by, parts) as the app's: tool calls and the tool call answered come from its parts. */
export function readChatMessage(m: Obj): ChatMessage {
  if ('content' in m && !('text' in m)) return m as unknown as ChatMessage
  const parts = isObj(m.parts) ? m.parts : {}
  const calls = arr(parts.toolCalls).map((c) => ({ id: String(c.id), name: String(c.name), args: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}) }))
  const role = (['user', 'assistant', 'tool', 'system'].includes(String(m.role)) ? m.role : 'assistant') as ChatMessage['role']
  return {
    id: String(m.id), role, content: String(m.text ?? ''), at: str(m.at) ?? '',
    ...(str(m.by) ? { author: str(m.by) } : {}),
    ...(typeof m.yours === 'boolean' ? { yours: m.yours } : {}),
    ...(calls.length ? { toolCalls: calls } : {}),
    ...(str(parts.toolCallId) ? { toolCallId: str(parts.toolCallId) } : {}),
  }
}

/** chats.get: { thread, messages: [{ id, role, text, by, at, parts, yours }], more } → the app's thread. */
export function readThread(raw: unknown, args?: { repo?: string }): { thread: ChatThread; messages: ChatMessage[]; more?: boolean } {
  if (!isObj(raw)) return { thread: { id: '', repo: args?.repo ?? '', title: '', updatedAt: '' }, messages: [] }
  const t = isObj(raw.thread) ? raw.thread : {}
  const repo = str(raw.repo) ?? args?.repo ?? ''
  return {
    thread: { id: String(t.id ?? ''), repo: str(t.repo) ?? repo, title: str(t.title) ?? '', updatedAt: str(t.updated) ?? str(t.updatedAt) ?? '', ...(str(t.by) ?? str(t.author) ? { author: str(t.by) ?? str(t.author) } : {}) },
    messages: arr(raw.messages).map(readChatMessage),
    ...(typeof raw.more === 'boolean' ? { more: raw.more } : {}),
  }
}

/** chats.append: { thread: { id }, ids, created } → { id (the thread), messageId (the person's message), created }. */
export function readAppended(raw: unknown): { id: string; messageId: string; created?: boolean } {
  if (!isObj(raw) || !isObj(raw.thread)) return raw as { id: string; messageId: string }
  const ids = Array.isArray(raw.ids) ? raw.ids.map(String) : []
  return { id: String(raw.thread.id), messageId: ids[0] ?? '', created: Boolean(raw.created) }
}

/** chats.recall: { messages: [{ text }] } → the texts, newest first. */
export function readRecall(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  return arr(isObj(raw) ? raw.messages : []).map((m) => String(m.text ?? ''))
}

/** The readers, by action. */
export const READERS: Partial<Record<string, (raw: unknown, args: Record<string, unknown>) => unknown>> = {
  'journey.get': (r, a) => readJourney(r, a as { repo?: string }),
  'jobs.list': (r, a) => readJobs(r, a as { repo?: string }),
  inbox: readInbox,
  'me.get': readMe,
  'project.members': readMembers,
  'users.list': readUsers,
  'files.list': readFiles,
  'files.url': readFileUrl,
  'gate.sign': readSigned,
  'projects.create': readCreated,
  'chats.list': (r, a) => readThreads(r, a as { repo?: string }),
  'chats.get': (r, a) => readThread(r, a as { repo?: string }),
  'chats.append': readAppended,
  'chats.recall': readRecall,
  'changes.list': (r, a) => readChanges(r, a as { repo?: string }),
  'change.get': readChange,
  'change.diff': readChangeDiff,
}
