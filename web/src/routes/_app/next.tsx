/**
 * Next (was Inbox; docs/ui-design.md, "Notifications"): the four kinds only — a gate is ready, an agent is stuck, a question
 * blocks work, money is about to be spent — each the same item that sits on Home and in the bell. Acted on in place:
 * a question with a recommendation answers in one tap; Other answer opens the Decision card, which asks for a reason
 * when the answer is not the recommendation (question.answer). Answering here clears it everywhere: the item leaves
 * the inbox cache at once, and the live connection's notification and journey events refetch every other screen. A
 * stuck agent's report can be dismissed with a reason in one line (stuck.dismiss), which the agent reads.
 * One card at a time: the first item large, with its one-tap answer, Other answer and Later; the rest under Up next,
 * any of which can be brought to the front. Later moves an item to the back of this visit's queue (nothing is sent).
 * The phone's fourth tab.
 */
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { DecisionCard, type Decision, type DecisionChoice } from '@/components/decision-card'
import { KIND, NeedsYouCard } from '@/components/needs-you-card'
import { offerPush } from '@/components/push-prompt'
import { Rich } from '@/components/rich'
import { Button } from '@/components/ui/button'
import { useAcceptFromInbox } from '@/components/changes/use-change-actions'
import { useDismissStuck } from '@/components/dismiss-stuck'
import { Column, Section } from '@/components/shell/app-shell'
import { useCommands } from '@/components/shell/command-menu'
import { EmptyState, Loading, QueryError, SkeletonRows } from '@/components/states'
import { useTraceContext } from '@/components/chat/context'
import { useMediaQuery } from '@/hooks/use-media-query'
import { call } from '@/lib/api'
import { plural, waited } from '@/lib/format'
import { useLiveStatus } from '@/lib/live'
import { q, useInbox } from '@/lib/queries'
import type { InboxItem, InboxKind, Journey } from '@/lib/types'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/next')({
  staticData: { crumb: 'Next' },
  // a tapped notification opens its item at the front (src/web/push-sender.ts messageFor)
  validateSearch: (s: Record<string, unknown>): { item?: string } => (typeof s.item === 'string' && s.item.length < 200 ? { item: s.item } : {}),
  component: Next,
})

export const INBOX_KINDS: InboxKind[] = ['gate', 'question', 'spend', 'stuck', 'review', 'renders']
export const KIND_WORDS: Record<InboxKind, string> = { gate: 'Gates ready', question: 'Questions', spend: 'Spend', stuck: 'Agents stuck', review: 'Changes to review', renders: 'Renders ready' }

/** The kinds that need a person (the four that earn a notification, and trace's changes to review), most blocking and oldest first (the API's order is kept). */
export function inboxItems(items: InboxItem[] | undefined): InboxItem[] {
  return (items ?? []).filter((i) => INBOX_KINDS.includes(i.kind))
}

/** The Decision card for a question: the recommendation first, then the question's other options, then Other answer. */
export function decisionFor(item: InboxItem, journey?: Journey): Decision {
  const qn = journey?.questions.find((x) => x.id === item.questionId)
  const rec = item.recommended ?? qn?.recommended
  const opts = (qn?.options ?? []).filter((o) => o.id !== rec?.id)
  const waiverOf = (id: string) => { const w = qn?.options?.find((o) => o.id === id)?.waiver; return w ? { waiver: w } : {} }
  return {
    question: qn?.text ?? item.summary.replace(/\*\*/g, ''),
    recommended: rec?.id ?? '__other',
    // an option that waives says so before it is chosen: the answer records the waiver in the person's name
    options: [
      ...(rec ? [{ id: rec.id, label: rec.label, ...waiverOf(rec.id) }] : []), ...opts.map((o) => ({ id: o.id, label: o.label, ...waiverOf(o.id) })),
      { id: '__other', label: 'Other answer', detail: 'In your own words', free: true },
    ],
    evidence: item.sources ?? qn?.sources,
    blocks: item.blocks ?? qn?.blocks,
  }
}


