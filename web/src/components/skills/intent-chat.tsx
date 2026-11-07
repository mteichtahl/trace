/**
 * The Intent builder's conversation: trace opens it, and it is kept.
 *
 * - trace asks the topic's question when the builder opens (test-esp32 #8: the chat was empty on arrival, as the
 *   opening line was the bar's count, "0 of 7 checks met.", not a question). In a new conversation it is the first
 *   thing said; coming back to a kept one, it stands after what was said before, at the topic the person left.
 * - the conversation is kept with the person's preferences (one thread per project and skill), so it is there when
 *   they come back, on any device, as the rail promises: "trace picks up at the topic you left" (test-esp32 #21: a
 *   new, empty chat every visit).
 * - trace notes each statement it drafts from the person's answers in their draft at once, with its `note_intent` tool
 *   (the app runs it: noteStatements), so it shows in the Draft intent panel as Draft and the quality bar checks it.
 *   No job, no branch, no change: Submit intent records them (actions-skills.ts pendingDecisions). Before this the chat
 *   could only offer a Verification job per answer to record them, and the panel stayed at "0 statements" (test log
 *   R5; #7, #11, #84).
 * - trace makes the same decisions on a statement already in the record that the person makes in the panel, with its
 *   `decide_intent` tool (decideStatements): Accept, Edit (its words and an interface's five fields) or Reject with a
 *   reason. Each goes into the draft's decisions, as the panel's do, so it shows there as Not submitted, the quality bar
 *   checks it and Submit intent records it. Before this the chat offered a Verification job to fix a missing connector
 *   or unit (test log R12). A topic that does not matter is marked with a "don't care" statement noted in it.
 */
import { useCallback } from 'react'
import { z } from 'zod'
import { Rich } from '@/components/rich'
import { getPath, useMe, useSetMe } from '@/lib/prefs'
import type { IntentDraft, IntentStatement, InterfaceField } from '@/lib/types-s1'
import type { SkillDef } from './definitions'

/** trace's question for each topic of the intent, asked one at a time. */
export const TOPIC_QUESTIONS: Readonly<Record<string, string>> = {
  purpose: 'What does the product do, in one sentence, and who uses it?',
  environment: 'Where does it live? The operating and storage temperatures, the enclosure and its ingress protection, vibration, and where it is installed.',
  power: 'What powers it? The source, the input voltage range, the power budget, the battery life if it has a battery, and what it does on a brown-out.',
  interfaces: 'What does it connect to? For each one: its type, connector, protocol, rate and direction.',
  performance: 'Which numbers say it works? Accuracy, latency, resolution, range or throughput, each with its unit.',
  physical: 'How big may it be? The board size limits, mounting, height, where the connectors go, and the enclosure.',
  compliance: 'Which standards must it meet? The target standards and class, safety, and the markings.',
  build: 'How many, and at what cost? The quantity per run, the target unit cost, and how you would like it assembled.',
  constraints: 'Are there parts or vendors it must use or avoid, or an earlier design to reuse?',
  references: 'Is there anything to work from? Specs, datasheets, sketches or earlier boards.',
}

/**
 * trace's opening words for the topic the builder is on: the first topic's question in a new intent, or the topic
 * the person left, picked up. Any topic can be answered "don't care" or "not known yet". Pure.
 */
export function openingWords(def: Pick<SkillDef, 'steps'>, topic: number, answered: readonly string[]): string {
  const t = def.steps[topic] ?? def.steps[0]!
  const ask = TOPIC_QUESTIONS[t.id] ?? t.detail
  if (topic === 0 && answered.length === 0) {
    return `Let's write the intent, one topic at a time; I note each statement in the draft as you answer. Any topic can be "don't care" or "not known yet".\n\nFirst, **${t.title.toLowerCase()}**. ${ask}`
  }
  return `We're on **${t.title.toLowerCase()}** (topic ${topic + 1} of ${def.steps.length}). ${ask}`
}

/** trace's opening, drawn as trace's own message in the chat. */
export function IntentOpening({ words }: { words: string }) {
  return (
    <div className="mx-auto max-w-[680px] text-sm" aria-label="trace asks">
      <p className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="flex size-4 items-center justify-center rounded bg-foreground font-mono text-[10px] font-semibold text-background">t</span> trace
      </p>
      {words.split('\n\n').map((p, i) => <p key={i} className={i ? 'mt-2' : undefined}><Rich text={p} /></p>)}
    </div>
  )
}

