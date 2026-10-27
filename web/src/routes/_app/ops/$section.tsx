import { createFileRoute } from '@tanstack/react-router'
import { Operations } from '@/components/ops/operations'

export const Route = createFileRoute('/_app/ops/$section')({
  staticData: { crumb: 'Operations' },
  component: function OpsSection() {
    const { section } = Route.useParams()
    return <Operations section={section} />
  },
})