/** This visit's order over the API's: ids in `order` first, in that order, then items that arrived since, as the API sorts them. */
export function queueOrder(items: InboxItem[], order: string[]): InboxItem[] {
  if (!order.length) return items
  const pos = new Map(order.map((id, i) => [id, i]))
  const known = items.filter((i) => pos.has(i.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!)
  return [...known, ...items.filter((i) => !pos.has(i.id))]
}

function Next() {
  const inbox = useInbox()
  const qc = useQueryClient()
  const phone = useMediaQuery('(max-width: 767px)')
  const live = useLiveStatus()
  const [answering, setAnswering] = useState<string | null>(null)
  const dismiss = useDismissStuck()
  const accept = useAcceptFromInbox()
  const [busy, setBusy] = useState<string | null>(null)
  // this visit's order: Later sends an item to the back, Up next brings one to the front
  const { item: opened } = Route.useSearch()
  const [order, setOrder] = useState<string[]>(() => (opened ? [opened] : []))
  const items = useMemo(() => queueOrder(inboxItems(inbox.data), order), [inbox.data, order])
  const qRepos = [...new Set(items.filter((i) => i.kind === 'question').map((i) => i.repo))]
  const journeys = useQueries({ queries: qRepos.map((repo) => ({ ...q('journey.get', { repo }), enabled: !!answering })) })
  const journeyOf = (repo: string) => journeys[qRepos.indexOf(repo)]?.data
  const offline = live.state === 'offline'
  const [first, ...rest] = items
  const later = (id: string) => setOrder([...items.map((i) => i.id).filter((x) => x !== id), id])
  const bringForward = (id: string) => { setAnswering(null); setOrder([id, ...items.map((i) => i.id).filter((x) => x !== id)]) }

  useTraceContext({ label: 'Next', description: 'The screen the person is on: what needs them next (gates ready, questions, spend, stuck agents, changes to review), one at a time', value: { count: items.length, kinds: items.map((i) => i.kind), current: first?.summary ?? null } }, 'screen')
  useCommands(items.filter((i) => i.kind === 'question' && i.recommended).map((i) => ({ id: `answer-${i.id}`, label: `${i.project}: ${i.recommended!.label}`, group: 'Next', keywords: ['answer', 'question'], run: () => void answer(i, { option: i.recommended!.id, recommended: true }) })))

  const answer = async (item: InboxItem, c: DecisionChoice) => {
    if (!item.questionId) return
    setBusy(item.id)
    try {
      const own = c.option === '__other'
      const r = await call('question.answer', { repo: item.repo, question: item.questionId, ...(own ? { answer: c.answer } : { option: c.option }), ...(c.reason ? { reason: c.reason } : {}) })
      // cleared here at once; the live event refetches Home, the bell and the project everywhere else
      qc.setQueryData<InboxItem[]>(['inbox', {}], (xs) => xs?.filter((x) => x.id !== item.id))
      void qc.invalidateQueries({ queryKey: ['inbox'] })
      void qc.invalidateQueries({ queryKey: ['journey.get', item.repo] })
      setAnswering(null)
      const left = items.length - 1
      toast(r.summary || 'Answered. The agent carries on.', { description: left > 0 ? `${plural(left, 'more thing')} ${left === 1 ? 'needs' : 'need'} you.` : 'That was the last one. Nothing else needs you.' })
    } catch (e) {
      toast.error(`Could not send the answer: ${e instanceof Error ? e.message : String(e)}. Your answer is kept; try again.`)
      throw e
    } finally {
      setBusy(null)
    }
  }

  return (
    <Column>
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Next</h1>
        {items.length > 0 && <p className="text-sm text-muted-foreground">{items.length === 1 ? 'Just this one' : `1 of ${items.length} for you`}</p>}
      </div>
      {items.length > 1 && (
        <div className="mt-3 flex gap-1" aria-hidden>
          {items.slice(0, 12).map((i, n) => <span key={i.id} className={cn('h-1 flex-1 rounded-full', n === 0 ? 'bg-primary' : 'bg-muted')} />)}
        </div>
      )}
      {!phone && <p className="mt-3 text-sm text-muted-foreground">What needs you, one at a time: a gate that is ready, a question that blocks work, money about to be spent, an agent that is stuck, changes trace made for you to review, and a revision's renders when they are ready. Acting here clears it everywhere.</p>}
      {offline && <p className="mt-3 text-sm text-muted-foreground">You are offline: answers wait until you are back, and gates and spending cannot be approved offline.</p>}
      <div className="mt-6">
        {inbox.isError ? (
          <QueryError error={inbox.error} what="what needs you" onRetry={() => void inbox.refetch()} />
        ) : inbox.isLoading ? (
          <Loading><SkeletonRows rows={3} /></Loading>
        ) : !first ? (
          <EmptyState>All clear. Nothing needs you; trace will tell you when something does.</EmptyState>
        ) : (
          <>
            <div className={cn('rounded-xl shadow-sm', answering === first.id && 'ring-2 ring-primary/30')}>
              <NeedsYouCard
                item={first}
                answering={busy === first.id}
                onAnswer={offline ? undefined : (it) => void answer(it, { option: it.recommended!.id, recommended: true }).then(() => offerPush(), () => undefined)}
                onOther={(it) => setAnswering(answering === it.id ? null : it.id)}
                onDismiss={offline ? undefined : dismiss}
                onAccept={offline ? undefined : accept.run}
                accepting={accept.busy === first.id}
              />
            </div>
            {answering === first.id && (
              <DecisionCard className="mt-2" decision={decisionFor(first, journeyOf(first.repo))} detail="full" onChoose={(c) => answer(first, c)} />
            )}
            {rest.length > 0 && (
              <Button variant="ghost" className="mt-2 h-11 w-full text-muted-foreground" onClick={() => later(first.id)}>
                Later: show me the next one
              </Button>
            )}
            {rest.length > 0 && (
              <Section label="Up next" count={rest.length} className="mt-8">
                <ul className="divide-y overflow-hidden rounded-xl border">
                  {rest.map((i) => (
                    <li key={i.id}>
                      <button type="button" onClick={() => bringForward(i.id)} className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent">
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs text-muted-foreground">{[i.project, KIND[i.kind], waited(i.createdAt)].filter(Boolean).join(' · ')}</span>
                          <span className="mt-0.5 line-clamp-2 block text-sm"><Rich text={i.summary} terms={false} /></span>
                        </span>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </>
        )}
      </div>
    </Column>
  )
}
