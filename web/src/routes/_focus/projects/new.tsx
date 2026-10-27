/**
 * New project (/projects/new, Focus mode, admins): six steps, each with defaults, so a project can be made by typing
 * a name and pressing Continue five times (docs/ui-design.md, "Creating a project"):
 *
 *   About (name, description, icon from 8 glyphs and 8 colours or an upload) · How it starts (an idea or a KiCad
 *   design, and the template trace recommends) · Repository (new or existing, branch; Advanced folded) · People (parts:
 *   Contributor or Reviewer; Guests locked to Reviewer; admins locked, on every project) · Build and budget · Review
 *
 * Create calls projects.create and shows the work as Run lines, anything that waits as a Wait line, then Open project
 * goes to the first task (Intent builder or Design import). The draft is kept with the person's preferences.
 */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { ArrowLeft, ChevronRight, Lightbulb, Lock, Shield, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { EmbeddedChat } from '@/components/chat/embedded-chat'
import { useTraceContext } from '@/components/chat/context'
import { FocusLayout } from '@/components/focus/focus-layout'
import { checks as allChecks, partsFor, recommendTemplate, slug, STEPS, type StepId } from '@/components/new-project/rules'
import { IconPicker, ProjectIconView, recommendGlyph } from '@/components/project/project-icon'
import { RunLine } from '@/components/run-line'
import { useCommands } from '@/components/shell/command-menu'
import { useSkillDraft } from '@/components/skills/draft'
import { ErrorState, NotShared } from '@/components/states'
import { WaitLine } from '@/components/wait-line'
import { call, projectId, projectName } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { initials, money } from '@/lib/format'
import { q, useCall, useProjects } from '@/lib/queries'
import type { Template } from '@/lib/types'
import type { NewProjectDraft } from '@/lib/types-s1'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_focus/projects/new')({ component: NewProject })

const TEMPLATES: { id: Template; label: string; detail: string }[] = [
  { id: 'board', label: 'Board', detail: 'A circuit board, with a firmware track when it has a microcontroller' },
  { id: 'fpga', label: 'FPGA', detail: 'Logic on an FPGA: synthesis, timing and the board around it' },
  { id: 'firmware', label: 'Firmware', detail: 'Firmware for a board that already exists' },
  { id: 'mixed', label: 'Mixed', detail: 'A board, an FPGA and firmware, with their gates together' },
]

const blank = (owner: string): NewProjectDraft => ({
  name: '', description: '', icon: { glyph: 'board', colour: 'green' }, start: 'idea', template: 'board',
  repository: { mode: 'new', owner, name: '', branch: 'main' },
  advanced: { ownToken: false, memoryDays: 30, onboardingPr: true, applySettings: true },
  people: [],
  build: { quantity: 10, later: { certify: false, produce: false, sustain: false }, fab: 'JLCPCB' },
})

type Created = { repo: string; done: string[]; waits: import('@/lib/types').Wait[] }

/** What projects.create takes (src/api/actions-projects.ts), from the draft. */
export function createArgs(d: NewProjectDraft) {
  const later = (Object.entries(d.build.later) as [keyof NewProjectDraft['build']['later'], boolean][]).filter(([, on]) => on).map(([k]) => k)
  return {
    repo: `${d.repository.owner}/${d.repository.name}`, name: d.name.trim(), description: d.description.trim() || undefined, template: d.template,
    start: d.start === 'design' ? 'import' as const : 'idea' as const,
    // the icon is kept as its JSON: glyph and colour (an uploaded image is too large for the record)
    icon: JSON.stringify({ glyph: d.icon.glyph, colour: d.icon.colour }),
    ...(d.repository.mode === 'new' ? { new: { private: true } } : {}),
    people: d.people.filter((p) => p.class !== 'admin').map((p) => ({ who: p.class === 'new' ? p.email : p.who, part: p.part, ...(p.class === 'new' ? { class: p.part === 'reviewer' ? 'guest' as const : 'user' as const } : {}) })),
    build: { quantity: d.build.quantity, ...(d.build.unitCost !== undefined ? { unit_cost: d.build.unitCost } : {}), ...(d.build.budget !== undefined ? { budget: d.build.budget } : {}), fab: d.build.fab },
    later, apply: d.advanced.applySettings,
  }
}

function NewProject() {
  const { user } = useAuth()
  const router = useRouter()
  const navigate = useNavigate()
  const projects = useProjects()
  const users = useQuery({ ...q('users.list', {}), enabled: user?.class === 'admin' })
  const owner = projects.data?.[0]?.repo.split('/')[0] ?? 'acme'
  const draft = useSkillDraft<NewProjectDraft & { done: string[] }>('new/project', 'new-project', { name: 'New project', steps: STEPS.length }, { ...blank(owner), done: [] })
  const d = draft.data
  const set = (p: Partial<NewProjectDraft>) => draft.setData((x) => ({ ...x, ...p }))
  const step = STEPS[draft.step]!.id
  const taken = (projects.data ?? []).map((p) => projectName(p.repo))
  const all = allChecks(d, { taken })
  const reached = new Set(STEPS.slice(0, draft.step + 1).map((s) => s.id))
  const bar = all.filter((c) => reached.has(c.step)).map((c) => ({ id: c.id, text: c.text, status: c.ok ? 'met' as const : 'not_met' as const, onJump: () => draft.setStep(STEPS.findIndex((s) => s.id === c.step)) }))
  const create = useCall('projects.create', () => [['projects'], ['journey.get']])
  const [created, setCreated] = useState<Created | null>(null)
  const recGlyph = recommendGlyph(`${d.name} ${d.description}`)
  const rec = recommendTemplate(`${d.name} ${d.description}`, d.start)
  const close = () => (window.history.length > 1 ? router.history.back() : void navigate({ to: '/projects' }))

  useTraceContext({ label: 'New project', description: 'The person is creating a project', value: { step, name: d.name, template: d.template } }, 'screen')
  useCommands(STEPS.map((s, i) => ({ id: `np-${s.id}`, label: `New project: ${s.title}`, run: () => draft.setStep(i) })))

  if (user && user.class !== 'admin') return <NotShared />

  const go = (i: number) => {
    draft.setData((x) => ({ ...x, done: [...new Set([...x.done, step])] }))
    draft.setStep(i)
  }
  const continueOrCreate = async () => {
    if (step !== 'review') {
      // carry defaults forward as the person goes: the repository is named from the project
      if (step === 'about' && !d.repository.name) set({ repository: { ...d.repository, name: slug(d.name) } })
      return go(draft.step + 1)
    }
    try {
      const r = await create.mutateAsync(createArgs(d))
      setCreated(r)
      draft.discard()
    } catch {
      /* shown under the review */
    }
  }

  const steps = STEPS.map((s, i) => ({ id: s.id, title: s.title, state: (i === draft.step ? 'current' : i < draft.step || d.done.includes(s.id) ? 'done' : 'todo') as 'current' | 'done' | 'todo' }))
  const preview = (
    <div className="flex h-full flex-col overflow-y-auto bg-sidebar px-5 py-6">
      <p className="section-label">How it will look</p>
      <div className="mt-3 flex items-center gap-3 rounded-xl border bg-background p-4">
        <ProjectIconView icon={d.icon} />
        <div><p className="font-semibold">{d.name || 'Your project'}</p><p className="text-xs text-muted-foreground">Rev A · {TEMPLATES.find((t) => t.id === d.template)?.label} · Define</p></div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">On Home and in Projects</p>
      <div className="mt-4 rounded-xl border bg-background p-4 text-sm">{d.name || 'Your project'}: the requirements baseline is ready to sign.</div>
      <p className="mt-2 text-xs text-muted-foreground">In a notification</p>
      <div className="dark mt-4 flex items-center gap-3 rounded-xl bg-neutral-950 p-4 text-white">
        <ProjectIconView icon={d.icon} />
        <div><p className="font-semibold">{d.name || 'Your project'}</p><p className="text-xs text-neutral-400">In dark mode</p></div>
      </div>
    </div>
  )

  if (created) return <CreatedView created={created} draft={d} onOpen={() => void navigate({ to: '/p/$id/do/$skill', params: { id: projectId(created.repo), skill: d.start === 'idea' ? 'intent-builder' : 'design-import' } })} onClose={close} />

  return (
    <FocusLayout
      title="New project"
      context={`Step ${draft.step + 1} of ${STEPS.length} · ${STEPS[draft.step]!.title}`}
      steps={steps}
      onStep={(id) => draft.setStep(STEPS.findIndex((s) => s.id === id))}
      checks={bar}
      submitLabel={step === 'review' ? (create.isPending ? 'Creating…' : 'Create project') : 'Continue'}
      onSubmit={continueOrCreate}
      onClose={close}
      draftSavedAt={draft.savedAt}
      trace={step === 'about' ? preview : <EmbeddedChat repo={undefined} intro={<TraceTip step={step} d={d} />} placeholder="Ask about this step…" />}
    >
      {draft.step > 0 && <Button variant="ghost" size="sm" className="-ml-2 mb-2" onClick={() => draft.setStep(draft.step - 1)}><ArrowLeft /> Back</Button>}

      {step !== 'about' && <Summary d={d} onEdit={() => draft.setStep(0)} />}

      {step === 'about' && (
        <div className="max-w-[640px] space-y-6">
          <div><h1 className="text-2xl font-semibold tracking-tight">Name and describe the project</h1><p className="mt-1 text-sm text-muted-foreground">These show on Home, in notifications and to everyone you add. You can change them later in the project's Settings.</p></div>
          <div className="space-y-1.5">
            <Label htmlFor="np-name">Name</Label>
            <Input id="np-name" value={d.name} onChange={(e) => set({ name: e.target.value, icon: d.icon.image ? d.icon : { ...d.icon, glyph: recommendGlyph(`${e.target.value} ${d.description}`) } })} autoFocus />
            {d.name.trim().length >= 2 && <p className={cn('text-xs', all[0]!.ok ? 'text-verified' : 'text-destructive')}>{all[0]!.ok ? '✓ No other project uses this name' : 'Another project already uses this name'}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np-desc">Short description</Label>
            <Textarea id="np-desc" rows={3} value={d.description} maxLength={280} onChange={(e) => set({ description: e.target.value, icon: d.icon.image ? d.icon : { ...d.icon, glyph: recommendGlyph(`${d.name} ${e.target.value}`) } })} />
            <p className="text-xs text-muted-foreground">One or two sentences: what it is and who it is for. trace's agents read this first. {d.description.length} of 280 characters.</p>
          </div>
          <IconPicker value={d.icon} onChange={(icon) => set({ icon })} recommended={recGlyph} why="from your description" />
          <p className="-mt-3 text-xs text-muted-foreground">All 8 colours work in light and dark.</p>
        </div>
      )}

      {step === 'start' && (
        <div className="max-w-[720px] space-y-6">
          <h1 className="text-2xl font-semibold tracking-tight">How does it start?</h1>
          <RadioGroup value={d.start} onValueChange={(v) => set({ start: v as NewProjectDraft['start'], template: recommendTemplate(`${d.name} ${d.description}`, v as NewProjectDraft['start']).template })} className="grid gap-3 sm:grid-cols-2">
            <Choice value="idea" title="From an idea" detail="Opens the Intent builder: trace asks one topic at a time and drafts the requirements." />
            <Choice value="design" title="From an existing KiCad design" detail="Opens Design import: trace infers the intent and places the project at its entry stage." />
          </RadioGroup>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Template</legend>
            <RadioGroup value={d.template} onValueChange={(v) => set({ template: v as Template })} className="grid gap-2 sm:grid-cols-2">
              {TEMPLATES.map((t) => <Choice key={t.id} value={t.id} title={t.label} detail={t.detail} badge={t.id === rec.template ? 'trace recommends' : undefined} />)}
            </RadioGroup>
            <p className="mt-2 text-sm text-muted-foreground"><Lightbulb className="mr-1 inline size-4" />{rec.why}: {TEMPLATES.find((t) => t.id === rec.template)?.label}. {d.template !== rec.template && 'You chose another; that is fine.'}</p>
            <p className="mt-1 text-xs text-muted-foreground">The template is fixed once the project exists: its stages and gates follow from it.</p>
          </fieldset>
        </div>
      )}

      {step === 'repository' && (
        <div className="max-w-[640px] space-y-6">
          <h1 className="text-2xl font-semibold tracking-tight">Where its files live</h1>
          <RadioGroup value={d.repository.mode} onValueChange={(v) => set({ repository: { ...d.repository, mode: v as 'new' | 'existing' } })} className="grid gap-3 sm:grid-cols-2">
            <Choice value="new" title="A new repository" detail="Private, created for this project" badge="trace recommends" />
            <Choice value="existing" title="An existing repository" detail={d.start === 'design' ? 'The one that holds the KiCad design' : 'One you already have'} />
          </RadioGroup>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_1.4fr]">
            <div className="space-y-1.5"><Label htmlFor="np-owner">Owner</Label><Input id="np-owner" value={d.repository.owner} onChange={(e) => set({ repository: { ...d.repository, owner: e.target.value.trim() } })} className="font-mono" /></div>
            <span className="hidden pt-8 text-muted-foreground sm:block">/</span>
            <div className="space-y-1.5"><Label htmlFor="np-repo">Name</Label><Input id="np-repo" value={d.repository.name || slug(d.name)} onChange={(e) => set({ repository: { ...d.repository, name: e.target.value.trim() } })} className="font-mono" /></div>
          </div>
          <div className="max-w-xs space-y-1.5"><Label htmlFor="np-branch">Default branch</Label><Input id="np-branch" value={d.repository.branch} onChange={(e) => set({ repository: { ...d.repository, branch: e.target.value } })} className="font-mono" /></div>
          <Collapsible className="rounded-xl border">
            <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium"><ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" /> Advanced <span className="font-normal text-muted-foreground">· agent token, memory, onboarding</span></CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 border-t px-4 py-4 text-sm">
              <Toggle label="This project's own agent token" detail="Its agents reach only its repository. Recommended when projects belong to different teams." checked={d.advanced.ownToken} onChange={(v) => set({ advanced: { ...d.advanced, ownToken: v } })} />
              <div className="flex items-center gap-3"><span className="flex-1"><span className="block font-medium">Recent agent memory kept for</span><span className="text-xs text-muted-foreground">3 to 365 days</span></span><Input type="number" min={3} max={365} className="w-24" value={d.advanced.memoryDays} onChange={(e) => set({ advanced: { ...d.advanced, memoryDays: Math.min(365, Math.max(3, Number(e.target.value) || 30)) } })} aria-label="Days" /><span>days</span></div>
              <Toggle label="Open the onboarding pull request" detail="Adds trace's settings and workflow to the repository for review." checked={d.advanced.onboardingPr} onChange={(v) => set({ advanced: { ...d.advanced, onboardingPr: v } })} />
              <Toggle label="Apply repository settings" detail="Branch protection and merge rules trace relies on." checked={d.advanced.applySettings} onChange={(v) => set({ advanced: { ...d.advanced, applySettings: v } })} />
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}

      {step === 'people' && <PeopleStep d={d} set={set} users={users.data ?? []} me={user?.email} />}

      {step === 'build' && (
        <div className="max-w-[640px] space-y-6">
          <h1 className="text-2xl font-semibold tracking-tight">Build and budget</h1>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5"><Label htmlFor="np-qty">Boards per build</Label><Input id="np-qty" type="number" min={1} value={d.build.quantity} onChange={(e) => set({ build: { ...d.build, quantity: Math.max(0, Math.floor(Number(e.target.value))) } })} /></div>
            <div className="space-y-1.5"><Label htmlFor="np-unit">Target unit cost (US$)</Label><Input id="np-unit" inputMode="decimal" placeholder="None" value={d.build.unitCost ?? ''} onChange={(e) => set({ build: { ...d.build, unitCost: e.target.value === '' ? undefined : Number(e.target.value) } })} /></div>
            <div className="space-y-1.5"><Label htmlFor="np-budget">Budget per revision (US$)</Label><Input id="np-budget" inputMode="decimal" placeholder="No budget" value={d.build.budget ?? ''} onChange={(e) => set({ build: { ...d.build, budget: e.target.value === '' ? undefined : Number(e.target.value) } })} /></div>
          </div>
          <fieldset className="space-y-3 rounded-xl border p-4">
            <legend className="px-1 text-sm font-medium">Later stages, after the board is accepted</legend>
            <Toggle label="Certify" detail="Formal compliance testing at an accredited lab" checked={d.build.later.certify} onChange={(v) => set({ build: { ...d.build, later: { ...d.build.later, certify: v } } })} />
            <Toggle label="Produce" detail="Hand the design to volume manufacture" checked={d.build.later.produce} onChange={(v) => set({ build: { ...d.build, later: { ...d.build.later, produce: v } } })} />
            <Toggle label="Sustain" detail="Keep it buildable: lifecycle, alternates, field issues" checked={d.build.later.sustain} onChange={(v) => set({ build: { ...d.build, later: { ...d.build.later, sustain: v } } })} />
          </fieldset>
          <div className="max-w-xs space-y-1.5">
            <Label>Fab and assembler</Label>
            <Select value={d.build.fab} onValueChange={(v) => set({ build: { ...d.build, fab: v } })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="JLCPCB">JLCPCB</SelectItem></SelectContent></Select>
            <p className="text-xs text-muted-foreground">trace prepares orders for JLCPCB today.</p>
          </div>
        </div>
      )}

      {step === 'review' && (
        <div className="max-w-[720px] space-y-5">
          <h1 className="text-2xl font-semibold tracking-tight">Review</h1>
          <ul className="space-y-2 text-sm">
            <li><b>{d.name || 'The project'}</b>, {TEMPLATES.find((t) => t.id === d.template)?.label} template, starting {d.start === 'idea' ? 'from an idea' : 'from an existing KiCad design'}.</li>
            <li>{d.repository.mode === 'new' ? 'A new private repository' : 'The existing repository'} <span className="font-mono">{d.repository.owner}/{d.repository.name || slug(d.name)}</span> on <span className="font-mono">{d.repository.branch}</span>{d.advanced.onboardingPr ? ', with an onboarding pull request' : ''}.</li>
            <li>{d.people.length ? `${d.people.length} ${d.people.length === 1 ? 'person' : 'people'} added` : 'Nobody added yet'}{d.people.some((p) => p.class === 'new') ? `, ${d.people.filter((p) => p.class === 'new').length} to invite by email` : ''}; admins reach it without being added.</li>
            <li>{d.build.quantity} boards per build{d.build.budget !== undefined ? `, ${money(d.build.budget)} per revision` : ', no budget'}{Object.entries(d.build.later).filter(([, on]) => on).length ? `, with ${Object.entries(d.build.later).filter(([, on]) => on).map(([k]) => k).join(' and ')}` : ''}; {d.build.fab}.</li>
          </ul>
          <div className="rounded-xl border p-4 text-sm">
            <p className="font-medium">What happens when you press Create</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>{d.repository.mode === 'new' ? 'Create' : 'Connect'} the repository{d.advanced.onboardingPr ? ' and open the onboarding pull request' : ''}</li>
              <li>Set up the project's agent, knowledge base and build runner</li>
              <li>Invite the people you added</li>
              <li>Open {d.start === 'idea' ? 'the Intent builder' : 'Design import'}</li>
            </ol>
            <p className="mt-2 text-xs text-muted-foreground">Most of it takes under a minute; the pull request's checks may take a few more, shown as they run.</p>
          </div>
          {create.isError && <ErrorState title="The project was not created." kept="Everything you entered is kept." detail={String(create.error)} onRetry={() => void continueOrCreate()} />}
        </div>
      )}
    </FocusLayout>
  )
}

function Summary({ d, onEdit }: { d: NewProjectDraft; onEdit: () => void }) {
  return (
    <div className="mb-6 flex items-start gap-4 rounded-xl border p-4">
      <ProjectIconView icon={d.icon} size={48} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2"><span className="text-lg font-semibold">{d.name || 'Untitled'}</span><span className="rounded border px-1.5 text-xs">{TEMPLATES.find((t) => t.id === d.template)?.label} template</span><span className="rounded border px-1.5 text-xs">{d.start === 'idea' ? 'Start from an idea' : 'Start from a design'}</span></p>
        {d.description && <p className="mt-1 text-sm">{d.description}</p>}
        <p className="mt-1 text-xs text-muted-foreground"><span className="font-mono">{d.repository.owner}/{d.repository.name || slug(d.name)}</span> · {d.build.quantity} boards per run · {d.build.fab} · {d.build.budget !== undefined ? money(d.build.budget) : 'no budget set'}</p>
      </div>
      <Button variant="link" size="sm" onClick={onEdit}>Edit basics</Button>
    </div>
  )
}

function Choice({ value, title, detail, badge }: { value: string; title: string; detail: string; badge?: string }) {
  return (
    <Label className="flex cursor-pointer items-start gap-3 rounded-xl border p-4 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
      <RadioGroupItem value={value} className="mt-0.5" />
      <span className="space-y-0.5"><span className="flex flex-wrap items-center gap-2 font-medium">{title}{badge && <span className="rounded-sm bg-primary/10 px-1.5 text-xs font-normal text-primary">{badge}</span>}</span><span className="block text-sm text-muted-foreground">{detail}</span></span>
    </Label>
  )
}

function Toggle({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex-1"><span className="block text-sm font-medium">{label}</span><span className="text-xs text-muted-foreground">{detail}</span></span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  )
}

const PART_WORDS = { contributor: 'Change the design, answer questions, start work', reviewer: 'Read everything, comment at gates' }

function PeopleStep({ d, set, users, me }: { d: NewProjectDraft; set: (p: Partial<NewProjectDraft>) => void; users: { email: string; sub: string; class: 'admin' | 'user' | 'guest' | null }[]; me?: string }) {
  const [text, setText] = useState('')
  const admins = users.filter((u) => u.class === 'admin')
  const matches = useMemo(() => {
    const t = text.trim().toLowerCase()
    if (!t) return []
    return users.filter((u) => u.class !== 'admin' && u.email.toLowerCase().includes(t) && !d.people.some((p) => p.email === u.email)).slice(0, 5)
  }, [text, users, d.people])
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim())
  const add = (email: string) => {
    const u = users.find((x) => x.email === email)
    const cls = (u?.class ?? 'new') as 'user' | 'guest' | 'new'
    if (u?.class === 'admin' || d.people.some((p) => p.email === email)) return setText('')
    set({ people: [...d.people, { who: u?.sub ?? email, email, class: cls, part: partsFor(cls)[0]!, notify: 'normal' }] })
    setText('')
  }
  return (
    <div className="max-w-[820px] space-y-5">
      <div><h1 className="text-2xl font-semibold tracking-tight">People and their parts</h1><p className="mt-1 text-sm text-muted-foreground">Who works on {d.name || 'the project'}, and their part on it. A person's account class sets the most they can be: a User can contribute or review, a Guest can only review.</p></div>
      <form className="relative flex gap-2" onSubmit={(e) => { e.preventDefault(); if (matches[0]) add(matches[0].email); else if (isEmail) add(text.trim()) }}>
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add people by name or email, or type a new email to invite" aria-label="Add a person" />
        <Button type="submit" variant="outline" disabled={!matches.length && !isEmail}>Add</Button>
        {(matches.length > 0 || (isEmail && !users.some((u) => u.email === text.trim()))) && (
          <ul className="absolute left-0 right-24 top-11 z-10 rounded-lg border bg-popover p-1 shadow-md">
            {matches.map((u) => <li key={u.sub}><button type="button" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent" onClick={() => add(u.email)}>{u.email} <span className="text-xs text-muted-foreground">· {u.class === 'guest' ? 'Guest' : 'User'} account</span></button></li>)}
            {isEmail && !users.some((u) => u.email === text.trim()) && <li><button type="button" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent" onClick={() => add(text.trim())}>Invite {text.trim()} as a User</button></li>}
          </ul>
        )}
      </form>
      {d.people.length > 0 ? (
        <ul className="divide-y rounded-xl border">
          {d.people.map((p) => {
            const allowed = partsFor(p.class)
            return (
              <li key={p.email} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[auto_1.3fr_auto_1.3fr_auto]">
                <span className={cn('flex size-8 items-center justify-center rounded-full text-xs font-semibold', p.class === 'new' ? 'border border-dashed' : 'bg-muted')}>{p.class === 'new' ? '@' : initials(p.email)}</span>
                <span className="min-w-0"><span className="block truncate text-sm font-medium">{p.email}</span><span className={cn('block text-xs', p.class === 'new' ? 'text-primary' : 'text-muted-foreground')}>{p.class === 'new' ? 'New: invited as a User' : `${p.class === 'guest' ? 'Guest' : 'User'} account`}</span></span>
                {allowed.length > 1 ? (
                  <Select value={p.part} onValueChange={(v) => set({ people: d.people.map((x) => (x.email === p.email ? { ...x, part: v as 'contributor' | 'reviewer' } : x)) })}>
                    <SelectTrigger className="w-36" aria-label={`Part for ${p.email}`}><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="contributor">Contributor</SelectItem><SelectItem value="reviewer">Reviewer</SelectItem></SelectContent>
                  </Select>
                ) : (
                  <span className="text-sm"><span className="rounded-md bg-muted px-2 py-1"><Lock className="mr-1 inline size-3" />Reviewer</span><span className="mt-1 block text-xs text-muted-foreground">Guest accounts can only review</span></span>
                )}
                <span className="col-span-2 text-sm text-muted-foreground sm:col-span-1">{PART_WORDS[p.part]}</span>
                <Button variant="ghost" size="icon" aria-label={`Remove ${p.email}`} onClick={() => set({ people: d.people.filter((x) => x.email !== p.email) })}><X /></Button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">Nobody added yet. You can add people now or later from Settings.</p>
      )}
      <p className="flex items-start gap-2 rounded-xl bg-muted/60 p-4 text-sm"><Shield className="mt-0.5 size-4 shrink-0" aria-hidden /><span><b>Admins reach every project without being added:</b> {admins.length ? admins.map((a) => (a.email === me ? `${a.email} (you)` : a.email)).join(', ') : 'you'}. Admins sign gates and approve spend; they get gate and spend notifications for {d.name || 'this project'}.</span></p>
      <Collapsible className="rounded-xl border">
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium"><ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" /> What each part can do</CollapsibleTrigger>
        <CollapsibleContent className="space-y-1 border-t px-4 py-3 text-sm">
          <p><b>Contributor:</b> {PART_WORDS.contributor.toLowerCase()}, run tools.</p>
          <p><b>Reviewer:</b> {PART_WORDS.reviewer.toLowerCase()}; changes nothing.</p>
          <p><b>Admin:</b> on every project; signs gates and approves spend.</p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function TraceTip({ step, d }: { step: StepId; d: NewProjectDraft }) {
  const tips: Record<StepId, string> = {
    about: '',
    start: d.start === 'design' ? 'Design import reads the KiCad project and proposes where it enters the journey.' : 'The Intent builder takes about 20 minutes; you can stop and come back.',
    repository: 'A new private repository named from the project is the simplest start. The template and repository cannot change later: the record depends on them.',
    people: 'Give the project a second person who can answer questions while you are away. Inviting someone sends one email; they sign in with a passkey and land on this project.',
    build: '10 boards is JLCPCB\'s usual minimum. A budget makes trace warn before an order goes over it.',
    review: 'Nothing is created until you press Create.',
  }
  return <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm"><span className="rounded-sm bg-primary/10 px-1.5 text-xs text-primary">trace recommends</span><p className="mt-2">{tips[step]}</p></div>
}

function CreatedView({ created, draft: d, onOpen, onClose }: { created: Created; draft: NewProjectDraft; onOpen: () => void; onClose: () => void }) {
  const now = new Date().toISOString()
  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="flex h-[52px] items-center gap-3 border-b px-4"><Button variant="outline" size="icon" onClick={onClose} aria-label="Close"><X /></Button><span className="font-semibold">New project</span><span className="text-sm text-muted-foreground">Created</span></header>
      <div className="mx-auto w-full max-w-[720px] flex-1 overflow-y-auto px-4 py-10">
        <div className="flex items-center gap-3"><ProjectIconView icon={d.icon} size={48} /><div><h1 className="text-2xl font-semibold tracking-tight">{d.name} is ready</h1><p className="text-sm font-mono text-muted-foreground">{created.repo}</p></div></div>
        <div className="mt-6 divide-y rounded-xl border">
          {created.done.map((t, i) => <RunLine key={i} run={{ id: `c${i}`, title: t, state: 'done', startedAt: now }} />)}
          {created.waits.map((w) => <WaitLine key={w.id} wait={w} onCheckNow={(x) => call('tools.check_now', { repo: created.repo, waitId: x.id })} />)}
        </div>
        <p className="mt-3 text-sm text-muted-foreground">You can start now; anything still waiting finishes on its own and says so here and on the project.</p>
        <Button size="lg" className="mt-6" onClick={() => { toast(`${d.name} created.`); onOpen() }}>Open project</Button>
      </div>
    </div>
  )
}
