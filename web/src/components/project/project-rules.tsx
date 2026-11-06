/**
 * The project's rules (src/api/rule-answers.ts; test-esp32 log #109): .trace/rules.md on the default branch, which
 * every agent follows as its authority, and each question a person answered as "A rule for the project". Each answer
 * shows who decided it and which question it answers, and where it stands: in the rules, waiting in its change (a link
 * to it), or not in the rules yet (an answer from before trace wrote them, or whose change could not be made), with a
 * button that adds it through a change. The whole file is one tap away.
 */
import { Link } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { QueryError } from '@/components/states'
import { type RuleAnswer, projectId } from '@/lib/api'
import { useAction, useCall } from '@/lib/queries'

const day = (at: string | null): string => (at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '')

export function ProjectRules({ repo, canWrite }: { repo: string; canWrite: boolean }) {
  const rules = useAction('project.rules', { repo })
  const add = useCall('project.rule_from_answer', (a) => [['project.rules', a.repo], ['changes.list', a.repo]])
  if (rules.isError) return <QueryError error={rules.error} what="the project's rules" onRetry={() => void rules.refetch()} />
  if (!rules.data) return <div className="h-24 animate-pulse rounded-xl border bg-muted/40" aria-label="Loading the project's rules" />
  const { text, answers, path, branch } = rules.data
  const written = (text ?? '').trim().length > 0
  return (
    <div className="space-y-4 rounded-xl border p-5">
      <p className="text-xs text-muted-foreground">
        Every agent follows the rules in <span className="font-mono">{path}</span> on <span className="font-mono">{branch}</span>. When you answer an agent's question as "A rule for the project", trace adds it here through a change.
      </p>
      {answers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No answer has been made a rule yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border" aria-label="Rules from answers">
          {answers.map((r) => (
            <RuleRow key={r.question} r={r} repo={repo} canWrite={canWrite} adding={add.isPending && add.variables?.question === r.question}
              onAdd={() => add.mutate({ repo, question: r.question }, {
                onSuccess: (x) => toast('Rule added as a change', { description: x.summary }),
                onError: (e) => toast.error('The rule was not added.', { description: e instanceof Error ? e.message : String(e) }),
              })} />
          ))}
        </ul>
      )}
      {written ? (
        <details className="group">
          <summary className="cursor-pointer text-sm font-medium text-primary">Read the whole rules file</summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 font-mono text-xs">{text}</pre>
        </details>
      ) : (
        <p className="text-sm text-muted-foreground">The rules file on {branch} is empty, so agents have no project rules yet{answers.some((r) => r.state === 'waiting') ? ': the rules waiting in a change go in once it is accepted' : ''}.</p>
      )}
    </div>
  )
}

function RuleRow({ r, repo, canWrite, adding, onAdd }: { r: RuleAnswer; repo: string; canWrite: boolean; adding: boolean; onAdd: () => void }) {
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-3">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{r.rule}</span>
        {r.reason && <span className="block text-xs text-muted-foreground">Why: {r.reason}</span>}
        <span className="mt-0.5 block text-xs text-muted-foreground">
          Decided by {r.by ?? 'a person on the project'}{r.at ? ` on ${day(r.at)}` : ''}, answering {r.asked_by}: "{r.asked}"
        </span>
      </span>
      <span className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end sm:gap-1.5">
        {r.state === 'in_rules' && <StatusBadge status="done" label="In the rules" />}
        {r.state === 'waiting' && (
          <>
            <StatusBadge status="waiting" label={r.change ? `Waiting in change #${r.change}` : 'Waiting in a change'} />
            {r.change && <Link to={`/p/${projectId(repo)}/changes/${r.change}` as string} className="text-xs font-medium text-primary hover:underline">Open the change</Link>}
          </>
        )}
        {r.state === 'missing' && (
          <>
            <StatusBadge status="warning" label="Not in the rules yet" />
            {canWrite && <Button size="sm" variant="outline" onClick={onAdd} disabled={adding}>{adding && <Loader2 className="size-4 animate-spin" />}Add it to the rules</Button>}
          </>
        )}
      </span>
    </li>
  )
}
