/**
 * The Release review's steps (docs/user-journey.md, "Release review"): what the record holds for each area, the
 * person's acknowledgement of it, and the Decide step's note. trace reads the report in a fixed order, so each step
 * shows its own area: the EMC prechecks and estimates (pre-compliance estimates) with their waivers, the parts list's
 * cost, stock, sellers and lifecycle, the DRC result and what the fab places, and what changed since the last
 * revision. Where the record has nothing for a step, the step says so plainly.
 */
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EvidenceChip } from '@/components/evidence-chip'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/states'
import type { ReleaseView } from '@/lib/types-s1'
import { cn } from '@/lib/utils'

/** The five areas acknowledged in turn, as step ids. */
export const RELEASE_AREAS = ['coverage', 'emc', 'bom', 'fab', 'changes'] as const

export interface ReleaseDraft { acknowledged?: string[]; parts_ack?: string[]; note?: string }

/** The bar's checks the screen works out from the draft as it is typed (the record agrees once it is saved). Pure. */
export function releaseChecks(v: ReleaseView | undefined, d: ReleaseDraft & { choice?: { option: string } }): Record<string, 'met' | 'not_met'> {
  const acked = d.acknowledged ?? []
  const out: Record<string, 'met' | 'not_met'> = { areas: RELEASE_AREAS.every((a) => acked.includes(a)) ? 'met' : 'not_met' }
  const opt = d.choice?.option
  if (opt) out.decision = opt === 'release' || (opt.startsWith('return:') && (d.note ?? '').trim().length >= 5) ? 'met' : 'not_met'
  // flagged parts left: not met at once; all of them ticked waits for the record (unknown lines stay the person's)
  if (v?.parts?.flagged.some((k) => !(d.parts_ack ?? []).includes(k))) out.single = 'not_met'
  return out
}

const money = (n: number | null, c: string | null): string => (n === null ? 'not known' : `${c ?? ''} ${n.toFixed(2)}`.trim())
const day = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
const run = (id: string, label = `run ${id.replace(/^run_/, '').slice(0, 8)}`) => <EvidenceChip evidence={{ kind: 'run', id, label }} />

export function ReleaseStep({ step, view, draft, setDraft, loading }: { step: string; view?: ReleaseView; draft: ReleaseDraft; setDraft: (fn: (d: ReleaseDraft) => ReleaseDraft) => void; loading: boolean }) {
  if (step === 'decide') {
    return (
      <section className="mt-6" aria-labelledby="note">
        <h2 id="note" className="text-base font-semibold">Note</h2>
        <p className="mt-1 text-sm text-muted-foreground">Kept with your decision. A return says what has to change.</p>
        <textarea
          className="mt-2 min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={draft.note ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
          placeholder="Anything the release or the return should carry"
          aria-labelledby="note"
        />
      </section>
    )
  }
  const area = (RELEASE_AREAS as readonly string[]).includes(step)
  const done = (draft.acknowledged ?? []).includes(step)
  const body = step === 'coverage' ? null : !view ? <EmptyState className="mt-2">{loading ? 'Loading what trace prepared…' : 'trace could not read the record for this step.'}</EmptyState>
    : step === 'emc' ? <Emc v={view.emc} />
    : step === 'bom' ? <Parts v={view.parts} acked={draft.parts_ack ?? []} toggle={(k) => setDraft((d) => { const a = d.parts_ack ?? []; return { ...d, parts_ack: a.includes(k) ? a.filter((x) => x !== k) : [...a, k] } })} />
    : step === 'fab' ? <Fab v={view.fab} />
    : step === 'changes' ? <Changes v={view.changes} />
    : null
  return (
    <>
      {body && <section className="mt-6" aria-labelledby="release-step"><h2 id="release-step" className="text-base font-semibold">In the record</h2>{body}</section>}
      {area && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2">
          <span className="min-w-0 flex-1 text-sm">{done ? 'You acknowledged this area.' : 'Read this area, then acknowledge it.'}</span>
          <Button size="sm" variant={done ? 'outline' : 'default'} onClick={() => setDraft((d) => { const a = d.acknowledged ?? []; return { ...d, acknowledged: done ? a.filter((x) => x !== step) : [...a, step] } })}>
            {done ? 'Take back' : <><Check /> Acknowledge</>}
          </Button>
        </div>
      )}
    </>
  )
}

