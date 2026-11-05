/**
 * What a criterion's shape found (shape.check), under the criterion, each with "Waive this one…": the gate review, the
 * gate while its stage still has work pending, and the Overview's stage guide all show them, so a person can waive a
 * finding wherever they see it (test-esp32 #142: the gate was locked for pending work, and the agent waited on the waiver).
 */
import { Link } from '@tanstack/react-router'
import { projectId } from '@/lib/api'
import type { Criterion } from '@/lib/types'
import { cn } from '@/lib/utils'

/** How many findings show under a criterion; the run its evidence opens lists them all. */
export const FINDINGS_SHOWN = 5

export function CriterionFindings({ repo, findings, className }: { repo: string; findings: NonNullable<Criterion['findings']>; className?: string }) {
  if (!findings.length) return null
  return (
    <ul className={cn('list-disc space-y-0.5 pl-4 text-xs text-muted-foreground', className)} aria-label="Still needed">
      {findings.slice(0, FINDINGS_SHOWN).map((f) => (
        <li key={f.id}>
          {f.text}{' '}
          <Link to="/p/$id/do/$skill" params={{ id: projectId(repo), skill: 'waiver' }} search={{ about: `finding:${f.id}` } as never} className="whitespace-nowrap text-primary underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>
            Waive this one…
          </Link>
        </li>
      ))}
      {findings.length > FINDINGS_SHOWN && <li className="list-none">and {findings.length - FINDINGS_SHOWN} more: open the evidence for all of them</li>}
    </ul>
  )
}