/** Where a skill's conversation is kept in the person's preferences: plain names only, as preference keys take. */
export const threadKey = (repo: string, skill: string): string => `threads.${repo.replace(/[^A-Za-z0-9_-]/g, '_')}.${skill.replace(/[^A-Za-z0-9_-]/g, '_')}`

/**
 * The skill's kept conversation on the project: its thread (undefined for none yet), whether the preferences have
 * loaded (the chat waits for them, so a kept conversation is not replaced by a new one), and `keep` for a new thread.
 */
export function useSkillThread(repo: string, skill: string): { loaded: boolean; thread: string | undefined; keep: (id: string) => void } {
  const me = useMe()
  const set = useSetMe()
  const key = threadKey(repo, skill)
  const v = getPath(me.data, key)
  const { mutate } = set
  const keep = useCallback((id: string) => mutate({ key, value: id }), [mutate, key])
  return { loaded: me.isSuccess || me.isError, thread: typeof v === 'string' && v ? v : undefined, keep }
}

// ------------------------------------------------------------------ statements noted in the draft

/** The topics in the builder's order (definitions.ts intent-builder steps). */
const TOPICS = Object.keys(TOPIC_QUESTIONS)
const TOPIC_TITLE = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1)

/** A statement trace noted in the person's draft (draft.proposed): the person's own, recorded by Submit intent. */
export interface NotedStatement {
  id: string
  topic: string
  kind?: 'statement' | 'dont_care' | 'unknown' | 'question'
  text: string
  interface?: Partial<Record<InterfaceField, string>>
  owner?: string
  decide_by?: string
}

/** An interface's five fields, in the panel's order. */
export const INTERFACE_FIELDS: readonly InterfaceField[] = ['type', 'connector', 'protocol', 'rate', 'direction']

/**
 * The fields of an interface a person changed, trimmed: what Save sends beside the words. The fields left as shown are
 * not sent, so trace reads them from the new words (a reworded rate is not held back by the old one). Pure.
 */
export function changedFields(shown: Partial<Record<InterfaceField, string>>, typed: Partial<Record<InterfaceField, string>>): Partial<Record<InterfaceField, string>> | undefined {
  const out: Partial<Record<InterfaceField, string>> = {}
  for (const f of INTERFACE_FIELDS) { const v = typed[f]?.trim(); if (v && v !== (shown[f] ?? '').trim()) out[f] = v }
  return Object.keys(out).length ? out : undefined
}

const Iface = z.object({ type: z.string(), connector: z.string(), protocol: z.string(), rate: z.string(), direction: z.string() }).partial()

/** note_intent's arguments: what the chat model sends. */
export const NoteIntent = z.object({
  statements: z.array(z.object({
    id: z.string().optional().describe('only to reword a statement you noted before: its id'),
    topic: z.enum(TOPICS as [string, ...string[]]),
    kind: z.enum(['statement', 'dont_care', 'unknown', 'question']).optional().describe('statement (default); dont_care: the topic does not matter here; unknown: decided later (give decide_by); question: open, with an owner'),
    text: z.string().describe('one statement, in plain words, with its number and unit where it has one'),
    interface: Iface.optional().describe('interfaces: type, connector, protocol, rate, direction'),
    owner: z.string().optional().describe('question: who answers it'),
    decide_by: z.enum(['define', 'architect', 'capture', 'prove', 'layout', 'signoff', 'release', 'fabricate', 'bringup']).optional().describe('unknown: the stage it must be decided by'),
  })).default([]),
  withdraw: z.array(z.string()).optional().describe('ids of statements you noted that the person took back'),
})
export type NoteIntentArgs = z.input<typeof NoteIntent>

export const NOTE_INTENT_DESCRIPTION = 'Note the intent statements you drafted from the person\'s answers in their Intent builder draft. They show at once in the Draft intent panel as Draft, the quality bar checks them, and the person can accept, edit or reject each there; Submit intent records them. No task, branch or change is needed: never offer start_task to record intent. One statement per line of intent, in the person\'s words where you can, with its number and unit. To reword one you noted before, give its id; to take one back, list it in withdraw. To mark a topic that does not matter for this product (References, say), note one statement in it with kind dont_care and a few words why: a topic counts as answered once it holds a statement. A statement already in the record is changed with decide_intent, not noted again.'

