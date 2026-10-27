/**
 * Dismiss a stuck agent's report (stuck.dismiss): a person says, in one line, why the agent need not wait on it any
 * more. The reason is required; the agent reads it (journey.status). The item leaves Home, the inbox and the Agents
 * page at once here, and everywhere else through the live event.
 */
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { call } from '@/lib/api'
import type { InboxItem } from '@/lib/types'
import { cn } from '@/lib/utils'

/** The reason as the API takes it: one line, at least 3 characters, at most 300. Null: not yet a reason. */
export function dismissReason(text: string): string | null {
  const r = text.replace(/\s+/g, ' ').trim()
  return r.length >= 3 && r.length <= 300 ? r : null
}

/** Send the dismissal, and take the item out of the inbox cache at once. */
export function useDismissStuck() {
  const qc = useQueryClient()
  return async (item: InboxItem, reason: string): Promise<void> => {
    if (!item.questionId) throw new Error('This item names no stuck report.')
    await call('stuck.dismiss', { repo: item.repo, job: item.questionId, reason })
    qc.setQueryData<InboxItem[]>(['inbox', {}], (xs) => xs?.filter((x) => x.id !== item.id))
    void qc.invalidateQueries({ queryKey: ['inbox'] })
    void qc.invalidateQueries({ queryKey: ['journey.get', item.repo] })
  }
}

export interface DismissStuckProps {
  item: InboxItem
  /** sends it (useDismissStuck); throws to keep the form open with what was typed */
  onDismiss: (item: InboxItem, reason: string) => Promise<void>
  size?: 'sm' | 'lg'
  className?: string
}

export function DismissStuck({ item, onDismiss, size = 'sm', className }: DismissStuckProps) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const id = useId()
  const reason = dismissReason(text)
  if (!open) {
    return <Button size={size} variant="ghost" className={className} onClick={() => setOpen(true)}>Dismiss</Button>
  }
  const send = async () => {
    if (!reason || busy) return
    setBusy(true)
    try {
      await onDismiss(item, reason)
      toast('Dismissed. The agent is told why.')
      setOpen(false)
      setText('')
    } catch (e) {
      toast.error(`Could not dismiss it: ${e instanceof Error ? e.message : String(e)}. What you wrote is kept; try again.`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className={cn('flex w-full flex-col gap-2 sm:flex-row sm:items-center', className)}
      onSubmit={(e) => { e.preventDefault(); void send() }}
    >
      <label htmlFor={id} className="sr-only">Why it can be dismissed</label>
      <Input
        id={id}
        autoFocus
        required
        maxLength={300}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
        placeholder="Why, in one line (the agent reads it)"
        className="min-w-0 flex-1"
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!reason || busy}>
          {busy && <Loader2 className="animate-spin" />}
          Dismiss
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
      </div>
    </form>
  )
}
