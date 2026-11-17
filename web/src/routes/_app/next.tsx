/**
 * The old Next address: the queue is now Home (docs/ui-simplify.md, "One queue"). Links, bookmarks and tapped
 * notifications (/next?item=…) keep working, and open their item at the front.
 */
import { createFileRoute, redirect } from '@tanstack/react-router'

export { INBOX_KINDS, KIND_WORDS, decisionFor, inboxItems, queueOrder } from '@/components/next-queue'

export const Route = createFileRoute('/_app/next')({
  validateSearch: (s: Record<string, unknown>): { item?: string } => (typeof s.item === 'string' && s.item.length < 200 ? { item: s.item } : {}),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/', search: search.item ? { item: search.item } : {}, replace: true })
  },
})
