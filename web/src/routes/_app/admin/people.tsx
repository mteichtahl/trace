/**
 * Admin › People and access (docs/ui-design.md, "Admin"). A Data table of people: name and email, account class as a
 * dropdown (users.class; making someone an Admin asks first and says what it grants; nobody can remove their own
 * Admin class), the projects they are on as chips with their part on each, and when they were last seen. Invite opens
 * a sheet: email, class, and per project the part (users.invite, then assign with the part). A row opens the person:
 * their class, projects and parts to change, and their history.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Loader2, Lock, MoreHorizontal, Plus, UserPlus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DataTable, Highlight, useUrlView } from '@/components/data-table'
import { Column } from '@/components/shell/app-shell'
import { useCommands } from '@/components/shell/command-menu'
import { SideSheet } from '@/components/side-sheet'
import { Loading, QueryError, SkeletonRows } from '@/components/states'
import { useTraceContext } from '@/components/chat/context'
import { call, projectName } from '@/lib/api'
import type { UserRow } from '@/lib/admin-types'
import { useAuth } from '@/lib/auth'
import { ago, initials, plural } from '@/lib/format'
import { q, useAction, useProjects } from '@/lib/queries'
import type { Part, PersonClass } from '@/lib/types'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/admin/people')({
  staticData: { crumb: 'People and access' },
  validateSearch: z.record(z.string(), z.unknown()),
  component: People,
})

export const CLASS_WORDS: Record<PersonClass, { label: string; line: string }> = {
  admin: { label: 'Admin', line: 'On every project; signs gates, approves spend, manages people.' },
  user: { label: 'User', line: 'Can be a Contributor or a Reviewer on each project.' },
  guest: { label: 'Guest', line: 'Can only be a Reviewer.' },
}
export const PART_WORDS: Record<Part, { label: string; line: string }> = {
  contributor: { label: 'Contributor', line: 'Changes the design, answers questions, runs tools.' },
  reviewer: { label: 'Reviewer', line: 'Reads everything and comments at gates.' },
}

/** The class is a ceiling: a guest can only review; an admin is on every project. */
export function allowedParts(cls: PersonClass): Part[] {
  return cls === 'guest' ? ['reviewer'] : ['contributor', 'reviewer']
}

/** May the signed-in person change this row's class to `to`? Nobody removes their own Admin class. */
export function classChangeAllowed(me: string | undefined, row: Pick<UserRow, 'sub' | 'class'>, to: PersonClass): boolean {
  if (row.sub === me && row.class === 'admin' && to !== 'admin') return false
  return true
}

/** Several addresses in one field, separated by commas, spaces or new lines. */
export function parseEmails(text: string): { ok: string[]; bad: string[] } {
  const all = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return { ok: [...new Set(all.filter((e) => re.test(e)))], bad: all.filter((e) => !re.test(e)) }
}

interface Row extends UserRow {
  person: string
  classWord: string
  projectWords: string
  seen: string
  seenAt: number
}

function seenOf(u: UserRow): { text: string; at: number } {
  if (u.lastSeen) return { text: ago(u.lastSeen), at: Date.parse(u.lastSeen) }
  if (u.status === 'FORCE_CHANGE_PASSWORD') return { text: 'Invitation not accepted yet', at: 0 }
  return { text: 'Not reported', at: 0 }
}

