/**
 * The conversational skills (docs/ui-design.md, "Focus mode": Conversational): the chat moves to the centre and
 * becomes the work; the right panel shows what is being built, live from the agent's shared state.
 *
 * - Intent builder: the ten topics as the stepper; the chat asks one topic at a time; the right panel holds the draft
 *   statements (Accepted, Draft, Needs a number…), the open questions with owners, and the quality bar's seven checks.
 *   The shared state comes over AG-UI (STATE_SNAPSHOT / STATE_DELTA) through CopilotKit's `useAgent`; until the agent
 *   has sent any, the record's draft (skill.get) is shown.
 * - Question answer: what the agent is doing and what the question blocks, the sources it searched, its options with
 *   the recommended one first (Decision card), then making the answer specific and saying whether it lasts. Sends
 *   with question.answer.
 */
import { UseAgentUpdate, useAgent } from '@copilotkit/react-core/v2'
import { ArrowRight, Check, Circle, CircleDot } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { FOCUS_AGENT_ID } from '@/components/chat/agent'
import { useTraceContext } from '@/components/chat/context'
import { EmbeddedChat } from '@/components/chat/embedded-chat'
import { DecisionCard, WaiverNote, chosenWords } from '@/components/decision-card'
import { EvidenceChip } from '@/components/evidence-chip'
import { FocusLayout } from '@/components/focus/focus-layout'
import { OutOfDateNote } from '@/components/question-notes'
import type { QualityCheck } from '@/components/quality-bar'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState, QueryError } from '@/components/states'
import { useMediaQuery } from '@/hooks/use-media-query'
import { type ResultOf, call } from '@/lib/api'
import { useCall } from '@/lib/queries'
import type { CriterionStatus, Question } from '@/lib/types'
import type { IntentDraft, IntentStatement, InterfaceField } from '@/lib/types-s1'
import { cn } from '@/lib/utils'
import type { SkillDef } from './definitions'
import { IntentOpening, openingWords, useSkillThread } from './intent-chat'
import { StepHeader, Unavailable, type Confirmable } from './parts'
import { type SkillDraftBase, focusSteps, qualityChecks, useSkill } from './use-skill'

// ------------------------------------------------------------------ the agent's shared state

/** The intent draft as the agent's shared state carries it (assumed keys: intent.statements, intent.questions…). */
export function intentFromState(state: unknown): IntentDraft | undefined {
  const s = (state && typeof state === 'object' ? (state as Record<string, unknown>).intent ?? state : undefined) as Partial<IntentDraft> | undefined
  if (!s || !Array.isArray(s.statements)) return undefined
  return { topic: typeof s.topic === 'number' ? s.topic : 0, answered: Array.isArray(s.answered) ? s.answered : [], statements: s.statements, questions: Array.isArray(s.questions) ? s.questions : [] }
}

const STATE_WORD: Record<IntentStatement['state'], { status: 'met' | 'yours' | 'warning' | 'failing'; label: string }> = {
  accepted: { status: 'met', label: 'Accepted' },
  draft: { status: 'yours', label: 'Draft' },
  needs_number: { status: 'warning', label: 'Needs a number' },
  vague: { status: 'warning', label: 'Vague word' },
  conflict: { status: 'failing', label: 'Conflict' },
}

// ------------------------------------------------------------------ intent builder

/** A person's decision on one statement, kept in the draft until Submit records it (actions-skills pendingDecisions). */
export interface IntentDecision { statement: string; choice: 'accept' | 'edit' | 'reject'; text?: string; reason?: string; interface?: Partial<Record<InterfaceField, string>> }
interface IntentLocal extends SkillDraftBase { topic?: number; decisions?: IntentDecision[] }

/** The draft with one statement's decision replaced, or removed (null). Pure. */
export function withIntentDecision<D extends { decisions?: IntentDecision[] }>(d: D, statement: string, decision: Omit<IntentDecision, 'statement'> | null): D {
  const rest = (d.decisions ?? []).filter((x) => x.statement !== statement)
  return { ...d, decisions: decision ? [...rest, { statement, ...decision }] : rest }
}

