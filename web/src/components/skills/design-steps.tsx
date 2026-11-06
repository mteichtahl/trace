/**
 * What the design skills add to a stepped skill's screen, so the draft carries the decisions Submit records
 * (src/api/actions-skills.ts pendingDecisions; design.decide's shapes):
 *
 *   Requirements review  per requirement: accept, or strike with a reason (draft.decisions), or accept every one
 *                        still undecided at once; a decided row shows Undo; a requirement changed since a person
 *                        decided it shows what changed. Per intent line no requirement covers: leave it out with a
 *                        reason (draft.uncovered), on every step it shows
 *   Architecture choice  the criteria step fixes the criteria and their weights now, before any score is read
 *                        (design.decide criteria: "criteria fixed before scoring" checks it was first); the choose
 *                        step names the criteria that decided it (draft.deciding); the option and its reason come
 *                        from the decision card above (draft.choice); the parts step lists the key parts of the
 *                        option going ahead with stock, price and exception (KeyParts, from skill.get's key_parts)
 *   Pin plan review      nothing to add: Submit agrees every part's plan as it stands, once its checks pass
 *
 * The quality bar is the server's, computed with this draft laid over the record, so it moves as the person decides.
 */
import { CheckCheck, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StatusBadge } from '@/components/status-badge'
import { ArchitectureSummary, OptionSwitch, OptionsTable, drawn, useOption } from '@/components/project/architecture'
import { BlockDiagramCanvas } from '@/components/project/block-diagram'
import { useCall } from '@/lib/queries'
import type { ArchitectureRecord, KeyPartView } from '@/lib/types-s1'
import type { SkillItem, SkillView } from '@/lib/types-s1'

export interface DesignDraft {
  decisions?: { requirement: string; choice: 'accept' | 'strike'; reason?: string }[]
  uncovered?: { statement: string; reason: string }[]
  deciding?: string[]
  /** Resolve conflicts: the person confirms no two requirements contradict each other (no tool compares their numbers) */
  no_conflicts?: boolean
}

type Set = (fn: (d: DesignDraft) => DesignDraft) => void

/** A requirement's decision in the draft, replaced. Pure. */
export function withDecision(d: DesignDraft, requirement: string, choice: 'accept' | 'strike' | null, reason?: string): DesignDraft {
  const rest = (d.decisions ?? []).filter((x) => x.requirement !== requirement)
  return { ...d, decisions: choice ? [...rest, { requirement, choice, ...(reason ? { reason } : {}) }] : rest }
}

/** Every requirement named that has no decision in the draft yet, accepted; the ones decided keep theirs. Pure. */
export function acceptRest(d: DesignDraft, requirements: readonly string[]): DesignDraft {
  const decided = new Set((d.decisions ?? []).map((x) => x.requirement))
  return { ...d, decisions: [...(d.decisions ?? []), ...requirements.filter((id) => !decided.has(id)).map((requirement) => ({ requirement, choice: 'accept' as const }))] }
}

/** An intent line's "left out" in the draft, replaced (reason) or removed (null). Pure. */
export function withLeftOut(d: DesignDraft, statement: string, reason: string | null): DesignDraft {
  const rest = (d.uncovered ?? []).filter((u) => u.statement !== statement)
  return { ...d, uncovered: reason ? [...rest, { statement, reason }] : rest }
}

/**
 * The items of Requirements review that its own steps decide, and so are not resolved from the generic list: every
 * requirement (accept, or strike with a reason, in Decide) and every intent line no requirement covers (left out
 * with a reason, on whichever step shows it). A bare Resolve on them marked them resolved without a reason while the
 * check still said they were not (test-esp32 #29).
 */
export const decidedByReview = (skill: string, item: { id: string }): boolean =>
  skill === 'requirements-review' && (item.id.startsWith('requirement:') || item.id.startsWith('intent:'))

