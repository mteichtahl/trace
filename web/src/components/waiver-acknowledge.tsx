/**
 * A waiver's "Acknowledge" box on the gate page. The record asks the signer to open each waiver of the stage for the
 * signing at hand (src/core/journey.ts openedBy), and ticking the box is how the page records that open
 * (journey.criterion.open). So the box shows what the record counts (journey.get `opened_by_you`, or ticked this
 * session), never an acknowledgement from an earlier signing: after the budget change reopened Layout, the case-fit
 * waivers acknowledged at the first signing showed ticked and locked, no open was sent, and the gate refused to sign
 * with "Open 2 waivers taken in this stage" (test-esp32-e2e).
 */
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { isWaiverRead } from '@/components/skills/gate-rules'
import type { Waiver } from '@/lib/types'
import { cn } from '@/lib/utils'

export function WaiverAcknowledge({ waiver: w, ticked, onTick, className }: {
  waiver: Pick<Waiver, 'id' | 'opened'>
  /** waiver ids ticked this session */
  ticked: ReadonlySet<string>
  /** ticked on (record the open, and acknowledge it with the signature) or off */
  onTick: (on: boolean) => void
  className?: string
}) {
  const read = isWaiverRead(w, { acknowledged: ticked })
  return (
    <Label className={cn('flex cursor-pointer items-center gap-2 font-normal', className)}>
      {/* the record already counts it for this signing: nothing to send, so it stays ticked */}
      <Checkbox checked={read} disabled={!!w.opened} onCheckedChange={(v) => onTick(!!v)} />
      Acknowledge: I've read this waiver and where it is caught.
    </Label>
  )
}
