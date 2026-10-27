import { createFileRoute } from '@tanstack/react-router'
import { NotBuilt } from '@/components/placeholder'

export const Route = createFileRoute('/_app/admin/people')({
  staticData: { crumb: 'People and access' },
  component: () => <NotBuilt title="People and access" section="Admin" />,
})
