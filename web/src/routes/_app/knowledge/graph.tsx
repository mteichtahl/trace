/**
 * Knowledge › Graph (/knowledge/graph?focus=R-006): what trace knows as a network around one item, from
 * graph.neighbourhood (already filtered by access). Start from…, depth 1–3, Expand on a node, filters by node and link
 * kind, Related by meaning, Show failing chains, "How is this connected to…" (the shortest path in words), a side
 * sheet for the selected item, hover summaries, grouping beyond about 150 items into "+N more", a mini-map, Pin layout,
 * Ask trace about this view, and the List switch (a Data table; the default on phones and what screen readers get).
 * Keyboard: Tab moves between items in order of distance from the focus, Enter opens, E expands, Escape closes.
 */
import { useQueries } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { ArrowRight, ChevronDown, Eye, Minus, Pin, PinOff, Plus, Search, Sparkles, X } from 'lucide-react'
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { askTrace } from '@/components/chat/chat-state'
import { useTraceContext } from '@/components/chat/context'
import { DataTable, Highlight } from '@/components/data-table'
import { useKnowledgeView, useScopeRepos } from '@/components/knowledge/use-knowledge'
import { Facts, NeedsBuilding, SideSheet } from '@/components/side-sheet'
import { useCommands } from '@/components/shell/command-menu'
import { EmptyState, ErrorState, Partial } from '@/components/states'
import { StatusBadge, type Status } from '@/components/status-badge'
import { useMediaQuery } from '@/hooks/use-media-query'
import { call, projectName } from '@/lib/api'
import { plural } from '@/lib/format'
import {
  type Graph, type GraphNode, type GroupNode, LINK_KINDS, LINK_WORD, type LinkKind, type ListRow, NODE_KINDS, NODE_WORD, type NodeKind, failingChains, filterGraph, groupBeyond, linksOf,
  listRows, mergeGraphs, pathWords, readGraph, shortestPath, tabOrder,
} from '@/lib/graph'
import { q } from '@/lib/queries'
import { cn } from '@/lib/utils'
import type { CanvasHandle } from '@/components/graph/graph-canvas'

const GraphCanvas = lazy(() => import('@/components/graph/graph-canvas'))

export const Route = createFileRoute('/_app/knowledge/graph')({
  staticData: { crumb: 'Graph' },
  component: GraphView,
})

const STATUS: Partial<Record<string, Status>> = { failing: 'failing', verified: 'verified', untested: 'untested', waived: 'waived', active: 'met', inactive: 'idle' }

