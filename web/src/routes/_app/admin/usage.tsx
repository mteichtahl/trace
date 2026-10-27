/**
 * Admin › Usage and cost (docs/ui-design.md, "Admin"): spend across projects for the month, by project, against
 * budgets. No API action reports cost yet, so the screen says so plainly and names what is needed, and points to
 * what can be seen today.
 */
import { Link, createFileRoute } from '@tanstack/react-router'
import { Column, Section } from '@/components/shell/app-shell'
import { EmptyState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { useTraceContext } from '@/components/chat/context'
import { projectId, projectName } from '@/lib/api'
import { useProjects } from '@/lib/queries'

export const Route = createFileRoute('/_app/admin/usage')({
  staticData: { crumb: 'Usage and cost' },
  component: Usage,
})

function Usage() {
  const projects = useProjects()
  useTraceContext({ label: 'Usage and cost', description: 'The screen the person is on: Admin, usage and cost across projects (not reported by the API yet)', value: 'no cost data action yet' }, 'screen')
  return (
    <Column>
      <h1 className="text-2xl font-semibold tracking-tight">Usage and cost</h1>
      <p className="mt-1 text-[15px] text-muted-foreground">Spend across projects for the month: cloud use and recorded orders, by project, against each budget.</p>
      <EmptyState
        className="mt-8"
        action={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm"><Link to="/ops">Open Operations</Link></Button>
          </div>
        }
      >
        trace cannot show spend here yet: no API action reports cost per project. It needs a <span className="font-mono">usage.month</span> read that adds up cloud use (agents, graphics card and CPU jobs) from Cost Explorer by each project's resource tags, and the recorded orders from each project's journey, with each project's budget from its settings. Until then, Operations shows the installation's cloud spend this month from CloudWatch.
      </EmptyState>
      {!!projects.data?.length && (
        <Section label="Projects" className="mt-8">
          <ul className="divide-y rounded-xl border bg-card">
            {projects.data.map((p) => (
              <li key={p.repo} className="flex items-center gap-3 px-5 py-3 text-sm">
                <span className="flex-1 font-medium">{projectName(p.repo)}</span>
                <span className="text-muted-foreground">Spend not reported yet</span>
                <Button asChild variant="link" size="sm" className="h-auto px-0"><Link to={`/p/${projectId(p.repo)}/cost` as string}>Cost and time</Link></Button>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </Column>
  )
}
