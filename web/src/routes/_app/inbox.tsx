/** Inbox: every notification (the four kinds), each the same item that sits on Home. The phone's fourth tab. */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { NeedsYouCard } from '@/components/needs-you-card'
import { Column } from '@/components/shell/app-shell'
import { EmptyState, Loading, QueryError, SkeletonRows } from '@/components/states'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useCall, useInbox } from '@/lib/queries'

export const Route = createFileRoute('/_app/inbox')({
  staticData: { crumb: 'Inbox' },
  component: Inbox,
})

function Inbox() {
  const inbox = useInbox()
  const navigate = useNavigate()
  const phone = useMediaQuery('(max-width: 767px)')
  const answer = useCall('question.answer', (a) => [['inbox'], ['journey.get', a.repo]])
  return (
    <Column>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Inbox</h1>
      {inbox.isError ? (
        <QueryError error={inbox.error} what="your inbox" onRetry={() => void inbox.refetch()} />
      ) : inbox.isLoading ? (
        <Loading>
          <SkeletonRows rows={3} />
        </Loading>
      ) : !inbox.data?.length ? (
        <EmptyState>Nothing needs you. trace will tell you when something does.</EmptyState>
      ) : (
        <div className="space-y-3">
          {inbox.data.map((i) => (
            <NeedsYouCard
              key={i.id}
              item={i}
              compact={phone}
              answering={answer.isPending && answer.variables?.question === i.questionId}
              onAnswer={(it) =>
                it.questionId && it.recommended &&
                answer.mutate({ repo: it.repo, question: it.questionId, option: it.recommended.id }, { onSuccess: () => toast(`Answered: ${it.recommended!.label}`) })
              }
              onOther={(it) => it.action.to && void navigate({ to: it.action.to })}
            />
          ))}
        </div>
      )}
    </Column>
  )
}
