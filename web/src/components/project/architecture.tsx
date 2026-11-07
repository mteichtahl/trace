/**
 * The architecture record as the Design tab and Architecture choice show it (docs/user-journey.md, "Architecture
 * block diagram"): one diagram per option in the same layout, switched with the layout held still, each block with
 * its key part and the requirements it serves, each connection with what flows along it; below it, the options
 * compared on the criteria with trace's score and reason per cell, the recommendation and why, and the person's
 * choice when there is one. A requirement served by no block shows here before the architecture gate, not after.
 */
import { useState } from 'react'
import { askTrace } from '@/components/chat/chat-state'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { StatusBadge } from '@/components/status-badge'
import type { ArchOption, ArchitectureRecord, Block } from '@/lib/types-s1'
import { cn } from '@/lib/utils'

/** The requirements no block of an option serves. Pure. */
export function unmapped(option: Pick<ArchOption, 'blocks'>, requirements: readonly string[]): string[] {
  const served = new Set(option.blocks.flatMap((b) => b.serves))
  return requirements.filter((r) => !served.has(r))
}

/** Which option to draw: the one asked for, else the chosen, else the recommended, else the first. Pure. */
export function optionToDraw(a: Pick<ArchitectureRecord, 'options' | 'chosen' | 'recommended' | 'id'>, wanted: string | null): string | null {
  const ids = (a.options ?? []).map((o) => o.id)
  if (wanted && ids.includes(wanted)) return wanted
  return a.chosen?.option ?? a.recommended ?? a.id ?? ids[0] ?? null
}

