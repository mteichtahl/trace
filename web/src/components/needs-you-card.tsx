/**
 * One item that needs the person (Home, Inbox, the bell): the project and stage as small text, the summary, how long
 * it has waited, and one primary button. A question with a clear recommendation shows the recommended answer as its
 * own button ("Use 4.2 A") with "Other answer" beside it, so most questions are answered in one tap. A stuck agent's
 * report can be dismissed with a reason in one line (onDismiss: stuck.dismiss).
 */
import { Link } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DismissStuck } from '@/components/dismiss-stuck'
import { EvidenceChip } from '@/components/evidence-chip'
import { PullStatusLine } from '@/components/pull-status'
import { Rich } from '@/components/rich'
import { waited } from '@/lib/format'
import type { InboxItem } from '@/lib/types'
import { cn } from '@/lib/utils'

const KIND: Record<InboxItem['kind'], string> = { gate: 'Gate ready', question: 'Question', spend: 'Spend', stuck: 'Agent stuck', review: 'Pull request' }

export interface NeedsYouCardProps {
  item: InboxItem
  /** answer with the recommended option, in one tap */
  onAnswer?: (item: InboxItem) => void
  answering?: boolean
  /** "Other answer": opens Question answer */
  onOther?: (item: InboxItem) => void
  /** a stuck report: dismiss it with a reason (useDismissStuck); absent: no Dismiss */
  onDismiss?: (item: InboxItem, reason: string) => Promise<void>
  compact?: boolean
  className?: string
}

export function NeedsYouCard({ item, onAnswer, answering, onOther, onDismiss, compact, className }: NeedsYouCardProps) {
  const stuck = item.kind === 'stuck'
  const meta = [item.project, item.revision, item.stage, KIND[item.kind], compact ? waited(item.createdAt) : `waiting ${waited(item.createdAt)}`].filter(Boolean).join(' · ')
  const chips = [...(item.sources ?? []), ...(item.blocks ? [{ kind: 'record' as const, label: `Blocks: ${item.blocks}` }] : [])]
  return (
    <article className={cn('flex flex-col gap-4 rounded-xl border bg-card p-5 sm:flex-row sm:items-start', compact && 'p-4', className)} data-density-item>
      <span className={cn('mt-1.5 hidden size-2 shrink-0 rounded-full sm:block', stuck ? 'bg-warning' : 'bg-primary')} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className={cn('size-2 shrink-0 rounded-full sm:hidden', stuck ? 'bg-warning' : 'bg-primary')} aria-hidden />
          <span className="sr-only">{stuck ? 'Agent stuck. ' : 'Your move. '}</span>
          {meta}
        </p>
        <p className={cn('mt-1.5 text-[15px] leading-relaxed', compact && 'text-sm')}>
          <Rich text={item.summary} />
        </p>
        {!compact && chips.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {chips.map((c, i) => (
              <EvidenceChip key={i} evidence={c} />
            ))}
          </div>
        )}
        {item.pull && <PullStatusLine repo={item.pull.repo} number={item.pull.number} className="mt-2" />}
        {stuck && onDismiss && item.questionId && <DismissStuck item={item} onDismiss={onDismiss} className="mt-3" />}
      </div>
      {/* a long recommended answer wraps inside its button, the buttons capped at 40 % of the card, so the question keeps the room */}
      <div className="flex gap-2 max-sm:[&>*]:flex-1 sm:max-w-[40%] sm:shrink-0 sm:flex-wrap sm:justify-end">
        {item.recommended && onAnswer ? (
          <>
            <Button size={compact ? 'sm' : 'lg'} className="h-auto min-h-10 max-w-full py-2 text-left whitespace-normal" onClick={() => onAnswer(item)} disabled={answering}>
              {answering && <Loader2 className="animate-spin" />}
              {item.recommended.label}
            </Button>
            <Button size={compact ? 'sm' : 'lg'} variant="outline" onClick={() => onOther?.(item)} asChild={!onOther && !!item.action.to}>
              {!onOther && item.action.to ? <Link to={item.action.to}>Other answer</Link> : 'Other answer'}
            </Button>
          </>
        ) : (
          <Button size={compact ? 'sm' : 'lg'} variant={stuck ? 'outline' : 'default'} asChild={!!item.action.to || !!item.action.href}>
            {item.action.to ? <Link to={item.action.to}>{item.action.label}</Link>
              : item.action.href ? <a href={item.action.href} target="_blank" rel="noreferrer">{item.action.label}</a>
              : <span>{item.action.label}</span>}
          </Button>
        )}
      </div>
    </article>
  )
}
