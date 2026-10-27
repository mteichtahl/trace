/**
 * The picture a guided step opens with (docs/ui-design.md, "Focus mode": "It always opens with the picture for the
 * step"). One component for every kind the skill table names: the schematic sheet or board with its findings, the
 * block diagram, the pin map, the traceability view, the bench wiring view. Each draws from the record (design.get,
 * verify.coverage, files.url); where the record has no picture yet, it says which and why instead of inventing one.
 */
import { useState } from 'react'
import { openPanel } from '@/components/chat/chat-state'
import { CanvasFrame } from '@/components/canvas/canvas-frame'
import { drawn } from '@/components/project/architecture'
import { BlockDiagram } from '@/components/project/block-diagram'
import { useCoverage } from '@/components/project/shared'
import { TRACE_WIDTH, Traceability } from '@/components/project/traceability'
import { StatusBadge } from '@/components/status-badge'
import { useAction } from '@/lib/queries'
import type { PictureFinding, SkillView } from '@/lib/types-s1'
import { cn } from '@/lib/utils'
import { PICTURE_WORDS, type PictureKind } from './definitions'
import { FindingsPicture } from './findings'

export function StepPicture({ repo, kind, view, selected, onSelect, height = 340 }: { repo: string; kind: PictureKind; view?: SkillView; selected?: string | null; onSelect?: (id: string | null) => void; height?: number }) {
  const design = useAction('design.get', { repo }, { enabled: ['sheet', 'board', 'render', 'block-diagram', 'pin-map'].includes(kind) })
  const cov = useCoverage(repo)
  const trace = useAction('requirements.trace', { repo }, { enabled: kind === 'traceability' })
  const [sheet] = useState(0)
  const d = design.data
  if (kind === 'none' || kind === 'report' || kind === 'order-sheet') return null

  if (kind === 'sheet') {
    const s = view?.sheets?.[sheet] ?? d?.sheets[sheet]
    const findings: PictureFinding[] = view?.findings?.filter((f) => !f.sheet || f.sheet === s?.id) ?? (s && 'findings' in s ? s.findings : [])
    return <FindingsPicture repo={repo} title={s?.name ?? 'Schematic'} subtitle={s ? `Sheet ${sheet + 1} of ${view?.sheets?.length ?? d?.sheets.length ?? 1}${view?.push ? ` · push ${view.push.sha}` : ''}` : undefined} path={s?.path} findings={findings} selected={selected} onSelect={onSelect} height={height} onAsk={() => openPanel(true)} />
  }
  if (kind === 'board' || kind === 'render') {
    const findings = kind === 'board' ? (view?.findings ?? d?.board?.findings ?? []) : []
    return <FindingsPicture repo={repo} title={kind === 'render' ? 'Board render · top' : 'Board · top'} subtitle={d?.board?.size} path={d?.board?.path} findings={findings} selected={selected} onSelect={onSelect} height={height} onAsk={() => openPanel(true)} emptyText="No board yet: trace draws it once the board file exists." />
  }
  if (kind === 'block-diagram') {
    return (
      <CanvasFrame title="Block diagram" subtitle={d?.architecture?.option} height={height + 40} onAsk={() => openPanel(true)}>
        {d?.architecture ? <div className="origin-center scale-[0.4] sm:scale-[0.7] 2xl:scale-90"><BlockDiagram {...drawn(d.architecture, d.architecture.id ?? null)} /></div> : <Empty kind={kind} loading={design.isLoading} />}
      </CanvasFrame>
    )
  }
  if (kind === 'pin-map') {
    const pins = d?.pins ?? []
    return (
      <CanvasFrame title="Pin map" subtitle={pins.length ? `${pins.length} pins` : undefined} height={height} zoomable={false}>
        {pins.length ? (
          <div className="grid w-full grid-cols-2 gap-1.5 overflow-auto p-4 sm:grid-cols-4 lg:grid-cols-5">
            {pins.map((p) => (
              <div key={`${p.part ?? ''}.${p.pin}`} className={cn('rounded-md border bg-card p-2 text-xs', p.status === 'conflict' && 'border-destructive', p.status === 'spare' && 'border-dashed')}>
                <p className="font-mono font-semibold">{p.part ? `${p.part}.` : ''}{p.pin}{p.name ? <span className="font-normal text-muted-foreground"> {p.name}</span> : null}</p>
                <p className="truncate font-mono text-muted-foreground">{p.net}</p>
                <p className="truncate">{p.fn}</p>
                {p.status !== 'ok' && <StatusBadge plain status={p.status === 'conflict' ? 'failing' : p.status === 'waived' ? 'waived' : 'idle'} label={p.status === 'spare' ? 'Spare' : undefined} />}
              </div>
            ))}
          </div>
        ) : <Empty kind={kind} loading={design.isLoading} />}
      </CanvasFrame>
    )
  }
  if (kind === 'traceability') {
    const rows = cov.data?.requirements ?? []
    return (
      <CanvasFrame title="Traceability" subtitle="intent → requirement → evidence" height={height + 60} onAsk={() => openPanel(true)}>
        {rows.length ? <div className="origin-center scale-[0.5] sm:scale-75 2xl:scale-90" style={{ width: TRACE_WIDTH }}><Traceability rows={rows} trace={trace.data} onSelect={() => undefined} /></div> : <Empty kind={kind} loading={cov.isLoading} />}
      </CanvasFrame>
    )
  }
  // bench wiring
  const wires = view?.bench?.wires ?? []
  return (
    <CanvasFrame title="Bench wiring" subtitle={wires.length ? `${wires.filter((w) => w.done).length} of ${wires.length} connected` : undefined} height={height} zoomable={wires.length > 0}>
      {wires.length ? <BenchWiring wires={wires} /> : <Empty kind={kind} loading={false} />}
    </CanvasFrame>
  )
}

