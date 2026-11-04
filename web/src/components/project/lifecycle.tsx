/**
 * Pausing and retiring a project (project.pause / resume / retire / restore, src/api/actions-lifecycle.ts).
 *
 *   Paused   the project stays exactly as it is: nobody can change it and trace starts no work on it (agents, tools,
 *            checks, deploys) until someone resumes it. Everyone can still read everything. Contributors and admins
 *            pause and resume.
 *   Retired  the project is "deleted" for everyone: it leaves every list. Nothing is thrown away, so an admin can
 *            restore it from Admin › Retired projects. Admins only.
 *
 * PausedBanner shows on every project page while it is paused (and, for admins, while it is retired) with the one
 * button that undoes it. PauseDialog and RetireDialog say plainly what will happen before it does.
 */
import { useNavigate } from '@tanstack/react-router'
import { Archive, Loader2, PauseCircle, Play } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { projectName } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ago } from '@/lib/format'
import { useAction, useCall } from '@/lib/queries'
import type { Lifecycle, LifecycleMark } from '@/lib/types'
import { cn } from '@/lib/utils'

/** The queries a lifecycle change touches (the live event refreshes the same for everyone else). */
const touched = (repo: string): unknown[][] => [['project.lifecycle', repo], ['projects'], ['projects.retired'], ['journey.get', repo], ['inbox'], ['activity.list']]

export const useLifecycle = (repo: string) => useAction('project.lifecycle', { repo })

/** Whether this person may pause and resume (contributors and admins). Pure. */
export const mayPause = (o: { admin: boolean; part?: string | undefined }): boolean => o.admin || o.part === 'contributor'

/** "Paused by ana@… 2 hours ago: waiting on parts." Pure. */
export function markWords(verb: 'Paused' | 'Retired', m: LifecycleMark, now: number = Date.now()): string {
  return `${verb} by ${m.by} ${ago(m.at * 1000, now).replace(/^Today /, 'today at ')}${m.reason ? `: ${m.reason}` : ''}.`
}

/** The banner's words for a lifecycle, or null when the project is active. Pure. */
export function bannerWords(l: Pick<Lifecycle, 'paused' | 'retired'> | undefined, now: number = Date.now()): { title: string; line: string; body: string; retired: boolean } | null {
  if (!l) return null
  if (l.retired) {
    return {
      title: 'This project is retired', retired: true, line: markWords('Retired', l.retired, now),
      body: 'It is hidden from everyone and does no work. Nothing has been deleted: restoring it brings it back as it was.',
    }
  }
  if (l.paused) {
    return {
      title: 'This project is paused', retired: false, line: markWords('Paused', l.paused, now),
      body: 'Everything stays as it is: nothing can be changed and trace starts no work here until it is resumed. You can still look at everything.',
    }
  }
  return null
}

/** The banner on every project page while it is paused or retired, with the button that undoes it. */
export function PausedBanner({ repo, part, className }: { repo: string; part?: string | undefined; className?: string }) {
  const { user } = useAuth()
  const admin = user?.class === 'admin'
  const l = useLifecycle(repo)
  const resume = useCall('project.resume', ({ repo: r }) => touched(r))
  const restore = useCall('project.restore', ({ repo: r }) => touched(r))
  const w = bannerWords(l.data)
  if (!w) return null
  const Icon = w.retired ? Archive : PauseCircle
  const act = w.retired
    ? admin && { label: 'Restore project', busy: restore.isPending, go: () => restore.mutate({ repo }, { onSuccess: (r) => toast(r.summary), onError: (e) => toast.error(`Could not restore: ${e.message}`) }) }
    : mayPause({ admin, part }) && { label: 'Resume project', busy: resume.isPending, go: () => resume.mutate({ repo }, { onSuccess: (r) => toast(r.summary), onError: (e) => toast.error(`Could not resume: ${e.message}`) }) }
  return (
    <section role="status" aria-label={w.title} className={cn('flex flex-wrap items-start gap-x-4 gap-y-3 rounded-xl border px-4 py-3 text-sm', w.retired ? 'border-destructive/30 bg-destructive/5' : 'border-warning/40 bg-warning/5', className)}>
      <div className="min-w-0 flex-1 basis-72">
        <p className="flex items-start gap-2 font-medium">
          <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{w.title}</span>
        </p>
        <p className="mt-1 pl-6">{w.line}</p>
        <p className="mt-1 pl-6 text-muted-foreground">{w.body}</p>
      </div>
      {act && (
        <Button size="sm" className="max-sm:ml-6 max-sm:w-[calc(100%-1.5rem)]" disabled={act.busy} onClick={act.go}>
          {act.busy ? <Loader2 className="animate-spin" /> : <Play />}
          {act.label}
        </Button>
      )}
    </section>
  )
}

