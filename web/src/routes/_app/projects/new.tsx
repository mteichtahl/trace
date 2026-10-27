import { createFileRoute } from '@tanstack/react-router'
import { NotBuilt } from '@/components/placeholder'

export const Route = createFileRoute('/_app/projects/new')({
  staticData: { crumb: 'New project' },
  component: () => <NotBuilt title="New project" section="Creating a project" />,
})
