/**
 * On the change review page, before Accept: the accepted requirements the change's database edits (change.get's
 * requirement_edits, src/api/requirement-edits.ts). An agent's change once rewrote an accepted requirement while its
 * description said "only the note string changed", and Define reopened after it was accepted with no word before
 * (test-esp32 log #112). This says it plainly at the top of the page: which requirement, what changes in it, what
 * accepting costs, and whether anything asked for the edit.
 */
import { TriangleAlert } from 'lucide-react'
import type { RequirementEdits } from '@/lib/types'
import { cn } from '@/lib/utils'

export function RequirementEditsNotice({ edits, className }: { edits: RequirementEdits; className?: string }) {
  return (
    <section className={cn('flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4', className)} aria-labelledby="requirement-edits">
      <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <h3 id="requirement-edits" className="text-sm font-semibold">{edits.says}</h3>
        <ul className="mt-1.5 space-y-1 text-sm">
          {edits.edits.map((e) => <li key={e.id} className="break-words">{e.what}</li>)}
        </ul>
        <p className="mt-2 text-sm text-muted-foreground">
          {edits.asked
            ? edits.asked
            : 'Nothing asked for this edit: no answer said it changes a requirement, and no change request did. Ask for changes to keep the requirement as agreed.'}
        </p>
      </div>
    </section>
  )
}

/** What the decision bar says accepting does, when the change edits an accepted requirement. */
export const acceptWithEdits = (edits: RequirementEdits): string =>
  edits.reopens
    ? `Accepting adds it to the design and reopens Define: ${edits.ids.join(', ')} ${edits.ids.length === 1 ? 'is' : 'are'} agreed again, and every gate from Define on is signed again.`
    : `Accepting adds it to the design and sends ${edits.ids.join(', ')} back to Requirements review.`
