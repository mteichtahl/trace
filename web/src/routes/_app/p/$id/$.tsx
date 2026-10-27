import { createFileRoute } from '@tanstack/react-router'
import { NotBuilt } from '@/components/placeholder'

/** Every project tab and item not built yet (requirements, design, evidence, runs, files, …). */
export const Route = createFileRoute('/_app/p/$id/$')({
  component: function Tab() {
    const { _splat } = Route.useParams()
    const title = (_splat ?? '').split('/')[0] ?? ''
    return <NotBuilt title={title.charAt(0).toUpperCase() + title.slice(1).replace(/-/g, ' ')} section="Project page" />
  },
})