function GraphView() {
  const [view] = useKnowledgeView()
  const { all } = useScopeRepos(view)
  const navigate = useNavigate()
  const search = Route.useSearch() as Record<string, unknown>
  const focus = typeof search.focus === 'string' ? search.focus : ''
  const depth = (Number(search.depth) || 2) as 1 | 2 | 3
  const phone = useMediaQuery('(max-width: 767px)')
  const [mode, setMode] = useState<'graph' | 'list' | null>(null)
  const shownMode = mode ?? (phone ? 'list' : 'graph')
  const setSearch = (patch: Record<string, unknown>) => void navigate({ to: '.', replace: true, search: ((p: Record<string, unknown>) => ({ ...p, ...patch })) as never })

  // which projects: This project, or every project of the person (the library scope keeps only shared items)
  const repos = view.scope === 'project' && view.repo ? [view.repo] : all
  const base = useQueries({ queries: repos.map((repo) => ({ ...q('graph.neighbourhood', { repo, focus, depth }), enabled: !!focus, retry: false })) })
  const [expanded, setExpanded] = useState<Graph>({ nodes: [], links: [] })
  useEffect(() => setExpanded({ nodes: [], links: [] }), [focus, depth])
  // the API names the item it found for a bare id (R-006 → requirement:R-006): the address takes that name
  const resolved = base.map((b) => (b.data as { focus?: string } | undefined)?.focus).find((f): f is string => !!f && f !== focus)
  useEffect(() => { if (resolved) setSearch({ focus: resolved }) }, [resolved]) // eslint-disable-line react-hooks/exhaustive-deps

  const loaded = useMemo(() => {
    let g: Graph = { nodes: [], links: [] }
    for (const r of base) if (r.data) g = mergeGraphs(g, readGraph(r.data))
    g = mergeGraphs(g, expanded)
    if (view.scope === 'library') {
      const keep = new Set(g.nodes.filter((n) => !n.repo || n.id === focus).map((n) => n.id))
      g = { nodes: g.nodes.filter((n) => keep.has(n.id)), links: g.links.filter((l) => keep.has(l.source) && keep.has(l.target)) }
    }
    if (!view.inactive) {
      const off = new Set(g.nodes.filter((n) => n.status === 'inactive').map((n) => n.id))
      g = { nodes: g.nodes.filter((n) => !off.has(n.id)), links: g.links.filter((l) => !off.has(l.source) && !off.has(l.target)) }
    }
    return g
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base.map((b) => b.dataUpdatedAt).join(','), expanded, view.scope, view.inactive, focus])
  const loading = !!focus && base.some((b) => b.isLoading)
  const failed = repos.filter((_, i) => base[i]?.isError)
  const notFound = !!focus && !loading && base.every((b) => !b.isError) && !loaded.nodes.some((n) => n.id === focus)

  // filters
  const [nodeKinds, setNodeKinds] = useState<Set<NodeKind>>(new Set(NODE_KINDS))
  const [linkKinds, setLinkKinds] = useState<Set<LinkKind>>(new Set(LINK_KINDS))
  const [meaning, setMeaning] = useState(true)
  const [chains, setChains] = useState(true)
  const [pinned, setPinned] = useState(false)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const filtered = useMemo(() => filterGraph(loaded, { nodeKinds, linkKinds, meaning, hidden }, focus), [loaded, nodeKinds, linkKinds, meaning, hidden, focus])

  // selection, path
  const [selected, setSelected] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [to, setTo] = useState<string>('')
  const [showPath, setShowPath] = useState(false)
  const from = selected ?? focus
  const path = useMemo(() => (to && from && to !== from ? shortestPath(filtered, from, to) : null), [filtered, from, to])
  const pathSets = useMemo(() => {
    if (!path || !showPath) return null
    return { nodes: new Set(path.map((p) => p.node.id)), links: new Set(path.flatMap((p) => (p.link ? [p.link.id] : []))) }
  }, [path, showPath])
  const chainSets = useMemo(() => (chains ? failingChains(filtered) : null), [chains, filtered])

  // grouping beyond ~150 items
  const keep = useMemo(() => {
    const k = new Set<string>([...(pathSets?.nodes ?? []), ...(selected ? [selected] : [])])
    for (const id of openGroups) for (const n of filtered.nodes) if (`group:${n.kind}` === id) k.add(n.id)
    return k
  }, [pathSets, selected, openGroups, filtered])
  const { graph: drawn, groups } = useMemo(() => groupBeyond(filtered, focus, 150, keep), [filtered, focus, keep])
  const order = useMemo(() => (focus ? tabOrder(drawn, focus) : []), [drawn, focus])
  const byId = useMemo(() => new Map(loaded.nodes.map((n) => [n.id, n])), [loaded])
  const sel = selected ? byId.get(selected) ?? null : null

  const expand = async (id: string) => {
    const r = await Promise.allSettled(repos.map((repo) => call('graph.neighbourhood', { repo, focus: id, depth: 1 })))
    let g: Graph = { nodes: [], links: [] }
    for (const x of r) if (x.status === 'fulfilled') g = mergeGraphs(g, readGraph(x.value))
    setExpanded((e) => mergeGraphs(e, g))
  }

  const canvas = useRef<CanvasHandle>(null)
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null)
  const hovered = hover ? byId.get(hover.id) : undefined
  const [kbd, setKbd] = useState<string | null>(null)

  useTraceContext(
    focus ? { label: `Graph around ${byId.get(focus)?.label ?? focus}`, description: 'The knowledge graph on screen: the items and how they are linked', value: { focus, depth, items: drawn.nodes.slice(0, 60).map((n) => ({ id: n.id, kind: n.kind, label: n.title ?? n.label, status: n.status })), links: drawn.links.slice(0, 120).map((l) => `${l.source} ${LINK_WORD[l.kind]} ${l.target}`) } } : null,
    'graph',
  )
  useTraceContext(sel ? { label: sel.label, description: 'The graph item the person selected', value: { id: sel.id, kind: sel.kind, title: sel.title ?? sel.label, summary: sel.summary ?? '' } } : null, 'graph-selected')
  useCommands(focus ? [
    { id: 'g-fit', label: 'Fit the graph to the screen', group: 'Graph', run: () => canvas.current?.fit() },
    { id: 'g-list', label: shownMode === 'graph' ? 'Show the graph as a list' : 'Show the graph as a picture', group: 'Graph', run: () => setMode(shownMode === 'graph' ? 'list' : 'graph') },
    { id: 'g-ask', label: 'Ask trace about this view', group: 'Graph', run: () => askTrace('Explain the connections in this view, in plain words, with the items as chips.') },
  ] : [])

  const select = (id: string | null, open = true) => {
    setSelected(id)
    setSheetOpen(!!id && open)
    if (id) canvas.current?.focusNode(id)
  }

  return (
    <div className="mt-4">
      <StartFrom
        focus={focus}
        focusNode={byId.get(focus)}
        nodes={loaded.nodes}
        onPick={(id) => {
          setSearch({ focus: id })
          select(null)
        }}
        onConnect={() => {
          select(focus)
          setTimeout(() => document.getElementById('connect-to')?.focus(), 200)
        }}
      />

      {!focus ? (
        <EmptyState className="mt-6">
          Start from anything: type a requirement, part, run, file, memory or person in “Start from…”, or press Show in graph on any item elsewhere in the app.
          <span className="mt-3 flex flex-wrap gap-2">
            {['R-006', 'R-002', 'P-sx1262', 'run_8e14'].map((id) => (
              <button key={id} type="button" className="rounded-full border bg-background px-3 py-1 font-mono text-sm text-foreground hover:bg-accent" onClick={() => setSearch({ focus: id })}>
                {id}
              </button>
            ))}
          </span>
        </EmptyState>
      ) : (
        <div className="mt-4">
          <Toolbar
            depth={depth}
            onDepth={(d) => setSearch({ depth: d })}
            nodeKinds={nodeKinds}
            setNodeKinds={setNodeKinds}
            linkKinds={linkKinds}
            setLinkKinds={setLinkKinds}
            chains={chains}
            setChains={setChains}
            meaning={meaning}
            setMeaning={setMeaning}
            pinned={pinned}
            setPinned={setPinned}
            mode={shownMode}
            setMode={setMode}
            canvas={canvas}
          />
          <p className="mt-3 text-xs text-muted-foreground" aria-live="polite">
            {plural(drawn.nodes.length, 'item')} shown
            {groups.length > 0 && ` · ${groups.reduce((n, g) => n + g.members.length, 0)} more grouped`}
            {hidden.size > 0 && (
              <>
                {' · '}
                {hidden.size} hidden{' '}
                <button type="button" className="text-primary hover:underline" onClick={() => setHidden(new Set())}>
                  Show again
                </button>
              </>
            )}{' '}
            · only from {view.scope === 'project' && view.repo ? projectName(view.repo) : 'your projects'} and the shared library
          </p>
          {failed.length > 0 && <Partial onRetry={() => base.forEach((b) => b.isError && void b.refetch())}>Could not draw {failed.map(projectName).join(', ')}'s part of the graph. What arrived is shown.</Partial>}

          {loading && drawn.nodes.length === 0 ? (
            <Skeleton className="mt-3 h-[560px] rounded-xl" />
          ) : notFound ? (
            <ErrorState className="mt-3" title={`Nothing called “${focus}” is in the record of a project you're on.`} action={<Button size="sm" variant="outline" onClick={() => setSearch({ focus: undefined })}>Start from something else</Button>} />
          ) : base.every((b) => b.isError) ? (
            <ErrorState className="mt-3" title="Could not draw the graph." onRetry={() => base.forEach((b) => void b.refetch())} detail={String(base[0]?.error instanceof Error ? base[0].error.message : base[0]?.error)} />
          ) : shownMode === 'list' ? (
            <GraphList graph={drawn} focus={focus} onOpen={(id) => select(id)} />
          ) : (
            <div
              className="relative mt-3 h-[min(70vh,640px)] min-h-[420px] overflow-hidden rounded-xl border bg-muted/20"
              onKeyDown={(e) => {
                if (e.key === 'Escape') select(null)
              }}
            >
              <Suspense fallback={<Skeleton className="absolute inset-0" />}>
                <GraphCanvas
                  handle={canvas}
                  graph={drawn}
                  groups={groups}
                  focus={focus}
                  selected={kbd ?? selected}
                  chain={chainSets}
                  path={pathSets}
                  pinned={pinned}
                  onSelect={(id) => select(id)}
                  onOpenGroup={(g: GroupNode) => setOpenGroups((s) => new Set([...s, g.id]))}
                  onHover={setHover}
                />
              </Suspense>
              <Legend />
              {hovered && hover && (
                <div role="tooltip" className="pointer-events-none absolute z-10 max-w-64 rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow" style={{ left: Math.min(hover.x + 14, 9999), top: hover.y + 14 }}>
                  <p className="font-semibold">{hovered.title ?? hovered.label}</p>
                  {hovered.summary && <p className="opacity-80">{hovered.summary}</p>}
                </div>
              )}
              {/* keyboard: the items in order of distance, as focusable buttons */}
              <ol aria-label="Items in the graph, nearest first" className="absolute left-3 top-3 z-10">
                {order.map((id) => {
                  const n = byId.get(id)
                  if (!n) return null
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        className="sr-only rounded-md bg-background px-2 py-1 text-sm shadow focus:not-sr-only focus:absolute focus:whitespace-nowrap focus:ring-2 focus:ring-ring"
                        onFocus={() => {
                          setKbd(id)
                          canvas.current?.focusNode(id)
                        }}
                        onBlur={() => setKbd(null)}
                        onClick={() => select(id)}
                        onKeyDown={(e) => {
                          if (e.key === 'e' || e.key === 'E') {
                            e.preventDefault()
                            void expand(id)
                          }
                        }}
                      >
                        {NODE_WORD[n.kind].one}: {n.title ?? n.label} · Enter opens, E expands
                      </button>
                    </li>
                  )
                })}
              </ol>
              <Button variant="outline" size="sm" className="absolute right-3 top-3 bg-background" onClick={() => askTrace('Explain the connections in this view, in plain words, with the items as chips.')}>
                <Sparkles /> Ask trace about this view
              </Button>
            </div>
          )}

          <p className="mt-3 flex gap-2 text-xs text-muted-foreground">
            <Eye className="mt-0.5 size-3.5 shrink-0" aria-hidden /> Only items from projects you're on and the shared library appear. Items from other projects are never shown, not even as grouped counts.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            <kbd className="rounded border px-1 font-mono">Tab</kbd> moves between items · <kbd className="rounded border px-1 font-mono">Enter</kbd> opens · <kbd className="rounded border px-1 font-mono">E</kbd> expands · <kbd className="rounded border px-1 font-mono">Esc</kbd> closes the panel
          </p>
        </div>
      )}

      <ItemSheet
        node={sheetOpen ? sel : null}
        graph={filtered}
        onClose={() => setSheetOpen(false)}
        onExpand={(id) => void expand(id)}
        onHide={(id) => {
          setHidden((h) => new Set([...h, id]))
          select(null)
        }}
        onShow={(id) => select(id)}
        onFocus={(id) => {
          setSearch({ focus: id })
          select(null)
        }}
        to={to}
        setTo={(id) => {
          setTo(id)
          setShowPath(false)
        }}
        path={path}
        showPath={showPath}
        setShowPath={setShowPath}
        candidates={filtered.nodes}
      />
    </div>
  )
}

