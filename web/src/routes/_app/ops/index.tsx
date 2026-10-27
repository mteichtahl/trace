import { createFileRoute } from '@tanstack/react-router'
import { NotBuilt } from '@/components/placeholder'

export const Route = createFileRoute('/_app/ops/')({
  staticData: { crumb: 'Operations' },
  component: () => <NotBuilt title="Operations" section="Operations" />,
})
