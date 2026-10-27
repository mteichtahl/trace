/**
 * The stage rail: the journey's stages left to right with a diamond for each gate between them.
 *
 * - done: a filled dot with a check; its gate diamond filled (hover: who signed and when)
 * - current: an accent ring with its name and "4 of 6 criteria met"
 * - reopened: a small return arrow and "Reopened: <why>"
 * - queued: hollow, "Queued" (hover: what trace has prepared, and that it starts when the gate is signed)
 * - optional later stages appear after a short gap
 *
 * Three forms: `full` (the project page), `compact` (Home rows: nine small dots) and `bar` (phones: a progress bar
 * with the stage's name). Every form reads to a screen reader as "Stage 3 of 9, Capture, 4 of 6 criteria met".
 */
import { Check, CornerUpLeft } from 'lucide-react'
import { Fragment } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ago } from '@/lib/format'
import type { Gate, Stage } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface StageRailProps {
  stages: Stage[]
  gates?: Gate[]
  variant?: 'full' | 'compact' | 'bar'
  /** tapping a stage opens its page */
  onSelect?: (stage: Stage) => void
  className?: string
}

/** "Stage 3 of 9, Capture, 4 of 6 criteria met" (and ", reopened: …" when it was). */
export function stageRailLabel(stages: Stage[]): string {
  const core = stages.filter((s) => !s.optional || s.state !== 'skipped')
  const i = core.findIndex((s) => s.state === 'current' || s.state === 'reopened')
  if (i < 0) {
    const done = core.every((s) => s.state === 'done')
    return done ? `All ${core.length} stages done` : `${core.length} stages, none started`
  }
  const s = core[i]!
  const crit = s.criteria.total ? `, ${s.criteria.met} of ${s.criteria.total} criteria met` : ''
  const re = s.state === 'reopened' && s.reopened ? `, reopened: ${s.reopened.reason}` : ''
  return `Stage ${i + 1} of ${core.length}, ${s.name}${crit}${re}`
}

const gateAfter = (gates: Gate[] | undefined, stage: Stage) => gates?.find((g) => g.after === stage.id)

function stageNote(s: Stage): string {
  switch (s.state) {
    case 'done': return 'Done'
    case 'current': return s.criteria.total ? `${s.criteria.met} of ${s.criteria.total} criteria met` : 'In progress'
    case 'reopened': return 'Reopened'
    case 'skipped': return 'Skipped'
    default: return 'Queued'
  }
}

function StageDot({ s, size = 26 }: { s: Stage; size?: number }) {
  const r = size / 2
  if (s.state === 'done') {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="text-foreground">
        <circle cx={r} cy={r} r={r - 1} fill="currentColor" />
        <foreignObject x={size * 0.25} y={size * 0.25} width={size * 0.5} height={size * 0.5}>
          <Check className="size-full text-background" strokeWidth={3} />
        </foreignObject>
      </svg>
    )
  }
  if (s.state === 'current' || s.state === 'reopened') {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="text-primary">
        <circle cx={r} cy={r} r={r - 2} fill="var(--background)" stroke="currentColor" strokeWidth={3} />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="text-muted-foreground/50">
      <circle cx={r} cy={r} r={r - 1.5} fill="none" stroke="currentColor" strokeWidth={1.25} />
    </svg>
  )
}

function Diamond({ gate, size = 10 }: { gate?: Gate; size?: number }) {
  const signed = gate?.state === 'signed'
  const ready = gate?.state === 'ready' || gate?.state === 'open'
  const h = size / 2
  return (
    <svg width={size + 2} height={size + 2} viewBox={`-1 -1 ${size + 2} ${size + 2}`} aria-hidden className={cn(signed ? 'text-foreground' : ready ? 'text-primary' : 'text-muted-foreground/45')}>
      <path d={`M${h} 0 L${size} ${h} L${h} ${size} L0 ${h} Z`} fill={signed ? 'currentColor' : 'var(--background)'} stroke="currentColor" strokeWidth={signed ? 0 : 1.5} />
    </svg>
  )
}

function StageHover({ s, gate }: { s: Stage; gate?: Gate }) {
  return (
    <div className="space-y-1 text-sm">
      <p className="font-medium">{s.name}</p>
      {s.state === 'done' && <p className="text-muted-foreground">Done{gate?.signature ? `. ${gate.name} signed by ${gate.signature.by}, ${ago(gate.signature.at)}.` : '.'}</p>}
      {(s.state === 'current' || s.state === 'reopened') && <p className="text-muted-foreground">{stageNote(s)}.</p>}
      {s.state === 'reopened' && s.reopened && <p className="text-muted-foreground">Reopened: {s.reopened.reason}</p>}
      {s.state === 'queued' && (
        <p className="text-muted-foreground">
          {s.prepared ? `${s.prepared} ` : ''}Starts only when the gate before it is signed.
        </p>
      )}
    </div>
  )
}