/** A new statement id, as the record's (INT-<6 hex>). */
export function newStatementId(): string {
  const b = new Uint8Array(3)
  crypto.getRandomValues(b)
  return `INT-${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}

/**
 * note_intent, run by the app on the person's draft: each statement added (a new id), or put in place of the one it
 * names that was noted before; withdrawn ones removed. A statement the record already has is not touched: the person
 * decides on it in the panel. Pure; `newId` gives the ids.
 */
export function noteStatements(proposed: readonly NotedStatement[], args: unknown, record: ReadonlySet<string>, newId: () => string = newStatementId): { proposed: NotedStatement[]; noted: { id: string; topic: string; text: string }[]; withdrawn: string[]; refused: string[] } {
  const a = NoteIntent.safeParse(args)
  if (!a.success) return { proposed: [...proposed], noted: [], withdrawn: [], refused: [`The statements could not be read: ${a.error.issues[0]?.message ?? 'bad arguments'}.`] }
  let out = [...proposed]
  const noted: { id: string; topic: string; text: string }[] = []
  const refused: string[] = []
  for (const st of a.data.statements) {
    const text = st.text.trim()
    if (text.length < 3) { refused.push(`A ${st.topic} statement has no words.`); continue }
    if (st.id && record.has(st.id) && !out.some((x) => x.id === st.id)) { refused.push(`${st.id} is in the record: change its words or fields, or reject it, with decide_intent.`); continue }
    const id = st.id && out.some((x) => x.id === st.id) ? st.id : newId()
    const iface = st.interface ? Object.fromEntries(Object.entries(st.interface).filter(([, v]) => typeof v === 'string' && v.trim())) as NotedStatement['interface'] : undefined
    const row: NotedStatement = {
      id, topic: st.topic, text, ...(st.kind && st.kind !== 'statement' ? { kind: st.kind } : {}), ...(iface && Object.keys(iface).length ? { interface: iface } : {}),
      ...(st.owner?.trim() ? { owner: st.owner.trim() } : {}), ...(st.decide_by ? { decide_by: st.decide_by } : {}),
    }
    out = out.some((x) => x.id === id) ? out.map((x) => (x.id === id ? row : x)) : [...out, row]
    noted.push({ id, topic: st.topic, text })
  }
  const gone = new Set((a.data.withdraw ?? []).filter((id) => out.some((x) => x.id === id)))
  out = out.filter((x) => !gone.has(x.id))
  return { proposed: out, noted, withdrawn: [...gone], refused }
}

/** What note_intent answers the chat. Pure. */
export function notedAnswer(r: Pick<ReturnType<typeof noteStatements>, 'noted' | 'withdrawn' | 'refused'>) {
  return {
    noted: r.noted, ...(r.withdrawn.length ? { withdrawn: r.withdrawn } : {}), ...(r.refused.length ? { refused: r.refused } : {}),
    note: 'In the person\'s Draft intent panel now, as Draft, and the quality bar checks them. They are recorded when the person presses Submit intent. Nothing needs to be started.',
  }
}

/**
 * The draft as the panel shows it: the record's view (skill.get lays the draft over the record, so a noted statement
 * is in it once the draft is saved), with any noted statement it does not hold yet added as Draft, so it shows the
 * moment trace notes it. One the person rejected in the draft is left out (it is listed under "Rejected in your
 * draft"). Pure.
 */
export function withNoted(intent: IntentDraft | undefined, proposed: readonly NotedStatement[], rejected: ReadonlySet<string>): IntentDraft | undefined {
  const have = new Set([...(intent?.statements ?? []).map((x) => x.id), ...(intent?.questions ?? []).map((x) => x.id)])
  const add = proposed.filter((x) => !have.has(x.id) && !rejected.has(x.id))
  if (!add.length) return intent
  const words = (x: NotedStatement): string => (x.kind === 'dont_care' ? `Don't care: ${x.text}` : x.kind === 'unknown' ? `Unknown, decide by ${x.decide_by ?? '?'}: ${x.text}` : x.text)
  const statements = [...(intent?.statements ?? []), ...add.filter((x) => x.kind !== 'question').map((x) => ({ id: x.id, topic: TOPIC_TITLE(x.topic), text: words(x), state: 'draft' as const }))]
  const questions = [...(intent?.questions ?? []), ...add.filter((x) => x.kind === 'question').map((x) => ({ id: x.id, text: x.text, owner: x.owner ?? 'no owner yet' }))]
  const answered = [...new Set([...(intent?.answered ?? []), ...add.filter((x) => x.kind !== 'question').map((x) => x.topic)])]
  const next = TOPICS.findIndex((t) => !answered.includes(t))
  return { topic: next === -1 ? TOPICS.length - 1 : next, answered, statements, questions }
}

