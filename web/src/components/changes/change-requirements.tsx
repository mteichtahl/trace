/**
 * "Requirements it covers" on the change review page: each requirement the change names, expanded so a reviewer can
 * judge it without leaving the page — what it says, its criterion, kind and priority, where it stands, and its tests —
 * with a link to open the requirement itself. Each row folds away; all start open when there are a few, folded when
 * there are many, and one button opens or folds them all.
 *
 * The requirement's details come from the coverage the Requirements tab reads (verify.coverage). A change may name a
 * requirement by a short form ("REQ-9" for "REQ-009"), so the row is matched loosely and the link uses the project's
 * own id, which is what the requirement sheet looks up.
 *
 * What a change cites as a requirement that the project does not have ("R3", where its requirements are REQ-xxxxxx)
 * is said once, in one line, and never listed as a requirement it covers (test-esp32 log #47, #105).
 */
import { useState, type ReactNode } from 'react'
import { ChevronDown, ExternalLink } from 'lucide-react'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { CoverageRow, Verdict } from '@/lib/types-s1'
import { cn } from '@/lib/utils'

const VERDICT_BADGE: Record<Verdict, { status: 'verified' | 'failing' | 'waived' | 'untested' | 'warning'; label: string }> = {
  verified: { status: 'verified', label: 'Verified' },
  failing: { status: 'failing', label: 'Failing' },
  waived: { status: 'waived', label: 'Waived' },
  untested: { status: 'untested', label: 'Untested' },
  no_test: { status: 'untested', label: 'No test yet' },
  partial: { status: 'warning', label: 'Partly tested' },
  coverage_gap: { status: 'warning', label: 'Coverage gap' },
}

/** How many rows start open: a few read at a glance, many would bury the recommendation below them. */
export const OPEN_UP_TO = 3

/** "REQ-009" and "REQ-9" are the same requirement. */
const norm = (id: string) => id.trim().toUpperCase().replace(/-0+(\d)/g, '-$1')

/** The coverage row a change's requirement id names, or undefined when the project has no such requirement. */
export function findRequirement(rows: CoverageRow[] | undefined, rid: string): CoverageRow | undefined {
  if (!rows) return undefined
  return rows.find((r) => r.id === rid) ?? rows.find((r) => norm(r.id) === norm(rid))
}

const testStatus = (s: string) => (s === 'pass' ? 'verified' : s === 'fail' || s === 'error' ? 'failing' : s === 'waived' ? 'waived' : 'untested') as 'verified' | 'failing' | 'waived' | 'untested'
const testWord = (s: string) => ({ pass: 'Passed', fail: 'Failed', error: 'Error', waived: 'Waived', planned: 'Planned' })[s] ?? 'Not run'

/** "R1, R2 and R3" */
const andList = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)

/** "The change names R3, which is not a requirement of this project." */
export function unknownWords(ids: string[]): string {
  const shown = ids.length > 8 ? [...ids.slice(0, 8), `${ids.length - 8} more`] : ids
  return ids.length === 1
    ? `The change names ${ids[0]}, which is not a requirement of this project.`
    : `The change names ${andList(shown)}, which are not requirements of this project.`
}

export interface ChangeRequirementsProps {
  /** the project's requirement ids the change names */
  ids: string[]
  /** what it cites as a requirement that the project does not have */
  unknown?: string[]
  /** the requirements this change's own tests cover (test-esp32-run2 R47) */
  tested?: string[]
  /** verify.coverage's rows; undefined while they load */
  rows: CoverageRow[] | undefined
  loading?: boolean
  /** a link to the requirement's own page, given the project's id for it */
  link: (rid: string, children: ReactNode, className?: string) => ReactNode
}

