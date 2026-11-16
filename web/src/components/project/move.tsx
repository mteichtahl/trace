/**
 * Moving a project between GitHub and trace's GitLab (project.move / move_status / move_cancel,
 * src/api/actions-move.ts; docs/gitlab-projects.md "Moving a project"). The screens approved on 16 Nov:
 *
 *   MoveCard       Settings › "Where this project lives": its home now, and Move to … (admins, when this installation
 *                  has trace's GitLab). While a move is going it becomes the progress view; once done it says what
 *                  changed and offers Move back; failed, Try again or Keep it where it is
 *   MoveSheet      the confirmation: what moves, what stays, and when: once the work running now has finished (Move
 *                  when idle) or now (running tasks are asked to pause first)
 *   MoveNextCard   the Overview's Next card while the project is moving (it is paused meanwhile)
 *
 * Every screen reads project.move_status, again every few seconds while a move is going (the bucket's write of the
 * record is a live event too). Looking is also what moves an idle move on and resumes the project when it is done.
 */
import { useQuery } from '@tanstack/react-query'
import { ArrowRightLeft, Check, CircleAlert, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { SideSheet } from '@/components/side-sheet'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ago } from '@/lib/format'
import { q, useCall } from '@/lib/queries'
import type { Forge, ForgeMove, MoveStep } from '@/lib/types'
import { cn } from '@/lib/utils'

export const forgeName = (f: Forge): string => (f === 'gitlab' ? "trace's GitLab" : 'GitHub')

export const MOVE_STEPS: { step: MoveStep; label: string }[] = [
  { step: 'deploy', label: 'Getting the new home ready' },
  { step: 'copy', label: 'Copying every branch and tag' },
  { step: 'changes', label: 'Recreating open changes' },
  { step: 'issues', label: 'Recreating open issues' },
  { step: 'archive', label: 'Archiving the old home' },
  { step: 'setup', label: 'Setting up the new home for trace' },
]

/** Whether a move is still going (waiting or moving). Pure. */
export const going = (m: ForgeMove | null | undefined): boolean => !!m && (m.status === 'waiting' || m.status === 'moving')

/** Each step's state for the progress view. Pure. */
export function stepStates(m: ForgeMove): { step: MoveStep; label: string; state: 'done' | 'now' | 'todo' | 'failed' }[] {
  const at = m.status === 'moved' ? MOVE_STEPS.length : m.step ? MOVE_STEPS.findIndex((s) => s.step === m.step) : -1
  return MOVE_STEPS.map((s, i) => ({
    ...s,
    state: m.status === 'moved' || i < at ? 'done'
      : i === at ? (m.status === 'failed' ? 'failed' : 'now')
        : 'todo',
  }))
}

/** What the card or Next card says of a move, in words. Pure. */
export function moveWords(m: ForgeMove, now: number = Date.now()): { title: string; line: string } {
  const to = forgeName(m.to)
  const from = forgeName(m.from)
  switch (m.status) {
    case 'waiting':
      return m.when === 'idle' && !m.idle_at
        ? { title: `Moving to ${to} once the work running now finishes`, line: `Asked for by ${m.requested_by} ${ago(Date.parse(m.requested_at), now)}. Nothing new starts meanwhile; an admin can still cancel it.` }
        : { title: `Moving to ${to}`, line: `Waiting for trace to update itself to make the move (asked for by ${m.requested_by}). An admin can still cancel it.` }
    case 'moving':
      return { title: `Moving to ${to}`, line: `${MOVE_STEPS.find((s) => s.step === m.step)?.label ?? 'Under way'}. The project is paused until the move is done; it resumes by itself.` }
    case 'moved': {
      const n = Object.keys(m.changes).length
      return { title: `Moved to ${to}`, line: `${m.finished_at ? `Done ${ago(Date.parse(m.finished_at), now)}. ` : ''}${n ? `${n} open ${n === 1 ? 'change has' : 'changes have'} new numbers there. ` : ''}The old home on ${from} is archived, read-only, never deleted.` }
    }
    case 'failed':
      return { title: `The move to ${to} stopped`, line: `${(m.error ?? 'It stopped').replace(/([^.!?])$/, '$1.')} The project is still on ${from}, exactly as it was, and stays paused until the move is tried again or set aside.` }
    case 'cancelled':
      return { title: `The move to ${to} was cancelled`, line: `The project stays on ${from}.` }
  }
}

