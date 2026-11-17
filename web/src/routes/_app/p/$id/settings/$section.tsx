/**
 * A project's rarely changed settings, each on its own page under Settings (docs/ui-simplify.md, "Project Settings"):
 * documents (the logo on the project's documents: project-logo.tsx), rules (the answers made rules: project-rules.tsx),
 * where (GitHub or trace's GitLab and moving between them: move.tsx; and what was fixed when the project was made),
 * stages (Certify, Produce, Sustain). Admins change them; everyone else reads. Agent instructions are settings/prompts.
 */
import { Link, createFileRoute } from '@tanstack/react-router'
import { ChevronLeft, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { useTraceContext } from '@/components/chat/context'
import { MoveCard } from '@/components/project/move'
import { ProjectLogo } from '@/components/project/project-logo'
import { ProjectRules } from '@/components/project/project-rules'
import { TabSkeleton } from '@/components/project/shared'
import { Section } from '@/components/shell/app-shell'
import { EmptyState, QueryError } from '@/components/states'
import { repoOf } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useAction, useCall, useJourney } from '@/lib/queries'
import type { JourneyMore, ProjectIcon } from '@/lib/types-s1'
import { SETTINGS_PAGES } from './index'

const pageOf = (section: string) => SETTINGS_PAGES.find((p) => p.id === section && p.id !== 'prompts')

export const Route = createFileRoute('/_app/p/$id/settings/$section')({
  staticData: { crumb: (p) => pageOf(p.section ?? '')?.label ?? 'Settings' },
  component: SettingsSection,
})

const TEMPLATE: Record<string, string> = { board: 'Board', fpga: 'FPGA', firmware: 'Firmware', mixed: 'Mixed' }
const LATER = [['certify', 'Certify', 'Formal compliance testing at an accredited lab'], ['produce', 'Produce', 'Hand the design to volume manufacture'], ['sustain', 'Sustain', 'Keep it buildable: lifecycle, alternates, field issues']] as const

function SettingsSection() {
  const { id, section } = Route.useParams()
  const repo = repoOf(id)
  const { user } = useAuth()
  const admin = user?.class === 'admin'
  const j = useJourney(repo)
  const s = useAction('settings.get', { repo })
  const update = useCall('project.update', (a) => [['journey.get', a.repo], ['projects']])
  const page = pageOf(section)
  useTraceContext({ label: page?.label ?? 'Settings', description: 'The project settings page on screen', value: { tab: 'settings', section } }, 'screen')

  const back = (
    <Link to="/p/$id/settings" params={{ id }} className="mt-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ChevronLeft className="size-4" aria-hidden /> Settings
    </Link>
  )
  if (!page) return <div className="max-w-[880px] pb-12">{back}<EmptyState className="mt-4">There is no settings page called “{section}”.</EmptyState></div>
  if (s.isError) return <div className="mt-6"><QueryError error={s.error} what="the settings" onRetry={() => void s.refetch()} /></div>
  if (!s.data || !j.data) return <TabSkeleton loading={s.isLoading || j.isLoading} />
  const jm = j.data as JourneyMore
  const icon: ProjectIcon = jm.icon ?? { glyph: 'board', colour: 'blue' }
  const later = new Set(jm.later ?? [])
  const setLater = (k: string, on: boolean) =>
    update.mutate({ repo, later: (['certify', 'produce', 'sustain'] as const).filter((x) => (x === k ? on : later.has(x))) }, {
      onSuccess: () => toast('Saved', { description: 'The project record is updated for everyone on it.' }),
      onError: (e) => toast.error('Not saved.', { description: e instanceof Error ? e.message : String(e) }),
    })

  return (
    <div className="max-w-[880px] pb-12">
      {back}
      {!admin && <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Lock className="size-4" aria-hidden /> Only admins change a project's settings. You can read them here.</p>}
      <div className="h-2" aria-hidden />
      {section === 'documents' && (
        <Section label="Documents">
          <ProjectLogo repo={repo} name={j.data.name} icon={icon} admin={admin} />
        </Section>
      )}
      {section === 'rules' && (
        <Section label="Project rules">
          <ProjectRules repo={repo} canWrite={user?.class !== 'guest'} />
        </Section>
      )}
      {section === 'where' && (
        <>
          <Section label="Where this project lives">
            <MoveCard repo={repo} name={j.data.name} admin={admin} />
          </Section>
          <Section label="Fixed when the project was made">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 rounded-xl border p-5 text-sm">
              <dt className="text-muted-foreground">Template</dt>
              <dd><span className="font-medium">{TEMPLATE[j.data.template]}</span> <span className="text-muted-foreground">· Fixed: the stages, gates and every record so far follow from it.</span></dd>
              <dt className="text-muted-foreground">Repository</dt>
              <dd><span className="font-mono">{repo}</span> on <span className="font-mono">{String(s.data.config.branch ?? 'main')}</span> <span className="text-muted-foreground">· Fixed: the project's record lives in it.</span></dd>
            </dl>
          </Section>
        </>
      )}
      {section === 'stages' && (
        <Section label="Later stages">
          <ul className="divide-y rounded-xl border">
            {LATER.map(([k, name, what]) => (
              <li key={k} className="flex items-center gap-3 px-5 py-3">
                <span className="flex-1"><span className="block text-sm font-medium">{name}</span><span className="block text-xs text-muted-foreground">{what}</span></span>
                <Switch checked={later.has(k)} disabled={!admin || update.isPending} aria-label={name} onCheckedChange={(on) => setLater(k, on)} />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}