/** Pause, with an optional reason everyone on the project will see. */
export function PauseDialog({ repo, name, open, onOpenChange }: { repo: string; name?: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [reason, setReason] = useState('')
  const pause = useCall('project.pause', ({ repo: r }) => touched(r))
  const close = (o: boolean) => { if (!o) setReason(''); onOpenChange(o) }
  const go = () => pause.mutate({ repo, ...(reason.trim() ? { reason: reason.trim() } : {}) }, {
    onSuccess: (r) => { toast(r.summary); close(false) },
    onError: (e) => toast.error(`Could not pause: ${e.message}`),
  })
  return (
    <AlertDialog open={open} onOpenChange={close}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Pause {name ?? projectName(repo)}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>Everything stays exactly as it is. Until someone resumes it:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>nobody can change it: no edits, answers, sign-offs or accepted changes;</li>
                <li>trace starts no work: running tasks pause at their next safe point, and queued work waits;</li>
                <li>everyone can still see everything, and any Contributor can resume it.</li>
              </ul>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="pause-reason">Why? <span className="font-normal text-muted-foreground">(optional, everyone on the project sees it)</span></Label>
          <Textarea id="pause-reason" rows={2} maxLength={300} placeholder="Waiting on the enclosure supplier" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button disabled={pause.isPending} onClick={go}>
            {pause.isPending ? <Loader2 className="animate-spin" /> : <PauseCircle />}Pause project
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Retire (admins), with the project's name typed to confirm: it disappears for everyone. */
export function RetireDialog({ repo, name, open, onOpenChange }: { repo: string; name?: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const shown = name ?? projectName(repo)
  const [typed, setTyped] = useState('')
  const [reason, setReason] = useState('')
  const navigate = useNavigate()
  const retire = useCall('project.retire', ({ repo: r }) => touched(r))
  const close = (o: boolean) => { if (!o) { setTyped(''); setReason('') } onOpenChange(o) }
  const go = () => retire.mutate({ repo, ...(reason.trim() ? { reason: reason.trim() } : {}) }, {
    onSuccess: (r) => { toast(r.summary); close(false); void navigate({ to: '/projects' }) },
    onError: (e) => toast.error(`Could not retire: ${e.message}`),
  })
  return (
    <AlertDialog open={open} onOpenChange={close}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Retire {shown}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>It disappears from every list and view, for everyone, and does no work. Nothing is deleted: its repository, record, chats and history are kept.</p>
              <p>Any admin can bring it back from <span className="font-medium text-foreground">Admin › Retired projects</span>. If you only want to stop work for a while, pause it instead.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="retire-reason">Why? <span className="font-normal text-muted-foreground">(optional, shown to admins)</span></Label>
            <Input id="retire-reason" maxLength={300} placeholder="Replaced by the v2 probe" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="retire-name">Type <span className="font-semibold">{shown}</span> to confirm</Label>
            <Input id="retire-name" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={typed.trim() !== shown || retire.isPending} onClick={go}>
            {retire.isPending ? <Loader2 className="animate-spin" /> : <Archive />}Retire project
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** The Next step card's words while the project is paused or retired, or null when it is active. Pure. */
export function heldNextWords(l: Pick<Lifecycle, 'paused' | 'retired'> | undefined, o: { admin: boolean; part?: string | undefined }, now: number = Date.now()): { label: string; summary: string; detail: string; action: 'resume' | 'restore' | null } | null {
  if (!l) return null
  if (l.retired) {
    return {
      label: 'Retired', summary: 'Nothing happens here: this project is retired.',
      detail: `${markWords('Retired', l.retired, now)} ${o.admin ? 'Restore it from the banner above to bring it back as it was.' : ''}`.trim(),
      action: o.admin ? 'restore' : null,
    }
  }
  if (l.paused) {
    const may = mayPause(o)
    return {
      label: 'Paused', summary: 'Nothing happens here until the project is resumed.',
      detail: `${markWords('Paused', l.paused, now)} ${may ? 'Resume it from the banner above when it should carry on: trace picks up where it stopped.' : 'A Contributor or an admin can resume it.'}`,
      action: may ? 'resume' : null,
    }
  }
  return null
}

/**
 * Stands in for the Overview's Next step card while the project is paused or retired, so nobody is nudged toward work
 * that cannot happen. The one button that undoes it stays on the banner above (PausedBanner), not repeated here.
 */
export function HeldNextCard({ repo, part, className }: { repo: string; part?: string | undefined; className?: string }) {
  const { user } = useAuth()
  const l = useLifecycle(repo)
  const w = heldNextWords(l.data, { admin: user?.class === 'admin', part })
  if (!w) return null
  const retired = !!l.data?.retired
  return (
    <section aria-labelledby="next-step" className={cn('rounded-xl border p-5 md:p-6', retired ? 'border-destructive/30 bg-destructive/5' : 'border-warning/40 bg-warning/5', className)}>
      <p id="next-step" className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span className={cn('size-2 rounded-full', retired ? 'bg-destructive' : 'bg-warning')} aria-hidden />
        Next step · {w.label}
      </p>
      <p className="mt-3 text-lg leading-snug md:text-xl">{w.summary}</p>
      <p className="mt-2 text-sm text-muted-foreground">{w.detail}</p>
    </section>
  )
}