function Empty({ kind, loading }: { kind: PictureKind; loading: boolean }) {
  return <p className="max-w-sm px-6 text-center text-sm text-muted-foreground">{loading ? 'Loading…' : `No ${PICTURE_WORDS[kind].replace(/^the /, '')} yet: trace draws it from the record once this stage has one.`}</p>
}

type Wire = NonNullable<NonNullable<SkillView['bench']>['wires']>[number]

/** The bench wiring view: instruments on the left, the board's connection points on the right, power drawn apart. */
export function BenchWiring({ wires }: { wires: Wire[] }) {
  const H = 60 + wires.length * 56
  return (
    <svg viewBox={`0 0 720 ${H}`} className="h-full max-h-full w-full max-w-[720px]" role="img" aria-label={`Bench wiring: ${wires.map((w) => `${w.from} to ${w.to} (${w.net})${w.done ? ', connected' : ''}`).join('; ')}`}>
      <rect x={470} y={20} width={220} height={H - 40} rx={14} fill="var(--card)" stroke="var(--border)" strokeWidth={2} />
      <text x={580} y={44} textAnchor="middle" fontSize={13} fontWeight={600} fill="var(--foreground)">Board</text>
      {wires.map((w, i) => {
        const y = 70 + i * 56
        const colour = w.power ? 'var(--destructive)' : 'var(--chart-1)'
        return (
          <g key={w.id}>
            <rect x={20} y={y - 16} width={200} height={32} rx={8} fill="var(--card)" stroke="var(--border)" />
            <text x={34} y={y + 4} fontSize={12} fill="var(--foreground)">{w.from}</text>
            <path d={`M220 ${y} C 340 ${y}, 360 ${y}, 470 ${y}`} stroke={colour} strokeWidth={w.power ? 3 : 2} fill="none" strokeDasharray={w.done ? undefined : '6 5'} />
            <text x={345} y={y - 8} textAnchor="middle" fontSize={11} fill="var(--muted-foreground)">{w.net}{w.limit ? ` · limit ${w.limit}` : ''}</text>
            <circle cx={470} cy={y} r={6} fill={w.done ? colour : 'var(--background)'} stroke={colour} strokeWidth={2} />
            <text x={486} y={y + 4} fontSize={12} fontFamily="var(--font-mono, monospace)" fill="var(--foreground)">{w.to}</text>
            <text x={680} y={y + 4} textAnchor="end" fontSize={11} fill={w.done ? 'var(--verified)' : 'var(--muted-foreground)'}>{w.done ? '✓ connected' : 'to connect'}</text>
          </g>
        )
      })}
    </svg>
  )
}
