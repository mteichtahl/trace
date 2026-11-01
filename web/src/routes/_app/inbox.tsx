/**
 * Inbox (docs/ui-design.md, "Notifications"): the four kinds only — a gate is ready, an agent is stuck, a question
 * blocks work, money is about to be spent — each the same item that sits on Home and in the bell. Acted on in place:
 * a question with a recommendation answers in one tap; Other answer opens the Decision card, which asks for a reason
 * when the answer is not the recommendation (question.answer). Answering here clears it everywhere: the item leaves
 * the inbox cache at once, and the live connection's notification and journey events refetch every other screen. A
 * stuck agent's report can be dismissed with a reason in one line (stuck.dismiss), which the agent reads.
 * The phone's fourth tab.
 */
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { DecisionCard, type Decision, type DecisionChoice } from '@/components/decision-card'
import { NeedsYouCard } from '@/components/needs-you-card'
import { useAcceptFromInbox } from '@/components/changes/use-change-actions'
import { useDismissStuck } from '@/components/dismiss-stuck'
import { Column, Section } from '@/components/shell/app-shell'
import { useCommands } from '@/components/shell/command-menu'
import { EmptyState, Loading, QueryError, SkeletonRows } from '@/components/states'
import { useTraceContext } from '@/components/chat/context'
import { useMediaQuery } from '@/hooks/use-media-query'
import { call } from '@/lib/api'
import { useLiveStatus } from '@/lib/live'
import { q, useInbox } from '@/lib/queries'
import type { InboxItem, InboxKind, Journey } from '@/lib/types'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/inbox')({
  staticData: { crumb: 'Inbox' },
  component: Inbox,
})

export const INBOX_KINDS: InboxKind[] = ['gate', 'question', 'spend', 'stuck', 'review']
export const KIND_WORDS: Record<InboxKind, string> = { gate: 'Gates ready', question: 'Questions', spend: 'Spend', stuck: 'Agents stuck', review: 'Changes to review' }

/** The kinds that need a person (the four that earn a notification, and trace's changes to review), most blocking and oldest first (the API's order is kept). */
export function inboxItems(items: InboxItem[] | undefined): InboxItem[] {
  return (items ?? []).filter((i) => INBOX_KINDS.includes(i.kind))
}

/** The Decision card for a question: the recommendation first, then the question's other options, then Other answer. */
export function decisionFor(item: InboxItem, journey?: Journey): Decision {
  const qn = journey?.questions.find((x) => x.id === item.questionId)
  const rec = item.recommended ?? qn?.recommended
  const opts = (qn?.options ?? []).filter((o) => o.id !== rec?.id)
  return {
    question: qn?.text ?? item.summary.replace(/\*\*/g, ''),
    recommended: rec?.id ?? '__other',
    options: [...(rec ? [{ id: rec.id, label: rec.label }] : []), ...opts.map((o) => ({ id: o.id, label: o.label })), { id: '__other', label: 'Other answer', detail: 'In your own words', free: true }],
    evidence: item.sources ?? qn?.sources,
    blocks: item.blocks ?? qn?.blocks,
  }
}

function Inbox() {
  const inbox = useInbox()
  const qc = useQueryClient()
  const phone = useMediaQuery('(max-width: 767px)')
  const live = useLiveStatus()
  const [answering, setAnswering] = useState<string | null>(null)
  const dismiss = useDismissStuck()
  const accept = useAcceptFromInbox()
  const [busy, setBusy] = useState<string | null>(null)
  const items = useMemo(() => inboxItems(inbox.data), [inbox.data])
  const qRepos = [...new Set(items.filter((i) => i.kind === 'question').map((i) => i.repo))]
  const journeys = useQueries({ queries: qRepos.map((repo) => ({ ...q('journey.get', { repo }), enabled: !!answering })) })
  const journeyOf = (repo: string) => journeys[qRepos.indexOf(repo)]?.data
  const offline = live.state === 'offline'

  useTraceContext({ label: 'Inbox', description: 'The screen the person is on: their notifications (gates ready, questions, spend, stuck agents)', value: { count: items.length, kinds: items.map((i) => i.kind) } }, 'screen')
  useCommands(items.filter((i) => i.kind === 'question' && i.recommended).map((i) => ({ id: `answer-${i.id}`, label: `${i.project}: ${i.recommended!.label}`, group: 'Inbox', keywords: ['answer', 'question'], run: () => void answer(i, { option: i.recommended!.id, recommended: true }) })))

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
      toast(r.summary || 'Answered. The agent carries on.')
    } catch (e) {
      toast.error(`Could not send the answer: ${e instanceof Error ? e.message : String(e)}. Your answer is kept; try again.`)
      throw e
    } finally {
      setBusy(null)
    }
  }

  const groups = INBOX_KINDS.map((k) => ({ kind: k, items: items.filter((i) => i.kind === k) })).filter((g) => g.items.length)

  return (
    <Column>
      <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        trace tells you about a gate that is ready, a question that blocks work, money about to be spent, an agent that is stuck, and a change it made for you to review. Acting here clears it everywhere.
      </p>
      {offline && <p className="mt-3 text-sm text-muted-foreground">You are offline: answers wait until you are back, and gates and spending cannot be approved offline.</p>}
      <div className="mt-6">
        {inbox.isError ? (
          <QueryError error={inbox.error} what="your inbox" onRetry={() => void inbox.refetch()} />
        ) : inbox.isLoading ? (
          <Loading><SkeletonRows rows={3} /></Loading>
        ) : !items.length ? (
          <EmptyState>Nothing needs you. trace will tell you when something does.</EmptyState>
        ) : (
          groups.map((g) => (
            <Section key={g.kind} label={KIND_WORDS[g.kind]} count={g.items.length} className="mt-8 first:mt-0">
              <div className="space-y-3">
                {g.items.map((i) => (
                  <div key={i.id} className={cn(answering === i.id && 'rounded-2xl ring-2 ring-primary/30')}>
                    <NeedsYouCard
                      item={i}
                      compact={phone}
                      answering={busy === i.id}
                      onAnswer={offline ? undefined : (it) => void answer(it, { option: it.recommended!.id, recommended: true }).catch(() => undefined)}
                      onOther={(it) => setAnswering(answering === it.id ? null : it.id)}
                      onDismiss={offline ? undefined : dismiss}
                      onAccept={offline ? undefined : accept.run}
                      accepting={accept.busy === i.id}
                    />
                    {answering === i.id && (
                      <DecisionCard
                        className="mt-2"
                        decision={decisionFor(i, journeyOf(i.repo))}
                        detail="full"
                        onChoose={(c) => answer(i, c)}
                      />
                    )}
                  </div>
                ))}
              </div>
            </Section>
          ))
        )}
      </div>
    </Column>
  )
}
