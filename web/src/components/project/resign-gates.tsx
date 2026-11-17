/**
 * The gates to sign again after a change of requirements took the project back (journey.get `resign`,
 * src/api/reopen-scope.ts). Every gate from Define is signed again, as before; this says which ones, and for each
 * whether its evidence stands, so a person sees that re-signing is quick where the change does not reach the work
 * (test-esp32 log #62, #71: four gates went back to Queued with nothing saying that most of them were unchanged).
 */
import { Link } from '@tanstack/react-router'
import { ExceptionCard } from '@/components/exception-card'
import { Button } from '@/components/ui/button'
import { StatusBadge, type Status } from '@/components/status-badge'
import { plural } from '@/lib/format'
import type { Journey } from '@/lib/types'

type Resign = NonNullable<Journey['resign']>

const STATE: Record<Resign['gates'][number]['state'], { status: Status; label: string }> = {
  agree: { status: 'yours', label: 'Agree the change' },
  kept: { status: 'verified', label: 'Evidence unchanged' },
  redo: { status: 'waiting', label: 'Part redone' },
  signed: { status: 'done', label: 'Signed again' },
}

/** The card's heading and opening line. Pure. */
export function resignText(r: Resign): { title: string; body: string } {
  const left = r.gates.filter((g) => g.state !== 'signed')
  const kept = left.filter((g) => g.state === 'kept').length
  const keeps = !kept ? ''
    : kept === left.length ? ' Each keeps its evidence: open it and sign again, nothing is redone.'
    : ` ${plural(kept, 'gate')} ${kept === 1 ? 'keeps its' : 'keep their'} evidence: open and sign again, nothing is redone there.`
  return {
    title: `${plural(left.length, 'gate')} to sign again`,
    body: `${r.edits.replace(/^./, (c) => c.toUpperCase())} after the requirements baseline, so the project went back to Define.${keeps}`,
  }
}

export function ResignGates({ resign, id, open = true, className }: { resign: Resign; id: string; /** the gates listed from the start */ open?: boolean; className?: string }) {
  const t = resignText(resign)
  const first = resign.gates.find((g) => g.state !== 'signed')
  return (
    <ExceptionCard
      tone="back"
      label="Gates to sign again"
      title={t.title}
      body={<span className="text-muted-foreground">{t.body}</span>}
      sentBack="Define"
      action={first && (
        <Button asChild size="sm" variant="outline">
          <Link to="/p/$id/gates/$gate" params={{ id, gate: first.gate }}>Open {first.name}</Link>
        </Button>
      )}
      detailLabel="Which gates, and why"
      open={open}
      className={className}
      detail={
        <ul className="divide-y border-t">
          {resign.gates.map((g) => (
            <li key={g.gate} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:gap-4">
              <div className="min-w-0 flex-1">
                <Link to="/p/$id/gates/$gate" params={{ id, gate: g.gate }} className="font-medium hover:underline">
                  {g.name.replace(/^./, (c) => c.toUpperCase())}
                </Link>
                <p className="text-xs text-muted-foreground">{g.why}</p>
              </div>
              <StatusBadge status={STATE[g.state].status} label={STATE[g.state].label} className="shrink-0 self-start" />
            </li>
          ))}
        </ul>
      }
    />
  )
}