export function DesignSteps({ repo, skill, step, view, draft, setDraft }: { repo: string; skill: string; step: string; view?: SkillView; draft: DesignDraft; setDraft: Set }) {
  if (skill === 'requirements-review') {
    // an intent line no requirement covers shows with its reason box on every step, the only way to resolve it
    return (
      <>
        {step === 'decide' && <ReviewItems view={view} draft={draft} setDraft={setDraft} only="requirement" />}
        {step === 'conflicts' && <NoConflicts draft={draft} setDraft={setDraft} />}
        <ReviewItems view={view} draft={draft} setDraft={setDraft} only="intent" />
      </>
    )
  }
  if (skill === 'architecture-choice' && (step === 'read' || step === 'score')) return <CompareOptions view={view} scores={step === 'score'} />
  if (skill === 'architecture-choice' && step === 'criteria') return <FixCriteria repo={repo} view={view} />
  if (skill === 'architecture-choice' && step === 'choose') return <Deciding view={view} draft={draft} setDraft={setDraft} />
  if (skill === 'architecture-choice' && step === 'parts') return <KeyParts view={view} />
  return null
}

const FIELD_WORD = { words: 'Words', criterion: 'Criterion' } as const

/**
 * What changed in a requirement since a person accepted (or struck) it: each field before and after (test-esp32 #63:
 * the re-review showed the unchanged words and not the criterion that changed).
 */