const DECIDED_WORD: Record<IntentDecision['choice'], string> = { accept: 'Accepting', edit: 'Rewording', reject: 'Rejecting' }

/**
 * A statement's badge. The view the panel reads lays the person's draft over the record (so the quality bar shows what
 * Submit would record), which made a saved edit read "Accepted" while the note said it was still in the draft and the
 * record did not have it (test-esp32 #22). A decision still in the draft reads "Not submitted"; a flag the check still
 * raises on it (the new words lack a number) is shown over that. Pure.
 */
export function statementBadge(st: Pick<IntentStatement, 'state' | 'flag'>, decision?: Pick<IntentDecision, 'choice'>): { status: 'met' | 'yours' | 'warning' | 'failing'; label: string } {
  const flagged = st.state !== 'accepted' && st.state !== 'draft'
  if (decision && !flagged) return { status: 'yours', label: 'Not submitted' }
  return { status: STATE_WORD[st.state].status, label: st.flag ?? STATE_WORD[st.state].label }
}

/** The line under a statement the person decided in the draft: what it will be, and that Submit records it. Pure. */
export const decidedNote = (choice: IntentDecision['choice']): string => `${DECIDED_WORD[choice]} in your draft. Submit intent records it.`

/**
 * The statements Submit intent accepts as worded: shown, not decided in the draft, and not accepted in the record
 * already (actions-skills pendingDecisions accepts every one left proposed). Pure.
 */
export function undecidedStatements(statements: readonly Pick<IntentStatement, 'id' | 'state'>[], decisions: readonly Pick<IntentDecision, 'statement'>[]): string[] {
  const named = new Set(decisions.map((d) => d.statement))
  return statements.filter((x) => !named.has(x.id) && x.state !== 'accepted').map((x) => x.id)
}

/** Submit's words: it says when it also accepts the statements left in draft (test-esp32 #26). Pure. */
export function intentSubmitLabel(submit: string, undecided: number): string {
  return undecided ? `${submit} (accepts ${undecided} still in draft)` : submit
}

/**
 * What trace's chat is told about the draft: the decisions made here are not in the record until Submit intent, so the
 * chat says the same as the panel (test-esp32 #22: it said the edits had not reached the record while the badge said
 * Accepted). Pure.
 */
export function intentDraftContext(decisions: readonly IntentDecision[], undecided: readonly string[]) {
  return {
    submitted: false,
    note: 'These decisions are in the person\'s Intent builder draft, not in the record. They are recorded when the person presses Submit intent; until then the record still has the statements as the agents wrote them. Submit intent also accepts, as worded, every statement still in draft.',
    decisions: decisions.map((d) => ({ statement: d.statement, choice: d.choice, ...(d.text ? { words: d.text } : {}), ...(d.reason ? { reason: d.reason } : {}) })),
    acceptedAtSubmit: undecided,
  }
}

const FIELDS: { id: InterfaceField; label: string; hint: string }[] = [
  { id: 'type', label: 'Type', hint: 'USB device, I2C, antenna' },
  { id: 'connector', label: 'Connector', hint: 'USB-C receptacle, 4-pin header' },
  { id: 'protocol', label: 'Protocol', hint: 'USB 2.0 full speed' },
  { id: 'rate', label: 'Rate', hint: '12 Mbit/s, 400 kHz' },
  { id: 'direction', label: 'Direction', hint: 'in, out or both' },
]

/**
 * The fields of an interface a person changed, trimmed: what Save sends beside the words. The fields left as shown are
 * not sent, so trace reads them from the new words (a reworded rate is not held back by the old one). Pure.
 */
export function changedFields(shown: Partial<Record<InterfaceField, string>>, typed: Partial<Record<InterfaceField, string>>): Partial<Record<InterfaceField, string>> | undefined {
  const out: Partial<Record<InterfaceField, string>> = {}
  for (const f of FIELDS) { const v = typed[f.id]?.trim(); if (v && v !== (shown[f.id] ?? '').trim()) out[f.id] = v }
  return Object.keys(out).length ? out : undefined
}