// ------------------------------------------------------------------ decisions on the record's statements

/** A person's decision on one statement, kept in the draft until Submit records it (actions-skills pendingDecisions). */
export interface IntentDecision { statement: string; choice: 'accept' | 'edit' | 'reject'; text?: string; reason?: string; interface?: Partial<Record<InterfaceField, string>> }

/** decide_intent's arguments: what the chat model sends. */
export const DecideIntent = z.object({
  decisions: z.array(z.object({
    statement: z.string().describe('the statement\'s id, as the Intent draft context lists it (INT-…)'),
    choice: z.enum(['accept', 'edit', 'reject', 'undo']).describe('accept as worded; edit: new words and/or interface fields; reject: with a reason; undo: take back the draft\'s decision on it'),
    text: z.string().optional().describe('edit: the whole statement in its new words, with its number and unit; leave out to keep the words and set only interface fields'),
    interface: Iface.optional().describe('edit, an interface statement only: the fields to set (type, connector, protocol, rate, direction). The ones left out are read from the words'),
    reason: z.string().optional().describe('reject: why, in one line'),
  })).min(1),
})
export type DecideIntentArgs = z.input<typeof DecideIntent>

export const DECIDE_INTENT_DESCRIPTION = 'Change a statement in the person\'s Intent builder draft the way the person does with the Draft intent panel\'s Accept, Edit and Reject: reword it (give a number and unit, make it testable), set an interface\'s missing fields (connector, rate…), reject it with a reason, accept it as worded, or undo a decision. Use it for statements already in the record (from the agents) as well as ones you noted. It goes in the draft at once, shows in the panel as Not submitted, and the quality bar checks it; Submit intent records it as the person\'s decision. No task, branch or change is needed: never offer start_task or a Verification job to fix intent statements. Only make the changes the person asked for or agreed to; say each one back in plain words.'

/** A statement as decide_intent reads it from the panel: its words and an interface's fields as shown. */
export type ShownStatement = Pick<IntentStatement, 'id' | 'text' | 'interface'>

/**
 * decide_intent, run by the app on the person's draft: each decision replaces the draft's decision on that statement,
 * as the panel's Accept, Edit and Reject do (withIntentDecision). An edit keeps the words shown when it gives none,
 * and its fields add to the ones an earlier edit set; only an interface statement takes fields. A reject needs its
 * reason. A statement the panel does not show is refused. Pure.
 */
