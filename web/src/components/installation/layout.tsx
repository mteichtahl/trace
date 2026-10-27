/**
 * Where this installation keeps each project's cloud resources (installation.layout, src/api/actions-layout.ts), in
 * words, for Admin › Installation (LayoutSection: what a flat installation lacks, the recommendation and the move's
 * steps and costs) and New project (FlatNote: what a project created here gets in a flat installation). A nested
 * installation shows nothing on New project: it has everything.
 */
import { ArrowRight, Layers } from 'lucide-react'
import { StatusBadge } from '@/components/status-badge'
import { useAction } from '@/lib/queries'

export interface LayoutView {
  layout: 'flat' | 'nested'
  projects: { max: number; updateMax: number }
  has: { knowledgeBase: boolean; cpuQueue: boolean; answerEvents: boolean }
  note: string
  recommendation?: string
  move?: { how: string; steps: string[]; costs: string; gives: string }
}

/** What the layout lacks, as short phrases (none for nested). */
export function missing(v: Pick<LayoutView, 'has'>): string[] {
  return [
    ...(v.has.knowledgeBase ? [] : ['a knowledge base per project']),
    ...(v.has.cpuQueue ? [] : ['the CPU queue for heavy simulations']),
    ...(v.has.answerEvents ? [] : ['agents told at once when you answer their question']),
  ]
}

export function LayoutSection() {
  const q = useAction('installation.layout', {})
  const v = q.data as LayoutView | undefined
  if (!v) return null
  if (v.layout === 'nested') {
    return (
      <div className="flex flex-wrap items-start gap-x-4 gap-y-1 rounded-xl border bg-card px-5 py-3.5" data-density-item>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Project layout</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{v.note}</p>
        </div>
        <StatusBadge status="verified" label="One stack per project" />
      </div>
    )
  }
  return (
    <div className="rounded-xl border bg-card px-5 py-4" data-density-item>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium"><Layers className="size-4" aria-hidden /> Project layout: every project in one stack</p>
          <p className="mt-1 text-sm text-muted-foreground">{v.note}</p>
        </div>
        <StatusBadge status="warning" label={`Up to ${v.projects.max} projects`} />
      </div>
      <p className="mt-3 text-sm"><span className="font-medium">Missing here: </span>{missing(v).join('; ')}.</p>
      {v.recommendation && <p className="mt-2 text-sm"><span className="font-medium">Recommendation: </span>{v.recommendation}</p>}
      {v.move && (
        <div className="mt-3 rounded-lg bg-muted/50 p-3 text-sm">
          <p className="font-medium">How to move to one nested stack per project</p>
          <p className="mt-1">{v.move.how}</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
            {v.move.steps.map((s) => <li key={s}>{s}</li>)}
          </ol>
          <p className="mt-2"><span className="font-medium">What it costs: </span>{v.move.costs}</p>
          <p className="mt-1 flex items-start gap-1.5"><ArrowRight className="mt-0.5 size-3.5 shrink-0" aria-hidden /><span><span className="font-medium">What it gives: </span>{v.move.gives}</span></p>
          <p className="mt-2 text-xs text-muted-foreground">The automatic update never makes this move: it deletes the agents' memory records, so it is yours to choose.</p>
        </div>
      )}
    </div>
  )
}

/** On New project, in a flat installation only: what the new project gets, and where the move is explained. */
export function FlatNote() {
  const q = useAction('installation.layout', {})
  const v = q.data as LayoutView | undefined
  if (!v || v.layout !== 'flat') return null
  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm" role="note">
      <p className="font-medium">This installation keeps every project in one stack</p>
      <p className="mt-1 text-muted-foreground">
        The new project gets its agent, memory and build runner, but not {missing(v).join(', or ')}. About {v.projects.max} projects fit; the
        automatic update adds new ones while there are fewer than {v.projects.updateMax}, and the installer adds the rest.
      </p>
      <p className="mt-1 text-muted-foreground">Admin › Installation explains the move to one nested stack per project, which adds all of these.</p>
    </div>
  )
}