/** The move's answer, looked at again every few seconds while it is going. */
export function useMove(repo: string) {
  return useQuery({
    ...q('project.move_status', { repo }),
    refetchInterval: (query) => (going(query.state.data?.move) ? 5_000 : false),
  })
}

const touched = (repo: string): unknown[][] => [['project.move_status', repo], ['project.lifecycle', repo], ['projects'], ['journey.get', repo]]

function Steps({ move, className }: { move: ForgeMove; className?: string }) {
  return (
    <ol className={cn('space-y-2 text-sm', className)} aria-label="Steps of the move">
      {stepStates(move).map((s) => (
        <li key={s.step} className="flex items-center gap-2.5">
          {s.state === 'done' ? <Check className="size-4 shrink-0 text-verified" aria-label="Done" />
            : s.state === 'now' ? <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-label="Now" />
              : s.state === 'failed' ? <CircleAlert className="size-4 shrink-0 text-destructive" aria-label="Stopped here" />
                : <span className="mx-[5px] size-1.5 shrink-0 rounded-full bg-muted-foreground/40" aria-label="To do" />}
          <span className={cn(s.state === 'todo' && 'text-muted-foreground', s.state === 'failed' && 'text-destructive')}>{s.label}</span>
        </li>
      ))}
    </ol>
  )
}

/** Settings › Where this project lives. */
export function MoveCard({ repo, name, admin }: { repo: string; name: string; admin: boolean }) {
  const s = useMove(repo)
  const [open, setOpen] = useState<Forge | null>(null)
  const cancel = useCall('project.move_cancel', ({ repo: r }) => touched(r))
  if (!s.data) return null
  const { move, forge, gitlab } = s.data
  const other: Forge = forge === 'gitlab' ? 'github' : 'gitlab'
  const recent = move && move.status !== 'cancelled' && (going(move) || move.status === 'failed' || (move.finished_at && Date.now() - Date.parse(move.finished_at) < 7 * 86400_000))
  const w = move && recent ? moveWords(move) : null
  const doCancel = () => cancel.mutate({ repo }, { onSuccess: (r) => toast(r.summary), onError: (e) => toast.error(`Could not cancel: ${e.message}`) })

  return (
    <div className="rounded-xl border p-5 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 basis-60">
          On <span className="font-medium">{forgeName(forge)}</span>
          <span className="text-muted-foreground"> · {forge === 'gitlab' ? 'trace runs its own GitLab in this installation; only admins sign in to it.' : 'The repository, its changes and checks are on GitHub.'}</span>
        </p>
        {admin && gitlab && !going(move) && move?.status !== 'failed' && (
          <Button variant="outline" onClick={() => setOpen(other)}>
            <ArrowRightLeft className="size-4" aria-hidden />{move?.status === 'moved' && move.to === forge ? 'Move back' : `Move to ${forgeName(other)}`}
          </Button>
        )}
      </div>
      {!gitlab && admin && <p className="mt-2 text-xs text-muted-foreground">Turn on trace's GitLab in the installer (Optional › trace's GitLab) to be able to move projects there.</p>}

      {move && w && (
        <div className={cn('mt-4 rounded-lg border p-4', move.status === 'failed' ? 'border-destructive/30 bg-destructive/5' : going(move) ? 'border-primary/30 bg-primary/5' : 'bg-muted/40')} role="status" aria-live="polite">
          <p className="font-medium">{w.title}</p>
          <p className="mt-1 text-muted-foreground">{w.line}</p>
          {(going(move) || move.status === 'failed') && <Steps move={move} className="mt-3" />}
          {move.status === 'moved' && move.todo.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">{move.todo.map((t) => <li key={t}>{t}</li>)}</ul>
          )}
          {admin && (move.status === 'waiting' || move.status === 'failed') && (
            <div className="mt-3 flex flex-wrap gap-2">
              {move.status === 'failed' && <Button size="sm" onClick={() => setOpen(move.to)}>Try again</Button>}
              <Button size="sm" variant="outline" disabled={cancel.isPending} onClick={doCancel}>
                {cancel.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}{move.status === 'failed' ? `Keep it on ${forgeName(move.from)}` : 'Cancel the move'}
              </Button>
            </div>
          )}
        </div>
      )}
      {open && <MoveSheet repo={repo} name={name} from={forge} to={open} open onOpenChange={(o) => !o && setOpen(null)} />}
    </div>
  )
}

