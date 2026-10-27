/**
 * Knowledge (/knowledge, /knowledge/$tab, /knowledge/graph): one search box with its scope (This project, All my
 * projects, Shared library) and Include inactive, then the tabs: All results, Documents, Datasheets and parts, Agent
 * memory, Graph. The search, scope and switches live in the address so a link shares the view; each tab is a child
 * route. Entries come only from projects the person is on (the API checks every call), plus the shared library.
 */
import { Link, Outlet, createFileRoute, useNavigate, useRouterState } from '@tanstack/react-router'
import { BookOpen, Brain, FileText, Network, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useTraceContext } from '@/components/chat/context'
import { useCommands } from '@/components/shell/command-menu'
import { type Scope, useKnowledgeView, useScopeRepos } from '@/components/knowledge/use-knowledge'
import { projectName } from '@/lib/api'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/knowledge')({
  staticData: { crumb: 'Knowledge' },
  validateSearch: z.record(z.string(), z.unknown()),
  component: KnowledgeLayout,
})

export const KNOWLEDGE_TABS = [
  { id: '', label: 'All results', icon: Search },
  { id: 'documents', label: 'Documents', icon: FileText },
  { id: 'library', label: 'Datasheets and parts', icon: BookOpen },
  { id: 'memory', label: 'Agent memory', icon: Brain },
  { id: 'graph', label: 'Graph', icon: Network },
] as const

function KnowledgeLayout() {
  const [view, set] = useKnowledgeView()
  const { all } = useScopeRepos(view)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const navigate = useNavigate()
  const tab = pathname.replace(/^\/knowledge\/?/, '').split('/')[0] ?? ''
  const graph = tab === 'graph'
  const [text, setText] = useState(view.q)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => setText(view.q), [view.q])
  // search as the person types, a moment after they stop
  useEffect(() => {
    if (text === view.q) return
    const t = setTimeout(() => set({ q: text }), 350)
    return () => clearTimeout(t)
  }, [text, view.q, set])

  const projectRepo = view.repo ?? (all.length === 1 ? all[0] : undefined)
  useTraceContext({ label: 'Knowledge', description: 'The screen the person is on: Knowledge search', value: { tab: tab || 'all', query: view.q, scope: view.scope, project: view.repo ?? null } }, 'screen')
  useCommands([
    { id: 'k-search', label: 'Search knowledge', group: 'Knowledge', run: () => input.current?.focus() },
    { id: 'k-graph', label: 'Open the knowledge graph', group: 'Knowledge', run: () => void navigate({ to: '/knowledge/graph', search: (p: Record<string, unknown>) => p }) },
    { id: 'k-memory', label: 'Search agent memory', group: 'Knowledge', run: () => void navigate({ to: '/knowledge/$tab', params: { tab: 'memory' }, search: (p: Record<string, unknown>) => p }) },
    { id: 'k-library', label: 'Search datasheets and parts', group: 'Knowledge', run: () => void navigate({ to: '/knowledge/$tab', params: { tab: 'library' }, search: (p: Record<string, unknown>) => p }) },
  ])

  const scopes: { id: Scope; label: string; disabled?: boolean }[] = [
    { id: 'project', label: projectRepo ? `This project: ${projectName(projectRepo)}` : 'This project', disabled: !projectRepo },
    { id: 'mine', label: 'All my projects' },
    { id: 'library', label: 'Shared library' },
  ]

  return (
    <div className={cn('mx-auto w-full px-4 py-6 md:px-6 md:py-10', graph ? 'max-w-[1400px]' : 'max-w-[1200px]')}>
      <h1 className="text-2xl font-semibold tracking-tight">Knowledge</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {graph ? 'See how requirements, parts, runs, decisions and memories connect.' : 'Search datasheets, project documents, runs and what the agents remember.'}
      </p>

      {!graph && (
        <form
          role="search"
          className="relative mt-6"
          onSubmit={(e) => {
            e.preventDefault()
            set({ q: text })
          }}
        >
          <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search everything trace knows: a part, a value, a question…"
            aria-label="Search knowledge"
            className="h-13 rounded-xl pl-12 pr-10 text-base md:text-base"
          />
          {text && (
            <button type="button" aria-label="Clear the search" className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => { setText(''); set({ q: '' }) }}>
              <X className="size-4" />
            </button>
          )}
        </form>
      )}

      <div className={cn('flex flex-wrap items-center gap-3', graph ? 'mt-4' : 'mt-4')}>
        <div role="radiogroup" aria-label="Where to look" className="inline-flex max-w-full flex-wrap rounded-lg bg-muted p-1">
          {scopes.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={view.scope === s.id}
              disabled={s.disabled}
              onClick={() => set({ scope: s.id, ...(s.id === 'project' && projectRepo ? { repo: projectRepo } : {}) })}
              className={cn('rounded-md px-3 py-1.5 text-sm', view.scope === s.id ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground', s.disabled && 'opacity-50')}
            >
              {s.label}
            </button>
          ))}
        </div>
        {view.scope === 'project' && all.length > 1 && (
          <select aria-label="Project" className="h-9 rounded-md border bg-background px-2 text-sm" value={view.repo ?? projectRepo ?? ''} onChange={(e) => set({ repo: e.target.value, scope: 'project' })}>
            {all.map((r) => (
              <option key={r} value={r}>
                {projectName(r)}
              </option>
            ))}
          </select>
        )}
        <Label className="ml-auto flex items-center gap-2 font-normal">
          <Switch checked={view.inactive} onCheckedChange={(v) => set({ inactive: v })} />
          Include inactive
        </Label>
      </div>

      <nav aria-label="Knowledge" className="mt-5 flex items-end gap-1 overflow-x-auto border-b">
        {KNOWLEDGE_TABS.map((t) => {
          const active = t.id === tab
          const Icon = t.icon
          return (
            <Link
              key={t.id || 'all'}
              to={t.id === '' ? '/knowledge' : t.id === 'graph' ? '/knowledge/graph' : '/knowledge/$tab'}
              params={t.id && t.id !== 'graph' ? { tab: t.id } : {}}
              search={(p: Record<string, unknown>) => p}
              aria-current={active ? 'page' : undefined}
              className={cn('-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 pb-2.5 pt-1 text-sm', active ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
            >
              {t.id === 'graph' && <Icon className="size-4" aria-hidden />}
              {t.label}
            </Link>
          )
        })}
      </nav>
      <Outlet />
    </div>
  )
}
