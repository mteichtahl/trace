import { createFileRoute } from '@tanstack/react-router'
import { Operations } from '@/components/ops/operations'

export const Route = createFileRoute('/_app/ops/')({
  staticData: { crumb: 'Operations' },
  component: () => <Operations />,
})
