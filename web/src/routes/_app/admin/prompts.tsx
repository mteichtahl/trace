import { createFileRoute } from '@tanstack/react-router'
import { PromptsScreen } from '@/components/prompts/prompts-screen'

/** Admin › Agent instructions: the installation's instructions, or a project's (docs/ui-design.md). */
export const Route = createFileRoute('/_app/admin/prompts')({
  staticData: { crumb: 'Agent instructions' },
  component: () => <PromptsScreen initialScope="installation" />,
})
