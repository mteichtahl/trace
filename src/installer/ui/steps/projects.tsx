import { Loader2, Plus, RefreshCw, Search, Sparkles, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { runPreflight } from '../actions.js'
import { type Template, isRepoCheck, newRepoError, owner as ownerOf, preCurrent, repoList, repoSlug, sampleRepo } from '../model.js'
import { CheckProgress, Choice, Finding, Note, Section, TextField, Toggle } from '../parts.js'
import { get, update, useStore } from '../store.js'

const TEMPLATES: { value: Exclude<Template, 'sample'>; label: string }[] = [
  { value: 'kicad', label: 'KiCad board' }, { value: 'rust', label: 'Rust firmware' }, { value: 'python', label: 'Python' }, { value: 'empty', label: 'Empty' },
]

function SmallSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
      <Switch checked={checked} onCheckedChange={onChange} className="scale-75" />{label}
    </label>
  )
}

function RepoPicker() {
  const s = useStore()
  const all = repoList(s)
  const access = new Map((preCurrent(s) ? s.pre?.repos ?? [] : []).map((r) => [r.repo.toLowerCase(), r]))
  const q = s.filter.trim().toLowerCase()
  const shown = all.filter((r) => !q || r.fullName.toLowerCase().includes(q))
  // the chosen ones first, so they never scroll out of sight
  shown.sort((x, y) => Number(s.projects.has(y.fullName)) - Number(s.projects.has(x.fullName)))
  const chosen = all.filter((r) => s.projects.has(r.fullName)).length
  return (
    <Section title="Your repositories" description={`${all.length} the token can see${chosen ? `; ${chosen} chosen` : ''}. Onboarding opens a pull request with trace's workflows; repository settings turns on auto-merge and the required checks.`}>
      <div className="relative">
        <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
        <Input value={s.filter} onChange={(e) => update((x) => { x.filter = e.target.value })} placeholder={`Filter ${all.length} repositories…`} className="pl-8" aria-label="Filter repositories" />
      </div>
      <div className="max-h-80 overflow-y-auto rounded-lg border">
        {shown.length === 0 ? <p className="p-4 text-center text-sm text-muted-foreground">{all.length ? 'No repository matches the filter.' : 'The token sees no repositories. Create one below, or give the token access to yours and check it again on the GitHub step.'}</p> : null}
        {shown.slice(0, 300).map((r) => {
          const p = s.projects.get(r.fullName)
          const acc = access.get(r.fullName.toLowerCase())
          const id = `repo-${r.fullName}`
          return (
            <div key={r.fullName} className={cn('grid gap-1.5 border-b px-3 py-2 last:border-b-0', p && 'bg-primary-soft/60')}>
              <div className="flex items-center gap-3">
                <Checkbox id={id} checked={Boolean(p)} onCheckedChange={(v) => update((x) => {
                  if (v === true) x.projects.set(r.fullName, { branch: r.defaultBranch, onboard: true, applySettings: r.admin, memoryDays: '', generation: 0, create: null })
                  else x.projects.delete(r.fullName)
                })} />
                <Label htmlFor={id} className="min-w-0 flex-1 cursor-pointer truncate font-mono text-[0.8125rem] font-normal">{r.fullName}</Label>
                {r.private ? <Badge variant="outline" className="font-normal text-muted-foreground">private</Badge> : null}
                {!r.admin ? <Badge variant="outline" className="border-warning/50 font-normal text-warning-foreground" title="The token can't change this repository's settings">not admin</Badge> : null}
              </div>
              {p ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-7">
                  <SmallSwitch label="Onboarding pull request" checked={p.onboard} onChange={(v) => update(() => { p.onboard = v })} />
                  <SmallSwitch label="Repository settings" checked={p.applySettings} onChange={(v) => update(() => { p.applySettings = v })} />
                  <span className="text-xs text-muted-foreground">branch <span className="font-mono">{p.branch}</span></span>
                </div>
              ) : null}
              {p && acc?.missing.length ? <p className="pl-7 text-xs text-warning-foreground">The token is missing: {acc.missing.join(', ')}.</p> : null}
            </div>
          )
        })}
      </div>
      {shown.length > 300 ? <p className="text-xs text-muted-foreground">Showing 300 of {shown.length}: filter to find the rest.</p> : null}
    </Section>
  )
}

