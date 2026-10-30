/**
 * Settings (/p/:id/settings): what the project is and who works on it. The template and repository are shown
 * read-only with the reason (the record depends on them). Name, description, icon, the people and their parts, the
 * build quantity, the budget and the later stages are editable by admins: each change is written to the journey
 * record with project.update (they are what the project is, not repository settings) or, for people, assign — and
 * says "Saved" when it lands. Everyone else reads. Agent instructions for this project are one link away.
 */
import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Check, Loader2, Lock } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useTraceContext } from '@/components/chat/context'
import { IconPicker, ProjectIconView } from '@/components/project/project-icon'
import { TabSkeleton } from '@/components/project/shared'
import { Section } from '@/components/shell/app-shell'
import { StatusBadge } from '@/components/status-badge'
import { QueryError } from '@/components/states'
import { repoOf } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { initials } from '@/lib/format'
import type { ArgsOf } from '@/lib/api'
import { q, useAction, useCall, useJourney } from '@/lib/queries'
import type { Part } from '@/lib/types'
import type { JourneyMore, ProjectIcon } from '@/lib/types-s1'

export const Route = createFileRoute('/_app/p/$id/settings/')({
  staticData: { crumb: 'Settings' },
  component: Settings,
})

const TEMPLATE: Record<string, string> = { board: 'Board', fpga: 'FPGA', firmware: 'Firmware', mixed: 'Mixed' }

