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
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { FOCUS_AGENT_ID } from '@/components/chat/agent'
import { EmbeddedChat } from '@/components/chat/embedded-chat'
import { DecisionCard } from '@/components/decision-card'
import { EvidenceChip } from '@/components/evidence-chip'
import { FocusLayout } from '@/components/focus/focus-layout'
import type { QualityCheck } from '@/components/quality-bar'
import { Rich } from '@/components/rich'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState, QueryError } from '@/components/states'
import { call } from '@/lib/api'
import { useCall } from '@/lib/queries'
import type { CriterionStatus } from '@/lib/types'
import type { IntentDraft, IntentStatement } from '@/lib/types-s1'
import { cn } from '@/lib/utils'
import type { SkillDef } from './definitions'
import { StepHeader, Unavailable } from './parts'
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
export interface IntentDecision { statement: string; choice: 'accept' | 'edit' | 'reject'; text?: string; reason?: string }
interface IntentLocal extends SkillDraftBase { topic?: number; decisions?: IntentDecision[] }

/** The draft with one statement's decision replaced, or removed (null). Pure. */
export function withIntentDecision<D extends { decisions?: IntentDecision[] }>(d: D, statement: string, decision: Omit<IntentDecision, 'statement'> | null): D {
  const rest = (d.decisions ?? []).filter((x) => x.statement !== statement)
  return { ...d, decisions: decision ? [...rest, { statement, ...decision }] : rest }
}

const DECIDED_WORD: Record<IntentDecision['choice'], string> = { accept: 'Accepting', edit: 'Rewording', reject: 'Rejecting' }

/**
 * One statement in the Draft intent panel, with the person's decision on it: Accept as worded, Edit (in their own
 * words) or Reject (with a line why). The decision goes into the draft; the quality bar (skill.get, the draft laid over
 * the record) moves with it, and Submit intent records it. Statements left undecided are accepted at Submit.
 */