// ------------------------------------------------------------------ Start from…

function StartFrom({ focus, focusNode, nodes, onPick, onConnect }: { focus: string; focusNode?: GraphNode; nodes: GraphNode[]; onPick: (id: string) => void; onConnect: () => void }) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const t = text.trim().toLowerCase()
  const matches = t ? nodes.filter((n) => `${n.id} ${n.label} ${n.title ?? ''}`.toLowerCase().includes(t)).slice(0, 8) : nodes.slice(0, 8)
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm text-muted-foreground">Start from…</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <div className="flex min-h-11 min-w-0 flex-1 basis-80 items-center gap-2 rounded-xl border px-3 focus-within:ring-2 focus-within:ring-ring">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            {focus && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md border bg-muted px-2 py-0.5 text-sm">
                <span className="font-mono">{focusNode?.label ?? focus}</span>
                {focusNode?.title && <span className="hidden sm:inline">{focusNode.title.replace(/^.*?· /, '')}</span>}
                <button type="button" aria-label="Clear the starting item" onClick={() => onPick('')} className="text-muted-foreground hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              </span>
            )}
            <input
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                setOpen(true)
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && text.trim()) {
                  e.preventDefault()
                  onPick(matches[0]?.id ?? text.trim())
                  setText('')
                  setOpen(false)
                }
              }}
              placeholder={focus ? 'Start from another item…' : 'A requirement, part, run, file, memory or person'}
              aria-label="Start from"
              className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </div>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(420px,90vw)] p-1" onOpenAutoFocus={(e) => e.preventDefault()}>
          {matches.length === 0 && !text.trim() ? (
            <p className="p-2 text-sm text-muted-foreground">Type an item's id, such as R-006 or run_8e14.</p>
          ) : (
            <ul>
              {matches.map((n) => (
                <li key={n.id}>
                  <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent" onClick={() => { onPick(n.id); setText(''); setOpen(false) }}>
                    <span className="w-28 shrink-0 text-xs text-muted-foreground">{NODE_WORD[n.kind].one}</span>
                    <span className="truncate">{n.title ?? n.label}</span>
                  </button>
                </li>
              ))}
              {text.trim() && !matches.some((m) => m.id === text.trim()) && (
                <li>
                  <button type="button" className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent" onClick={() => { onPick(text.trim()); setText(''); setOpen(false) }}>
                    Start from <span className="font-mono">{text.trim()}</span>
                  </button>
                </li>
              )}
            </ul>
          )}
          <NeedsBuilding className="px-2 pb-1 pt-2">a search across every item; suggestions come from the items already drawn, or type an id.</NeedsBuilding>
        </PopoverContent>
      </Popover>
      {focus && (
        <button type="button" className="text-sm text-primary hover:underline" onClick={onConnect}>
          Add a second item to see how they connect
        </button>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ toolbar

function KindPicker<T extends string>({ label, all, chosen, set, word }: { label: string; all: readonly T[]; chosen: Set<T>; set: (s: Set<T>) => void; word: (k: T) => string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          {label} <span className="font-semibold">{chosen.size === all.length ? `All ${label.toLowerCase()}` : `${chosen.size} of ${all.length}`}</span> <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-1">
        {all.map((k) => (
          <Label key={k} className="flex items-center gap-2 py-0.5 font-normal">
            <Checkbox
              checked={chosen.has(k)}
              onCheckedChange={(on) => {
                const n = new Set(chosen)
                if (on) n.add(k)
                else n.delete(k)
                set(n)
              }}
            />
            {word(k)}
          </Label>
        ))}
        <Button variant="link" size="sm" className="h-6 px-0" onClick={() => set(new Set(all))}>Show all</Button>
      </PopoverContent>
    </Popover>
  )
}

function Toolbar(p: {
  depth: number
  onDepth: (d: number) => void
  nodeKinds: Set<NodeKind>
  setNodeKinds: (s: Set<NodeKind>) => void
  linkKinds: Set<LinkKind>
  setLinkKinds: (s: Set<LinkKind>) => void
  chains: boolean
  setChains: (v: boolean) => void
  meaning: boolean
  setMeaning: (v: boolean) => void
  pinned: boolean
  setPinned: (v: boolean) => void
  mode: 'graph' | 'list'
  setMode: (m: 'graph' | 'list') => void
  canvas: React.RefObject<CanvasHandle | null>
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-muted-foreground" id="depth-label">Depth</span>
          <ToggleGroup type="single" variant="outline" size="sm" value={String(p.depth)} onValueChange={(v) => v && p.onDepth(Number(v))} aria-labelledby="depth-label">
            <ToggleGroupItem value="1" aria-label="1 link out">1</ToggleGroupItem>
            <ToggleGroupItem value="2" aria-label="2 links out">2</ToggleGroupItem>
            <ToggleGroupItem value="3" aria-label="3 links out" className="px-2.5">3 hops</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <KindPicker label="Kinds" all={NODE_KINDS} chosen={p.nodeKinds} set={p.setNodeKinds} word={(k) => NODE_WORD[k].one} />
        <KindPicker label="Links" all={LINK_KINDS} chosen={p.linkKinds} set={p.setLinkKinds} word={(k) => LINK_WORD[k]} />
        <Label className="flex items-center gap-2 font-normal">
          <Switch checked={p.chains} onCheckedChange={p.setChains} /> Show failing chains
        </Label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Label className="mr-auto flex items-center gap-2 font-normal">
          <Switch checked={p.meaning} onCheckedChange={p.setMeaning} /> Related by meaning (dashed)
        </Label>
        {p.mode === 'graph' && (
          <>
            <Button variant="outline" size="sm" onClick={() => p.canvas.current?.fit()}>Fit</Button>
            <div className="flex">
              <Button variant="outline" size="icon" className="size-8 rounded-r-none" aria-label="Zoom out" onClick={() => p.canvas.current?.zoom(0.8)}><Minus /></Button>
              <Button variant="outline" size="icon" className="size-8 rounded-l-none border-l-0" aria-label="Zoom in" onClick={() => p.canvas.current?.zoom(1.25)}><Plus /></Button>
            </div>
            <Button variant="outline" size="sm" aria-pressed={p.pinned} onClick={() => p.setPinned(!p.pinned)}>
              {p.pinned ? <PinOff /> : <Pin />} {p.pinned ? 'Unpin layout' : 'Pin layout'}
            </Button>
          </>
        )}
        <ToggleGroup type="single" variant="outline" size="sm" value={p.mode} onValueChange={(v) => v && p.setMode(v as 'graph' | 'list')} aria-label="Show as">
          <ToggleGroupItem value="graph" className="px-3">Graph</ToggleGroupItem>
          <ToggleGroupItem value="list" className="px-3">List</ToggleGroupItem>
        </ToggleGroup>
      </div>
    </div>
  )
}

function Legend() {
  const item = (shape: React.ReactNode, word: string) => (
    <li className="flex items-center gap-1.5">
      <span className="flex size-3.5 items-center justify-center" aria-hidden>{shape}</span>
      {word}
    </li>
  )
  const svg = (d: React.ReactNode) => <svg viewBox="0 0 14 14" className="size-3.5 fill-none stroke-current">{d}</svg>
  return (
    <div className="absolute bottom-3 left-3 hidden rounded-lg border bg-background/95 p-2.5 text-[11px] text-muted-foreground shadow-sm lg:block">
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
        {item(svg(<rect x="1" y="4" width="12" height="6" rx="3" />), 'Intent statement')}
        {item(svg(<path d="M7 1 13 7 7 13 1 7Z" />), 'Run or evidence')}
        {item(svg(<circle cx="7" cy="7" r="5.5" />), 'Requirement')}
        {item(svg(<path d="M7 1.5 13 12.5H1Z" />), 'Decision or waiver')}
        {item(svg(<rect x="2" y="2" width="10" height="10" rx="1.5" />), 'Block')}
        {item(svg(<circle cx="7" cy="7" r="4" strokeDasharray="1.5 1.5" />), 'Memory')}
        {item(svg(<path d="M4 1.5h6l3 5.5-3 5.5H4L1 7Z" />), 'Part')}
        {item(svg(<><rect x="2.5" y="1.5" width="9" height="11" /><path d="M4.5 5h5M4.5 7.5h5M4.5 10h3" /></>), 'Document')}
        {item(svg(<path d="M3 1.5h6l2.5 2.5v8.5H3Z" />), 'Datasheet page')}
        {item(svg(<><circle cx="7" cy="7" r="5.5" /><text x="7" y="9" fontSize="5" textAnchor="middle" className="fill-current stroke-none">PS</text></>), 'Person')}
      </ul>
      <div className="mt-2 flex gap-4 border-t pt-1.5">
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-5 bg-destructive" aria-hidden /> Failing chain</span>
        <span className="flex items-center gap-1.5"><span className="w-5 border-t border-dashed border-current" aria-hidden /> Related by meaning</span>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ the List switch

const listColumns: ColumnDef<ListRow, any>[] = [
  { accessorKey: 'item', header: 'Item', size: 260, meta: { label: 'Item', kind: 'text' }, cell: ({ row }) => <span className="font-medium"><Highlight text={row.original.item} /></span> },
  { accessorKey: 'kind', header: 'Kind', size: 150, meta: { label: 'Kind', kind: 'enum' } },
  { accessorKey: 'link', header: 'Link', size: 150, meta: { label: 'Link', kind: 'enum' } },
  { accessorKey: 'linkedTo', header: 'Linked to', size: 260, meta: { label: 'Linked to', kind: 'text' } },
  { accessorKey: 'status', header: 'Status', size: 130, meta: { label: 'Status', kind: 'enum' }, cell: ({ row }) => { const s = STATUS[row.original.status.toLowerCase().replace('switched off', 'inactive')]; return s ? <StatusBadge status={s} label={row.original.status} /> : row.original.status } },
]

function GraphList({ graph, focus, onOpen }: { graph: Graph; focus: string; onOpen: (id: string) => void }) {
  const rows = useMemo(() => listRows(graph, focus), [graph, focus])
  return <DataTable id="knowledge-graph-list" className="mt-3" data={rows} columns={listColumns} getRowId={(r) => r.id} noun="links" persist={false} onRowClick={(r) => onOpen(r.nodeId)} empty="Nothing is linked to this item yet." />
}

// ------------------------------------------------------------------ the side sheet

function ItemSheet(p: {
  node: GraphNode | null
  graph: Graph
  onClose: () => void
  onExpand: (id: string) => void
  onHide: (id: string) => void
  onShow: (id: string) => void
  onFocus: (id: string) => void
  to: string
  setTo: (id: string) => void
  path: ReturnType<typeof shortestPath>
  showPath: boolean
  setShowPath: (v: boolean) => void
  candidates: GraphNode[]
}) {
  const n = p.node
  if (!n) return null
  const groups = linksOf(p.graph, n.id)
  const total = groups.reduce((s, g) => s + g.items.length, 0)
  const status = n.status ? STATUS[n.status] : undefined
  return (
    <SideSheet
      open={!!n}
      onOpenChange={(o) => !o && p.onClose()}
      title={n.title ?? n.label}
      description={
        <span className="flex items-center gap-2">
          <span>{NODE_WORD[n.kind].one}{n.repo ? ` · ${projectName(n.repo)}` : ' · shared library'}</span>
          {status && <StatusBadge status={status} />}
        </span>
      }
    >
      {n.summary && <p className="text-[15px]">{n.summary}</p>}
      {n.facts && <Facts className="mt-4" items={Object.entries(n.facts)} />}
      <div className="mt-5 flex flex-wrap gap-2">
        {n.to && (
          <Button asChild>
            <Link to={n.to}>Open {n.kind === 'run' ? 'the run' : n.kind === 'part' ? 'the part' : n.kind === 'memory' ? 'the memory' : n.kind === 'requirement' ? 'the requirement' : ''}</Link>
          </Button>
        )}
        <Button variant="outline" onClick={() => p.onExpand(n.id)}>Expand its links</Button>
        <Button variant="outline" onClick={() => p.onFocus(n.id)}>Start from here</Button>
        <Button variant="outline" onClick={() => p.onHide(n.id)}>Hide from view</Button>
      </div>

      <Separator className="my-5" />
      <h3 className="text-sm font-semibold">Connected to ({total})</h3>
      {groups.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No links shown with the filters on.</p>
      ) : (
        groups.map((g) => (
          <div key={g.word} className="mt-3">
            <p className="text-xs text-muted-foreground">{g.word}</p>
            <ul className="mt-1 space-y-1.5">
              {g.items.map(({ node: o, link }) => (
                <li key={link.id} className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-sm', link.kind === 'related' && 'border-dashed')}>
                  <span className="min-w-0 flex-1 truncate">{o.title ?? o.label}</span>
                  <button type="button" className="shrink-0 text-xs text-primary hover:underline" onClick={() => p.onShow(o.id)}>
                    Show in graph
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}

      <Separator className="my-5" />
      <h3 className="text-sm font-semibold">How is this connected to…</h3>
      <select id="connect-to" aria-label="A second item" className="mt-2 h-10 w-full rounded-md border bg-background px-2 text-sm" value={p.to} onChange={(e) => p.setTo(e.target.value)}>
        <option value="">Choose a second item</option>
        {p.candidates.filter((c) => c.id !== n.id).sort((a, b) => (a.title ?? a.label).localeCompare(b.title ?? b.label)).map((c) => (
          <option key={c.id} value={c.id}>{c.title ?? c.label}</option>
        ))}
      </select>
      {p.to && (
        <div className="mt-3 rounded-lg bg-muted/60 p-3 text-sm">
          {p.path ? (
            <>
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                {p.path.map((s, i) => (
                  <span key={s.node.id} className="inline-flex items-center gap-1.5">
                    {i > 0 && <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />}
                    <span>{s.node.title ?? s.node.label}</span>
                  </span>
                ))}
              </p>
              <p className="sr-only">{pathWords(p.path)}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                {plural(p.path.length - 1, 'link')} ·{' '}
                <button type="button" className="text-primary hover:underline" onClick={() => p.setShowPath(!p.showPath)}>
                  {p.showPath ? 'Stop showing the path' : 'Show path in graph'}
                </button>
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">No path between these two with the links shown. Turn on more link kinds, or go a level deeper.</p>
          )}
        </div>
      )}
    </SideSheet>
  )
}