export function ChangeRequirements({ ids, unknown = [], tested = [], rows, loading, link }: ChangeRequirementsProps) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(ids.map((r) => [r, ids.length <= OPEN_UP_TO])))
  const isOpen = (r: string) => open[r] ?? ids.length <= OPEN_UP_TO
  const allOpen = ids.every(isOpen)

  const notOurs = unknown.length ? unknownWords(unknown) : null
  if (!ids.length) return <p className={cn('mt-2 text-sm', !notOurs && 'text-muted-foreground')}>{notOurs ?? 'This change does not name a requirement.'}</p>

  return (
    <div className="mt-2">
      {notOurs && <p className="mb-2 text-sm">{notOurs}</p>}
      {ids.length > 1 && (
        <Button variant="ghost" size="sm" className="-ml-2 mb-1 h-7 px-2 text-xs" onClick={() => setOpen(Object.fromEntries(ids.map((r) => [r, !allOpen])))}>
          {allOpen ? 'Fold all' : `Open all ${ids.length}`}
        </Button>
      )}
      <ul className="space-y-2">
        {ids.map((rid) => {
          const r = findRequirement(rows, rid)
          const id = r?.id ?? rid
          // the accepted design has no test for it yet, and this change brings one: say that, not "No test yet"
          const here = !!r && (r.verdict === 'no_test' || r.verdict === 'untested') && tested.some((t) => norm(t) === norm(r.id))
          const v = here ? { status: 'untested' as const, label: 'Tested in this change' } : r ? VERDICT_BADGE[r.verdict] : null
          return (
            <li key={rid} className="rounded-lg border">
              <Collapsible open={isOpen(rid)} onOpenChange={(o) => setOpen((s) => ({ ...s, [rid]: o }))}>
                <CollapsibleTrigger className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50" aria-label={`${isOpen(rid) ? 'Fold' : 'Open'} ${id}`}>
                  <ChevronDown className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform', !isOpen(rid) && '-rotate-90')} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="mr-2 font-mono text-xs text-muted-foreground">{id}</span>
                    <span className={cn(!isOpen(rid) && 'line-clamp-1')}>{r?.text || (loading ? 'Loading…' : '')}</span>
                  </span>
                  {v && <StatusBadge status={v.status} label={v.label} className="shrink-0" />}
                </CollapsibleTrigger>
                <CollapsibleContent className="border-t px-3 py-2.5 text-sm">
                  {!r ? (
                    <p className="text-muted-foreground">{loading ? 'Loading the requirement…' : `${rid} is not among the design's requirements yet: this change adds it, or it was struck since.`}</p>
                  ) : (
                    <>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                        <dt className="text-muted-foreground">Criterion</dt>
                        <dd>{r.acceptance ?? <span className="text-muted-foreground">None yet: Requirements review makes it testable.</span>}</dd>
                        <dt className="text-muted-foreground">Kind</dt>
                        <dd className="capitalize">{r.kind}{r.priority && <span className="text-muted-foreground"> · {r.priority}</span>}</dd>
                        {r.source && <><dt className="text-muted-foreground">Source</dt><dd>{r.source}</dd></>}
                        <dt className="text-muted-foreground">Tests</dt>
                        <dd>
                          {r.tests.length === 0 ? (
                            <span className="text-muted-foreground">{here ? 'This change adds its tests; they count once it is accepted.' : 'None planned yet.'}</span>
                          ) : (
                            <ul className="space-y-1">
                              {r.tests.map((t) => (
                                <li key={t.id} className="flex flex-wrap items-center gap-x-2">
                                  <span className="font-mono text-xs">{t.id}</span>
                                  <span className="text-xs uppercase text-muted-foreground">{t.method}</span>
                                  <StatusBadge status={testStatus(t.status)} label={testWord(t.status)} plain />
                                </li>
                              ))}
                            </ul>
                          )}
                        </dd>
                      </dl>
                    </>
                  )}
                  <div className="mt-2.5">
                    {link(id, <>Open {id}<ExternalLink className="size-3.5" aria-hidden /></>, 'inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline')}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
