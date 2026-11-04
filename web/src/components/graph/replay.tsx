/**
 * The replay player in the graph view (docs/ontology-plan.md P8.3): the project's record played back from its intent,
 * the graph growing as each record is made. Play, pause, speed, a scrubber with each stage's start marked, stage chips
 * that jump to a chapter, a caption naming who did what and from which record, a filter by person or specialist, and
 * a click through to the record. The events come from journey.replay (every page read); the graph at the playhead
 * is lib/replay.ts graphAt. Keyboard: Space plays and pauses, ← and → step, Home and End go to either end.
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, ExternalLink, Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Slider } from '@/components/ui/slider'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { EmptyState, ErrorState } from '@/components/states'
import { call, projectName } from '@/lib/api'
import { NODE_WORD } from '@/lib/graph'
import { type Replay, type ReplayPage, SPEEDS, chapterAt, chapterIndex, graphAt, joinPages, shown, step } from '@/lib/replay'
import { cn } from '@/lib/utils'
import type { CanvasHandle } from './graph-canvas'

const GraphCanvas = lazy(() => import('./graph-canvas'))

/** Every page of journey.replay, oldest first. */
async function readReplay(repo: string, signal?: AbortSignal): Promise<Replay> {
  const pages: ReplayPage[] = []
  let after: string | undefined
  for (let i = 0; i < 200; i++) {
    const p = await call('journey.replay', { repo, limit: 1000, ...(after ? { after } : {}) }, { signal })
    pages.push(p)
    if (!p.next) break
    after = p.next
  }
  return joinPages(pages)
}

const when = (at: string) => new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const EVERYONE = '__everyone'