function Settings() {
  const { id } = Route.useParams()
  const repo = repoOf(id)
  const { user } = useAuth()
  const admin = user?.class === 'admin'
  const j = useJourney(repo)
  const s = useAction('settings.get', { repo })
  const members = useQuery(q('project.members', { repo }))
  const update = useCall('project.update', (a) => [['journey.get', a.repo], ['projects']])
  const assign = useCall('assign', (a) => [['project.members', a.repo], ['assignments']])
  const [saved, setSaved] = useState<string | null>(null)
  useTraceContext({ label: 'Settings', description: 'The project tab on screen', value: { tab: 'settings' } }, 'screen')

  const [pending, setPending] = useState<string | null>(null)
  /** one field of what the project is, by its name on this page: written to the journey record */
  const save = (key: Field, patch: Omit<ArgsOf<'project.update'>, 'repo'>) => {
    setPending(key)
    update.mutate({ repo, ...patch }, {
      onSuccess: () => { setSaved(key); toast('Saved', { description: 'The project record is updated for everyone on it.' }) },
      onError: (e) => toast.error('Not saved. Your change is still in the field.', { description: e instanceof Error ? e.message : String(e) }),
      onSettled: () => setPending(null),
    })
  }

  if (s.isError) return <div className="mt-6"><QueryError error={s.error} what="the settings" onRetry={() => void s.refetch()} /></div>
  if (!s.data || !j.data) return <TabSkeleton loading={s.isLoading || j.isLoading} />
  const jm = j.data as JourneyMore
  const icon: ProjectIcon = jm.icon ?? { glyph: 'board', colour: 'blue' }
  const build = jm.build ?? { quantity: 10, unit_cost: null, budget: null }
  const later = new Set(jm.later ?? [])

  return (
    <div className="max-w-[880px] pb-12">
      {!admin && <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><Lock className="size-4" aria-hidden /> Only admins change a project's settings. You can read them here.</p>}
      {s.data.errors.length > 0 && <p className="mt-6 text-sm text-destructive">Some stored settings could not be read: {s.data.errors.join('; ')}</p>}

      <div className="h-8" aria-hidden /><Section label="About">
        <div className="space-y-5 rounded-xl border p-5">
          <TextSetting label="Name" value={j.data.name} disabled={!admin} saving={pending === 'name'} saved={saved === 'name'} onSave={(x) => save('name', { name: x })} check={(x) => x.trim().length >= 2} />
          <TextSetting multiline label="Short description" hint="One or two sentences: shown on Home and in notifications." value={j.data.description ?? ''} disabled={!admin} saving={pending === 'description'} saved={saved === 'description'} onSave={(x) => save('description', { description: x })} check={(x) => /[.!?]$/.test(x.trim()) && x.trim().length <= 280} />
          <div className="flex items-start gap-4">
            <ProjectIconView icon={icon} size={48} />
            <div className="flex-1"><IconPicker value={icon} disabled={!admin || pending === 'icon'} onChange={(x) => save('icon', { icon: JSON.stringify({ glyph: x.glyph, colour: x.colour }) })} /></div>
          </div>
        </div>
      </Section>

      <Section label="Fixed when the project was made">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 rounded-xl border p-5 text-sm">
          <dt className="text-muted-foreground">Template</dt>
          <dd><span className="font-medium">{TEMPLATE[j.data.template]}</span> <span className="text-muted-foreground">· Fixed: the stages, gates and every record so far follow from it.</span></dd>
          <dt className="text-muted-foreground">Repository</dt>
          <dd><span className="font-mono">{repo}</span> on <span className="font-mono">{String(s.data.config.branch ?? 'main')}</span> <span className="text-muted-foreground">· Fixed: the project's record lives in it.</span></dd>
        </dl>
      </Section>

      <Section label="People and their parts" count={members.data?.length}>
        {members.isError ? <QueryError error={members.error} what="the people" onRetry={() => void members.refetch()} /> : (
          <ul className="divide-y rounded-xl border">
            {(members.data ?? []).map((m) => {
              const isAdmin = m.admin || m.class === 'admin'
              return (
                <li key={m.sub} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <span className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-semibold">{initials(m.name ?? m.email)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{m.name ?? m.email}</span>
                    <span className="block text-xs text-muted-foreground">{m.email} · {m.class === 'guest' ? 'Guest' : m.class === 'admin' ? 'Admin' : 'User'} account</span>
                  </span>
                  {isAdmin ? (
                    <span className="text-xs text-muted-foreground"><Lock className="mr-1 inline size-3" />Admin: every project</span>
                  ) : m.class === 'guest' ? (
                    <span className="text-xs text-muted-foreground"><Lock className="mr-1 inline size-3" />Reviewer · Guest accounts can only review</span>
                  ) : (
                    <Select value={m.part} disabled={!admin || assign.isPending} onValueChange={(p) => assign.mutate({ who: m.sub, repo, part: p as Part }, { onSuccess: () => toast('Saved', { description: `${m.name ?? m.email} is now a ${p} on this project.` }) })}>
                      <SelectTrigger className="w-40" aria-label={`Part for ${m.name ?? m.email}`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="contributor">Contributor</SelectItem>
                        <SelectItem value="reviewer">Reviewer</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">Contributor: changes the design, answers questions, runs tools. Reviewer: reads everything and comments at gates. Add people from Admin › People.</p>
      </Section>

      <Section label="Build and budget">
        <div className="grid gap-5 rounded-xl border p-5 sm:grid-cols-2">
          <NumberSetting label="Boards per build" value={build.quantity} disabled={!admin} saving={pending === 'quantity'} saved={saved === 'quantity'} onSave={(x) => save('quantity', { build: { quantity: Math.round(x) } })} min={1} />
          <NumberSetting label="Budget per revision (US$)" value={build.budget ?? undefined} placeholder="No budget" disabled={!admin} saving={pending === 'budget'} saved={saved === 'budget'} onSave={(x) => save('budget', { build: { budget: x } })} min={0} />
          <NumberSetting label="Target unit cost (US$)" value={build.unit_cost ?? undefined} placeholder="None" disabled={!admin} saving={pending === 'unit_cost'} saved={saved === 'unit_cost'} onSave={(x) => save('unit_cost', { build: { unit_cost: x } })} min={0} />
        </div>
      </Section>

      <Section label="Later stages">
        <ul className="divide-y rounded-xl border">
          {([['certify', 'Certify', 'Formal compliance testing at an accredited lab'], ['produce', 'Produce', 'Hand the design to volume manufacture'], ['sustain', 'Sustain', 'Keep it buildable: lifecycle, alternates, field issues']] as const).map(([k, name, what]) => (
            <li key={k} className="flex items-center gap-3 px-5 py-3">
              <span className="flex-1"><span className="block text-sm font-medium">{name}</span><span className="block text-xs text-muted-foreground">{what}</span></span>
              <Switch checked={later.has(k)} disabled={!admin || pending === 'later'} aria-label={name} onCheckedChange={(on) => save('later', { later: (['certify', 'produce', 'sustain'] as const).filter((x) => (x === k ? on : later.has(x))) })} />
            </li>
          ))}
        </ul>
      </Section>

      <Section label="Agent instructions">
        <div className="flex flex-wrap items-center gap-3 rounded-xl border p-5 text-sm">
          <p className="flex-1">What this project's agents are told, on top of the installation's instructions. A change opens a pull request for review.</p>
          <Button asChild variant="outline"><Link to="/p/$id/settings/prompts" params={{ id }}>Agent instructions</Link></Button>
        </div>
      </Section>
    </div>
  )
}

type Field = 'name' | 'description' | 'icon' | 'quantity' | 'budget' | 'unit_cost' | 'later'

function Status({ saving, saved }: { saving?: boolean; saved?: boolean }) {
  if (saving) return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />Saving</span>
  if (saved) return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite"><Check className="size-3" />Saved</span>
  return null
}

function Field({ label, hint, status, children, htmlFor }: { label: string; hint?: string; status: ReactNode; children: ReactNode; htmlFor: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2"><Label htmlFor={htmlFor}>{label}</Label>{status}</div>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function TextSetting({ label, hint, value, onSave, disabled, saving, saved, multiline, check }: { label: string; hint?: string; value: string; onSave: (v: string) => void; disabled?: boolean; saving?: boolean; saved?: boolean; multiline?: boolean; check: (v: string) => boolean }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const id = `set-${label.toLowerCase().replace(/\W+/g, '-')}`
  const commit = () => { if (v !== value && check(v)) onSave(v.trim()) }
  return (
    <Field label={label} hint={v !== value && !check(v) ? (multiline ? 'One or two full sentences, at most 280 characters.' : 'At least two characters.') : hint} status={<Status saving={saving} saved={saved && v === value} />} htmlFor={id}>
      {multiline ? <Textarea id={id} rows={2} value={v} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={commit} /> : <Input id={id} value={v} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />}
    </Field>
  )
}

function NumberSetting({ label, value, onSave, disabled, saving, saved, min, placeholder }: { label: string; value?: number; onSave: (v: number) => void; disabled?: boolean; saving?: boolean; saved?: boolean; min: number; placeholder?: string }) {
  const [v, setV] = useState(value === undefined ? '' : String(value))
  useEffect(() => setV(value === undefined ? '' : String(value)), [value])
  const id = `set-${label.toLowerCase().replace(/\W+/g, '-')}`
  const n = Number(v)
  const ok = v !== '' && Number.isFinite(n) && n >= min
  const commit = () => { if (ok && n !== value) onSave(n) }
  return (
    <Field label={label} status={<Status saving={saving} saved={saved} />} htmlFor={id}>
      <Input id={id} inputMode="decimal" value={v} placeholder={placeholder} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      {v !== '' && !ok && <StatusBadge plain status="not_met" label={`A number, ${min} or more`} />}
    </Field>
  )
}
