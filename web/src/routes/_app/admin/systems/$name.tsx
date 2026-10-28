/**
 * One connected system (/admin/systems/:name). Summary first: its status, what it can do, when it was last used.
 * Then its Projects (part on each; add, remove, change part: a read-only system is always a reviewer), its Keys
 * (secret ids and dates, never values; Rotate shows a new secret once; Retire the old one, recommended once the
 * system uses the new one), its History (services.history), and a danger zone: Disable or Enable, and Delete with
 * the name typed to confirm.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { KeyRound, Loader2, Plus, RotateCw, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Column, Section } from '@/components/shell/app-shell'
import { useCrumb } from '@/components/shell/breadcrumbs'
import { KeysSheet, PART_LINES, ScopeChoice } from '@/components/services/create-sheet'
import { DeleteDialog } from '@/components/services/delete-dialog'
import { CopyButton } from '@/components/services/keys-panel'
import { ExternalOff } from '@/components/services/external-off'
import { EmptyState, Loading, QueryError, SkeletonRows } from '@/components/states'
import { StatusBadge } from '@/components/status-badge'
import { useTraceContext } from '@/components/chat/context'
import { call, projectName } from '@/lib/api'
import { ago } from '@/lib/format'
import { q, useProjects } from '@/lib/queries'
import { type Scope, SCOPE_WORDS, type Service, type ShownKeys, canWords, isExternalOff, partsFor, scopeOf, scopesFor } from '@/lib/services'
import type { Part } from '@/lib/types'
import { useServices } from '@/components/services/use-services'

export const Route = createFileRoute('/_app/admin/systems/$name')({
  staticData: { crumb: ({ name }) => name ?? 'System', parent: { label: 'Connected systems', to: '/admin/systems' } },
  component: SystemPage,
})

const when = (at: string) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

function SystemPage() {
  const { name } = Route.useParams()
  const services = useServices()
  useCrumb('/_app/admin/systems/$name', name)
  const s = services.data?.services.find((x) => x.name === name)
  useTraceContext(s ? { label: s.name, description: 'The connected system the admin is looking at', value: { name: s.name, scopes: s.scopes, disabled: s.disabled, projects: s.projects } } : null, 'system')

  if (services.isError && isExternalOff(services.error)) return <Column><ExternalOff /></Column>
  if (services.isError) return <Column><QueryError error={services.error} what={`the connected system ${name}`} onRetry={() => void services.refetch()} /></Column>
  if (services.isLoading) return <Column><Loading><SkeletonRows rows={4} /></Loading></Column>
  if (!s) {
    return (
      <Column>
        <EmptyState action={<Button asChild variant="outline"><Link to="/admin/systems">All connected systems</Link></Button>}>
          There is no connected system called {name}. It may have been deleted.
        </EmptyState>
      </Column>
    )
  }
  return <System s={s} tokenUrl={services.data?.token_url} />
}

function System({ s, tokenUrl }: { s: Service; tokenUrl?: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const projects = useProjects()
  const [busy, setBusy] = useState<string | null>(null)
  const [keys, setKeys] = useState<ShownKeys | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [scopeAsk, setScopeAsk] = useState<Scope | null>(null)
  const scope = scopeOf(s.scopes)
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['services.list'] }), qc.invalidateQueries({ queryKey: ['services.history'] })])

  const act = async (id: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(id)
    try {
      await fn()
      toast(done)
      await refresh()
    } catch (e) {
      toast.error(`${e instanceof Error ? e.message : String(e)}. Nothing changed.`)
    } finally {
      setBusy(null)
    }
  }

  const rotate = async () => {
    setBusy('rotate')
    try {
      const r = await call('services.rotate', { name: s.name })
      setKeys({ name: s.name, scopes: s.scopes, client_id: s.client_id, secret: r.secret, secret_id: r.secret_id, token_url: r.token_url ?? tokenUrl, api_url: r.api_url, mcp_url: r.mcp_url, resource_server: r.resource_server })
      await refresh()
    } catch (e) {
      toast.error(`Could not make a new secret: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const secrets = [...(s.secrets ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const newest = secrets[secrets.length - 1]
  const others = (projects.data ?? []).map((p) => p.repo).filter((r) => !s.projects.some((p) => p.repo === r))

  return (
    <Column>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="break-all font-mono text-2xl font-semibold tracking-tight">{s.name}</h1>
          <p className="mt-1 text-[15px] text-muted-foreground">{s.description || 'No description.'}</p>
        </div>
        <StatusBadge status={s.disabled ? 'paused' : 'done'} label={s.disabled ? 'Disabled' : 'Active'} className="mt-1.5" />
      </div>

      {/* summary first */}
      <div className="mt-6 rounded-xl border p-4 md:p-6" data-testid="system-summary">
        <p className="text-[15px]">
          {s.disabled
            ? <><strong className="font-semibold">Disabled:</strong> its keys are refused. Enable it below to let it in again.</>
            : <><strong className="font-semibold">{SCOPE_WORDS[scope].label}</strong> on {s.projects.length ? `${s.projects.length} project${s.projects.length === 1 ? '' : 's'}` : 'no projects yet, so it sees nothing'}. Last used {s.last_used ? ago(s.last_used) : 'never'}.</>}
        </p>
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <div><dt className="text-muted-foreground">Status</dt><dd className="mt-0.5">{s.disabled ? 'Disabled' : 'Active'}</dd></div>
          <div><dt className="text-muted-foreground">Can</dt><dd className="mt-0.5">{canWords(s.scopes)}</dd></div>
          <div><dt className="text-muted-foreground">Last used</dt><dd className="mt-0.5">{s.last_used ? ago(s.last_used) : 'Never'}</dd></div>
        </dl>
        <div className="mt-4 flex items-center gap-2 border-t pt-3 text-sm">
          <span className="text-muted-foreground">Client id</span>
          <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{s.client_id}</code>
          <CopyButton value={s.client_id} label="client id" />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Connected {when(s.created_at)} by {s.created_by}.</p>
      </div>

      <Section label="What it may do" className="mt-10">
        <ScopeChoice idPrefix="detail-scope" value={scope} onChange={(v) => v !== scope && setScopeAsk(v)} />
      </Section>

      <Section label="Projects" count={s.projects.length}>
        {s.projects.length === 0 ? (
          <EmptyState>Not on any project, so it sees nothing yet. Put it on one below.</EmptyState>
        ) : (
          <ul className="divide-y rounded-xl border">
            {s.projects.map((p) => (
              <li key={p.repo} className="flex flex-wrap items-center gap-3 p-3">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{projectName(p.repo)}</span>
                  <span className="block text-xs text-muted-foreground">{p.repo}</span>
                </span>
                {scope === 'write' ? (
                  <Select value={p.part} onValueChange={(v) => void act(`part-${p.repo}`, () => call('services.assign', { name: s.name, repo: p.repo, part: v as Part }), `${s.name} is now a ${v} on ${projectName(p.repo)}.`)} disabled={busy === `part-${p.repo}`}>
                    <SelectTrigger size="sm" className="w-36" aria-label={`Part on ${projectName(p.repo)}`}><SelectValue /></SelectTrigger>
                    <SelectContent>{partsFor(scope).map((x) => <SelectItem key={x} value={x}>{PART_LINES[x].label}</SelectItem>)}</SelectContent>
                  </Select>
                ) : (
                  <span className="text-sm">Reviewer</span>
                )}
                <Button variant="ghost" size="icon" aria-label={`Take it off ${projectName(p.repo)}`} disabled={busy === `off-${p.repo}`} onClick={() => void act(`off-${p.repo}`, () => call('services.unassign', { name: s.name, repo: p.repo }), `${s.name} is off ${projectName(p.repo)}.`)}>
                  {busy === `off-${p.repo}` ? <Loader2 className="animate-spin" /> : <X />}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <AddProject others={others} scope={scope} busy={busy === 'add'} onAdd={(repo, part) => void act('add', () => call('services.assign', { name: s.name, repo, part }), `${s.name} is on ${projectName(repo)} as a ${part}.`)} />
        <p className="mt-2 text-xs text-muted-foreground">{scope === 'read' ? 'A read-only system is always a reviewer.' : `Contributor: ${PART_LINES.contributor.line.toLowerCase()} Reviewer: ${PART_LINES.reviewer.line.toLowerCase()}`}</p>
      </Section>

      <Section label="Keys" action={<Button size="sm" variant="outline" onClick={() => void rotate()} disabled={busy === 'rotate' || secrets.length >= 2} title={secrets.length >= 2 ? 'It already has two secrets: retire the old one first' : undefined}>{busy === 'rotate' ? <Loader2 className="animate-spin" /> : <RotateCw />} Make a new secret</Button>}>
        {secrets.length >= 2 && (
          <div className="mb-3 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
            <p><strong className="font-semibold">Retire the older secret once {s.name} uses the new one.</strong> Two secrets work at once so the system can switch without stopping; leaving the old one in place keeps a key you no longer need. A system can have two secrets at most, so retire the old one before making another.</p>
          </div>
        )}
        {secrets.length === 0 ? (
          <p className="text-sm text-muted-foreground">The secrets are not listed by this installation.</p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {secrets.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-3 p-3">
                <KeyRound className="size-4 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-[13px]">{x.id}</span>
                  <span className="block text-xs text-muted-foreground">Made {when(x.created_at)}{x === newest && secrets.length > 1 ? ' · newest' : ''}</span>
                </span>
                {secrets.length > 1 && x !== newest && (
                  <Button size="sm" variant="outline" disabled={busy === `retire-${x.id}`} onClick={() => void act(`retire-${x.id}`, () => call('services.retire_secret', { name: s.name, secret_id: x.id }), 'The old secret is retired: it no longer gets a token.')}>
                    {busy === `retire-${x.id}` && <Loader2 className="animate-spin" />}Retire old secret
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">Secret values are shown once, when they are made, and never again. Lost one? Make a new secret, switch the system to it, then retire the old one.</p>
      </Section>

      <Section label="History">
        <History name={s.name} />
      </Section>

      <Section label="Danger zone">
        <div className="divide-y rounded-xl border border-destructive/30">
          <div className="flex flex-wrap items-center gap-3 p-4">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{s.disabled ? 'Enable this system' : 'Disable this system'}</p>
              <p className="text-sm text-muted-foreground">{s.disabled ? 'Its keys work again at once.' : 'Its keys stop working within 30 seconds. Nothing is deleted; you can enable it again.'}</p>
            </div>
            <Button variant="outline" disabled={busy === 'disable'} onClick={() => void act('disable', () => call('services.update', { name: s.name, disabled: !s.disabled }), s.disabled ? `${s.name} is enabled.` : `${s.name} is disabled: its keys stop working within 30 seconds.`)}>
              {busy === 'disable' && <Loader2 className="animate-spin" />}{s.disabled ? 'Enable' : 'Disable'}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3 p-4">
            <div className="min-w-0 flex-1">
              <p className="font-medium">Delete this system</p>
              <p className="text-sm text-muted-foreground">Removes its keys and takes it off every project. This can't be undone. To stop it for now, disable it instead.</p>
            </div>
            <Button variant="destructive" onClick={() => setDeleting(true)}><Trash2 /> Delete</Button>
          </div>
        </div>
      </Section>

      <KeysSheet keys={keys} onDone={() => setKeys(null)} />
      <DeleteDialog name={s.name} open={deleting} onOpenChange={setDeleting} onDeleted={() => { void qc.invalidateQueries({ queryKey: ['services.list'] }); void navigate({ to: '/admin/systems' }) }} />
      <AlertDialog open={!!scopeAsk} onOpenChange={(o) => !o && setScopeAsk(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{scopeAsk === 'write' ? `Let ${s.name} read and change?` : `Make ${s.name} read only?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {scopeAsk === 'write'
                ? 'It will be able to start work and change settings on projects where you make it a contributor. It stays a reviewer on its projects until you change its part. Read only is safer if it only needs to look.'
                : 'It becomes a reviewer on every project it is on, and tokens it already holds that could change things stop working at once. Recommended unless it needs to start work.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button onClick={() => { const v = scopeAsk!; setScopeAsk(null); void act('scope', () => call('services.update', { name: s.name, scopes: scopesFor(v) }), `${s.name} can now ${v === 'write' ? 'read and change' : 'only read'}.`) }}>
              {scopeAsk === 'write' ? 'Let it read and change' : 'Make it read only'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Column>
  )
}

function AddProject({ others, scope, busy, onAdd }: { others: string[]; scope: Scope; busy: boolean; onAdd: (repo: string, part: Part) => void }) {
  const [repo, setRepo] = useState<string>('')
  const [part, setPart] = useState<Part>('reviewer')
  if (!others.length) return null
  const p = scope === 'read' ? 'reviewer' : part
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Select value={repo} onValueChange={setRepo}>
        <SelectTrigger size="sm" className="w-56" aria-label="Project to put it on"><SelectValue placeholder="Put it on a project…" /></SelectTrigger>
        <SelectContent>{others.map((r) => <SelectItem key={r} value={r}>{projectName(r)}</SelectItem>)}</SelectContent>
      </Select>
      {scope === 'write' ? (
        <Select value={part} onValueChange={(v) => setPart(v as Part)}>
          <SelectTrigger size="sm" className="w-36" aria-label="Its part on that project"><SelectValue /></SelectTrigger>
          <SelectContent>{partsFor(scope).map((x) => <SelectItem key={x} value={x}>{PART_LINES[x].label}</SelectItem>)}</SelectContent>
        </Select>
      ) : <span className="text-sm text-muted-foreground">as a reviewer</span>}
      <Button size="sm" disabled={!repo || busy} onClick={() => { onAdd(repo, p); setRepo('') }}>{busy ? <Loader2 className="animate-spin" /> : <Plus />} Add</Button>
    </div>
  )
}

function History({ name }: { name: string }) {
  const h = useQuery({ ...q('services.history', { name }), retry: false })
  if (h.isError) return <p className="text-sm text-muted-foreground">Its history could not be read: {h.error instanceof Error ? h.error.message : String(h.error)}</p>
  if (!h.data) return <Loading><SkeletonRows rows={2} /></Loading>
  if (!h.data.entries.length) return <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
  return (
    <ul className="space-y-1.5 text-sm">
      {h.data.entries.slice(0, 50).map((e, i) => <li key={`${e.at}-${i}`}><span className="text-muted-foreground">{ago(e.at)}: </span>{e.text}</li>)}
    </ul>
  )
}
