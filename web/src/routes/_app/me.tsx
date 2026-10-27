import { createFileRoute } from '@tanstack/react-router'
import { NotBuilt } from '@/components/placeholder'

export const Route = createFileRoute('/_app/me')({
  staticData: { crumb: 'Preferences' },
  component: () => <NotBuilt title="Preferences" section="Preferences" />,
})