/** The option switcher: options side by side by name, the recommended and chosen marked. */
export function OptionSwitch({ a, value, onChange }: { a: ArchitectureRecord; value: string | null; onChange: (id: string) => void }) {
  if (!a.options || a.options.length < 2) return null
  return (
    <ToggleGroup type="single" value={value ?? ''} onValueChange={(v) => v && onChange(v)} variant="outline" size="sm" aria-label="Architecture option">
      {a.options.map((o) => (
        <ToggleGroupItem key={o.id} value={o.id} className="px-3">
          Option {o.id}{a.chosen?.option === o.id ? ' · chosen' : o.recommended ? ' · recommended' : ''}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/** The options compared: trace's (or the person's) score on each criterion with its reason, the weighted total. */
export function OptionsTable({ a, current }: { a: ArchitectureRecord; current?: string | null }) {
  const options = a.options ?? []
  const criteria = a.criteria ?? []
  if (!options.length) return null
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[560px] text-sm">
        <caption className="sr-only">Architecture options scored on each criterion</caption>
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Criterion{a.fixed ? '' : ' (proposed)'}</th>
            {options.map((o) => <th key={o.id} scope="col" className={cn('px-3 py-2 font-medium', current === o.id && 'text-foreground')}>Option {o.id}: {o.name}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y">
          {criteria.map((c) => (
            <tr key={c.id}>
              <th scope="row" className="px-3 py-2 text-left font-normal">{c.name} <span className="text-xs text-muted-foreground">× {c.weight}</span></th>
              {options.map((o) => {
                const s = a.scores?.find((x) => x.option === o.id && x.criterion === c.id)
                return (
                  <td key={o.id} className="px-3 py-2 align-top">
                    {s ? <><span className="font-medium tabular-nums">{s.score} of 5</span><span className="block text-xs text-muted-foreground">{s.reason}{s.by === 'person' ? ' (yours)' : ''}</span></> : <span className="text-xs text-muted-foreground">Not scored</span>}
                  </td>
                )
              })}
            </tr>
          ))}
          <tr className="bg-muted/20">
            <th scope="row" className="px-3 py-2 text-left font-medium">Weighted total</th>
            {options.map((o) => <td key={o.id} className="px-3 py-2 font-medium tabular-nums">{o.total}</td>)}
          </tr>
        </tbody>
      </table>
      {!criteria.length && <p className="px-3 py-2 text-xs text-muted-foreground">No criteria yet: they are agreed in Architecture choice before any score is read.</p>}
    </div>
  )
}

/** The words under the diagram: what is drawn and its state, trace's recommendation and why, the choice. */
export function ArchitectureSummary({ a, current, requirements }: { a: ArchitectureRecord; current: string | null; requirements: readonly string[] }) {
  const o = a.options?.find((x) => x.id === current)
  const rec = a.options?.find((x) => x.id === a.recommended)
  const missing = o ? unmapped(o, requirements) : []
  return (
    <div className="space-y-2 text-sm">
      {a.chosen ? (
        <p>
          <StatusBadge status="met" label="Chosen" /> <span className="font-medium">Option {a.chosen.option}</span> by {a.chosen.by}: {a.chosen.reason}
          {a.chosen.deciding.length ? <span className="text-muted-foreground"> Decided on {a.chosen.deciding.map((d) => a.criteria?.find((c) => c.id === d)?.name ?? d).join(', ')}.</span> : null}
          {a.chosen.against ? <span className="text-muted-foreground"> Against trace's recommendation of option {a.recommended}.</span> : null}
        </p>
      ) : (
        <p><StatusBadge status="yours" label="Not chosen yet" /> The diagram shows trace's {rec ? 'recommendation' : 'first option'}; a person chooses in Architecture choice.</p>
      )}
      {rec && (
        <p><span className="font-medium">trace recommends option {rec.id}</span>{rec.why ? `: ${rec.why}` : '.'}{rec.gives_up ? <span className="text-muted-foreground"> It gives up {rec.gives_up.replace(/^./, (c) => c.toLowerCase())}</span> : null}</p>
      )}
      <CriteriaFollow a={a} />
      {o && o.risks.length > 0 && <p className="text-muted-foreground">Risks of option {o.id}: {o.risks.join('; ')}.</p>}
      {missing.length > 0 && <p><StatusBadge status="warning" label={`${missing.length} not served`} /> No block of option {o?.id} serves {missing.join(', ')}: map each to a block, or take it back to Requirements review.</p>}
    </div>
  )
}

/**
 * The criteria whose words moved since they were fixed, one line each: reworded (with the name it was fixed with; the
 * weight and the choice stand), or naming a requirement that changed after its words were written, so the numbers it
 * quotes may be old, with Ask trace to reword it from the requirement (test-esp32 run 2, #173). Nothing when none did.
 */
export function CriteriaFollow({ a }: { a: Pick<ArchitectureRecord, 'criteria'> }) {
  const moved = (a.criteria ?? []).filter((c) => c.was || c.stale)
  if (!moved.length) return null
  return (
    <ul className="space-y-1.5 text-sm" aria-label="Criteria changed since they were fixed">
      {moved.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {c.stale ? (
            <>
              <StatusBadge status="warning" label="May quote old numbers" />
              <span><span className="font-medium">{c.name}</span> names {c.stale.requirements.join(', ')}, changed on {c.stale.since.slice(0, 10)} after these words were written.</span>
              <Button size="sm" variant="outline" onClick={() => askTrace(`Reword the architecture criterion ${c.id} ("${c.name}") from the current text of ${c.stale!.requirements.join(' and ')}: record its new name and description with design.architecture, keeping its weight.`)}>Ask trace to reword it</Button>
            </>
          ) : (
            <span className="text-muted-foreground"><span className="font-medium text-foreground">{c.name}</span> was fixed as "{c.was}" and reworded since; its weight, and the choice made on it, stand.</span>
          )}
        </li>
      ))}
    </ul>
  )
}

/** The blocks and connections of the option drawn, from the record; the diagram component draws them. */
export function drawn(a: ArchitectureRecord, current: string | null): { blocks: Block[]; connections: ArchitectureRecord['connections'] } {
  const o = a.options?.find((x) => x.id === current)
  return o ? { blocks: o.blocks, connections: o.connections } : { blocks: a.blocks, connections: a.connections }
}

/** The option the screen draws, kept when the record changes under it. */
export function useOption(a: ArchitectureRecord | undefined) {
  const [wanted, setWanted] = useState<string | null>(null)
  const current = a ? optionToDraw(a, wanted) : null
  return [current, setWanted] as const
}
