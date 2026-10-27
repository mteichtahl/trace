/**
 * Agent instructions and system prompts (docs/ui-design.md): every word trace sends a model, entry by entry; the
 * parts trace allows to change can be changed here, previewed in full and reverted. One screen in two places: Admin ›
 * Agent instructions (the installation) and a project's Settings › Agent instructions (that project).
 *
 *   scope       Installation, or a project picked from the person's projects
 *   catalog     entries grouped by the prompt they belong to, with the layer in force or a lock; Editable only,
 *               Changed only and search
 *   entry       description, the layer in force, a markdown editor with Insert variable, live checks (declared
 *               variables only, 16,000 characters), the locked entries that always follow, Compare with the layer
 *               below or an earlier version, Ask trace to improve it, Save with a reason (project scope opens a pull
 *               request and shows Pending), Reset and Revert with a reason
 *   history     every version as a Data table, with Compare and Revert
 *   preview     the whole prompt one agent gets for one kind of job, its parts labelled, locked parts greyed, Copy
 *
 * Actions: prompts.list / get / preview / set / reset / revert / history (src/api/actions.ts).
 */
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Activity, Check, ChevronDown, ChevronRight, Copy, ExternalLink, GitPullRequest, ListTree, Loader2, Lock, Pencil, RotateCcw, Search, Sparkles, TriangleAlert, Variable, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DataTable } from '@/components/data-table'
import { useCommands } from '@/components/shell/command-menu'
import { SideSheet } from '@/components/side-sheet'
import { EmptyState, Loading, Partial, QueryError, SkeletonRows } from '@/components/states'
import { StatusBadge } from '@/components/status-badge'
import { useTraceContext } from '@/components/chat/context'
import { openPanel } from '@/components/chat/chat-state'
import { useMediaQuery } from '@/hooks/use-media-query'
import { askOnce } from '@/lib/agui-once'
import { call, projectId, projectName } from '@/lib/api'
import type { PreviewJob, PromptHistoryEntry, PromptRow, PromptView } from '@/lib/admin-types'
import { useAuth } from '@/lib/auth'
import { type DiffLine, diffCounts, lineDiff } from '@/lib/diff'
import { ago } from '@/lib/format'
import {
  MAX_PROMPT_CHARS, SPECIALIST_TITLES, canSave, checkTemplate, entryTitle, filterRows, groupCatalog, layerBelow, layerLabel, nextVersion, parseMarked, personHash, scopeText, suggestionFrom,
  type CatalogGroup,
} from '@/lib/prompts'
import { q, useAction, useProjects } from '@/lib/queries'
import { cn } from '@/lib/utils'

type Scope = 'installation' | 'project'

export interface PromptsScreenProps {
  /** fixed to one project (a project's Settings); otherwise the person picks Installation or a project */
  repo?: string
  /** the scope to open on (Admin opens on Installation) */
  initialScope?: Scope
}

const keyFor = (scope: Scope, repo: string | undefined) => (scope === 'project' && repo ? { repo } : ({} as Record<string, never>))

interface Pending { version: number; branch?: string; at: number }