export function StageRail({ stages, gates, variant = 'full', onSelect, className }: StageRailProps) {
  const label = stageRailLabel(stages)
  const visible = stages.filter((s) => !(s.optional && s.state === 'skipped'))
  const ci = visible.findIndex((s) => s.state === 'current' || s.state === 'reopened')
  const current = ci >= 0 ? visible[ci] : undefined

  if (variant === 'bar') {
    const done = visible.filter((s) => s.state === 'done').length
    const frac = (done + (current && current.criteria.total ? current.criteria.met / current.criteria.total : 0.5)) / Math.max(1, visible.length)
    return (
      <div role="img" aria-label={label} className={cn('space-y-1.5', className)}>
        <div className="flex justify-between text-xs text-muted-foreground" aria-hidden>
          <span>{current ? `Stage ${ci + 1} of ${visible.length} · ${current.name}` : label}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(frac * 100)}%` }} />
        </div>
      </div>
    )
  }

  if (variant === 'compact') {
    const step = 14
    const w = visible.length * step
    return (
      <div className={cn('inline-flex flex-col items-center gap-1', className)}>
        <Tooltip>
          <TooltipTrigger asChild>
            <svg role="img" aria-label={label} width={w} height={12} viewBox={`0 0 ${w} 12`} className="overflow-visible">
              {visible.map((s, i) => {
                const cx = i * step + 6
                if (s.state === 'done') return <circle key={s.id} cx={cx} cy={6} r={4.5} className="fill-foreground" />
                if (s.state === 'current' || s.state === 'reopened') return <circle key={s.id} cx={cx} cy={6} r={4.5} fill="var(--background)" className="stroke-primary" strokeWidth={2.2} />
                return <circle key={s.id} cx={cx} cy={6} r={4} fill="none" className="stroke-muted-foreground/50" strokeWidth={1} />
              })}
            </svg>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
        {current && (
          <span className="text-xs text-muted-foreground" aria-hidden>
            {current.name}
            {current.criteria.total ? ` · ${current.criteria.met} of ${current.criteria.total} criteria met` : ''}
          </span>
        )}
      </div>
    )
  }

  return (
    <div role="group" aria-label={label} className={cn('w-full overflow-x-auto', className)}>
      <ol className="flex min-w-max items-start justify-between gap-1 px-1">
        {visible.map((s, i) => {
          const gate = gateAfter(gates, s)
          const isCurrent = s.state === 'current' || s.state === 'reopened'
          const gap = s.optional && !visible[i - 1]?.optional && i > 0
          return (
            <Fragment key={s.id}>
              {gap && <li aria-hidden className="w-6" />}
              <li className="flex min-w-[72px] flex-1 flex-col items-center text-center">
                <HoverCard openDelay={200}>
                  <HoverCardTrigger asChild>
                    <button
                      type="button"
                      onClick={() => onSelect?.(s)}
                      className="group flex flex-col items-center gap-1.5 rounded-md px-1 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`${s.name}: ${stageNote(s)}${s.state === 'reopened' && s.reopened ? `. Reopened: ${s.reopened.reason}` : ''}`}
                      aria-current={isCurrent ? 'step' : undefined}
                    >
                      <span className="relative">
                        <StageDot s={s} />
                        {s.state === 'reopened' && (
                          <CornerUpLeft className="absolute -right-2.5 -top-1.5 size-3.5 rounded-full bg-background text-warning-foreground" aria-hidden />
                        )}
                      </span>
                      <span className={cn('text-[13px]', isCurrent ? 'font-semibold text-primary' : s.state === 'done' ? 'text-foreground' : 'text-muted-foreground')}>{s.name}</span>
                      <span className={cn('text-xs', isCurrent ? 'text-primary' : 'text-muted-foreground')}>{stageNote(s)}</span>
                    </button>
                  </HoverCardTrigger>
                  <HoverCardContent className="w-64">
                    <StageHover s={s} gate={gate} />
                  </HoverCardContent>
                </HoverCard>
              </li>
              {i < visible.length - 1 && !(visible[i + 1]?.optional && !s.optional) && (
                <li aria-hidden className="mt-2">
                  {gate?.signature ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex"><Diamond gate={gate} /></span>
                      </TooltipTrigger>
                      <TooltipContent>{gate.name} signed by {gate.signature.by}, {ago(gate.signature.at)}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Diamond gate={gate} />
                  )}
                </li>
              )}
            </Fragment>
          )
        })}
      </ol>
      {visible.some((s) => s.firmware) && (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
          <span>Firmware track</span>
          {visible.filter((s) => s.firmware).map((s, i) => (
            <Fragment key={s.id}>
              {i > 0 && <span aria-hidden>—</span>}
              <span className="inline-flex items-center gap-1">
                {s.firmware!.ok ? <Check className="size-3.5" aria-hidden /> : <span className="size-2 rounded-full border" aria-hidden />}
                {s.name} · {s.firmware!.text}
              </span>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}
