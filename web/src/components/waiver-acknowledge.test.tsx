/**
 * test-esp32-e2e, the Layout gate after the budget change reopened Define and every later gate: the two case-fit
 * waivers acknowledged at Layout's first signing showed their Acknowledge boxes ticked and locked, so no
 * journey.criterion.open was sent, and gate.sign refused with "Open 2 waivers taken in this stage". The box now shows
 * what the record counts for this signing (journey.get `opened_by_you`), and ticking it sends the open.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { READERS } from '@/lib/readers'
import type { Gate, Waiver } from '@/lib/types'
import { isWaiverRead, signBlockers } from './skills/gate-rules'
import { WaiverAcknowledge } from './waiver-acknowledge'

// journey.get's waivers after the reopen: acknowledged at the first signing, but not opened for this one
const raw = (opened: boolean) => ({
  repo: 'a/b', current_stage: 'layout', gates: [], stages: [],
  waivers: [{ id: '7fa8b3c2d25d49d4', severity: 'cosmetic', target: { kind: 'finding', id: 'layout.fit@x' }, acknowledged: { by: 'marc@example.com', at: '2026-11-05T23:50:00.000Z' }, opened_by_you: opened, closed: false }],
})
const read = (opened: boolean): Waiver => (READERS['journey.get']!(raw(opened), { repo: 'a/b' }) as { waivers: Waiver[] }).waivers[0]!

describe('a waiver acknowledged at an earlier signing of a reopened stage', () => {
  it('reads whether the record counts its open for this signing', () => {
    expect(read(false)).toMatchObject({ acknowledged: true, opened: false })
    expect(read(true).opened).toBe(true)
  })

  it('holds Sign until it is read again: the old acknowledgement does not count', () => {
    const gate: Pick<Gate, 'criteria' | 'waivers'> = { criteria: [{ id: 'layout.fit', text: 'Fits', status: 'met', opened: true }], waivers: [read(false)] }
    const s = { opened: new Set<string>(), acknowledged: new Set<string>(), admin: true, online: true }
    expect(signBlockers(gate, s).map((b) => b.id)).toEqual(['acknowledged'])
    expect(signBlockers(gate, { ...s, acknowledged: new Set(['7fa8b3c2d25d49d4']) })).toEqual([])
    expect(signBlockers({ ...gate, waivers: [read(true)] }, s)).toEqual([])
    expect(isWaiverRead(read(false), s)).toBe(false)
  })

  it('shows its box unticked and open to tick, and ticking it asks for the open', async () => {
    const onTick = vi.fn()
    render(<WaiverAcknowledge waiver={read(false)} ticked={new Set()} onTick={onTick} />)
    const box = screen.getByRole('checkbox')
    expect(box).not.toBeChecked()
    expect(box).toBeEnabled()
    await userEvent.click(box)
    expect(onTick).toHaveBeenCalledWith(true)
  })

  it('once the record counts it, the box is ticked and there is nothing to send', () => {
    render(<WaiverAcknowledge waiver={read(true)} ticked={new Set()} onTick={() => undefined} />)
    const box = screen.getByRole('checkbox')
    expect(box).toBeChecked()
    expect(box).toBeDisabled()
  })
})
