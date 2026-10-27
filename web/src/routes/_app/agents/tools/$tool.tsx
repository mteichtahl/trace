/**
 * One tool (/agents/tools/:tool): its plain name and tool name, description, where it runs, status, last used and
 * error rate over the runs on the person's projects, its recent runs, the input it takes, and Try it for read-only
 * tools (not for reviewers).
 */
import { Link, createFileRoute } from '@tanstack/react-router'
import { TryIt, useTryRepos } from '@/components/agents/try-it'
import { ToolStatus, lastUsedWords } from '@/components/agents/tools-catalogue'
import { useCatalogue } from '@/components/agents/use-agents'
import { useTraceContext } from '@/components/chat/context'
import { Column, Section } from '@/components/shell/app-shell'
import { Facts } from '@/components/side-sheet'
import { EmptyState, Loading, NotShared, QueryError, SkeletonRows } from '@/components/states'
import { StatusBadge } from '@/components/status-badge'
import { projectId, projectName } from '@/lib/api'
import { ago } from '@/lib/format'
import { RUNS_ON_WORD, canTry, familyOf, plainName, runsOn, schemaFields } from '@/lib/tools-catalogue'

export const Route = createFileRoute('/_app/agents/tools/$tool')({
  staticData: { crumb: ({ tool }) => tool, parent: { label: 'Agents and tools', to: '/agents' } },
  component: Tool,
})

function Tool() {
  const { tool: name } = Route.useParams()
  const c = useCatalogue()
  const reviewer = useTryRepos().length === 0
  const t = c.tools.find((x) => x.name === name)
  useTraceContext(t ? { label: name, description: 'The tool the person is looking at', value: { name, description: t.description }, mono: true } : null, 'tool')
  if (c.error) return <Column><QueryError error={c.error} what="the tools" onRetry={c.retry} /></Column>
  if (c.loading) return <Column><Loading><SkeletonRows rows={3} /></Loading></Column>
  if (!t) return <NotShared />
  const u = c.use.get(name)
  const runs = c.runs.filter((r) => r.kind === name).sort((a, b) => b.started - a.started).slice(0, 10)
  const fields = schemaFields(t.input)
  return (
    <Column>
      <p className="text-sm text-muted-foreground">{familyOf(name).label}</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{plainName(t)}</h1>
      <p className="font-mono text-sm text-muted-foreground">{name}</p>
      <p className="mt-3 text-[15px]">{t.description}</p>
      <Facts
        className="mt-5"
        items={[
          ['Runs on', RUNS_ON_WORD[runsOn(name)]],
          ['Status', <ToolStatus key="s" t={t} u={u} />],
          ['Changes the project', t.needs === 'write' ? 'Yes: only an agent or a guided task runs it' : 'No: it only reads'],
          ['Use', lastUsedWords(u)],
          ['Input', fields.length ? fields.map((f) => `${f.name}${f.required ? '' : ' (optional)'}`).join(', ') : 'None'],
        ]}
      />

      <Section label="Recent runs on your projects" count={runs.length} className="mt-10">
        {runs.length === 0 ? (
          <EmptyState>No runs of this tool on your projects are recorded.</EmptyState>
        ) : (
          <ul className="divide-y rounded-xl border">
            {runs.map((r) => (
              <li key={`${r.repo}:${r.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <StatusBadge status={r.status === 'pass' ? 'passed' : r.status === 'fail' ? 'failing' : r.status === 'error' ? 'warning' : 'running'} label={r.status === 'pass' ? 'Passed' : r.status === 'fail' ? 'Failed its check' : r.status === 'error' ? 'Did not finish' : 'Running'} />
                <Link to="/p/$id/$" params={{ id: projectId(r.repo), _splat: `runs/${r.id}` }} className="font-mono text-xs text-primary hover:underline">{r.id}</Link>
                <span className="min-w-0 flex-1 text-muted-foreground">{r.summary}</span>
                <span className="text-xs text-muted-foreground">{projectName(r.repo)} · {ago(r.started * 1000)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section label="Try it">
        {canTry(t, { reviewer }) ? (
          <div className="rounded-xl border p-5">
            <TryIt tool={t} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t.needs === 'write' ? 'This tool changes the project, so it is not tried from here.' : 'You review your projects, so tools are not run from here.'}</p>
        )}
      </Section>
    </Column>
  )
}