export function decideStatements(decisions: readonly IntentDecision[], args: unknown, shown: ReadonlyMap<string, ShownStatement>): { decisions: IntentDecision[]; decided: { statement: string; choice: string; words?: string; interface?: Partial<Record<InterfaceField, string>>; reason?: string }[]; refused: string[] } {
  const a = DecideIntent.safeParse(args)
  if (!a.success) return { decisions: [...decisions], decided: [], refused: [`The decisions could not be read: ${a.error.issues[0]?.message ?? 'bad arguments'}.`] }
  let out = [...decisions]
  const decided: ReturnType<typeof decideStatements>['decided'] = []
  const refused: string[] = []
  const put = (statement: string, d: Omit<IntentDecision, 'statement'> | null) => { out = [...out.filter((x) => x.statement !== statement), ...(d ? [{ statement, ...d }] : [])] }
  for (const d of a.data.decisions) {
    const st = shown.get(d.statement)
    if (!st) { refused.push(`${d.statement} is not in the Draft intent panel: use the ids the Intent draft context lists.`); continue }
    const before = out.find((x) => x.statement === d.statement)
    if (d.choice === 'undo') {
      if (before) { put(d.statement, null); decided.push({ statement: d.statement, choice: 'undo' }) }
      continue
    }
    if (d.choice === 'accept') { put(d.statement, { choice: 'accept' }); decided.push({ statement: d.statement, choice: 'accept' }); continue }
    if (d.choice === 'reject') {
      const reason = d.reason?.trim() ?? ''
      if (reason.length < 3) { refused.push(`Rejecting ${d.statement} needs a reason in a few words.`); continue }
      put(d.statement, { choice: 'reject', reason })
      decided.push({ statement: d.statement, choice: 'reject', reason })
      continue
    }
    // edit: the words as they stand (an earlier edit's) when none are given
    const text = d.text?.trim() || (before?.choice === 'edit' && before.text ? before.text : st.text)
    if (text.length < 3) { refused.push(`${d.statement} needs its words.`); continue }
    const typed = Object.fromEntries(Object.entries(d.interface ?? {}).filter(([, v]) => typeof v === 'string' && v.trim())) as Partial<Record<InterfaceField, string>>
    if (Object.keys(typed).length && !st.interface) { refused.push(`${d.statement} is not an interface statement: put the detail in its words.`); continue }
    const fields = st.interface ? changedFields(st.interface, { ...(before?.choice === 'edit' ? before.interface : {}), ...typed }) : undefined
    if (text === st.text && !fields) { refused.push(`${d.statement}: nothing to change; it reads so already.`); continue }
    put(d.statement, { choice: 'edit', text, ...(fields ? { interface: fields } : {}) })
    decided.push({ statement: d.statement, choice: 'edit', words: text, ...(fields ? { interface: fields } : {}) })
  }
  return { decisions: out, decided, refused }
}

/** What decide_intent answers the chat. Pure. */
export function decidedAnswer(r: Pick<ReturnType<typeof decideStatements>, 'decided' | 'refused'>) {
  return {
    decided: r.decided, ...(r.refused.length ? { refused: r.refused } : {}),
    note: 'In the person\'s Draft intent panel now, marked Not submitted, and the quality bar checks it. Submit intent records it as the person\'s decision, as the panel\'s own edits. Nothing needs to be started.',
  }
}

/**
 * The statements as the panel shows them, with the draft's edits laid over them at once: an edit's interface fields
 * are shown as set, and the "Missing …" flag names only the fields still empty (cleared when none are). The record's
 * view says the same once the saved draft is read again; until then the panel kept "Connector: not given" after Save
 * (test log R14). Pure.
 */
export function withDecided(intent: IntentDraft | undefined, decisions: readonly IntentDecision[]): IntentDraft | undefined {
  if (!intent) return intent
  const edits = new Map(decisions.filter((d) => d.choice === 'edit' && d.interface && Object.keys(d.interface).length).map((d) => [d.statement, d.interface!]))
  if (!edits.size) return intent
  let changed = false
  const statements = intent.statements.map((st) => {
    const f = edits.get(st.id)
    if (!f || !st.interface) return st
    const iface = { ...st.interface, ...f }
    const missing = INTERFACE_FIELDS.filter((k) => !iface[k]?.trim())
    const wasMissing = !!st.flag?.startsWith('Missing ')
    const flag = wasMissing ? (missing.length ? { flag: `Missing ${missing.join(', ')}` } : {}) : st.flag ? { flag: st.flag } : {}
    const state = wasMissing && !missing.length ? 'draft' as const : st.state
    changed = true
    const { flag: _old, ...rest } = st
    return { ...rest, interface: iface, missing, state, ...flag }
  })
  return changed ? { ...intent, statements } : intent
}

/**
 * The interfaces check as the panel shows the draft: met once every interface statement on screen has its five
 * fields, not met while one lacks any; undefined (the record's verdict stands) when no statement shows its fields.
 * Pure.
 */
export function interfacesCheck(statements: readonly Pick<IntentStatement, 'interface' | 'missing'>[]): 'met' | 'not_met' | undefined {
  const ifaces = statements.filter((s) => s.interface)
  if (!ifaces.length) return undefined
  return ifaces.some((s) => (s.missing ?? INTERFACE_FIELDS.filter((k) => !s.interface?.[k]?.trim())).length) ? 'not_met' : 'met'
}
