/**
 * What the API runtime answers, read into the shapes the screens use. `call()` (lib/api.ts) passes every answer
 * through READERS[action] when there is one. The API's shapes stay as they are because other callers read them too
 * (the `trace` CLI, the chat agent's tools); the reading is here, once, rather than in each screen.
 *
 * Each reader accepts an answer already in the app's shape and returns it unchanged, so mock mode (src/mock, which
 * answers in the app's shapes) and the tests keep working.
 */
import type { ChatMessage, ChatThread, EvidenceRef, Gate, InboxItem, Journey, Member, MeDoc, NextStep, Question, Stage, Waiver } from './types'
import type { DecisionEntry, JourneyMore } from './types-s1'

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
    default: return undefined
  }
}

const DECISION_KIND: Record<string, DecisionEntry['kind']> = { 'gate.signed': 'gate', 'gate.returned': 'gate', 'question.answered': 'question', 'waiver.added': 'waiver', 'skill.submitted': 'decision' }
const DECISION_STATE: Record<string, DecisionEntry['state']> = { 'gate.signed': 'signed', 'gate.returned': 'returned', 'question.answered': 'answered', 'waiver.added': 'active' }

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
  const stages: Stage[] = arr(raw.stages).map((s) => ({
    id: String(s.id), name: String(s.name), state: (STAGE_STATES.has(String(s.state)) ? s.state : 'queued') as Stage['state'],
    criteria: { met: Number(s.met ?? 0), total: Number(s.total ?? 0) },
    ...(isObj(s.reopened) ? { reopened: { reason: str(s.reopened.reason) ?? 'reopened' } } : {}),
    ...(s.optional ? { optional: true } : {}),
  }))
  const n = isObj(raw.next) ? raw.next : {}
  const belongs = String(n.belongs_to ?? 'trace')
  const owner: NextStep['owner'] = n.yours ? 'you' : belongs === 'trace' ? 'trace' : belongs === 'outside' ? 'outside' : 'person'
  const kind = String(n.kind)
  const recommendation = str(n.recommendation)
  const summary = `${String(n.summary ?? '')}${recommendation && !String(n.summary ?? '').includes(recommendation) ? ` **${recommendation}**` : ''}`
  const to = refTo(repo, n.ref, criterionGate)
  const next: NextStep = {
    kind: (kind === 'answer' ? 'task' : kind === 'done' ? 'none' : kind) as NextStep['kind'], owner, summary,
    ...(str(n.why) ? { why: String(n.why) } : {}),
    ...(str(n.button) ? { action: { label: String(n.button), ...(to ? { to } : {}) } } : {}),
    // the API words the step for whoever asks, so the reading form is the same words
    reviewer: { summary, ...(str(n.button) ? { action: { label: String(n.button), ...(to ? { to } : {}) } } : {}) },
  }
  const questions: Question[] = arr(raw.questions).filter((q) => !q.answered).map((q) => {
    const rec = isObj(q.recommended) ? q.recommended : null
    return {
      id: String(q.id), to: q.for === 'you' ? 'you' : q.for === 'contributors' ? 'the contributors' : 'a person on the project', text: String(q.text),
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
    // jobs are not part of the journey record: the API does not list a project's running jobs yet
    jobs: [],
    recent: decisions.slice(0, 5).map((d) => ({ id: String(d.id), who: str(d.by) ?? 'trace', text: String(d.summary), at: String(d.at) })),
    hasMemory: Boolean(raw.has_memory),
    decisions: decisions.map((d) => ({
      id: String(d.id), kind: DECISION_KIND[String(d.kind)] ?? 'decision', title: String(d.summary), by: str(d.by) ?? 'trace', at: String(d.at),
      ...(DECISION_STATE[String(d.kind)] ? { state: DECISION_STATE[String(d.kind)] } : {}),
      ...(String(d.kind).startsWith('gate.') && d.ref ? { to: `/p/${pid(repo)}/gates/${String(d.ref)}` } : {}),
    })),
  }
  return out
}

// ------------------------------------------------------------------ inbox

/** inbox: `{ summary, items, unavailable }` with the API's items, as the app's list. */
export function readInbox(raw: unknown): InboxItem[] {
  if (Array.isArray(raw)) return raw as InboxItem[]
  if (!isObj(raw)) return []
  return arr(raw.items).map((i) => {
    const repo = String(i.repo)
    const ref = isObj(i.ref) ? i.ref : {}
    const to = refTo(repo, ref)
    return {
      id: String(i.id), kind: i.kind as InboxItem['kind'], repo, project: String(i.project), stage: str(i.stage), summary: String(i.summary),
      createdAt: String(i.since), action: { label: String(i.action), ...(to ? { to } : {}) },
      ...(isObj(i.recommended) ? { recommended: { id: String(i.recommended.id), label: String(i.recommended.label) } } : {}),
      ...(ref.kind === 'question' ? { questionId: String(ref.id) } : {}),
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
}
