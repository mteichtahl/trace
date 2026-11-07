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
 */
import { useCallback } from 'react'
import { z } from 'zod'
import { Rich } from '@/components/rich'
import { getPath, useMe, useSetMe } from '@/lib/prefs'
import type { IntentDraft, InterfaceField } from '@/lib/types-s1'
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

export const NOTE_INTENT_DESCRIPTION = 'Note the intent statements you drafted from the person\'s answers in their Intent builder draft. They show at once in the Draft intent panel as Draft, the quality bar checks them, and the person can accept, edit or reject each there; Submit intent records them. No task, branch or change is needed: never offer start_task to record intent. One statement per line of intent, in the person\'s words where you can, with its number and unit. To reword one you noted before, give its id; to take one back, list it in withdraw. A statement already in the record is the person\'s to decide in the panel.'

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
    if (st.id && record.has(st.id) && !out.some((x) => x.id === st.id)) { refused.push(`${st.id} is in the record: the person accepts, edits or rejects it in the Draft intent panel.`); continue }
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
