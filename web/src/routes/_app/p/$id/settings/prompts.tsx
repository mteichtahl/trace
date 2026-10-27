import { createFileRoute } from '@tanstack/react-router'
import { PromptsScreen } from '@/components/prompts/prompts-screen'
import { repoOf } from '@/lib/api'

/** A project's Settings › Agent instructions: the same screen, fixed to this project. */
export const Route = createFileRoute('/_app/p/$id/settings/prompts')({
  staticData: { crumb: 'Agent instructions' },
  component: function ProjectPrompts() {
    const { id } = Route.useParams()
    return <PromptsScreen repo={repoOf(id)} />
  },
})
