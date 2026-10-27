/**
 * Switching a memory off and back on (memory.deactivate / memory.reactivate). Switching off needs a one-line reason,
 * which is kept; it never deletes the memory, and takes effect from the agents' next step. Who may switch: admins,
 * contributors on the project, and anyone for their own preferences; reviewers read only.
 */
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { projectName } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { type MemoryView, maySwitch } from '@/lib/knowledge'
import { useCall, useProjects } from '@/lib/queries'
import { cn } from '@/lib/utils'

const keys = (repo: string) => [['memory.list', repo], ['memory.recall', repo], ['graph.neighbourhood', repo]]

export function useMemorySwitch(repo = '') {
  const off = useCall('memory.deactivate', (a) => keys(a.repo))
  const on = useCall('memory.reactivate', (a) => keys(a.repo))
  return {
    off: (ids: string[], reason: string, inRepo = repo) =>
      Promise.all(ids.map((recordId) => off.mutateAsync({ repo: inRepo, recordId, reason })))
        .then(() => toast(ids.length === 1 ? 'Switched off' : `${ids.length} memories switched off`, { description: `${projectName(inRepo)}'s agents stop using ${ids.length === 1 ? 'it' : 'them'} from their next step. Nothing was deleted.` }))
        .catch((e: Error) => {
          toast.error('Could not switch it off', { description: `${e.message} Your reason is kept; try again.` })
          throw e
        }),
    on: (id: string, inRepo = repo) =>
      on.mutateAsync({ repo: inRepo, recordId: id })
        .then(() => toast('Switched back on', { description: 'The agents consider it again from their next step.' }))
        .catch((e: Error) => toast.error('Could not switch it back on', { description: e.message })),
    pending: off.isPending || on.isPending,
  }
}

/** May this person switch this memory on this project? */
export function useMaySwitch(): (m: Pick<MemoryView, 'actor' | 'repo'>) => boolean {
  const { user } = useAuth()
  const projects = useProjects()
  return (m) => maySwitch(m, { admin: user?.class === 'admin', part: projects.data?.find((p) => p.repo === m.repo)?.part ?? (projects.data?.find((p) => p.repo === m.repo)?.role === 'write' ? 'contributor' : 'reviewer') })
}

/** The reason is required: Switch off stays disabled until there is one. */
export const canSwitchOff = (reason: string): boolean => reason.trim().length >= 3

export function SwitchOffForm({ count = 1, onSubmit, onCancel, className, autoFocus }: { count?: number; onSubmit: (reason: string) => Promise<unknown>; onCancel?: () => void; className?: string; autoFocus?: boolean }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const id = `reason-${count}`
  return (
    <form
      className={cn('space-y-2', className)}
      onSubmit={async (e) => {
        e.preventDefault()
        if (!canSwitchOff(reason)) return
        setBusy(true)
        try {
          await onSubmit(reason.trim())
          setReason('')
        } catch {
          // the toast said so; the reason stays
        } finally {
          setBusy(false)
        }
      }}
    >
      <Label htmlFor={id} className="font-medium">
        Why should the agents stop using {count === 1 ? 'this' : `these ${count}`}? <span className="text-destructive">*</span> <span className="font-normal text-muted-foreground">(required)</span>
      </Label>
      <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="For example: superseded by the new regulator choice" autoFocus={autoFocus} />
      <p className="text-xs text-muted-foreground">Agents will not use {count === 1 ? 'it' : 'them'} from their next step. You can switch {count === 1 ? 'it' : 'them'} back on.</p>
      <div className="flex gap-2">
        <Button type="submit" variant="outline" className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={!canSwitchOff(reason) || busy}>
          {busy && <Loader2 className="animate-spin" />} Switch off
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}
