/**
 * What can be done with a waiver in force (test-esp32 #149: one taken by mistake could not be corrected or
 * withdrawn): "Withdraw…" asks why, in a sentence kept in the record (waiver.withdraw), and says what follows: what it
 * waived counts again, so a criterion it covered is not met until it is met or waived again. "Take it again" opens the
 * Waiver skill filled in from it; taking the new one withdraws this one. Only its author or an admin sees them; anyone
 * else, or a waiver a signed gate stands on, reads why not (the API's own words). Shown wherever waivers are listed:
 * the Decisions page and the gate.
 */
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { call, projectId } from '@/lib/api'
import type { Waiver } from '@/lib/types'
import { cn } from '@/lib/utils'

/** The reason as the API takes it: a sentence, at least 5 characters, at most 2000. Null: not yet a reason. */
export function withdrawReason(text: string): string | null {
  const r = text.trim()
  return r.length >= 5 && r.length <= 2000 && !/^(no|n\/?a|none|ok|yes|whatever)\.?$/i.test(r) ? r : null
}

/** What withdrawing gives back, in words: what it waived counts again. */
export function withdrawEffect(w: Pick<Waiver, 'target' | 'title'>): string {
  const what = w.target ? `${w.target.kind} ${w.target.id}` : w.title
  return w.target?.kind === 'criterion'
    ? `The criterion counts again: it is not met until it is met or waived again.`
    : `${what.replace(/^./, (c) => c.toUpperCase())} counts again: the gate reads it as open until it is fixed or waived again.`
}

/** Send the withdrawal, and read the journey again so every list shows it at once. */
export function useWithdrawWaiver(repo: string) {
  const qc = useQueryClient()
  return async (waiver: string, reason: string): Promise<string> => {
    const r = await call('waiver.withdraw', { repo, waiver, reason })
    for (const k of [['journey.get', repo], ['skill.get', repo], ['inbox']]) void qc.invalidateQueries({ queryKey: k })
    return r.summary
  }
}

export function WaiverActions({ repo, waiver, className, onWithdraw }: {
  repo: string
  waiver: Waiver
  className?: string
  /** sends it (useWithdrawWaiver by default); throws to keep the form open with what was typed */
  onWithdraw?: (waiver: string, reason: string) => Promise<string>
}) {
  const send = useWithdrawWaiver(repo)
  const withdraw = onWithdraw ?? send
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const id = useId()
  if (waiver.closed) return null
  if (!waiver.mayWithdraw) return waiver.withdrawBlocked ? <p className={cn('text-xs text-muted-foreground', className)}>{waiver.withdrawBlocked}</p> : null
  const reason = withdrawReason(text)
  const submit = async () => {
    if (!reason || busy) return
    setBusy(true)
    try {
      toast(await withdraw(waiver.id, reason))
      setOpen(false)
      setText('')
    } catch (e) {
      toast.error(`Could not withdraw it: ${e instanceof Error ? e.message : String(e)}. What you wrote is kept; try again.`)
    } finally {
      setBusy(false)
    }
  }
  if (!open) {
    return (
      <div className={cn('flex flex-wrap items-center gap-2', className)}>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Withdraw…</Button>
        <Button size="sm" variant="ghost" asChild>
          <Link to="/p/$id/do/$skill" params={{ id: projectId(repo), skill: 'waiver' }} search={{ replaces: waiver.id } as never}>Take it again</Link>
        </Button>
      </div>
    )
  }
  return (
    <form className={cn('space-y-2', className)} onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <label htmlFor={id} className="text-sm font-medium">Why withdraw it</label>
      <Textarea
        id={id}
        autoFocus
        rows={2}
        maxLength={2000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
        placeholder="For example: rated safety by mistake; I meant failure."
      />
      <p className="text-xs text-muted-foreground">The reason is kept in the record. {withdrawEffect(waiver)} To correct it instead, use Take it again.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="destructive" disabled={!reason || busy}>
          {busy && <Loader2 className="animate-spin" />}
          Withdraw the waiver
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
      </div>
    </form>
  )
}