/** What a move takes across and what it leaves behind. Pure. */
export function moveLists(from: Forge, to: Forge): { moves: string[]; stays: string[] } {
  return {
    moves: [
      'Every branch, tag and commit',
      'Open changes, in stack order, with their discussion so far (they get new numbers)',
      'Open issues and their labels',
      "trace's checks, merge rules and live updates, set up again there",
    ],
    stays: [
      `The old repository on ${forgeName(from)}, archived: read-only, never deleted. Moving back reuses it`,
      'Closed changes and their discussion (their commits are in the history)',
      `Check runs and logs from before the move${to === 'gitlab' ? ' (GitLab starts its own)' : ''}`,
      "The project's record, requirements, people and memory: they are trace's, not the repository's",
    ],
  }
}

/** The confirmation before a move. */
export function MoveSheet({ repo, name, from, to, open, onOpenChange }: { repo: string; name: string; from: Forge; to: Forge; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [when, setWhen] = useState<'idle' | 'now'>('idle')
  const move = useCall('project.move', ({ repo: r }) => touched(r))
  const lists = moveLists(from, to)
  const go = () => move.mutate({ repo, to, when }, {
    onSuccess: (r) => { toast(r.summary); onOpenChange(false) },
    onError: (e) => toast.error(`Not moved: ${e.message}`),
  })
  return (
    <SideSheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Move ${name} to ${forgeName(to)}`}
      description={`The project is paused while it moves (usually 10 to 30 minutes, most of it trace updating itself), then resumes by itself on ${forgeName(to)}.`}
      footer={(
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Not now</Button>
          <Button onClick={go} disabled={move.isPending}>
            {move.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}{when === 'idle' ? 'Move when idle' : 'Move now'}
          </Button>
        </div>
      )}
    >
      <div className="space-y-5 text-sm">
        <section>
          <h3 className="font-medium">What moves</h3>
          <ul className="mt-2 space-y-1.5">{lists.moves.map((l) => <li key={l} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-verified" aria-hidden />{l}</li>)}</ul>
        </section>
        <section>
          <h3 className="font-medium">What stays</h3>
          <ul className="mt-2 space-y-1.5 text-muted-foreground">{lists.stays.map((l) => <li key={l} className="flex gap-2"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />{l}</li>)}</ul>
        </section>
        <section>
          <h3 className="font-medium">When</h3>
          <RadioGroup value={when} onValueChange={(v) => setWhen(v as 'idle' | 'now')} className="mt-2 gap-3">
            <div className="flex items-start gap-2.5">
              <RadioGroupItem id="move-idle" value="idle" className="mt-0.5" />
              <Label htmlFor="move-idle" className="block font-normal leading-snug">
                <span className="font-medium">Once the work running now has finished</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">Nothing new starts meanwhile. Best for most moves.</span>
              </Label>
            </div>
            <div className="flex items-start gap-2.5">
              <RadioGroupItem id="move-now" value="now" className="mt-0.5" />
              <Label htmlFor="move-now" className="block font-normal leading-snug">
                <span className="font-medium">Now</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">Running tasks are asked to pause at their next safe point first; they can be resumed after the move.</span>
              </Label>
            </div>
          </RadioGroup>
        </section>
        <p className="text-xs text-muted-foreground">{repo} keeps its name in trace. Links to old changes on {forgeName(from)} keep working, read-only.</p>
      </div>
    </SideSheet>
  )
}

/** The Overview's Next card while the project moves (it stands in for the paused card), or null. */
export function MoveNextCard({ repo, className }: { repo: string; className?: string }) {
  const s = useMove(repo)
  const m = s.data?.move
  if (!m || !(going(m) || m.status === 'failed')) return null
  const w = moveWords(m)
  const failed = m.status === 'failed'
  return (
    <section aria-labelledby="next-step" className={cn('rounded-xl border p-5 md:p-6', failed ? 'border-destructive/30 bg-destructive/5' : 'border-primary/30 bg-primary/5', className)}>
      <p id="next-step" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span className={cn('size-2 rounded-full', failed ? 'bg-destructive' : 'bg-primary')} aria-hidden />
        Next step · {failed ? 'Move stopped' : 'Moving'}
      </p>
      <p className="mt-3 text-lg leading-snug md:text-xl">{w.title}</p>
      <p className="mt-2 text-sm text-muted-foreground">{w.line}</p>
      <Steps move={m} className="mt-4" />
      {failed && <p className="mt-3 text-sm">An admin can try again or keep it where it is from Settings › Where this project lives.</p>}
    </section>
  )
}