function SampleCard() {
  const s = useStore()
  const x = s.sample
  const owner = ownerOf(s)
  const repo = sampleRepo(s)
  const name = x.name.trim() ? repoSlug(x.name, owner) : `${owner || 'owner'}/trace-sample`
  const err = x.name.trim() ? newRepoError(x.name, owner, (r) => repoList(s).some((t) => t.fullName.toLowerCase() === r.toLowerCase())) : repoList(s).some((t) => t.fullName.toLowerCase() === name.toLowerCase()) ? `${name} exists already: choose another name.` : ''
  const add = (): void => {
    update((st) => {
      for (const [r, p] of st.projects) if (p.create?.template === 'sample') st.projects.delete(r)
      st.projects.set(name, { branch: 'main', onboard: true, applySettings: true, memoryDays: '', generation: 0, create: { template: 'sample', private: x.private } })
      st.sample.repo = name
    })
  }
  return (
    <div className="grid gap-3 rounded-lg border p-4">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="grid gap-1">
          <p className="text-sm font-semibold">Sample project <Badge variant="secondary" className="ml-1 align-middle">recommended for a first install</Badge></p>
          <p className="text-xs text-muted-foreground">A small, finished sensor board in a new repository. Once installed, a tour runs every agent and every simulation once (circuit, logic, thermal, electromagnetic, autorouting, firmware, hardware in the loop), so you see the whole system work before bringing your own design.</p>
        </div>
      </div>
      {repo ? (
        <div className="grid gap-2">
          <div className="flex items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]">{repo}</span>
            <span className="text-xs text-muted-foreground">{x.gone ? 'created again when installing' : s.projects.get(repo)?.create ? 'created when installing' : 'installed earlier'}</span>
            {s.projects.get(repo)?.create ? <Button variant="ghost" size="icon-xs" aria-label="Remove the sample" onClick={() => update((st) => { st.projects.delete(repo); st.sample.repo = ''; st.sample.gone = false })}><X /></Button> : null}
          </div>
          {x.gone ? (
            <Note tone="info" title={`${repo} is no longer on GitHub`}>
              <p>It was deleted, or this token can't see it. Installing creates it again and fills it with the sample, and its project in trace carries on. Remove it here to leave the sample out instead.</p>
              <p>If it still exists, give the token access to it and check the token again on the GitHub step.</p>
            </Note>
          ) : null}
          <Toggle label="Start the tour once installed" checked={x.tour} onChange={(v) => update((st) => { st.sample.tour = v })}
            description="It runs on AWS like any other work, so it costs what that work costs (graphics card and CPU jobs most of all)." />
        </div>
      ) : (
        <div className="grid items-start gap-3 sm:grid-cols-[1fr_auto_auto]">
          <TextField id="sample.name" label="New repository" mono value={x.name} placeholder={`${owner || 'owner'}/trace-sample`} error={err}
            onChange={(v) => update((st) => { st.sample.name = v })} hint="The installer creates it." />
          <label className="flex h-9 items-center gap-2 text-sm sm:mt-[1.375rem]"><Switch checked={x.private} onCheckedChange={(v) => update((st) => { st.sample.private = v })} />Private</label>
          <Button variant="outline" className="sm:mt-[1.375rem]" disabled={Boolean(err) || !owner && !x.name.includes('/')} onClick={add}><Plus />Add the sample</Button>
        </div>
      )}
    </div>
  )
}