export function ReplayPlayer({ repo, onExit }: { repo: string; onExit: () => void }) {
  const q = useQuery({ queryKey: ['journey.replay', repo], queryFn: ({ signal }) => readReplay(repo, signal), retry: false })
  const r = q.data
  const [at, setAt] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<number>(2)
  const [who, setWho] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const canvas = useRef<CanvasHandle>(null)
  const total = r?.events.length ?? 0

  // start at the end: the record as it stands, ready to play back from the start
  useEffect(() => { if (r) setAt(r.events.length) }, [r])

  // playing: one event (that the filter shows) per tick
  useEffect(() => {
    if (!playing || !r) return
    if (at >= total) { setPlaying(false); return }
    const id = setTimeout(() => setAt((i) => step(r, i, who)), 1000 / speed)
    return () => clearTimeout(id)
  }, [playing, at, speed, r, who, total])

  const graph = useMemo(() => (r ? graphAt(r, at, who) : { nodes: [], links: [] }), [r, at, who])
  const current = r && at > 0 ? r.events[at - 1] : undefined
  const chapter = r ? chapterAt(r, Math.max(0, at - 1)) : null
  const recent = useMemo(() => (r ? r.events.slice(0, at).filter((e) => shown(e, who)).slice(-6).reverse() : []), [r, at, who])
  const node = picked ? graph.nodes.find((n) => n.id === picked) ?? null : null


  const play = () => {
    if (!r) return
    if (at >= total) setAt(0)
    setPlaying((p) => !p)
  }
  const keys = (e: React.KeyboardEvent) => {
    if (!r || (e.target as HTMLElement).closest('input, [role="combobox"], [role="slider"]')) return
    if (e.key === ' ') { e.preventDefault(); play() }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setPlaying(false); setAt((i) => step(r, i, who)) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setPlaying(false); setAt((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Home') { e.preventDefault(); setAt(0) }
    else if (e.key === 'End') { e.preventDefault(); setAt(total) }
  }

  return (
    <section aria-label={`Replay of ${projectName(repo)}`} className="mt-4" onKeyDown={keys}>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onExit}><ArrowLeft /> Back to the graph</Button>
        <h2 className="text-base font-semibold">Replay · {projectName(repo)}</h2>
        {r && r.events.length > 0 && <span className="text-xs text-muted-foreground">{when(r.events[0]!.at)} – {when(r.events.at(-1)!.at)} · {r.events.length} records</span>}
      </div>

      {q.isLoading ? (
        <Skeleton className="mt-3 h-[560px] rounded-xl" />
      ) : q.isError ? (
        <ErrorState className="mt-3" title="Could not read the project's record." onRetry={() => void q.refetch()} detail={q.error instanceof Error ? q.error.message : String(q.error)} />
      ) : !r || r.events.length === 0 ? (
        <EmptyState className="mt-3">Nothing to replay yet: the project's journey has not started.</EmptyState>
      ) : (
        <>
          {/* chapters: each stage the first time it started */}
          <nav aria-label="Chapters" className="mt-3 flex flex-wrap gap-1.5">
            {r.chapters.map((c) => {
              const here = chapter?.stage === c.stage
              return (
                <button
                  key={c.stage}
                  type="button"
                  aria-current={here ? 'step' : undefined}
                  className={cn('rounded-full border px-3 py-1 text-xs', here ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-accent')}
                  onClick={() => { setPlaying(false); setAt(chapterIndex(r, c) + 1) }}
                >
                  {c.name}
                </button>
              )
            })}
          </nav>

          <div className="relative mt-3 h-[min(62vh,580px)] min-h-[400px] overflow-hidden rounded-xl border bg-muted/20">
            {graph.nodes.length === 0 ? (
              <p className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">Press play: the record grows from its first entry.</p>
            ) : (
              <Suspense fallback={<Skeleton className="absolute inset-0" />}>
                <GraphCanvas
                  handle={canvas}
                  graph={graph}
                  groups={[]}
                  focus={current?.node ?? ''}
                  selected={picked}
                  chain={null}
                  path={null}
                  pinned={false}
                  grow
                  onSelect={setPicked}
                  onOpenGroup={() => undefined}
                  onHover={() => undefined}
                />
              </Suspense>
            )}

            {/* a node picked: what it is, and the record */}
            {node && (
              <div className="absolute right-3 top-3 w-64 rounded-lg border bg-background p-3 text-sm shadow">
                <p className="text-xs text-muted-foreground">{NODE_WORD[node.kind].one}</p>
                <p className="font-medium">{node.title ?? node.label}</p>
                <div className="mt-2 flex gap-2">
                  {node.to && <Button asChild size="sm" variant="outline"><Link to={node.to}><ExternalLink /> Open the record</Link></Button>}
                  <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>Close</Button>
                </div>
              </div>
            )}
          </div>

          {/* the caption: who did what, from which record */}
          {current ? (
            <div aria-live="polite" className="mt-3 min-h-16 rounded-lg border bg-background p-3">
              <p className="text-sm font-medium">{current.caption}</p>
              <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <span>{when(current.at)}</span>
                {current.who && <span>by {current.who}</span>}
                <span>from <span className="font-mono">{current.source}</span></span>
                <span className="truncate font-mono" title={current.record}>{current.class}</span>
              </p>
            </div>
          ) : (
            <p aria-live="polite" className="mt-3 min-h-16 rounded-lg border bg-background p-3 text-sm text-muted-foreground">The start of the record.</p>
          )}

          {/* the controls */}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1">
              <Button size="icon" variant="ghost" aria-label="To the start" onClick={() => { setPlaying(false); setAt(0) }}><SkipBack /></Button>
              <Button size="icon" aria-label={playing ? 'Pause' : 'Play'} onClick={play}>{playing ? <Pause /> : <Play />}</Button>
              <Button size="icon" variant="ghost" aria-label="To the end" onClick={() => { setPlaying(false); setAt(total) }}><SkipForward /></Button>
            </div>
            <div className="relative min-w-48 flex-1 pb-3">
              <Slider aria-label="Where in the record" min={0} max={total} step={1} value={[at]} onValueChange={([v]) => { setPlaying(false); setAt(v ?? 0) }} />
              {r.chapters.map((c) => (
                <span key={c.stage} aria-hidden className="absolute top-3 h-2 w-px bg-muted-foreground/60" style={{ left: `${(chapterIndex(r, c) / Math.max(1, total)) * 100}%` }} title={c.name} />
              ))}
            </div>
            <span className="w-24 text-right text-xs tabular-nums text-muted-foreground">{at} of {total}</span>
            <ToggleGroup type="single" size="sm" variant="outline" value={String(speed)} onValueChange={(v) => v && setSpeed(Number(v))} aria-label="Speed">
              {SPEEDS.map((s) => <ToggleGroupItem key={s} value={String(s)} aria-label={`${s} records a second`}>{s}×</ToggleGroupItem>)}
            </ToggleGroup>
            <Select value={who ?? EVERYONE} onValueChange={(v) => setWho(v === EVERYONE ? null : v)}>
              <SelectTrigger size="sm" className="w-56" aria-label="Whose records"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={EVERYONE}>Everyone</SelectItem>
                {r.people.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {/* the latest records, each a step to jump back to */}
          <ol aria-label="The latest records" className="mt-3 divide-y rounded-lg border text-sm">
            {recent.map((e) => {
              const i = r.events.indexOf(e) + 1
              return (
                <li key={e.id}>
                  <button type="button" className={cn('flex w-full items-baseline gap-3 px-3 py-1.5 text-left hover:bg-accent', i === at && 'bg-accent/60')} onClick={() => { setPlaying(false); setAt(i); if (e.node) setPicked(e.node) }}>
                    <span className="w-36 shrink-0 text-xs tabular-nums text-muted-foreground">{when(e.at)}</span>
                    <span className="flex-1">{e.caption}</span>
                    <span className="hidden font-mono text-xs text-muted-foreground sm:inline">{e.source}</span>
                  </button>
                </li>
              )
            })}
          </ol>
          <p className="mt-2 text-xs text-muted-foreground">
            <kbd className="rounded border px-1 font-mono">Space</kbd> plays and pauses · <kbd className="rounded border px-1 font-mono">←</kbd> <kbd className="rounded border px-1 font-mono">→</kbd> step · <kbd className="rounded border px-1 font-mono">Home</kbd> <kbd className="rounded border px-1 font-mono">End</kbd> go to either end
          </p>
        </>
      )}
    </section>
  )
}