export function ChangedSince({ was }: { was: NonNullable<SkillItem['was']> }) {
  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs" aria-label="What changed">
      <p className="font-medium">Changed since {was.by} {was.choice === 'struck' ? 'struck' : 'accepted'} it</p>
      <dl className="mt-1 space-y-1">
        {was.changes.map((c) => (
          <div key={c.field} className="grid gap-x-2 sm:grid-cols-[5.5rem_1fr]">
            <dt className="text-muted-foreground">{FIELD_WORD[c.field]}</dt>
            <dd className="min-w-0 break-words">
              <del className="rounded-sm bg-destructive/10 px-1 text-destructive" aria-label={`Before: ${c.before ?? 'none'}`}>{c.before ?? 'none'}</del>
              {' → '}
              <ins className="rounded-sm bg-verified/10 px-1 text-verified no-underline" aria-label={`Now: ${c.after ?? 'none'}`}>{c.after ?? 'none'}</ins>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function ReviewItems({ view, draft, setDraft, only }: { view?: SkillView; draft: DesignDraft; setDraft: Set; only: 'requirement' | 'intent' }) {
  const items = (view?.items ?? []).filter((i) => i.id.startsWith(`${only}:`))
  const [reasons, setReasons] = useState<Record<string, string>>({})
  if (!items.length) return null
  const idOf = (it: SkillItem) => it.id.slice(only.length + 1)
  const undecided = only === 'requirement' ? items.map(idOf).filter((id) => !draft.decisions?.some((x) => x.requirement === id)) : []
  return (
    <section className="mt-6" aria-labelledby={`design-${only}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`design-${only}`} className="text-base font-semibold">{only === 'requirement' ? 'Accept or strike' : 'Intent no requirement covers'}</h2>
        {undecided.length > 0 && (
          <Button size="sm" onClick={() => setDraft((x) => acceptRest(x, undecided))}>
            <CheckCheck /> Accept the {undecided.length === 1 ? 'one' : undecided.length} still undecided
          </Button>
        )}
      </div>
      {only === 'requirement' ? (
        <p className="mt-1 text-sm text-muted-foreground">Strike the ones you do not want first, with a reason: accepting the rest leaves every row you decided as it is. Undo puts a row back to undecided.</p>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">Add a requirement that covers it, or leave it out with a reason.</p>
      )}
      <ul className="mt-2 divide-y rounded-xl border">
        {items.map((it) => {
          const id = idOf(it)
          const d = only === 'requirement' ? draft.decisions?.find((x) => x.requirement === id) : undefined
          const left = only === 'intent' ? draft.uncovered?.find((x) => x.statement === id) : undefined
          const decided = Boolean(d || left)
          const reason = reasons[id] ?? ''
          return (
            <li key={it.id} className="space-y-2 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">
                  {it.title}
                  {it.criterion !== undefined && <span className="block text-xs">Criterion: {it.criterion ?? <span className="text-warning">none given</span>}</span>}
                  <span className="block text-xs text-muted-foreground">{it.detail}</span>
                </span>
                {d && <StatusBadge status={d.choice === 'accept' ? 'met' : 'waived'} label={d.choice === 'accept' ? 'Accepted' : 'Struck'} />}
                {left && <StatusBadge status="waived" label="Left out" />}
              </div>
              {it.was && <ChangedSince was={it.was} />}
              {decided ? (
                <div className="flex flex-wrap items-center gap-2">
                  {(d?.reason ?? left?.reason) && <span className="min-w-0 flex-1 text-xs text-muted-foreground">Reason: {d?.reason ?? left?.reason}</span>}
                  <Button size="sm" variant="outline" className="ml-auto" aria-label={`Undo ${id}`} onClick={() => {
                    setReasons((r) => ({ ...r, [id]: d?.reason ?? left?.reason ?? '' }))
                    setDraft((x) => (only === 'requirement' ? withDecision(x, id, null) : withLeftOut(x, id, null)))
                  }}>
                    <Undo2 /> Undo
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Label className="sr-only" htmlFor={`r-${id}`}>Reason</Label>
                  <Input id={`r-${id}`} className="h-8 max-w-md flex-1" autoComplete="off" placeholder={only === 'requirement' ? 'Reason (needed to strike)' : 'Why no requirement covers it'} value={reason} onChange={(e) => setReasons((r) => ({ ...r, [id]: e.target.value }))} />
                  {only === 'requirement' ? (
                    <>
                      <Button size="sm" variant="outline" aria-label={`Accept ${id}`} onClick={() => setDraft((x) => withDecision(x, id, 'accept'))}>Accept</Button>
                      <Button size="sm" variant="outline" aria-label={`Strike ${id}`} disabled={reason.trim().length < 3} onClick={() => setDraft((x) => withDecision(x, id, 'strike', reason.trim()))}>Strike</Button>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" aria-label={`Leave out ${id}`} disabled={reason.trim().length < 3} onClick={() => setDraft((x) => withLeftOut(x, id, reason.trim()))}>Leave out</Button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function FixCriteria({ repo, view }: { repo: string; view?: SkillView }) {
  const a = view?.architecture
  const fix = useCall('design.decide', (x) => [['skill.get', x.repo], ['design.get', x.repo], ['journey.get', x.repo]])
  const [weights, setWeights] = useState<Record<string, number>>({})
  if (!a) return null
  if (a.fixed) return <p className="mt-4 text-sm"><StatusBadge status="met" label="Criteria fixed" /> by {a.fixed.by}. Changing them now means choosing again.</p>
  return (
    <section className="mt-6" aria-labelledby="crit">
      <h2 id="crit" className="text-base font-semibold">The criteria and their weights</h2>
      <p className="mt-1 text-sm text-muted-foreground">Fix them before reading any score, so the choice cannot be made on a criterion picked afterwards.</p>
      <ul className="mt-2 space-y-2">
        {(a.criteria ?? []).map((c) => (
          <li key={c.id} className="flex items-center gap-3 text-sm">
            <span className="w-40">{c.name}</span>
            <Label className="sr-only" htmlFor={`w-${c.id}`}>Weight of {c.name}</Label>
            <Input id={`w-${c.id}`} type="number" min={0} max={10} step={0.5} className="h-8 w-24" value={weights[c.id] ?? c.weight} onChange={(e) => setWeights((w) => ({ ...w, [c.id]: Number(e.target.value) }))} />
          </li>
        ))}
      </ul>
      <Button className="mt-3" size="sm" disabled={!(a.criteria ?? []).length || fix.isPending} onClick={() => fix.mutate({ repo, decision: { kind: 'criteria', criteria: (a.criteria ?? []).map((c) => ({ id: c.id, name: c.name, weight: weights[c.id] ?? c.weight })) } }, { onSuccess: () => toast('Criteria fixed.'), onError: (e) => toast.error('The criteria were not fixed.', { description: e.message }) })}>
        Fix these criteria
      </Button>
    </section>
  )
}

function Deciding({ view, draft, setDraft }: { view?: SkillView; draft: DesignDraft; setDraft: Set }) {
  const criteria = view?.architecture?.criteria ?? []
  if (!criteria.length) return null
  const on = new Set(draft.deciding ?? [])
  return (
    <fieldset className="mt-4 space-y-2">
      <legend className="text-sm font-medium">Which criteria decided it?</legend>
      {criteria.map((c) => (
        <Label key={c.id} className="flex items-center gap-2 font-normal">
          <Checkbox checked={on.has(c.id)} onCheckedChange={(v) => setDraft((d) => ({ ...d, deciding: v ? [...new Set([...(d.deciding ?? []), c.id])] : (d.deciding ?? []).filter((x) => x !== c.id) }))} />
          {c.name}
        </Label>
      ))}
    </fieldset>
  )
}

/**
 * Resolve conflicts: trace has checked for duplicates and for requirements drawn from intent still in conflict; no tool
 * compares the requirements' own numbers, so the person reads them together and confirms (draft.no_conflicts).
 */
function NoConflicts({ draft, setDraft }: { draft: DesignDraft; setDraft: Set }) {
  return (
    <section className="mt-6 space-y-2" aria-labelledby="no-conflicts">
      <h2 id="no-conflicts" className="text-base font-semibold">Do any two requirements contradict each other?</h2>
      <p className="text-sm text-muted-foreground">trace found no duplicates and no requirement drawn from intent still in conflict. No tool compares the requirements&apos; own numbers (a power budget against a draw, a size against a connector), so read them together. If two cannot both hold, strike or reword one in Decide.</p>
      <Label className="flex items-center gap-2 font-normal">
        <Checkbox checked={draft.no_conflicts === true} onCheckedChange={(v) => setDraft((d) => ({ ...d, no_conflicts: v === true }))} />
        I read them together: no two requirements contradict each other.
      </Label>
    </section>
  )
}

/** The steps that take the stage picture's place for Architecture choice: each option's own diagram. */
export const ARCH_COMPARE_STEPS: readonly string[] = ['read', 'score']

/**
 * Read each option / Score: every option, switched with the layout held still (its block diagram, what it is, why,
 * what it gives up, its risks and the requirements none of its blocks serve), and on Score the options side by side on
 * the fixed criteria with each score's reason. The same pieces as the Design tab (components/project/architecture).
 */
function CompareOptions({ view, scores }: { view?: SkillView; scores: boolean }) {
  const a = view?.architecture as (ArchitectureRecord & { options: NonNullable<ArchitectureRecord['options']> }) | undefined
  const [current, setCurrent] = useOption(a)
  if (!a?.options.length) return null
  const o = a.options.find((x) => x.id === current)
  const requirements = [...new Set(a.options.flatMap((x) => x.blocks.flatMap((b) => b.serves)))]
  return (
    <section className="mt-4 space-y-4" aria-labelledby="compare-options">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="compare-options" className="text-base font-semibold">{a.options.length} options{o ? `: option ${o.id}, ${o.name}` : ''}</h2>
        <OptionSwitch a={a} value={current} onChange={setCurrent} />
      </div>
      <BlockDiagramCanvas title="Block diagram" subtitle={o ? `Option ${o.id}: ${o.name}` : undefined} height={360} {...drawn(a, current)} />
      {o && (
        <div className="space-y-1 text-sm">
          <p>{o.summary}</p>
          {o.why && <p className="text-muted-foreground"><span className="font-medium text-foreground">Why:</span> {o.why}</p>}
          {o.gives_up && <p className="text-muted-foreground"><span className="font-medium text-foreground">Gives up:</span> {o.gives_up}</p>}
        </div>
      )}
      <ArchitectureSummary a={a} current={current} requirements={requirements} />
      {scores && <OptionsTable a={a} current={current} />}
    </section>
  )
}

/** "US$0.42", "€1.10", or the amount and its currency code. */
export function price(amount: number | null, currency: string | null): string {
  if (amount === null) return 'No price'
  const sign: Record<string, string> = { USD: 'US$', EUR: '€', GBP: '£', AUD: 'A$', CNY: '¥' }
  const n = amount < 1 ? amount.toFixed(3).replace(/0$/, '') : amount.toFixed(2)
  return currency && sign[currency] ? `${sign[currency]}${n}` : `${n}${currency ? ` ${currency}` : ''}`
}

/** A key part's standing in words, with the badge it shows. */
function partStatus(p: KeyPartView): { status: 'met' | 'waived' | 'not_met' | 'untested' | 'warning'; label: string } {
  if (p.exception && p.standing !== 'ok') return { status: 'waived', label: 'Excepted' }
  if (p.standing === 'unchecked') return { status: 'untested', label: 'Not checked' }
  if (p.standing === 'problem') return { status: 'not_met', label: p.check?.status === 'short' ? 'Short' : p.check?.status === 'out' ? 'Out of stock' : 'Not in stock' }
  if (p.check?.status === 'low') return { status: 'warning', label: 'Low stock' }
  return { status: 'met', label: 'In stock' }
}

/**
 * Accept the key parts: each key part of the option going ahead with its part number, the supplier code it was
 * checked with, stock against what the build needs, the unit price at that quantity, and its exception when one is
 * signed (test-esp32 #38, #96: the step showed only the diagram, though its check was met). From the newest parts
 * check of each part in the record.
 */
export function KeyParts({ view }: { view?: SkillView }) {
  const k = view?.key_parts
  if (!k) return null
  const name = view?.architecture?.options.find((o) => o.id === k.option)?.name
  const chosen = view?.architecture?.chosen?.option === k.option
  return (
    <section className="mt-6 space-y-2" aria-labelledby="key-parts">
      <h2 id="key-parts" className="text-base font-semibold">Key parts of option {k.option}{name ? `: ${name}` : ''}</h2>
      <p className="text-sm text-muted-foreground">
        {chosen ? 'The option you chose.' : 'trace\'s recommendation, until you choose.'} Stock and price are from the newest parts check of each part{k.quantity ? `, for the ${k.quantity} boards the project builds` : ''}.
      </p>
      {!k.parts.length ? (
        <p className="rounded-xl border px-4 py-3 text-sm text-muted-foreground">No block of option {k.option} marks a key part yet: the agents mark them when they propose the blocks.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[640px] text-sm">
            <caption className="sr-only">Key parts with stock, price and exceptions</caption>
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Part</th>
                <th scope="col" className="px-3 py-2 font-medium">Supplier code</th>
                <th scope="col" className="px-3 py-2 font-medium">Stock</th>
                <th scope="col" className="px-3 py-2 font-medium">Unit price</th>
                <th scope="col" className="px-3 py-2 font-medium">Standing</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {k.parts.map((p) => {
                const st = partStatus(p)
                return (
                  <tr key={`${p.block}/${p.mpn}`} className="align-top">
                    <th scope="row" className="px-3 py-2 text-left font-normal">
                      <span className="font-medium">{p.mpn}</span>
                      <span className="block text-xs text-muted-foreground">{p.block_name}{p.role ? `: ${p.role}` : ''}{p.off_board ? ' (off the board)' : ''}</span>
                    </th>
                    <td className="px-3 py-2">{p.check?.order_code ?? <span className="text-xs text-muted-foreground">None given</span>}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {p.check ? <>{p.check.stock === null ? 'Not published' : p.check.stock.toLocaleString('en')}<span className="block text-xs text-muted-foreground">{p.check.need} needed{p.check.boards ? ` for ${p.check.boards} boards` : ''}</span></> : <span className="text-xs text-muted-foreground">Not checked</span>}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{p.check ? price(p.check.unit_price, p.check.currency) : <span className="text-xs text-muted-foreground">—</span>}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={st.status} label={st.label} />
                      {p.why && <span className="mt-1 block text-xs text-muted-foreground">{p.why}</span>}
                      {p.exception && <span className="mt-1 block text-xs">Exception{p.exception.scope === 'criterion' ? ' for the stock check as a whole' : ''}, by {p.exception.by}: {p.exception.reason}</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
