/**
 * Incoming inspection's record (docs/user-journey.md "Incoming inspection"): the boards received by serial, and for
 * the board in hand each check of the step: counted and labelled, a fault against its reference, each hand-placed part
 * fitted or marked as left off. Writes board.record and board.check (the journey record), so the quality bar is
 * computed from what is recorded (src/api/skill-checks.ts). The person enters what they see; trace never does.
 */
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { BoardList } from '@/components/project/build-record'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useCall } from '@/lib/queries'
import type { BoardView } from '@/lib/types-s1'

type Kind = 'count' | 'visual' | 'fault' | 'hand' | 'label'
const STEP_KIND: Record<string, Kind> = { count: 'count', look: 'visual', faults: 'fault', hand: 'hand', label: 'label' }

/** The check id a step records for a board: the step's own, or with the part's reference (fault-U3, hand-J2). Pure. */
export const checkId = (kind: Kind, ref: string): string => (kind === 'fault' || kind === 'hand') && ref.trim() ? `${kind}-${ref.trim().toUpperCase()}` : kind

export function InspectionPanel({ repo, step, boards, handPlaced }: { repo: string; step: string; boards: BoardView[]; handPlaced?: string[] }) {
  const kind = STEP_KIND[step] ?? 'visual'
  const invalidate = (a: { repo: string }) => [['skill.get', a.repo], ['build.get', a.repo], ['journey.get', a.repo]]
  const record = useCall('board.record', invalidate)
  const check = useCall('board.check', invalidate)
  const [serial, setSerial] = useState(boards[0]?.serial ?? '')
  const [newSerial, setNewSerial] = useState(`SN-${String(boards.length + 1).padStart(3, '0')}`)
  const [photo, setPhoto] = useState('')
  const [ref, setRef] = useState(kind === 'hand' ? handPlaced?.[0] ?? '' : '')
  const [note, setNote] = useState('')
  const busy = record.isPending || check.isPending
  const err = (e: unknown) => toast.error('Not recorded. What you entered is kept.', { description: String(e) })
  const add = () => record.mutate({ repo, serial: newSerial.trim(), ...(photo.trim() ? { photos: [photo.trim()] } : {}) }, {
    onSuccess: () => { toast(`${newSerial.trim()} recorded as received.`); setSerial(newSerial.trim()); setNewSerial(`SN-${String(boards.length + 2).padStart(3, '0')}`); setPhoto('') }, onError: err,
  })
  const mark = (result: 'pass' | 'fail' | 'marked') => check.mutate({ repo, serial, check: checkId(kind, ref), kind, result, ...(ref.trim() ? { ref: ref.trim().toUpperCase() } : {}), ...(note.trim() ? { note: note.trim() } : {}), ...(photo.trim() ? { photo: photo.trim() } : {}) }, {
    onSuccess: () => { toast(`${serial}: ${kind === 'hand' ? `${ref} ${result === 'marked' ? 'marked as left off' : 'fitted'}` : result === 'fail' ? 'fault recorded' : 'recorded'}.`); setNote('') }, onError: err,
  })
  return (
    <section className="mt-6 space-y-4 rounded-xl border p-5" aria-labelledby="inspection">
      <h2 id="inspection" className="text-sm font-semibold">Boards</h2>
      <BoardList boards={boards} />
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
        <div className="space-y-1.5"><Label htmlFor="new-serial">Serial on the label</Label><Input id="new-serial" value={newSerial} onChange={(e) => setNewSerial(e.target.value)} className="font-mono" /></div>
        <div className="space-y-1.5"><Label htmlFor="photo">Photo (a run's picture, runs/…/top.jpg, or a file in the repository)</Label><Input id="photo" value={photo} onChange={(e) => setPhoto(e.target.value)} placeholder="runs/run_ins1/sn-001-top.jpg" /></div>
        <Button variant="outline" disabled={busy || newSerial.trim().length < 2} onClick={add}>{record.isPending && <Loader2 className="animate-spin" />}Record board</Button>
      </div>
      {boards.length > 0 && (
        <div className="grid gap-3 border-t pt-4 sm:grid-cols-[1fr_1fr_2fr] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="board">Board</Label>
            <Select value={serial} onValueChange={setSerial}>
              <SelectTrigger id="board"><SelectValue placeholder="Choose a board" /></SelectTrigger>
              <SelectContent>{boards.map((b) => <SelectItem key={b.serial} value={b.serial}>{b.serial}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {(kind === 'fault' || kind === 'hand') && (
            <div className="space-y-1.5"><Label htmlFor="ref">Part reference</Label><Input id="ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder={kind === 'hand' ? handPlaced?.join(', ') : 'U3'} className="font-mono" /></div>
          )}
          <div className="space-y-1.5"><Label htmlFor="note">Note (optional)</Label><Input id="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={kind === 'fault' ? 'Rotated 180°' : ''} /></div>
          <div className="flex flex-wrap gap-2 sm:col-span-3">
            {kind === 'fault' ? (
              <Button variant="outline" disabled={busy || !serial || !ref.trim()} onClick={() => mark('fail')}>Record the fault</Button>
            ) : kind === 'hand' ? (
              <>
                <Button variant="outline" disabled={busy || !serial || !ref.trim()} onClick={() => mark('pass')}>Fitted</Button>
                <Button variant="outline" disabled={busy || !serial || !ref.trim()} onClick={() => mark('marked')}>Left off on purpose</Button>
              </>
            ) : (
              <Button variant="outline" disabled={busy || !serial} onClick={() => mark('pass')}>{kind === 'count' ? 'Counted' : kind === 'label' ? 'Labelled' : 'Looks right'}</Button>
            )}
          </div>
          {kind === 'hand' && handPlaced?.length ? <p className="text-xs text-muted-foreground sm:col-span-3">The fab does not place {handPlaced.join(', ')}: fit each by hand, or mark it as left off.</p> : null}
        </div>
      )}
    </section>
  )
}