function People() {
  const users = useAction('users.list', {})
  const projects = useProjects()
  const { user: me } = useAuth()
  const url = useUrlView('people')
  const qc = useQueryClient()
  const [invite, setInvite] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ row: UserRow; to: PersonClass } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const list = (users.data ?? []) as UserRow[]
  const rows: Row[] = useMemo(
    () => list.map((u) => {
      const s = seenOf(u)
      const name = u.name ?? u.email.split('@')[0]!.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      return {
        ...u, name, person: `${name} ${u.email}`, classWord: u.class ? CLASS_WORDS[u.class].label : 'No class',
        projectWords: u.class === 'admin' ? 'Every project' : (u.parts ?? u.projects.map((repo) => ({ repo, part: 'contributor' as Part }))).map((p) => `${projectName(p.repo)} ${p.part}`).join(', '),
        seen: s.text, seenAt: s.at,
      }
    }),
    [list],
  )
  const waiting = list.filter((u) => u.status === 'FORCE_CHANGE_PASSWORD').length

  const setClass = async (row: UserRow, to: PersonClass) => {
    setBusy(row.sub)
    try {
      await call('users.class', { who: row.sub, class: to })
      toast(`${row.email} is now ${CLASS_WORDS[to].label === 'Admin' ? 'an Admin' : `a ${CLASS_WORDS[to].label}`}. It takes effect when their sign-in next refreshes, within an hour.`)
      await qc.invalidateQueries({ queryKey: ['users.list'] })
    } catch (e) {
      toast.error(`Could not change ${row.email}'s class: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }
  const askClass = (row: UserRow, to: PersonClass) => {
    if (to === row.class) return
    if (to === 'admin') setConfirm({ row, to })
    else void setClass(row, to)
  }

  useTraceContext({ label: 'People and access', description: 'The screen the person is on: Admin, people and their access', value: { people: list.length, waitingInvitations: waiting } }, 'screen')
  useTraceContext(open ? { label: rows.find((r) => r.sub === open)?.email ?? open, description: 'The person whose access is open', value: { sub: open } } : null, 'person')
  useCommands([{ id: 'people-invite', label: 'Invite people', group: 'Admin', icon: UserPlus, keywords: ['add', 'person', 'user'], run: () => setInvite(true) }])

  const columns: ColumnDef<Row, any>[] = [
    {
      accessorKey: 'person', header: 'Person', size: 250, meta: { label: 'Person', kind: 'text' },
      cell: ({ row: { original: r } }) => (
        <div className="flex items-center gap-3">
          <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold', !r.lastSeen && r.status === 'FORCE_CHANGE_PASSWORD' && 'border border-dashed bg-transparent')}>{initials(r.name ?? r.email)}</span>
          <span className="min-w-0">
            <span className="block truncate font-medium"><Highlight text={r.name ?? r.email} />{r.sub === me?.sub && <span className="font-normal text-muted-foreground"> (you)</span>}</span>
            <span className="block truncate text-xs text-muted-foreground"><Highlight text={r.email} /></span>
          </span>
        </div>
      ),
    },
    {
      accessorKey: 'classWord', header: 'Class', size: 140, meta: { label: 'Class', kind: 'enum', options: ['Admin', 'User', 'Guest', 'No class'] },
      cell: ({ row: { original: r } }) => {
        const own = r.sub === me?.sub && r.class === 'admin'
        return (
          <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5">
            <Select value={r.class ?? undefined} onValueChange={(v) => askClass(r, v as PersonClass)} disabled={busy === r.sub}>
              <SelectTrigger size="sm" className="w-28" aria-label={`${r.email}'s class`}>
                <SelectValue placeholder="No class" />
              </SelectTrigger>
              <SelectContent>
                {(['admin', 'user', 'guest'] as const).map((c) => (
                  <SelectItem key={c} value={c} disabled={!classChangeAllowed(me?.sub, r, c)}>{CLASS_WORDS[c].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {busy === r.sub && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Saving" />}
            {own && (
              <Tooltip>
                <TooltipTrigger asChild><Lock className="size-3.5 text-muted-foreground" aria-label="Why it is locked" /></TooltipTrigger>
                <TooltipContent>You cannot remove your own Admin class. Another admin can.</TooltipContent>
              </Tooltip>
            )}
          </div>
        )
      },
    },
    {
      accessorKey: 'projectWords', header: 'Projects', size: 300, meta: { label: 'Projects', kind: 'text' },
      cell: ({ row: { original: r } }) =>
        r.class === 'admin' ? (
          <Badge variant="outline" className="rounded-md font-normal">Every project</Badge>
        ) : (r.parts ?? []).length === 0 && r.projects.length === 0 ? (
          <span className="text-xs text-muted-foreground">Not on a project yet</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {(r.parts ?? r.projects.map((repo) => ({ repo, part: 'contributor' as Part }))).map((p) => (
              <Badge key={p.repo} variant="outline" className="rounded-md font-normal">
                {projectName(p.repo)} <span className="text-muted-foreground">· {PART_WORDS[p.part].label}</span>
              </Badge>
            ))}
          </div>
        ),
    },
    { accessorKey: 'seenAt', header: 'Last seen', size: 150, meta: { label: 'Last seen', kind: 'number' }, cell: ({ row: { original: r } }) => <span className={cn(!r.lastSeen && 'text-xs text-muted-foreground')}>{r.seen}</span> },
    {
      id: 'actions', header: '', size: 56, enableSorting: false, enableHiding: false, meta: { label: 'Actions' },
      cell: ({ row: { original: r } }) => (
        <div onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`More for ${r.email}`}><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setOpen(r.sub)}>Projects and history</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(r.email).then(() => toast('Email copied'))}>Copy email</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ]

  return (
    <Column wide>
      <h1 className="text-2xl font-semibold tracking-tight">People and access</h1>
      {users.data && (
        <p className="mt-1 text-[15px] text-muted-foreground">
          {plural(list.length, 'person', 'people')}.{waiting ? ` ${plural(waiting, 'invitation')} ${waiting === 1 ? 'is' : 'are'} waiting to be accepted.` : ''}
        </p>
      )}
      <div className="mt-6">
        {users.isError ? (
          <QueryError error={users.error} what="the people on this installation" onRetry={() => void users.refetch()} />
        ) : users.isLoading ? (
          <Loading><SkeletonRows rows={4} /></Loading>
        ) : (
          <DataTable
            id="people"
            data={rows}
            columns={columns}
            getRowId={(r) => r.sub}
            url={url}
            noun="people"
            onRowClick={(r) => setOpen(r.sub)}
            defaultView={{ sorting: [{ id: 'person', desc: false }] }}
            actions={<Button onClick={() => setInvite(true)}><Plus /> Invite people</Button>}
            empty="Nobody here yet but you. Invite people to give them a sign-in."
          />
        )}
      </div>

      <InviteSheet open={invite} onOpenChange={setInvite} projects={(projects.data ?? []).map((p) => p.repo)} existing={list.map((u) => u.email)} />
      <PersonSheet row={list.find((u) => u.sub === open) ?? null} me={me?.sub} projects={(projects.data ?? []).map((p) => p.repo)} onClose={() => setOpen(null)} onClass={askClass} />

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make {confirm?.row.email} an Admin?</AlertDialogTitle>
            <AlertDialogDescription>
              An Admin is on every project, can sign every gate, approves spend, and manages people and the installation's instructions and keys. Their project parts no longer apply.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirm && void setClass(confirm.row, 'admin')}>Make an Admin</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Column>
  )
}

interface ProjectChoice { on: boolean; part: Part }

function ProjectParts({ projects, cls, value, onChange }: { projects: string[]; cls: PersonClass; value: Record<string, ProjectChoice>; onChange: (v: Record<string, ProjectChoice>) => void }) {
  if (cls === 'admin') return <p className="rounded-lg border bg-muted/50 p-3 text-sm text-muted-foreground">Admins are on every project, so there is nothing to choose here.</p>
  if (!projects.length) return <p className="text-sm text-muted-foreground">There are no projects yet. Add people to a project when it is created.</p>
  const parts = allowedParts(cls)
  return (
    <div className="space-y-2">
      {projects.map((repo) => {
        const c = value[repo] ?? { on: false, part: parts[0]! }
        const part = parts.includes(c.part) ? c.part : parts[0]!
        return (
          <div key={repo} className={cn('flex items-center gap-3 rounded-lg border p-3', c.on && 'border-primary/60 bg-primary/5')}>
            <Checkbox id={`pp-${repo}`} checked={c.on} onCheckedChange={(v) => onChange({ ...value, [repo]: { on: !!v, part } })} />
            <Label htmlFor={`pp-${repo}`} className="flex-1 font-medium">{projectName(repo)}</Label>
            {c.on ? (
              parts.length > 1 ? (
                <Select value={part} onValueChange={(v) => onChange({ ...value, [repo]: { on: true, part: v as Part } })}>
                  <SelectTrigger size="sm" className="w-32" aria-label={`Part on ${projectName(repo)}`}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {parts.map((p) => <SelectItem key={p} value={p}>{PART_WORDS[p].label}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : (
                <span className="text-sm">Reviewer</span>
              )
            ) : (
              <span className="text-xs text-muted-foreground">Not added</span>
            )}
          </div>
        )
      })}
      <p className="text-xs text-muted-foreground">
        {cls === 'guest' ? 'A Guest can only be a Reviewer: reads everything and comments at gates.' : `Contributor: ${PART_WORDS.contributor.line.toLowerCase()} Reviewer: ${PART_WORDS.reviewer.line.toLowerCase()}`}
      </p>
    </div>
  )
}

function ClassChoice({ value, onChange, disabled }: { value: PersonClass; onChange: (c: PersonClass) => void; disabled?: (c: PersonClass) => boolean }) {
  return (
    <RadioGroup value={value} onValueChange={(v) => onChange(v as PersonClass)} className="gap-2">
      {(['admin', 'user', 'guest'] as const).map((c) => (
        <Label key={c} htmlFor={`cls-${c}`} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5', disabled?.(c) && 'cursor-not-allowed opacity-50')}>
          <RadioGroupItem id={`cls-${c}`} value={c} className="mt-0.5" disabled={disabled?.(c)} />
          <span>
            <span className="block font-medium">{CLASS_WORDS[c].label}</span>
            <span className="block text-sm text-muted-foreground">{CLASS_WORDS[c].line}</span>
          </span>
        </Label>
      ))}
    </RadioGroup>
  )
}

function InviteSheet({ open, onOpenChange, projects, existing }: { open: boolean; onOpenChange: (o: boolean) => void; projects: string[]; existing: string[] }) {
  const qc = useQueryClient()
  const [emails, setEmails] = useState('')
  const [cls, setCls] = useState<PersonClass>('user')
  const [chosen, setChosen] = useState<Record<string, ProjectChoice>>({})
  const [sending, setSending] = useState(false)
  const parsed = parseEmails(emails)
  const already = parsed.ok.filter((e) => existing.includes(e))
  const ready = parsed.ok.length > 0 && parsed.bad.length === 0 && already.length === 0
  const reset = () => { setEmails(''); setCls('user'); setChosen({}) }

  const send = async () => {
    setSending(true)
    const failed: string[] = []
    for (const email of parsed.ok) {
      try {
        const u = await call('users.invite', { email, class: cls })
        if (cls !== 'admin') {
          for (const [repo, c] of Object.entries(chosen)) {
            if (c.on) await call('assign', { who: u.sub, repo, part: cls === 'guest' ? 'reviewer' : c.part })
          }
        }
      } catch (e) {
        failed.push(`${email}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setSending(false)
    await qc.invalidateQueries({ queryKey: ['users.list'] })
    if (failed.length) toast.error(`Could not invite ${failed.join('; ')}`)
    const sent = parsed.ok.length - failed.length
    if (sent) {
      toast(`${plural(sent, 'invitation')} sent. They get an email with a sign-in link.`)
      reset()
      onOpenChange(false)
    }
  }

  return (
    <SideSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Invite people"
      description="They get an email with a sign-in link. You can change their class and projects at any time."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!ready || sending} onClick={() => void send()}>
            {sending && <Loader2 className="animate-spin" />}
            {parsed.ok.length > 1 ? `Send ${parsed.ok.length} invitations` : 'Send invitation'}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <div className="space-y-1.5">
          <Label htmlFor="invite-email">Email</Label>
          <Input id="invite-email" type="text" inputMode="email" autoComplete="off" placeholder="sam.okafor@example.com" value={emails} onChange={(e) => setEmails(e.target.value)} aria-invalid={parsed.bad.length > 0 || already.length > 0} />
          <p className="text-xs text-muted-foreground">Separate several addresses with commas.</p>
          {parsed.bad.length > 0 && <p className="text-xs text-destructive">Not an email address: {parsed.bad.join(', ')}</p>}
          {already.length > 0 && <p className="text-xs text-destructive">Already has a sign-in: {already.join(', ')}. Change their class in the table instead.</p>}
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Account class <span className="font-normal text-muted-foreground">· the most they can be on any project</span></p>
          <ClassChoice value={cls} onChange={setCls} />
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Projects and their part</p>
          <ProjectParts projects={projects} cls={cls} value={chosen} onChange={setChosen} />
        </div>
      </div>
    </SideSheet>
  )
}

/** Who added them where, and every part and class change, from the assignment log (users.history), newest first. */
function History({ who }: { who: string }) {
  const h = useQuery({ ...q('users.history', { who }), retry: false })
  if (h.isError) return <p className="text-xs text-muted-foreground">Their history could not be read: {h.error instanceof Error ? h.error.message : String(h.error)}</p>
  if (!h.data) return <p className="text-xs text-muted-foreground">Reading their history…</p>
  if (!h.data.entries.length) return <p className="text-xs text-muted-foreground">No assignments or class changes recorded.</p>
  return (
    <ul className="space-y-1 text-sm">
      {h.data.entries.slice(0, 30).map((e, i) => <li key={`${e.at}-${i}`}><span className="text-muted-foreground">{ago(e.at)}: </span>{e.text}</li>)}
    </ul>
  )
}

/** One person: change their projects and parts, and their history. */
function PersonSheet({ row, me, projects, onClose, onClass }: { row: UserRow | null; me?: string; projects: string[]; onClose: () => void; onClass: (row: UserRow, to: PersonClass) => void }) {
  const qc = useQueryClient()
  const initial = useMemo(() => Object.fromEntries((row?.parts ?? row?.projects.map((repo) => ({ repo, part: 'contributor' as Part })) ?? []).map((p) => [p.repo, { on: true, part: p.part }])) as Record<string, ProjectChoice>, [row])
  const [chosen, setChosen] = useState<Record<string, ProjectChoice> | null>(null)
  const [saving, setSaving] = useState(false)
  const value = chosen ?? initial
  const changes = projects.filter((repo) => (value[repo]?.on ?? false) !== (initial[repo]?.on ?? false) || (value[repo]?.on && value[repo]?.part !== initial[repo]?.part))

  const save = async () => {
    if (!row) return
    setSaving(true)
    try {
      for (const repo of changes) {
        if (value[repo]?.on) await call('assign', { who: row.sub, repo, part: value[repo]!.part })
        else await call('unassign', { who: row.sub, repo })
      }
      toast(`${row.email}'s projects saved.`)
      setChosen(null)
      await qc.invalidateQueries({ queryKey: ['users.list'] })
    } catch (e) {
      toast.error(`Could not save: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SideSheet
      open={!!row}
      onOpenChange={(o) => { if (!o) { setChosen(null); onClose() } }}
      title={row?.name ?? row?.email ?? ''}
      description={row ? `${row.email}${row.sub === me ? ' (you)' : ''}` : undefined}
      footer={row && row.class !== 'admin' ? (
        <>
          <Button variant="outline" onClick={() => setChosen(null)} disabled={!changes.length || saving}>Discard</Button>
          <Button onClick={() => void save()} disabled={!changes.length || saving}>{saving && <Loader2 className="animate-spin" />}Save {changes.length ? plural(changes.length, 'change') : 'changes'}</Button>
        </>
      ) : undefined}
    >
      {row && (
        <div className="space-y-6">
          <div className="space-y-2">
            <p className="text-sm font-medium">Account class</p>
            <ClassChoice value={row.class ?? 'user'} onChange={(c) => onClass(row, c)} disabled={(c) => !classChangeAllowed(me, row, c)} />
            {row.sub === me && row.class === 'admin' && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Lock className="size-3" /> You cannot remove your own Admin class. Another admin can.</p>}
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">Projects and their part</p>
            <ProjectParts projects={projects} cls={row.class ?? 'user'} value={value} onChange={setChosen} />
          </div>
          <div className="space-y-2">
            <p className="section-label">History</p>
            <ul className="space-y-1 text-sm">
              <li className="text-muted-foreground">{row.status === 'FORCE_CHANGE_PASSWORD' ? 'Invited; has not signed in yet.' : row.lastSeen ? `Last seen ${ago(row.lastSeen)}.` : 'Has a sign-in.'}</li>
            </ul>
            <History who={row.sub} />
          </div>
        </div>
      )}
    </SideSheet>
  )
}