function NewProject() {
  const s = useStore()
  const n = s.newRepo
  const owner = ownerOf(s)
  const taken = (r: string): boolean => repoList(s).some((t) => t.fullName.toLowerCase() === r.toLowerCase()) || s.projects.has(r)
  const err = newRepoError(n.name, owner, taken)
  const created = [...s.projects].filter(([, p]) => p.create && p.create.template !== 'sample')
  return (
    <Section title="Start a new project" description="A new repository, created and filled from a starter when installing.">
      <div className="grid items-start gap-3 sm:grid-cols-[1fr_10rem_auto_auto]">
        <TextField id="newRepo.name" label="Repository" mono value={n.name} placeholder={`${owner || 'owner'}/new-board`} error={err}
          onChange={(v) => update((x) => { x.newRepo.name = v })} hint={n.name && !n.name.includes('/') && owner ? `Becomes ${owner}/${n.name.trim()}.` : undefined} />
        <Choice label="Starts from" value={n.template} options={TEMPLATES} onChange={(v) => update((x) => { x.newRepo.template = v })} />
        <label className="flex h-9 items-center gap-2 text-sm sm:mt-[1.375rem]"><Switch checked={n.private} onCheckedChange={(v) => update((x) => { x.newRepo.private = v })} />Private</label>
        <Button variant="outline" className="sm:mt-[1.375rem]" disabled={!n.name.trim() || Boolean(err)} onClick={() => update((x) => {
          x.projects.set(repoSlug(n.name, owner), { branch: 'main', onboard: true, applySettings: true, memoryDays: '', generation: 0, create: { template: n.template, private: n.private } })
          x.newRepo.name = ''
        })}><Plus />Add</Button>
      </div>
      {created.map(([r, p]) => (
        <div key={r} className="flex items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]">{r}</span>
          <span className="text-xs text-muted-foreground">new, from the {TEMPLATES.find((t) => t.value === p.create?.template)?.label ?? p.create?.template} starter, {p.create?.private ? 'private' : 'public'}</span>
          <Button variant="ghost" size="icon-xs" aria-label={`Remove ${r}`} onClick={() => update((x) => { x.projects.delete(r) })}><X /></Button>
        </div>
      ))}
    </Section>
  )
}

export function ProjectsStep() {
  const s = useStore()
  const dropped = s.dropped.filter((r) => !s.projects.has(r))
  const fresh = preCurrent(s)
  const findings = fresh ? (s.pre?.checks ?? []).filter((c) => isRepoCheck(c) && s.projects.has(c.title)) : []
  const fails = findings.filter((c) => c.status === 'fail')
  return (
    <>
      {dropped.length ? (
        <Note tone="warn" title={`${dropped.length === 1 ? 'A project' : `${dropped.length} projects`} from the last installation ${dropped.length === 1 ? 'is' : 'are'} no longer on GitHub`}>
          <p><span className="font-mono">{dropped.join(', ')}</span>: deleted, or this token can't see {dropped.length === 1 ? 'it' : 'them'}. Left out, installing removes {dropped.length === 1 ? 'its' : 'their'} agents and runners from trace (data is kept when Keep the data is on).</p>
          <p>To keep {dropped.length === 1 ? 'it' : 'them'}, give the token access and check it again on the GitHub step.</p>
        </Note>
      ) : null}
      <RepoPicker />
      <SampleCard />
      <NewProject />
      {s.projects.size ? (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {fresh && !s.preBusy ? <span className="text-xs text-muted-foreground">{fails.length ? `${fails.length} can't be installed as they are.` : 'The token can do what trace needs in each one.'}</span>
              : !s.preBusy ? <span className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin text-primary" />Checking access to the projects chosen…</span> : null}
            {!s.preBusy && (fresh || s.preError) ? <Button variant="ghost" size="xs" onClick={() => void runPreflight()}><RefreshCw />Check again</Button> : null}
          </div>
          <CheckProgress />
          {s.preError && !s.preBusy ? <Note tone="fail" title="The checks could not run">{s.preError}</Note> : null}
          {findings.filter((c) => c.status !== 'ok').map((c) => <Finding key={`${c.id}:${c.detail}`} c={c} />)}
        </div>
      ) : (
        <Note tone="info">No projects chosen: trace installs without any, and you add them later by running the installer again.</Note>
      )}
      {get().projects.size > 60 ? <Note tone="fail">At most 60 projects per installation.</Note> : null}
    </>
  )
}
