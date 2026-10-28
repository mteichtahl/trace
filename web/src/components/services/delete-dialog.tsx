import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { call } from '@/lib/api'

/** Delete, with the system's name typed to confirm. */
export function DeleteDialog({ name, open, onOpenChange, onDeleted }: { name: string; open: boolean; onOpenChange: (o: boolean) => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState('')
  const [sending, setSending] = useState(false)
  const close = (o: boolean) => { if (!o) setTyped(''); onOpenChange(o) }
  const go = async () => {
    setSending(true)
    try {
      await call('services.delete', { name })
      toast(`${name} is deleted: its keys no longer work.`)
      close(false)
      onDeleted()
    } catch (e) {
      toast.error(`Could not delete ${name}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSending(false)
    }
  }
  return (
    <AlertDialog open={open} onOpenChange={close}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>Its keys stop working at once and it comes off every project. This can't be undone. If you only want to stop it for now, disable it instead.</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="delete-name">Type <span className="font-mono font-semibold">{name}</span> to confirm</Label>
          <Input id="delete-name" autoComplete="off" spellCheck={false} className="font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={typed.trim() !== name || sending} onClick={() => void go()}>
            {sending && <Loader2 className="animate-spin" />}Delete {name}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