/** An interface statement's five fields, as the check reads them: the empty ones named. */
function InterfaceFields({ st }: { st: IntentStatement }) {
  if (!st.interface) return null
  return (
    <p className="text-xs text-muted-foreground">
      {FIELDS.map((f, i) => (
        <span key={f.id}>
          {i > 0 && ' · '}
          {f.label}: {st.interface?.[f.id] ? <span className="text-foreground">{st.interface[f.id]}</span> : <span className="font-medium text-warning">not given</span>}
        </span>
      ))}
    </p>
  )
}

/**
 * One statement in the Draft intent panel, with the person's decision on it: Accept as worded, Edit (in their own
 * words) or Reject (with a line why). Editing an interface statement shows its five fields beside the words (test-esp32
 * #20): the ones the person changes are kept as typed, the others are read from the new words. The decision goes into
 * the draft; the quality bar (skill.get, the draft laid over the record) moves with it, and Submit intent records it.
 * Statements left undecided are accepted at Submit, and Submit's words say how many. Until Submit a decision reads
 * "Not submitted" (statementBadge), the way trace's chat is told it (intentDraftContext).
 */
function IntentStatementRow({ st, decision, onDecide }: { st: IntentStatement; decision?: IntentDecision; onDecide: (d: Omit<IntentDecision, 'statement'> | null) => void }) {
  const [mode, setMode] = useState<'edit' | 'reject' | null>(null)
  const [words, setWords] = useState('')
  const [fields, setFields] = useState<Partial<Record<InterfaceField, string>>>({})
  const ok = words.trim().length >= 3
  const done = () => { setMode(null); setWords(''); setFields({}) }
  const save = () => {
    const changed = st.interface ? changedFields(st.interface, fields) : undefined
    onDecide(mode === 'edit' ? { choice: 'edit', text: words.trim(), ...(changed ? { interface: changed } : {}) } : { choice: 'reject', reason: words.trim() })
    done()
  }
  return (
    <li className="space-y-1.5 text-sm">
      <div className="flex items-start justify-between gap-3">
        <span>{decision?.choice === 'edit' && decision.text ? decision.text : st.text}</span>
        <StatusBadge {...statementBadge(st, decision)} className="shrink-0" />
      </div>
      {mode !== 'edit' && <InterfaceFields st={st} />}
      {mode ? (
        <div className="space-y-2">
          <Label className="sr-only" htmlFor={`intent-${st.id}`}>{mode === 'edit' ? `Statement ${st.id} in your words` : `Why ${st.id} is rejected`}</Label>
          <Input id={`intent-${st.id}`} className="h-8 min-w-0" autoFocus placeholder={mode === 'edit' ? 'The statement in your words' : 'Why it is rejected'} value={words} onChange={(e) => setWords(e.target.value)} />
          {mode === 'edit' && st.interface && (
            <fieldset className="grid gap-2 rounded-md border p-2">
              <legend className="px-1 text-xs text-muted-foreground">The interface. Change a field to set it; the ones you leave are read from your words.</legend>
              {FIELDS.map((f) => (
                <div key={f.id} className="flex min-w-0 items-center gap-2">
                  <Label htmlFor={`intent-${st.id}-${f.id}`} className="w-20 shrink-0 text-xs">{f.label}</Label>
                  <Input id={`intent-${st.id}-${f.id}`} className="h-8 min-w-0 flex-1" placeholder={f.hint} value={fields[f.id] ?? ''} onChange={(e) => setFields((x) => ({ ...x, [f.id]: e.target.value }))} />
                </div>
              ))}
            </fieldset>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={!ok} onClick={save}>{mode === 'edit' ? 'Save' : 'Reject'}</Button>
            <Button size="sm" variant="ghost" onClick={done}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          {decision && <span className="mr-1 text-muted-foreground">{decidedNote(decision.choice)}</span>}
          {decision ? (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => onDecide(null)}>Undo</Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" aria-label={`Accept ${st.id}`} onClick={() => onDecide({ choice: 'accept' })}>Accept</Button>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" aria-label={`Edit ${st.id}`} onClick={() => { setMode('edit'); setWords(st.text); setFields({ ...st.interface }) }}>Edit</Button>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" aria-label={`Reject ${st.id}`} onClick={() => setMode('reject')}>Reject</Button>
            </>
          )}
        </div>
      )}
    </li>
  )
}

export function IntentBuilder({ repo, def }: { repo: string; def: SkillDef }) {
  const s = useSkill<IntentLocal>(repo, def, { done: [] })
  const kept = useSkillThread(repo, def.id)
  const { agent } = useAgent({ agentId: FOCUS_AGENT_ID, updates: [UseAgentUpdate.OnStateChanged] })
  const live = intentFromState(agent.state)
  const intent = live ?? s.view.data?.intent
  const v = s.view.data
  // the agent drives the topic; the person can revisit an answered one
  const topic = intent?.topic ?? s.stepIndex
  const answered = intent?.answered ?? s.draft.data.done
  const steps = focusSteps(def, topic, answered)
  const checks = qualityChecks(def, v, {})
  const left = checks.filter((c) => c.status === 'not_met').length
  const t = def.steps[topic] ?? def.steps[0]!
  const decisions = s.draft.data.decisions ?? []
  // a statement rejected in the draft drops out of the record's view (skill.get lays the draft over it): listed here
  const shown = new Set((intent?.statements ?? []).map((x) => x.id))
  const rejected = decisions.filter((d) => d.choice === 'reject' && !shown.has(d.statement))
  const decide = (statement: string, d: Omit<IntentDecision, 'statement'> | null) => s.draft.setData((x) => withIntentDecision(x, statement, d))
  const undecided = undecidedStatements(intent?.statements ?? [], decisions)
  useTraceContext(decisions.length || undecided.length ? { label: 'Intent draft', description: 'The person\'s Intent builder draft, not submitted yet', value: intentDraftContext(decisions, undecided) } : null, 'intent-draft')

  const aside = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-baseline justify-between border-b px-5 py-4">
        <h2 className="font-semibold">Draft intent</h2>
        <span className="text-xs text-muted-foreground">{intent?.statements.length ?? 0} statements{live ? '' : ' · from the record'}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
        {!intent ? (
          <p className="text-sm text-muted-foreground">{s.view.isLoading ? 'Loading the draft…' : 'Nothing drafted yet. Statements appear here as you answer.'}</p>
        ) : (
          groupBy(intent.statements, (x) => x.topic).map(([g, list]) => (
            <section key={g}>
              <h3 className="mb-1.5 text-xs text-muted-foreground">{g}</h3>
              <ul className="space-y-2">
                {list.map((st) => (
                  <IntentStatementRow key={st.id} st={st} decision={decisions.find((x) => x.statement === st.id)} onDecide={(d) => decide(st.id, d)} />
                ))}
              </ul>
            </section>
          ))
        )}
        {rejected.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-xs text-muted-foreground">Rejected in your draft ({rejected.length})</h3>
            <ul className="space-y-2">
              {rejected.map((d) => (
                <li key={d.statement} className="flex items-start justify-between gap-3 text-sm">
                  <span><span className="font-mono text-xs">{d.statement}</span>: {d.reason}</span>
                  <Button size="sm" variant="ghost" className="h-6 shrink-0 px-2 text-xs" aria-label={`Undo rejecting ${d.statement}`} onClick={() => decide(d.statement, null)}>Undo</Button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {intent && (
          <section className="border-t pt-4">
            <h3 className="text-sm font-semibold">Open questions ({intent.questions.length})</h3>
            {intent.questions.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">None.</p> : (
              <ul className="mt-2 space-y-2">
                {intent.questions.map((q) => <li key={q.id} className="flex justify-between gap-3 text-sm"><span>{q.text}</span><span className="shrink-0 text-muted-foreground">Owner: {q.owner}</span></li>)}
              </ul>
            )}
          </section>
        )}
        <section className="border-t pt-4">
          <h3 className="text-sm font-semibold">Quality bar · {checks.length - left} of {checks.length} met</h3>
          <ul className="mt-2 space-y-1.5">
            {checks.map((c) => (
              <li key={c.id} className="flex items-center gap-2 text-sm">
                {c.status === 'met' ? <Check className="size-3.5 text-verified" aria-hidden /> : c.id === 'interfaces' && topic === 3 ? <CircleDot className="size-3.5 text-primary" aria-hidden /> : <Circle className="size-3.5 text-muted-foreground" aria-hidden />}
                <span className="flex-1">{c.text.replace(/ \(.*\)$/, '')}</span>
                <span className={cn('text-xs', c.status === 'met' ? 'text-verified' : 'text-muted-foreground')}>{c.status === 'met' ? 'Met' : (/\((.*)\)$/.exec(c.text)?.[1] ?? 'Not met')}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )

  return (
    <FocusLayout
      title={def.name}
      context={s.context}
      variant="conversational"
      centre="fill"
      steps={steps}
      onStep={(id) => s.goTo(id)}
      stepsExtra={<p className="px-2 text-xs text-muted-foreground">You can stop at any time. The draft is kept and trace picks up at the topic you left.</p>}
      checks={checks}
      submitLabel={intentSubmitLabel(def.submit ?? 'Submit', undecided.length)}
      onSubmit={() => s.submit(async () => {
        // Submit starts the Verification agent drafting the candidate requirements (skill.submit); say whether it did
        const r = await call('skill.submit', { repo, skill: def.id, draft: s.draft.data as unknown as Record<string, unknown> }) as { jobId?: string; jobError?: string; queued?: boolean }
        if (r.jobError) toast.warning('trace could not start drafting the requirements.', { description: `${r.jobError} Ask trace to draft them from the intent.` })
        // a new project whose agent is still being set up: the drafting is queued and starts by itself (log #2, #80)
        else if (r.queued) toast('Your intent is submitted. Drafting the requirements is queued.', { description: 'It starts by itself once this project\'s agent is ready; you need not submit again.' })
        else toast('trace is drafting the candidate requirements for Requirements review.')
        return r
      }, 'Intent submitted.')}
      onClose={s.close}
      outcome={s.outcome}
      draftSavedAt={s.draft.savedAt}
      aside={aside}
    >
      <div className="flex items-center gap-3 border-b px-4 py-3 md:px-6">
        <span className="font-semibold">{t.title}</span>
        <span className="text-sm text-muted-foreground">Topic {topic + 1} of {def.steps.length}</span>
      </div>
      {/* trace opens the conversation with the topic's question, and the conversation is kept (intent-chat.tsx) */}
      {kept.loaded ? (
        <EmbeddedChat
          repo={repo}
          threadId={kept.thread}
          onThread={kept.keep}
          pinIntro
          title={`Intent builder · ${t.title}`}
          placeholder="Answer, or ask trace a question…"
          intro={
            <div className="space-y-4">
              <IntentOpening words={openingWords(def, topic, answered)} />
              {v?.recommendation && <DecisionCard decision={v.recommendation} onChoose={() => undefined} />}
              {s.view.isError && <QueryError error={s.view.error} what="the intent draft" onRetry={() => void s.view.refetch()} />}
            </div>
          }
        />
      ) : <p className="px-6 py-4 text-sm text-muted-foreground">Opening the conversation…</p>}
      <div className="mt-4"><Unavailable checks={s.view.data?.checks} def={def} draft={s.draft as unknown as Confirmable} /></div>
    </FocusLayout>
  )
}

function groupBy<T>(xs: T[], key: (x: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>()
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x])
  return [...m]
}

// ------------------------------------------------------------------ question answer

export interface AnswerDraft extends SkillDraftBase {
  /** the question this draft answers: a draft belongs to its question, never to the next one asked */
  question?: string
  option?: string
  reason?: string
  answer: string
  /** the detail a chosen option needs from the person (its `needs`), sent with the option */
  detail?: string
  value: string
  source: string
  lasts: 'once' | 'rule' | 'requirement' | ''
}

/**
 * What the person is told once an answer is in: the answer's summary (whether the agent carried on), and for a rule,
 * the change that adds it to the project's rules, or that it could not be added yet and where to add it. Pure.
 */
export function answeredWords(r: Pick<ResultOf<'question.answer'>, 'summary' | 'rule' | 'rule_error'> | undefined): string {
  const said = r?.summary ?? 'Answered. The agent continues.'
  if (r?.rule?.words) return `${said} ${r.rule.words}`
  if (r?.rule_error) return `${said} The rule could not be added to the project's rules yet: add it from Settings, under Project rules.`
  return said
}

/** The question-answer bar, from the draft. Pure. */
export function answerChecks(d0: AnswerDraft, o: { recommended?: string; unit?: string; options?: string[]; question?: string; needs?: Record<string, string> }): Record<string, CriterionStatus> {
  // a draft written for another question answers nothing here, even when that question had the same option ids
  const d = o.question && d0.question && d0.question !== o.question ? { ...d0, option: undefined, reason: undefined, answer: '', detail: '', value: '', source: '', lasts: '' as const } : d0
  // a chosen option counts only while it is one of this question's options: a draft kept from an earlier question can
  // still hold that question's choice
  const chosen = !!d.option && d.option !== 'other' && (!o.options || o.options.includes(d.option))
  const text = d.answer.trim()
  const vague = (s: string) => /^(it depends|you decide|whatever|not sure|dunno|tbd|n\/?a)\.?$/i.test(s)
  const quantity = !o.unit || chosen || /\d/.test(d.value || text)
  // an option that needs a detail from the person resolves nothing until it is given (test-esp32 log #137)
  const detail = (d.detail ?? '').trim()
  const needed = chosen && !!o.needs?.[d.option!] && (detail.length < 3 || vague(detail))
  return {
    resolves: !needed && (chosen || (text.length >= 3 && !vague(text))) ? 'met' : 'not_met',
    units: quantity ? 'met' : 'not_met',
    // a source is asked for when the answer states a quantity the question asked for, not for any digit in a decision
    // ("allow the 2 fixes at J1")
    source: chosen || !o.unit || d.source.trim().length >= 3 || !/\d/.test(d.value || text) ? 'met' : 'not_met',
    requirement: d.lasts ? 'met' : 'not_met',
    reasons: d.option && o.recommended && d.option !== o.recommended && (d.reason ?? '').trim().length < 3 ? 'not_met' : 'met',
  }
}

/** `question`: the one to answer (its "Answer it" link names it: test-esp32 #107); without it, the oldest open one. */
export function QuestionAnswer({ repo, def, question }: { repo: string; def: SkillDef; question?: string | undefined }) {
  const s = useSkill<AnswerDraft>(repo, def, { done: [], answer: '', value: '', source: '', lasts: '' }, { question })
  const v = s.view.data
  const q = v?.question
  const d = s.draft.data
  const set = (p: Partial<AnswerDraft>) => s.draft.setData((x) => ({ ...x, ...p }))
  const answer = useCall('question.answer', (a) => [['journey.get', a.repo], ['inbox']])
  const options = useMemo<NonNullable<Question['options']>>(() => q?.options ?? (q?.recommended ? [q.recommended] : []), [q])
  // the draft is kept per project, not per question: a draft written for another question is dropped (two near-identical
  // questions share option ids, so its choice would look like this one's: test-esp32 #143), and a choice that is not
  // one of this question's options is dropped rather than sent (the record refuses it)
  const otherQuestion = !!q && !!d.question && d.question !== q.id
  const stale = otherQuestion || (!!q && !!d.option && d.option !== 'other' && !options.some((o) => o.id === d.option))
  useEffect(() => {
    if (otherQuestion) set({ question: q!.id, option: undefined, reason: undefined, answer: '', detail: '', value: '', source: '', lasts: '' })
    else if (stale) set({ option: undefined, reason: undefined })
  }, [stale, otherQuestion]) // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = !!d.option && d.option !== 'other' && !stale
  // the chosen option records a waiver in this person's name: say so beside the answer, as the option did
  const chosenWaiver = chosen ? options.find((o) => o.id === d.option)?.waiver : undefined
  const writing = !chosen
  const needsMap = Object.fromEntries(options.flatMap((o) => (o.needs ? [[o.id, o.needs]] : [])))
  const needs = chosen ? needsMap[d.option!] : undefined
  const local = answerChecks(d, { recommended: q?.recommended?.id, unit: q?.quantity?.unit, options: options.map((o) => o.id), needs: needsMap, ...(q ? { question: q.id } : {}) })
  const checks: QualityCheck[] = qualityChecks(def, v, local, s.goTo)

  // the answer's own fields: beside the work on wide screens, and in the page itself below that, so a phone never has to
  // find them behind a button
  const wide = useMediaQuery('(min-width: 1280px)')
  const fields = q ? (
          <>
            <div>
              <p className="text-xs text-muted-foreground">Chosen</p>
              <p className="mt-0.5">{chosen ? chosenWords(options.find((o) => o.id === d.option), d.detail?.trim() || undefined) : d.answer.trim() || <span className="text-muted-foreground">Nothing yet</span>}</p>
              {d.reason && <p className="mt-1 text-muted-foreground">Reason: {d.reason}</p>}
              {chosenWaiver && <WaiverNote text={chosenWaiver} />}
            </div>
            {needs && (
              <div className="space-y-1.5">
                <Label htmlFor="qa-detail">{needs.charAt(0).toUpperCase() + needs.slice(1)}</Label>
                <Input id="qa-detail" value={d.detail ?? ''} onChange={(e) => set({ detail: e.target.value })} placeholder="trace needs this from you to act on the answer" aria-required />
              </div>
            )}
            {q.quantity && writing && (
              <div className="space-y-1.5"><Label htmlFor="qa-value">Value ({q.quantity.unit})</Label><Input id="qa-value" inputMode="decimal" value={d.value} onChange={(e) => set({ value: e.target.value })} placeholder={`A number in ${q.quantity.unit}`} /></div>
            )}
            {q.quantity && writing && (
              <div className="space-y-1.5"><Label htmlFor="qa-source">Where the fact comes from</Label><Input id="qa-source" value={d.source} onChange={(e) => set({ source: e.target.value })} placeholder="Datasheet page, a measurement, a person" /></div>
            )}
            <fieldset>
              <legend className="mb-2 font-medium">Does it last?</legend>
              <RadioGroup value={d.lasts} onValueChange={(x) => set({ lasts: x as AnswerDraft['lasts'] })} className="gap-1.5">
                <Label className="flex items-center gap-2 font-normal"><RadioGroupItem value="once" /> Just this once</Label>
                <Label className="flex items-center gap-2 font-normal"><RadioGroupItem value="rule" /> A rule for the project <span className="text-muted-foreground">(added to the project's rules, which every agent follows)</span></Label>
                <Label className="flex items-center gap-2 font-normal"><RadioGroupItem value="requirement" /> It changes a requirement (goes through review)</Label>
              </RadioGroup>
            </fieldset>
          </>
  ) : null

  const aside = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-5 py-4"><h2 className="font-semibold">Your answer</h2></div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4 text-sm">
        {!q ? <p className="text-muted-foreground">{s.view.isLoading ? 'Loading the question…' : 'No question is open for you on this project.'}</p> : fields}
      </div>
    </div>
  )

  return (
    <FocusLayout
      title={def.name}
      context={s.context}
      variant="conversational"
      steps={s.steps}
      onStep={s.onStep}
      checks={checks}
      submitLabel={def.submit}
      onClose={s.close}
      outcome={s.outcome}
      draftSavedAt={s.draft.savedAt}
      aside={wide ? aside : undefined}
      onSubmit={() => s.submit(() => answer.mutateAsync({
        repo, question: q!.id,
        ...(chosen ? { option: d.option, ...(needs ? { answer: (d.detail ?? '').trim() } : {}) } : { answer: [d.value && q?.quantity ? `${d.value} ${q.quantity.unit}` : '', d.answer].filter(Boolean).join(': ') + (d.source ? ` (source: ${d.source})` : '') }),
        ...(d.reason ? { reason: d.reason } : {}),
        ...(d.lasts ? { lasts: d.lasts } : {}),
        // a rule for the project: trace itself adds it to .trace/rules.md through a change (src/api/rule-answers.ts)
      }), (r) => answeredWords(r as ResultOf<'question.answer'> | undefined))}
    >
      <StepHeader def={def} index={s.stepIndex} />
      {s.view.isError && <div className="mt-4"><QueryError error={s.view.error} what="the question" onRetry={() => void s.view.refetch()} /></div>}
      {!q && !s.view.isLoading && <EmptyState className="mt-4">No question is waiting on you here. Questions appear on Home and in Next when an agent asks one.</EmptyState>}
      {q && (
        <div className="mt-4 space-y-4">
          {q.outOfDate && <OutOfDateNote why={q.outOfDate} />}
          <div className="rounded-xl border p-5 text-sm">
            <p className="text-lg font-medium">{q.text}</p>
            {q.context && <p className="mt-2">{q.context}</p>}
            {q.blocks && <p className="mt-1 text-muted-foreground">It blocks {q.blocks}.</p>}
            {q.searched?.length ? (
              <div className="mt-3"><p className="text-xs text-muted-foreground">What it already looked at</p><div className="mt-1 flex flex-wrap gap-1.5">{q.searched.map((e, i) => <EvidenceChip key={i} evidence={e} />)}</div></div>
            ) : null}
          </div>
          {q.recommended && options.length > 0 && (
            <DecisionCard
              decision={{ recommended: q.recommended.id, options: [...options, { id: 'other', label: 'Other answer', detail: 'Write your own', free: true }], evidence: q.sources, blocks: q.blocks }}
              chosen={d.option && !stale ? { option: d.option, recommended: d.option === q.recommended.id, reason: d.reason, ...(needs ? (d.detail?.trim() ? { answer: d.detail.trim() } : {}) : d.answer ? { answer: d.answer } : {}) } : undefined}
              onChoose={(c) => {
                // the detail an option needs is kept apart from an answer in the person's own words
                const asks = !!needsMap[c.option]
                set({ question: q.id, option: c.option, reason: c.reason, ...(asks ? { detail: c.answer ?? '' } : c.answer ? { answer: c.answer } : {}) })
                if (s.stepIndex < 2) s.goTo(c.option === 'other' || asks ? 'specific' : 'lasts')
              }}
            />
          )}
          {d.option && !stale && <Button variant="ghost" size="sm" onClick={() => set({ option: undefined, reason: undefined })}>Choose again</Button>}
          {(d.option === 'other' || !q.recommended) && (
            <div className="space-y-1.5"><Label htmlFor="qa-answer">Your answer</Label><Textarea id="qa-answer" rows={3} value={d.answer} onChange={(e) => set({ question: q.id, answer: e.target.value })} placeholder={'Specific enough to unblock the agent: not "it depends"'} /></div>
          )}
          {!wide && <section className="space-y-5 rounded-xl border p-5 text-sm" aria-label="Your answer"><h2 className="font-semibold">Your answer</h2>{fields}</section>}
          <div className="h-[360px] overflow-hidden rounded-xl border"><EmbeddedChat repo={repo} title="Ask trace about this question" placeholder="Why does it recommend that? Where did it look?" /></div>
        </div>
      )}
      {s.stepIndex < def.steps.length - 1 && <div className="mt-6 flex justify-end"><Button variant="outline" onClick={s.next}>Continue to {def.steps[s.stepIndex + 1]!.title.toLowerCase()} <ArrowRight /></Button></div>}
      <div className="mt-4"><Unavailable checks={s.view.data?.checks} def={def} draft={s.draft as unknown as Confirmable} /></div>
    </FocusLayout>
  )
}