function IntentStatementRow({ st, decision, onDecide }: { st: IntentStatement; decision?: IntentDecision; onDecide: (d: Omit<IntentDecision, 'statement'> | null) => void }) {
  const [mode, setMode] = useState<'edit' | 'reject' | null>(null)
  const [words, setWords] = useState('')
  const ok = words.trim().length >= 3
  const done = () => { setMode(null); setWords('') }
  return (
    <li className="space-y-1.5 text-sm">
      <div className="flex items-start justify-between gap-3">
        <span>{decision?.choice === 'edit' && decision.text ? decision.text : st.text}</span>
        <StatusBadge status={STATE_WORD[st.state].status} label={st.flag ?? STATE_WORD[st.state].label} className="shrink-0" />
      </div>
      {mode ? (
        <div className="flex flex-wrap items-center gap-2">
          <Label className="sr-only" htmlFor={`intent-${st.id}`}>{mode === 'edit' ? `Statement ${st.id} in your words` : `Why ${st.id} is rejected`}</Label>
          <Input id={`intent-${st.id}`} className="h-8 min-w-0 flex-1" autoFocus placeholder={mode === 'edit' ? 'The statement in your words' : 'Why it is rejected'} value={words} onChange={(e) => setWords(e.target.value)} />
          <Button size="sm" variant="outline" disabled={!ok} onClick={() => { onDecide(mode === 'edit' ? { choice: 'edit', text: words.trim() } : { choice: 'reject', reason: words.trim() }); done() }}>{mode === 'edit' ? 'Save' : 'Reject'}</Button>
          <Button size="sm" variant="ghost" onClick={done}>Cancel</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          {decision && <span className="mr-1 text-muted-foreground">{DECIDED_WORD[decision.choice]} in your draft</span>}
          {decision ? (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => onDecide(null)}>Undo</Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" aria-label={`Accept ${st.id}`} onClick={() => onDecide({ choice: 'accept' })}>Accept</Button>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" aria-label={`Edit ${st.id}`} onClick={() => { setMode('edit'); setWords(st.text) }}>Edit</Button>
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
      submitLabel={def.submit}
      onSubmit={() => s.submit(async () => {
        // Submit starts the Verification agent drafting the candidate requirements (skill.submit); say whether it did
        const r = await call('skill.submit', { repo, skill: def.id, draft: s.draft.data as unknown as Record<string, unknown> }) as { jobId?: string; jobError?: string }
        if (r.jobError) toast.warning('trace could not start drafting the requirements.', { description: `${r.jobError} Ask trace to draft them from the intent.` })
        else toast('trace is drafting the candidate requirements for Requirements review.')
      }, 'Intent submitted.')}
      onClose={s.close}
      draftSavedAt={s.draft.savedAt}
      aside={aside}
    >
      <div className="flex items-center gap-3 border-b px-4 py-3 md:px-6">
        <span className="font-semibold">{t.title}</span>
        <span className="text-sm text-muted-foreground">Topic {topic + 1} of {def.steps.length}</span>
      </div>
      <EmbeddedChat
        repo={repo}
        title={`Intent builder · ${t.title}`}
        placeholder="Answer, or ask trace a question…"
        intro={
          <div className="mx-auto max-w-[680px] space-y-4 text-sm">
            <p><Rich text={v?.summary ?? `Let's write the intent, one topic at a time. First, **${t.title.toLowerCase()}**: ${t.detail.charAt(0).toLowerCase()}${t.detail.slice(1)}`} /></p>
            {v?.recommendation && <DecisionCard decision={v.recommendation} onChoose={() => undefined} />}
            {s.view.isError && <QueryError error={s.view.error} what="the intent draft" onRetry={() => void s.view.refetch()} />}
          </div>
        }
      />
      <div className="mt-4"><Unavailable checks={s.view.data?.checks} def={def} /></div>
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
  option?: string
  reason?: string
  answer: string
  value: string
  source: string
  lasts: 'once' | 'rule' | 'requirement' | ''
}

/** The question-answer bar, from the draft. Pure. */
export function answerChecks(d: AnswerDraft, o: { recommended?: string; unit?: string }): Record<string, CriterionStatus> {
  const chosen = !!d.option && d.option !== 'other'
  const text = d.answer.trim()
  const vague = /^(it depends|you decide|whatever|not sure|dunno)\.?$/i.test(text)
  const quantity = !o.unit || chosen || /\d/.test(d.value || text)
  return {
    resolves: chosen || (text.length >= 3 && !vague) ? 'met' : 'not_met',
    units: quantity ? 'met' : 'not_met',
    source: chosen || d.source.trim().length >= 3 || !/\d/.test(text) ? 'met' : 'not_met',
    requirement: d.lasts ? 'met' : 'not_met',
    reasons: d.option && o.recommended && d.option !== o.recommended && (d.reason ?? '').trim().length < 3 ? 'not_met' : 'met',
  }
}

export function QuestionAnswer({ repo, def }: { repo: string; def: SkillDef }) {
  const s = useSkill<AnswerDraft>(repo, def, { done: [], answer: '', value: '', source: '', lasts: '' })
  const v = s.view.data
  const q = v?.question
  const d = s.draft.data
  const set = (p: Partial<AnswerDraft>) => s.draft.setData((x) => ({ ...x, ...p }))
  const answer = useCall('question.answer', (a) => [['journey.get', a.repo], ['inbox']])
  const local = answerChecks(d, { recommended: q?.recommended?.id, unit: q?.quantity?.unit })
  const checks: QualityCheck[] = qualityChecks(def, v, local, s.goTo)
  const options = useMemo(() => q?.options ?? (q?.recommended ? [q.recommended] : []), [q])

  const aside = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-5 py-4"><h2 className="font-semibold">Your answer</h2></div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4 text-sm">
        {!q ? <p className="text-muted-foreground">{s.view.isLoading ? 'Loading the question…' : 'No question is open for you on this project.'}</p> : (
          <>
            <div>
              <p className="text-xs text-muted-foreground">Chosen</p>
              <p className="mt-0.5">{d.option && d.option !== 'other' ? options.find((o) => o.id === d.option)?.label : d.answer || <span className="text-muted-foreground">Nothing yet</span>}</p>
              {d.reason && <p className="mt-1 text-muted-foreground">Reason: {d.reason}</p>}
            </div>
            {q.quantity && d.option === 'other' && (
              <div className="space-y-1.5"><Label htmlFor="qa-value">Value ({q.quantity.unit})</Label><Input id="qa-value" inputMode="decimal" value={d.value} onChange={(e) => set({ value: e.target.value })} placeholder={`A number in ${q.quantity.unit}`} /></div>
            )}
            {d.option === 'other' && (
              <div className="space-y-1.5"><Label htmlFor="qa-source">Where the fact comes from</Label><Input id="qa-source" value={d.source} onChange={(e) => set({ source: e.target.value })} placeholder="Datasheet page, a measurement, a person" /></div>
            )}
            <fieldset>
              <legend className="mb-2 font-medium">Does it last?</legend>
              <RadioGroup value={d.lasts} onValueChange={(x) => set({ lasts: x as AnswerDraft['lasts'] })} className="gap-1.5">
                <Label className="flex items-center gap-2 font-normal"><RadioGroupItem value="once" /> Just this once</Label>
                <Label className="flex items-center gap-2 font-normal"><RadioGroupItem value="rule" /> A rule for the project</Label>
                <Label className="flex items-center gap-2 font-normal"><RadioGroupItem value="requirement" /> It changes a requirement (goes through review)</Label>
              </RadioGroup>
            </fieldset>
          </>
        )}
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
      draftSavedAt={s.draft.savedAt}
      aside={aside}
      onSubmit={() => s.submit(() => answer.mutateAsync({
        repo, question: q!.id,
        ...(d.option && d.option !== 'other' ? { option: d.option } : { answer: [d.value && q?.quantity ? `${d.value} ${q.quantity.unit}` : '', d.answer].filter(Boolean).join(': ') + (d.source ? ` (source: ${d.source})` : '') }),
        ...(d.reason ? { reason: d.reason } : {}),
      }).then(() => d.lasts === 'rule' ? call('task', { repo, request: `Add a project rule from the answer to "${q!.text}".` }) : undefined), 'Answered. The agent continues.')}
    >
      <StepHeader def={def} index={s.stepIndex} />
      {s.view.isError && <div className="mt-4"><QueryError error={s.view.error} what="the question" onRetry={() => void s.view.refetch()} /></div>}
      {!q && !s.view.isLoading && <EmptyState className="mt-4">No question is waiting on you here. Questions appear on Home and in the Inbox when an agent asks one.</EmptyState>}
      {q && (
        <div className="mt-4 space-y-4">
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
              decision={{ recommended: q.recommended.id, options: [...options, { id: 'other', label: 'Other answer', detail: 'Write your own' }], evidence: q.sources, blocks: q.blocks }}
              chosen={d.option ? { option: d.option, recommended: d.option === q.recommended.id, reason: d.reason } : undefined}
              onChoose={(c) => { set({ option: c.option, reason: c.reason }); if (s.stepIndex < 2) s.goTo(c.option === 'other' ? 'specific' : 'lasts') }}
            />
          )}
          {d.option && <Button variant="ghost" size="sm" onClick={() => set({ option: undefined, reason: undefined })}>Choose again</Button>}
          {(d.option === 'other' || !q.recommended) && (
            <div className="space-y-1.5"><Label htmlFor="qa-answer">Your answer</Label><Textarea id="qa-answer" rows={3} value={d.answer} onChange={(e) => set({ answer: e.target.value })} placeholder={'Specific enough to unblock the agent: not "it depends"'} /></div>
          )}
          <div className="h-[360px] overflow-hidden rounded-xl border"><EmbeddedChat repo={repo} title="Ask trace about this question" placeholder="Why does it recommend that? Where did it look?" /></div>
        </div>
      )}
      {s.stepIndex < def.steps.length - 1 && <div className="mt-6 flex justify-end"><Button variant="outline" onClick={s.next}>Continue to {def.steps[s.stepIndex + 1]!.title.toLowerCase()} <ArrowRight /></Button></div>}
      <div className="mt-4"><Unavailable checks={s.view.data?.checks} def={def} /></div>
    </FocusLayout>
  )
}
