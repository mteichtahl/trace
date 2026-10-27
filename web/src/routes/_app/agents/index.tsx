import { createFileRoute } from '@tanstack/react-router'
import { NotBuilt } from '@/components/placeholder'

export const Route = createFileRoute('/_app/agents/')({
  staticData: { crumb: 'Agents and tools' },
  component: () => <NotBuilt title="Agents and tools" section="Agents and tools" />,
})
