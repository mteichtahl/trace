import { createFileRoute } from '@tanstack/react-router'
import { NotBuilt } from '@/components/placeholder'

export const Route = createFileRoute('/_app/knowledge/')({
  staticData: { crumb: 'Knowledge' },
  component: () => <NotBuilt title="Knowledge" section="Knowledge" />,
})