function Emc({ v }: { v: ReleaseView['emc'] }) {
  if (!v.precheck && !v.estimates.length && !v.waivers.length) return <EmptyState className="mt-2">No EMC precheck or estimate is recorded yet: the EMC specialist runs emc.precheck on the board.</EmptyState>
  return (
    <div className="mt-2 space-y-3">
      <p className="text-xs text-muted-foreground">Pre-compliance estimates from the board's geometry, not a test result.</p>
      {v.criterion && (
        <p className="flex flex-wrap items-center gap-2 text-sm"><StatusBadge status={v.criterion.status} />{v.criterion.text}</p>
      )}
      {v.precheck && (
        <div className="rounded-xl border">
          <p className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm">
            <span className="font-medium">Precheck</span>
            <span className="text-muted-foreground">{v.precheck.counts.error} errors, {v.precheck.counts.warn} warnings · {day(v.precheck.at)}</span>
            <span className="ml-auto">{run(v.precheck.run)}</span>
          </p>
          {v.precheck.findings.length ? (
            <ul className="divide-y">
              {v.precheck.findings.map((f, i) => (
                <li key={i} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                  <StatusBadge status={f.severity === 'error' ? 'failing' : 'warning'} label={f.severity === 'error' ? 'Error' : 'Warning'} />
                  <span className="min-w-0 flex-1">{f.text}{f.where && <span className="block text-xs text-muted-foreground">{f.where}</span>}</span>
                </li>
              ))}
              {v.precheck.more > 0 && <li className="px-4 py-2 text-xs text-muted-foreground">{v.precheck.more} more in the run.</li>}
            </ul>
          ) : <p className="px-4 py-2 text-sm text-muted-foreground">No errors or warnings.</p>}
        </div>
      )}
      {v.estimates.map((e) => (
        <p key={e.run} className="flex flex-wrap items-center gap-2 text-sm"><span className="font-medium">{e.kind === 'emc.si' ? 'Signal integrity' : 'Field solver'}</span><span className="text-muted-foreground">{e.summary ?? e.status}</span>{run(e.run)}</p>
      ))}
      {v.waivers.length > 0 && (
        <ul className="divide-y rounded-xl border">
          {v.waivers.map((w) => (
            <li key={w.id} className="px-4 py-2 text-sm">
              <span className="flex flex-wrap items-center gap-2"><StatusBadge status="waived" /><span className="font-medium">{w.target}</span><span className="text-xs text-muted-foreground">{w.severity} · by {w.by}</span></span>
              <span className="mt-1 block">{w.reason}</span>
              <span className="block text-xs text-muted-foreground">Risk: {w.risk}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Parts({ v, acked, toggle }: { v: ReleaseView['parts']; acked: string[]; toggle: (key: string) => void }) {
  if (!v) return <EmptyState className="mt-2">No parts check is recorded yet: parts.bom_check at the build quantity gives the cost, stock, sellers and lifecycle.</EmptyState>
  const fitted = v.lines.filter((l) => l.need > 0)
  const forBuild = v.build_quantity === null ? 'No build quantity is set in the build plan.' : v.boards === v.build_quantity ? `${money(v.for_build, v.currency)} for ${v.build_quantity} boards.` : `About ${money(v.for_build, v.currency)} for ${v.build_quantity} boards (checked for ${v.boards}).`
  return (
    <div className="mt-2 space-y-3">
      <div className="grid gap-2 text-sm sm:grid-cols-3">
        <p className="rounded-lg border px-3 py-2"><span className="block text-xs text-muted-foreground">Per board</span>{money(v.per_board, v.currency)}</p>
        <p className="rounded-lg border px-3 py-2"><span className="block text-xs text-muted-foreground">Build</span>{forBuild}</p>
        <p className="rounded-lg border px-3 py-2"><span className="block text-xs text-muted-foreground">Stock today</span>{v.blocking ? `${v.blocking} of ${v.line_count} lines out, short or not found.` : `Every line in stock (${v.line_count} lines).`}</p>
      </div>
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">Parts check of {day(v.at)} for {v.boards ?? '?'} boards {run(v.run)}</p>
      {v.unknown > 0 && <p className="text-sm text-muted-foreground">The parts check has no sellers or lifecycle for {v.unknown === fitted.length ? 'any part' : `${v.unknown} of ${fitted.length} parts`}: {v.unknown === 1 ? 'it is' : 'they are'} shown as not known. Check {v.unknown === 1 ? 'it' : 'them'} yourself, or run the parts check again.</p>}
      {v.line_count > v.lines.length && <p className="text-xs text-muted-foreground">{v.lines.length} of {v.line_count} lines are kept in the run.</p>}
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr className="border-b"><th className="px-3 py-2 font-medium">Part</th><th className="px-3 py-2 font-medium">Stock</th><th className="px-3 py-2 font-medium">Sellers with stock</th><th className="px-3 py-2 font-medium">Lifecycle</th><th className="px-3 py-2 font-medium"><span className="sr-only">Acknowledge</span></th></tr>
          </thead>
          <tbody className="divide-y">
            {fitted.map((l) => {
              const flagged = v.flagged.includes(l.key)
              return (
                <tr key={l.key} className={cn(flagged && 'bg-warning/5')}>
                  <td className="px-3 py-2"><span className="font-mono text-xs">{l.mpn ?? `line ${l.line}`}</span>{l.refs && <span className="block text-xs text-muted-foreground">{l.refs}</span>}</td>
                  <td className="px-3 py-2">{l.stock === null ? 'not known' : `${l.stock.toLocaleString()} for ${l.need}`}</td>
                  <td className="px-3 py-2">{l.sellers === null ? 'not known' : l.sellers.length ? l.sellers.join(', ') : 'none'}{l.single && <span className="block text-xs text-warning-foreground">Single source</span>}{l.single === null && l.sellers?.length === 1 && <span className="block text-xs text-muted-foreground">One provider asked</span>}</td>
                  <td className="px-3 py-2">{l.lifecycle ?? 'not known'}{l.inactive && <span className="block text-xs text-warning-foreground">Not active</span>}</td>
                  <td className="px-3 py-2 text-right">
                    {flagged && (
                      <label className="inline-flex items-center gap-1.5 text-xs">
                        <input type="checkbox" checked={acked.includes(l.key)} onChange={() => toggle(l.key)} />Acknowledged
                      </label>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Fab({ v }: { v: ReleaseView['fab'] }) {
  return (
    <ul className="mt-2 divide-y rounded-xl border text-sm">
      <li className="flex flex-wrap items-center gap-3 px-4 py-2">
        {v.drc ? <StatusBadge status={v.drc.errors ? 'failing' : 'clean'} label={v.drc.errors ? `${v.drc.errors} errors` : 'No errors'} /> : <StatusBadge status="untested" label="Not run" />}
        <span className="min-w-0 flex-1">DRC{v.drc ? <span className="block text-xs text-muted-foreground">{v.drc.findings} findings{v.drc.waived ? `, ${v.drc.waived} waived` : ''}{v.drc.at ? ` · ${day(v.drc.at)}` : ''}</span> : <span className="block text-xs text-muted-foreground">No design rule check is recorded yet.</span>}</span>
        {v.drc?.run && run(v.drc.run)}
      </li>
      <li className="px-4 py-2">Board<span className="block text-xs text-muted-foreground">{v.board ? [v.board.size, v.board.layers ? `${v.board.layers.length} layers` : null].filter(Boolean).join(' · ') || 'Size and layers not recorded.' : 'No board check (kicad.board) is recorded yet.'}</span></li>
      <li className="px-4 py-2">Placed by hand<span className="block text-xs text-muted-foreground">{v.hand_placed === null ? 'No fabrication run says which parts JLCPCB places yet.' : v.hand_placed.length ? v.hand_placed.join(', ') : 'None: JLCPCB places every part.'}</span></li>
    </ul>
  )
}

function Changes({ v }: { v: ReleaseView['changes'] }) {
  if (!v.started) return <EmptyState className="mt-2">Revision {v.revision} is the first revision: nothing to compare.</EmptyState>
  return (
    <div className="mt-2 space-y-2 text-sm">
      <p>{v.started.summary}{v.started.by && <span className="text-muted-foreground"> · {v.started.by}, {day(v.started.at)}</span>}</p>
      {v.items.length ? (
        <ul className="divide-y rounded-xl border">
          {v.items.map((c, i) => <li key={i} className="px-4 py-2">{c.summary}<span className="block text-xs text-muted-foreground">{c.by ?? 'trace'} · {day(c.at)}</span></li>)}
        </ul>
      ) : <p className="text-muted-foreground">Nothing else changed since revision {v.previous ?? 'before'}.</p>}
    </div>
  )
}