export function PromptsScreen({ repo: fixedRepo, initialScope }: PromptsScreenProps) {
  const { user } = useAuth()
  const admin = user?.class === 'admin'
  const projects = useProjects()
  const wide = useMediaQuery('(min-width: 1280px)')
  const md = useMediaQuery('(min-width: 768px)')
  const [scope, setScope] = useState<Scope>(fixedRepo ? 'project' : (initialScope ?? 'installation'))
  const [pickedRepo, setPickedRepo] = useState<string | undefined>(fixedRepo)
  const repo = fixedRepo ?? pickedRepo ?? projects.data?.[0]?.repo
  const myPart = projects.data?.find((p) => p.repo === repo)
  const canEdit = scope === 'installation' ? admin : admin || myPart?.role === 'write'
  const canHistory = scope === 'installation' ? user?.class === 'admin' || user?.class === 'user' : canEdit

  const listArgs = keyFor(scope, repo)
  const list = useAction('prompts.list', listArgs, { enabled: scope === 'installation' || !!repo })
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState({ editableOnly: false, changedOnly: false, text: '' })
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [pending, setPending] = useState<Record<string, Pending>>({})

  const rows = list.data?.prompts ?? []
  const current = selected ?? rows.find((r) => r.mode === 'editable')?.id ?? null

  useTraceContext({ label: 'Agent instructions', description: 'The screen the person is on: the agents\' instructions and system prompts', value: { scope, repo: scope === 'project' ? repo ?? null : null } }, 'screen')
  useCommands([
    { id: 'prompts-installation', label: 'Agent instructions: installation', group: 'Agent instructions', run: () => !fixedRepo && setScope('installation') },
    { id: 'prompts-changed', label: 'Agent instructions: show changed only', group: 'Agent instructions', run: () => setFilter((f) => ({ ...f, changedOnly: true })) },
    ...rows.filter((r) => r.mode === 'editable').map((r) => ({ id: `prompt-${r.id}`, label: `Instruction: ${r.id}`, keywords: [entryTitle(r.id), r.description], group: 'Agent instructions', run: () => setSelected(r.id) })),
  ])

  const scopeWords = scope === 'installation' ? 'Changes here apply to every project at once, for its next job.' : `Changes here apply only to ${repo ? projectName(repo) : 'this project'}, through a pull request someone reviews.`

  const catalog = (
    <Catalog rows={rows} filter={filter} onFilter={setFilter} selected={current} onSelect={(id) => { setSelected(id); setCatalogOpen(false) }} loading={list.isLoading} pending={pending} />
  )

  return (
    <div className="mx-auto w-full max-w-[1480px] px-4 py-6 md:px-6 md:py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Agent instructions</h1>
      <p className="mt-1 max-w-3xl text-[15px] text-muted-foreground">
        Everything trace sends a model, entry by entry. The most specific layer wins: trace's default, then Installation, then Project. Locked parts never change.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {!fixedRepo && (
          <div role="radiogroup" aria-label="Scope" className="inline-flex rounded-lg bg-muted p-[3px]">
            {(['installation', 'project'] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={scope === s}
                disabled={s === 'project' && !projects.data?.length}
                onClick={() => { setScope(s); setSelected(null) }}
                className={cn('rounded-md px-3 py-1 text-sm text-muted-foreground disabled:opacity-50', scope === s && 'bg-background font-medium text-foreground shadow-sm')}
              >
                {s === 'installation' ? 'Installation (all projects)' : `Project${repo ? `: ${projectName(repo)}` : ''}`}
              </button>
            ))}
          </div>
        )}
        {!fixedRepo && scope === 'project' && (
          <Select value={repo} onValueChange={(v) => { setPickedRepo(v); setSelected(null) }}>
            <SelectTrigger className="w-48" aria-label="Project"><SelectValue placeholder="Choose a project" /></SelectTrigger>
            <SelectContent>
              {(projects.data ?? []).map((p) => <SelectItem key={p.repo} value={p.repo}>{projectName(p.repo)}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <span className="text-xs text-muted-foreground">{scopeWords}</span>
      </div>

      {list.data?.problems.map((p) => (
        <div key={`${p.layer}-${p.id}`} role="alert" className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-sm">
          <TriangleAlert className="size-4 shrink-0 text-warning-foreground" aria-hidden />
          <span className="font-medium text-warning-foreground">Warning</span>
          <span className="min-w-0 flex-1">
            An override isn't used: <code className="font-mono text-[0.92em]">{p.id}</code> ({p.layer} v{p.version}) {p.reason}. The layer below is used instead.
          </span>
          <Button size="sm" variant="outline" onClick={() => { if (!fixedRepo) setScope(p.layer); setSelected(p.id) }}>Fix</Button>
        </div>
      ))}
      {list.data?.unavailable?.map((u) => (
        <div key={u.layer} className="mt-3"><Partial onRetry={() => void list.refetch()}>The {u.layer} layer could not be read ({u.reason}), so its overrides are left out below.</Partial></div>
      ))}

      {list.isError ? (
        <div className="mt-6"><QueryError error={list.error} what="the agents' instructions" onRetry={() => void list.refetch()} /></div>
      ) : (
        <div className={cn('mt-6 grid gap-6', wide ? 'grid-cols-[260px_minmax(0,1fr)_340px]' : md ? 'grid-cols-[240px_minmax(0,1fr)]' : 'grid-cols-1')}>
          {md ? (
            <aside className="self-start rounded-xl border bg-card p-3" aria-label="Catalog">{catalog}</aside>
          ) : (
            <>
              <Button variant="outline" className="justify-between" onClick={() => setCatalogOpen(true)}>
                <span className="flex items-center gap-2"><ListTree /> {current ? entryTitle(current) : 'Choose an instruction'}</span>
                <ChevronDown />
              </Button>
              <SideSheet open={catalogOpen} onOpenChange={setCatalogOpen} title="Instructions">{catalog}</SideSheet>
            </>
          )}
          <main className="min-w-0">
            {list.isLoading ? (
              <Loading><SkeletonRows rows={3} /></Loading>
            ) : !current ? (
              <EmptyState>No instruction matches. Clear the filters to see the whole catalog.</EmptyState>
            ) : (
              <Entry
                key={`${scope}:${repo}:${current}`}
                id={current}
                scope={scope}
                repo={repo}
                canEdit={canEdit}
                canHistory={canHistory}
                pending={pending[`${scope}:${repo}:${current}`]}
                onPending={(p) => setPending((x) => ({ ...x, [`${scope}:${repo}:${current}`]: p }))}
              />
            )}
            {!wide && repo && current && (
              <div className="mt-8"><Preview repo={repo} entry={current} rows={rows} /></div>
            )}
          </main>
          {wide && (
            <aside className="min-w-0 self-start xl:sticky xl:top-20" aria-label="Preview">
              {repo && current ? <Preview repo={repo} entry={current} rows={rows} /> : <EmptyState>The preview needs a project to assemble a prompt for.</EmptyState>}
            </aside>
          )}
        </div>
      )}

      <p className="mt-10 border-t pt-4 text-xs text-muted-foreground">
        Anyone can read instructions. Admins change installation instructions; contributors and admins on a project change its instructions. History is hidden from reviewers. Locked parts never change.
      </p>
    </div>
  )
}

// ------------------------------------------------------------------ the catalog

function LayerBadge({ row, pending }: { row: PromptRow; pending?: boolean }) {
  if (row.mode === 'locked') return <Lock className="size-3.5 text-muted-foreground" aria-label="Locked" />
  return (
    <span className="flex items-center gap-1">
      {pending && <span className="size-1.5 rounded-full bg-warning" aria-label="A change is pending review" />}
      <span className={cn('rounded border px-1.5 text-[11px] leading-5', row.layer === 'default' ? 'border-transparent text-muted-foreground' : row.layer === 'project' ? 'border-primary/30 text-primary' : 'text-foreground/80')}>
        {layerLabel(row.layer, row.version)}
      </span>
    </span>
  )
}

function Catalog({
  rows, filter, onFilter, selected, onSelect, loading, pending,
}: {
  rows: PromptRow[]
  filter: { editableOnly: boolean; changedOnly: boolean; text: string }
  onFilter: (f: { editableOnly: boolean; changedOnly: boolean; text: string }) => void
  selected: string | null
  onSelect: (id: string) => void
  loading: boolean
  pending: Record<string, Pending>
}) {
  const shown = filterRows(rows, filter)
  const groups = groupCatalog(shown)
  const narrowed = filter.editableOnly || filter.changedOnly || !!filter.text
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const isOpen = (g: CatalogGroup) => open[g.id] ?? (narrowed || g.id === 'specialists' || g.rows.some((r) => r.id === selected) || !!g.groups?.some((s) => s.rows.some((r) => r.id === selected)))
  const pend = (id: string) => Object.keys(pending).some((k) => k.endsWith(`:${id}`))

  const rowButton = (r: PromptRow & { title: string }, indent: boolean) => (
    <li key={r.id}>
      <button
        type="button"
        onClick={() => onSelect(r.id)}
        aria-current={r.id === selected ? 'true' : undefined}
        title={r.id}
        className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent', indent && 'pl-7', r.id === selected && 'bg-accent font-medium')}
      >
        <span className={cn('min-w-0 flex-1 truncate', r.mode === 'locked' && 'text-muted-foreground')}>{r.title}</span>
        <LayerBadge row={r} pending={pend(r.id)} />
      </button>
    </li>
  )

  const groupBlock = (g: CatalogGroup, depth: number) => (
    <li key={g.id}>
      <button type="button" onClick={() => setOpen((o) => ({ ...o, [g.id]: !isOpen(g) }))} aria-expanded={isOpen(g)} className={cn('flex w-full items-center gap-1.5 rounded-md px-1 py-1.5 text-left text-sm hover:bg-accent', depth === 0 ? 'font-semibold' : 'pl-3')}>
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', isOpen(g) && 'rotate-90')} aria-hidden />
        <span className="flex-1 truncate">{g.title}</span>
        {depth > 0 && !isOpen(g) && <span className="text-xs text-muted-foreground">{g.rows.length}{g.rows.some((r) => r.layer !== 'default') ? ` · ${g.rows.filter((r) => r.layer !== 'default').length} changed` : ''}</span>}
        {g.locked && <Lock className="size-3.5 text-muted-foreground" aria-label="Locked" />}
      </button>
      {isOpen(g) && (
        <ul className="mt-0.5">
          {g.groups?.map((s) => groupBlock(s, depth + 1))}
          {g.rows.map((r) => rowButton(r, depth > 0 || !g.groups))}
        </ul>
      )}
    </li>
  )

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
        <Input value={filter.text} onChange={(e) => onFilter({ ...filter, text: e.target.value })} placeholder="Find an instruction" className="pl-8" aria-label="Find an instruction" />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {([['editableOnly', 'Editable only'], ['changedOnly', 'Changed only']] as const).map(([k, label]) => (
          <Button key={k} size="sm" variant={filter[k] ? 'secondary' : 'outline'} aria-pressed={filter[k]} onClick={() => onFilter({ ...filter, [k]: !filter[k] })} className="h-7">
            {filter[k] && <Check />} {label}
          </Button>
        ))}
      </div>
      {loading ? (
        <Loading><div className="space-y-2">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-6" />)}</div></Loading>
      ) : groups.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">{filter.changedOnly ? 'Nothing is changed from trace\'s defaults here.' : 'No instruction matches.'}</p>
      ) : (
        <nav aria-label="Instructions">
          <ul className="space-y-0.5">{groups.map((g) => groupBlock(g, 0))}</ul>
        </nav>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ one entry

function DiffView({ lines, title }: { lines: DiffLine[]; title: React.ReactNode }) {
  const c = diffCounts(lines)
  return (
    <div className="overflow-hidden rounded-xl border">
      <p className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm">
        {title}
        <span className="text-verified">+{c.added} {c.added === 1 ? 'line' : 'lines'}</span>
        <span className="text-destructive">−{c.removed} {c.removed === 1 ? 'line' : 'lines'}</span>
      </p>
      {c.added + c.removed === 0 ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">No difference.</p>
      ) : (
        <pre className="max-h-72 overflow-auto py-1 font-mono text-xs leading-5" aria-label="Line by line difference">
          {lines.map((l, i) => (
            <div key={i} className={cn('whitespace-pre-wrap px-3', l.kind === 'add' && 'bg-verified/10 text-verified', l.kind === 'remove' && 'bg-destructive/10 text-destructive')}>
              <span className="sr-only">{l.kind === 'add' ? 'Added: ' : l.kind === 'remove' ? 'Removed: ' : ''}</span>
              <span aria-hidden>{l.kind === 'add' ? '+ ' : l.kind === 'remove' ? '− ' : '  '}</span>
              {l.text || ' '}
            </div>
          ))}
        </pre>
      )}
    </div>
  )
}

function useWhoNames() {
  const { user } = useAuth()
  const users = useAction('users.list', {}, { enabled: user?.class === 'admin' })
  const [map, setMap] = useState<Record<string, string>>({})
  useEffect(() => {
    let live = true
    const list = [...(users.data ?? []).map((u) => ({ email: u.email, name: (u as { name?: string }).name ?? u.email })), ...(user ? [{ email: user.email, name: 'You' }] : [])]
    void Promise.all(list.map(async (u) => [await personHash(u.email), u.name] as const)).then((pairs) => live && setMap(Object.fromEntries(pairs)))
    return () => { live = false }
  }, [users.data, user])
  return (by: string | null): string => {
    if (!by) return 'trace'
    if (map[by]) return map[by]!
    if (/^[0-9a-f]{16}$/.test(by)) return 'Someone'
    // a login, written through the CLI
    return user && (user.email.split('@')[0] === by) ? 'You' : by.charAt(0).toUpperCase() + by.slice(1)
  }
}

function Entry({ id, scope, repo, canEdit, canHistory, pending, onPending }: { id: string; scope: Scope; repo?: string; canEdit: boolean; canHistory: boolean; pending?: Pending; onPending: (p: Pending) => void }) {
  const qc = useQueryClient()
  const args = { ...keyFor(scope, repo), id }
  const view = useQuery({ ...q('prompts.get', args), enabled: scope === 'installation' || !!repo })
  const v = view.data
  const histArgs = { id, scope, ...(scope === 'project' && repo ? { repo } : {}) }
  const history = useQuery({ ...q('prompts.history', histArgs), enabled: canHistory && !!v && v.mode === 'editable' })
  const locked = useQueries({ queries: (v?.followed_by_locked ?? []).map((l) => q('prompts.get', { id: l })) })
  const whoName = useWhoNames()
  const area = useRef<HTMLTextAreaElement>(null)

  const original = v ? scopeText(v, scope) : ''
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? original
  const [reason, setReason] = useState('')
  const [compare, setCompare] = useState<string>('below')
  const [saving, setSaving] = useState(false)
  const [suggest, setSuggest] = useState<{ state: 'asking' | 'ready' | 'error'; text: string; error?: string } | null>(null)
  const [undo, setUndo] = useState<{ kind: 'reset' } | { kind: 'revert'; version: number } | null>(null)

  const isLocked = v?.mode === 'locked'
  const editable = !!v && !isLocked && canEdit
  const declared = Object.keys(v?.vars ?? {})
  const check = checkTemplate(text, declared)
  const changed = draft !== null && draft !== original
  const below = v ? layerBelow(v, scope) : null
  const own = v ? (scope === 'installation' ? v.installation : v.project) : null
  const next = v ? nextVersion(v, scope) : 1
  const scopeName = scope === 'installation' ? 'Installation' : 'Project'

  useTraceContext(v ? { label: id, description: 'The agent instruction open on screen (its id, the layer in force and the draft)', value: { id, mode: v.mode, scope, repo: repo ?? null, inForce: layerLabel(v.effective.layer, v.effective.version), changed, draft: changed ? text.slice(0, 4000) : null }, mono: true } : null, 'prompt-entry')

  if (view.isError) return <QueryError error={view.error} what={`the instruction ${id}`} onRetry={() => void view.refetch()} />
  if (!v) return <Loading><SkeletonRows rows={2} /></Loading>

  const compareText = compare === 'below' ? below?.text ?? '' : compare.startsWith('v') ? history.data?.history.find((h) => `v${h.version}` === compare)?.text ?? '' : null
  const compareLabel = compare === 'below' ? `${layerLabel(below!.layer, below!.version)}` : compare

  const invalidate = async () => {
    await Promise.all([['prompts.list'], ['prompts.get'], ['prompts.history'], ['prompts.preview']].map((k) => qc.invalidateQueries({ queryKey: k })))
  }

  const insertVar = (name: string) => {
    const el = area.current
    const token = `{{${name}}}`
    const at = el?.selectionStart ?? text.length
    const end = el?.selectionEnd ?? at
    const nextText = text.slice(0, at) + token + text.slice(end)
    setDraft(nextText)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at + token.length, at + token.length)
    })
  }

  const save = async () => {
    setSaving(true)
    try {
      const r = await call('prompts.set', { id, scope, ...(scope === 'project' && repo ? { repo } : {}), text, reason: reason.trim() })
      if (scope === 'project') {
        onPending({ version: r.version, branch: r.branch, at: Date.now() })
        toast(`Saved as Project v${r.version}: a pull request opens in ${repo} for review. Agents use it once it is merged.`)
      } else {
        toast(`Saved as Installation v${r.version}. Every project's next job uses it.`)
      }
      setDraft(null)
      setReason('')
      await invalidate()
    } catch (e) {
      toast.error(`Could not save ${id}: ${e instanceof Error ? e.message : String(e)}. Your text is kept.`)
    } finally {
      setSaving(false)
    }
  }

  const ask = async () => {
    setSuggest({ state: 'asking', text: '' })
    try {
      const reply = await askOnce({
        prompt: [
          `Improve this agent instruction for trace. Entry ${id}: ${v.description}`,
          `It may use only these variables: ${declared.length ? declared.map((d) => `{{${d}}}`).join(', ') : 'none'}. At most ${MAX_PROMPT_CHARS} characters.`,
          'Keep its meaning; make it clearer and more specific. Answer with the whole new text in one fenced block, then one line on what you changed.',
          '', '```', text, '```',
        ].join('\n'),
        context: [{ description: 'The agent instruction being edited', value: JSON.stringify({ id, scope, repo }) }],
        onText: (t) => setSuggest({ state: 'asking', text: t }),
      })
      const s = suggestionFrom(reply)
      setSuggest(s ? { state: 'ready', text: s } : { state: 'error', text: '', error: 'trace answered without a suggestion.' })
    } catch (e) {
      setSuggest({ state: 'error', text: '', error: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <article aria-labelledby="entry-title">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="entry-title" className="text-lg font-semibold">{entryTitle(id)}</h2>
        <code className="font-mono text-xs text-muted-foreground">{id}</code>
        {isLocked ? <Badge variant="outline" className="rounded-md font-normal"><Lock /> Locked</Badge> : <Badge variant="outline" className="rounded-md font-normal"><Pencil /> Editable</Badge>}
        <Badge variant="outline" className="rounded-md border-primary/30 font-normal text-primary">
          In force: {layerLabel(v.effective.layer, v.effective.version)}
          {v.effective.layer !== 'default' && (() => { const o = v.effective.layer === 'project' ? v.project : v.installation; return o ? ` · ${whoName(o.by)} · ${ago(o.updated)}` : '' })()}
        </Badge>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{v.description}</p>
      {v.effective.skipped?.map((s, i) => (
        <p key={i} className="mt-2 flex items-center gap-1.5 text-xs text-warning-foreground"><TriangleAlert className="size-3.5" /> The {s.layer} v{s.version} override is skipped: {s.reason}.</p>
      ))}
      {pending && (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <GitPullRequest className="size-4 text-muted-foreground" aria-hidden />
          Pending: v{pending.version} in a pull request, waiting for review.
          {pending.branch && repo && (
            <a className="inline-flex items-center gap-1 text-primary hover:underline" href={`https://github.com/${repo}/pulls?q=is%3Apr+head%3A${encodeURIComponent(pending.branch)}`} target="_blank" rel="noreferrer">
              Open pull request <ExternalLink className="size-3" />
            </a>
          )}
        </p>
      )}

      {id === 'system.notes' && (
        <p className="mt-3 rounded-lg border bg-muted/40 p-3 text-sm">
          These notes are quoted from the repository's <span className="font-mono">CLAUDE.md</span>, so they change by editing that file.
          {repo && (
            <>
              {' '}
              <Link to={`/p/${projectId(repo)}/files/CLAUDE.md` as string} className="text-primary hover:underline">Open CLAUDE.md</Link>
              {' · '}
              <a href={`https://github.com/${repo}/edit/HEAD/CLAUDE.md`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">Change it in the repository <ExternalLink className="size-3" /></a>
            </>
          )}
        </p>
      )}

      <div className="mt-4 overflow-hidden rounded-xl border bg-card">
        {editable && (
          <div className="flex flex-wrap items-center gap-2 border-b p-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={!declared.length}><Variable /> Insert variable <ChevronDown /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-80">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Variables this instruction may use</DropdownMenuLabel>
                {Object.entries(v.vars).map(([name, spec]) => (
                  <DropdownMenuItem key={name} onSelect={() => insertVar(name)} className="flex-col items-start gap-0">
                    <span className="font-mono text-sm">{name}</span>
                    <span className="text-xs text-muted-foreground">{spec.description}{spec.type !== 'text' ? ` (${spec.type})` : ''}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Select value={compare} onValueChange={setCompare}>
              <SelectTrigger size="sm" className="w-auto min-w-44" aria-label="Compare with"><span className="text-muted-foreground">Compare with:</span> <SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Nothing</SelectItem>
                <SelectItem value="below">{below ? layerLabel(below.layer, below.version) : 'The layer below'}</SelectItem>
                {(history.data?.history ?? []).filter((h) => h.text !== null).length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Earlier versions</SelectLabel>
                    {[...(history.data?.history ?? [])].reverse().filter((h) => h.text !== null).map((h) => <SelectItem key={h.uid} value={`v${h.version}`}>v{h.version} · {h.reason ?? h.action}</SelectItem>)}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => void ask()} disabled={suggest?.state === 'asking'}>
              {suggest?.state === 'asking' ? <Loader2 className="animate-spin" /> : <Sparkles />} Ask trace to improve it
            </Button>
          </div>
        )}
        <Textarea
          ref={area}
          value={text}
          onChange={(e) => setDraft(e.target.value)}
          readOnly={!editable}
          aria-label={`Text of ${id}`}
          aria-describedby="entry-checks"
          spellCheck={false}
          className={cn('min-h-56 resize-y rounded-none border-0 font-mono text-[13px] leading-6 shadow-none focus-visible:ring-0', !editable && 'bg-muted/40 text-muted-foreground')}
        />
      </div>
      <div id="entry-checks" className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" aria-live="polite">
        {isLocked ? (
          <span className="flex items-center gap-1.5 text-muted-foreground"><Lock className="size-3.5" /> Locked: read it here; it never changes.</span>
        ) : !canEdit ? (
          <span className="text-muted-foreground">You can read this. {scope === 'installation' ? 'Admins change installation instructions.' : 'Contributors and admins on this project change its instructions.'}</span>
        ) : (
          <>
            {check.malformed ? <StatusBadge status="failing" label={check.malformed} plain /> : check.unknown.length ? (
              <StatusBadge status="failing" label={`Not a variable of this instruction: ${check.unknown.map((u) => `{{${u}}}`).join(', ')}`} plain />
            ) : (
              <StatusBadge status="met" label="Uses only declared variables" plain />
            )}
            <StatusBadge status={check.tooLong ? 'failing' : 'met'} label={`${check.length.toLocaleString()} of ${MAX_PROMPT_CHARS.toLocaleString()} characters`} plain />
          </>
        )}
      </div>

      {suggest && (
        <div className="mt-4 space-y-2 rounded-xl border border-primary/30 p-3">
          <p className="flex items-center gap-2 text-sm font-medium"><Sparkles className="size-4 text-primary" /> trace's suggestion</p>
          {suggest.state === 'asking' && <p className="text-sm text-muted-foreground">{suggest.text ? 'Writing…' : 'Asking trace…'}</p>}
          {suggest.state === 'error' && <p className="text-sm text-destructive">Could not get a suggestion: {suggest.error}</p>}
          {suggest.state === 'ready' && (
            <>
              <DiffView lines={lineDiff(text, suggest.text)} title="Changes from your text:" />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => { setDraft(suggest.text); setSuggest(null) }}><Check /> Accept</Button>
                <Button size="sm" variant="outline" onClick={() => setSuggest(null)}><X /> Discard</Button>
                <Button size="sm" variant="ghost" onClick={() => openPanel(true)}>Talk it through in Ask trace</Button>
              </div>
            </>
          )}
        </div>
      )}

      {v.followed_by_locked.length > 0 && (
        <section className="mt-4 rounded-xl border bg-muted/40 p-4" aria-label="Always follows this (locked)">
          <div className="flex flex-wrap items-center gap-2">
            <Lock className="size-4 text-muted-foreground" aria-hidden />
            <h3 className="text-sm font-medium">Always follows this (locked)</h3>
            <Tooltip>
              <TooltipTrigger asChild><button type="button" className="ml-auto text-xs text-primary hover:underline">Why can't I change this?</button></TooltipTrigger>
              <TooltipContent className="max-w-72">Locked entries hold the guardrails and the formats trace's code reads. They always come after your text, so a change can never drop a guardrail or have the last word over one.</TooltipContent>
            </Tooltip>
          </div>
          {v.followed_by_locked.map((l, i) => (
            <p key={l} className="mt-2 text-sm text-muted-foreground">
              <code className="font-mono text-xs text-foreground/80">{l}</code> — {locked[i]?.data?.default ?? (locked[i]?.isLoading ? '…' : locked[i]?.data?.description ?? '')}
            </p>
          ))}
        </section>
      )}

      {compareText !== null && editable && (
        <div className="mt-4">
          <DiffView lines={lineDiff(compareText, text)} title={<span>Changes from {compareLabel}:</span>} />
        </div>
      )}

      {editable && (
        <div className="mt-5 space-y-2">
          <Label htmlFor="entry-reason">Why this change?</Label>
          <p className="text-xs text-muted-foreground">Required. Kept in history with the change.</p>
          <Textarea id="entry-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} placeholder="For example: reports were missing the margin numbers we review at Prove" aria-required />
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button disabled={!canSave({ check, changed, reason, locked: isLocked }) || saving} onClick={() => void save()}>
                    {saving && <Loader2 className="animate-spin" />} Save as {scopeName} v{next}
                  </Button>
                </span>
              </TooltipTrigger>
              {!canSave({ check, changed, reason, locked: isLocked }) && (
                <TooltipContent>{!changed ? 'Change the text first.' : !check.ok ? 'Fix the checks under the text first.' : 'Say why, in one line.'}</TooltipContent>
              )}
            </Tooltip>
            {own?.text && (
              <Button variant="outline" onClick={() => setUndo({ kind: 'reset' })}><RotateCcw /> Reset to {below?.layer === 'installation' ? 'installation' : 'default'}</Button>
            )}
            {changed && <Button variant="ghost" onClick={() => { setDraft(null); setSuggest(null) }}>Discard</Button>}
          </div>
          <p className="text-xs text-muted-foreground">
            {scope === 'project' ? <>Opens a pull request in <span className="font-mono">{repo}</span> for review. Agents use it once merged.</> : 'Takes effect at once, for every project\'s next job.'}
          </p>
        </div>
      )}

      {v.mode === 'editable' && (
        <section className="mt-8" aria-labelledby="entry-history">
          <h3 id="entry-history" className="section-label mb-3">History</h3>
          {!canHistory ? (
            <p className="text-sm text-muted-foreground">History is shown to people who can change these instructions.</p>
          ) : history.isError ? (
            <QueryError error={history.error} what="this instruction's history" onRetry={() => void history.refetch()} />
          ) : (
            <History
              entries={history.data?.history ?? []}
              loading={history.isLoading}
              scope={scope}
              view={v}
              whoName={whoName}
              canEdit={editable}
              onCompare={(ver) => setCompare(`v${ver}`)}
              onRevert={(ver) => setUndo({ kind: 'revert', version: ver })}
            />
          )}
        </section>
      )}

      <UndoDialog
        undo={undo}
        id={id}
        scope={scope}
        repo={repo}
        belowLabel={below?.layer === 'installation' ? 'the installation\'s text' : 'trace\'s default'}
        onClose={() => setUndo(null)}
        onDone={async (r) => {
          if (scope === 'project') onPending({ version: r.version, branch: r.branch, at: Date.now() })
          setDraft(null)
          await invalidate()
        }}
      />
    </article>
  )
}

interface HistRow { key: string; version: number | null; versionWord: string; layer: string; who: string; when: string; at: number; reason: string; inForce: boolean; action: string }

function History({ entries, loading, scope, view, whoName, canEdit, onCompare, onRevert }: {
  entries: PromptHistoryEntry[]
  loading: boolean
  scope: Scope
  view: PromptView
  whoName: (by: string | null) => string
  canEdit: boolean
  onCompare: (v: number) => void
  onRevert: (v: number) => void
}) {
  const own = scope === 'installation' ? view.installation : view.project
  const rows: HistRow[] = [
    ...[...entries].reverse().map((h) => ({
      key: h.uid, version: h.version, versionWord: `v${h.version}`, layer: scope === 'installation' ? 'Installation' : 'Project', who: whoName(h.by), when: ago(h.at), at: Date.parse(h.at),
      reason: h.reason ?? '', inForce: own?.version === h.version && view.effective.layer === scope, action: h.action === 'set' ? 'Changed' : h.action === 'reset' ? 'Reset' : 'Reverted',
    })),
    { key: 'default', version: null, versionWord: 'Default', layer: 'trace', who: '—', when: '—', at: 0, reason: "trace's built-in wording", inForce: view.effective.layer === 'default', action: '' },
  ]
  const columns: ColumnDef<HistRow, any>[] = [
    { accessorKey: 'versionWord', header: 'Version', size: 110, meta: { label: 'Version' }, cell: ({ row: { original: r } }) => <span className="flex items-center gap-1.5 font-medium">{r.versionWord}{r.inForce && <Badge variant="outline" className="rounded px-1 text-[10px] font-normal text-primary">In force</Badge>}</span> },
    { accessorKey: 'layer', header: 'Layer', size: 110, meta: { label: 'Layer', kind: 'enum' } },
    { accessorKey: 'action', header: 'What', size: 100, meta: { label: 'What', kind: 'enum' } },
    { accessorKey: 'who', header: 'By', size: 100, meta: { label: 'By', kind: 'enum' } },
    { accessorKey: 'at', header: 'When', size: 100, meta: { label: 'When', kind: 'number' }, cell: ({ row: { original: r } }) => r.when },
    { accessorKey: 'reason', header: 'Reason', size: 240, meta: { label: 'Reason' } },
    {
      id: 'do', header: '', size: 150, enableSorting: false, enableHiding: false, meta: { label: 'Actions' },
      cell: ({ row: { original: r } }) => r.version === null ? null : (
        <span className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="link" className="h-auto px-1" onClick={() => onCompare(r.version!)}>Compare</Button>
          {canEdit && !r.inForce && r.action !== 'Reset' && <Button size="sm" variant="link" className="h-auto px-1" onClick={() => onRevert(r.version!)}>Revert</Button>}
        </span>
      ),
    },
  ]
  if (loading) return <Loading><SkeletonRows rows={2} /></Loading>
  return <DataTable id="prompt-history" data={rows} columns={columns} getRowId={(r) => r.key} noun="versions" persist={false} pageSize={20} maxHeight="none" />
}

function UndoDialog({ undo, id, scope, repo, belowLabel, onClose, onDone }: {
  undo: { kind: 'reset' } | { kind: 'revert'; version: number } | null
  id: string
  scope: Scope
  repo?: string
  belowLabel: string
  onClose: () => void
  onDone: (r: { version: number; branch?: string }) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    if (!undo) return
    setBusy(true)
    try {
      const base = { id, scope, ...(scope === 'project' && repo ? { repo } : {}), reason: reason.trim() }
      const r = undo.kind === 'reset' ? await call('prompts.reset', base) : await call('prompts.revert', { ...base, version: undo.version })
      toast(scope === 'project'
        ? `${undo.kind === 'reset' ? 'Reset' : `Revert to v${undo.version}`} saved as v${r.version}: a pull request opens for review.`
        : `${undo.kind === 'reset' ? 'Reset' : `Reverted to v${undo.version}`}, saved as v${r.version}. Every project's next job uses it.`)
      await onDone(r)
      setReason('')
      onClose()
    } catch (e) {
      toast.error(`Could not ${undo.kind}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <AlertDialog open={!!undo} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{undo?.kind === 'reset' ? `Reset ${id}?` : `Revert ${id} to v${undo?.kind === 'revert' ? undo.version : ''}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {undo?.kind === 'reset' ? `This ${scope}'s change is set aside and ${belowLabel} is used again.` : 'That version\'s text becomes the newest version.'} It is recorded as a new version, so it can be undone too.
            {scope === 'project' && ' It opens a pull request for review.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="undo-reason">Why?</Label>
          <Textarea id="undo-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="One line, kept in history" aria-required />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button disabled={!reason.trim() || busy} onClick={() => void go()}>{busy && <Loader2 className="animate-spin" />}{undo?.kind === 'reset' ? 'Reset' : 'Revert'}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ------------------------------------------------------------------ the preview

const AGENTS: { group: string; items: { value: string; label: string }[] }[] = [
  { group: 'Specialists', items: Object.entries(SPECIALIST_TITLES).map(([k, t]) => ({ value: k, label: t })) },
  {
    group: 'Others',
    items: [
      { value: 'worker.task', label: 'Worker, on a task' },
      { value: 'worker.item', label: 'Worker, on a pull request or issue' },
      { value: 'delegate', label: 'Delegation to the worker' },
      { value: 'actions.check', label: 'GitHub Actions check' },
      { value: 'router', label: 'Router' },
      { value: 'render', label: 'Renders' },
      { value: 'cloudworker', label: 'Cloud worker' },
      { value: 'memory', label: 'Memory block' },
      { value: 'system', label: 'System prompt' },
    ],
  },
]

const JOBS: { value: string; label: string; job: PreviewJob }[] = [
  { value: 'task', label: 'A task someone asked for', job: { kind: 'task', request: '(the request)' } },
  { value: 'ci-red', label: 'A pull request whose check failed', job: { kind: 'work-item', item: { kind: 'ci-red', number: 1, sha: '0'.repeat(40), ref: 'claude/example', own: true, title: "(the item's title)" } } },
  { value: 'conflict', label: 'A pull request in merge conflict', job: { kind: 'work-item', item: { kind: 'conflict', number: 1, sha: '0'.repeat(40), ref: 'claude/example', own: true, title: "(the item's title)" } } },
  { value: 'agent-fix', label: 'An issue for the agents', job: { kind: 'work-item', item: { kind: 'agent-fix', number: 1, sha: '0'.repeat(40), ref: 'claude/example', own: true, title: "(the item's title)" } } },
]

function defaultTarget(entry: string, rows: PromptRow[]): string {
  const k = Object.keys(SPECIALIST_TITLES).find((x) => entry.startsWith(`specialist.${x}.`))
  if (k) return k
  const p = rows.find((r) => r.id === entry)?.prompt
  return p === 'specialist' || !p ? 'ams' : p
}

function Preview({ repo, entry, rows }: { repo: string; entry: string; rows: PromptRow[] }) {
  const [target, setTarget] = useState(() => defaultTarget(entry, rows))
  const [job, setJob] = useState('ci-red')
  const [all, setAll] = useState<Record<string, boolean>>({})
  useEffect(() => setTarget(defaultTarget(entry, rows)), [entry, rows])
  const j = JOBS.find((x) => x.value === job)!
  const preview = useQuery(q('prompts.preview', { repo, target, job: j.job }))
  const parts = useMemo(() => (preview.data ? parseMarked(preview.data.marked) : []), [preview.data])
  const copy = () => void navigator.clipboard?.writeText(preview.data?.text ?? '').then(() => toast('Prompt copied'))
  return (
    <section aria-labelledby="preview-title" className="space-y-3">
      <div>
        <h2 id="preview-title" className="text-lg font-semibold">Preview</h2>
        <p className="text-sm text-muted-foreground">The whole prompt this agent gets, in order, as saved for {projectName(repo)}.</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="pv-agent" className="text-xs">Agent</Label>
        <Select value={target} onValueChange={setTarget}>
          <SelectTrigger id="pv-agent" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {AGENTS.map((g) => (
              <SelectGroup key={g.group}>
                <SelectLabel>{g.group}</SelectLabel>
                {g.items.map((i) => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="pv-job" className="text-xs">Job</Label>
        <Select value={job} onValueChange={setJob}>
          <SelectTrigger id="pv-job" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{JOBS.map((x) => <SelectItem key={x.value} value={x.value}>{x.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <p className="flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
        <span className="border-l-2 border-primary pl-1">Project</span>
        <span className="border-l-2 border-foreground/60 pl-1">Installation</span>
        <span className="border-l-2 border-border pl-1">Default</span>
        <span className="flex items-center gap-0.5"><Lock className="size-3" /> Locked</span>
      </p>
      {preview.isError ? (
        <QueryError error={preview.error} what="the preview" onRetry={() => void preview.refetch()} />
      ) : preview.isLoading ? (
        <Loading><div className="space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20" />)}</div></Loading>
      ) : (
        <ol className="space-y-2">
          {parts.map((p, i) => {
            const open = all[`${i}`]
            return (
              <li key={`${p.id}-${i}`} className={cn('rounded-lg border p-3 text-sm', p.locked ? 'bg-muted/60 text-muted-foreground' : 'bg-card', p.id === entry && 'ring-2 ring-primary/40', 'border-l-4', p.layer === 'project' ? 'border-l-primary' : p.layer === 'installation' ? 'border-l-foreground/60' : 'border-l-border')}>
                <p className="mb-1 flex flex-wrap items-center gap-1 font-mono text-[11px]">
                  {p.locked && <Lock className="size-3" aria-label="Locked" />}
                  <span className={cn(!p.locked && p.layer === 'project' && 'text-primary')}>{p.id}</span>
                  <span className="text-muted-foreground">· {p.locked ? 'locked' : layerLabel(p.layer as 'default', p.version)}</span>
                </p>
                <p className={cn('whitespace-pre-wrap', !open && 'line-clamp-3')}>{p.text}</p>
                {p.text.split('\n').length > 3 || p.text.length > 160 ? (
                  <button type="button" className="mt-1 text-xs text-primary hover:underline" onClick={() => setAll((a) => ({ ...a, [`${i}`]: !open }))}>{open ? 'Show less' : 'Show all'}</button>
                ) : null}
              </li>
            )
          })}
        </ol>
      )}
      <Button variant="outline" className="w-full" onClick={copy} disabled={!preview.data}><Copy /> Copy prompt</Button>
      <p className="flex items-start gap-2 border-t pt-3 text-xs text-muted-foreground">
        <Activity className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Each run records the entries and versions it received, but the API cannot yet count or list the runs that used one entry.
      </p>
    </section>
  )
}
