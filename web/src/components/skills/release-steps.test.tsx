import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { SKILL_VIEWS } from '@/mock/fixtures-s1'
import { ReleaseStep, type ReleaseDraft, releaseChecks } from './release-steps'
import { boardEmpty } from './step-picture'

const view = SKILL_VIEWS['release-review']!.release!

function step(id: string, start: ReleaseDraft = {}) {
  let d = start
  const r = render(<ReleaseStep step={id} view={view} draft={d} setDraft={(fn) => { d = fn(d) }} loading={false} />)
  return { ...r, draft: () => d }
}

describe('Release review steps', () => {
  it('EMC shows the precheck, labelled an estimate, and the waiver', () => {
    step('emc')
    expect(screen.getByText(/Pre-compliance estimates/)).toBeInTheDocument()
    expect(screen.getByText(/crosses a split in the ground plane/)).toBeInTheDocument()
    expect(screen.getByText(/radiated scan is booked/)).toBeInTheDocument()
  })

  it('the parts list shows cost, sellers and lifecycle, and says plainly where it has none', async () => {
    const s = step('bom')
    expect(screen.getByText('USD 4.72')).toBeInTheDocument()
    expect(screen.getByText('Single source')).toBeInTheDocument()
    expect(screen.getByText('Not active')).toBeInTheDocument()
    expect(screen.getByText(/has no sellers or lifecycle for 1 of 4 parts/)).toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('checkbox', { name: 'Acknowledged' })[0]!)
    expect(s.draft().parts_ack).toEqual(['ESP32-C3-MINI-1-N4'])
  })

  it('fabrication shows the DRC result and the parts placed by hand', () => {
    step('fab')
    expect(screen.getByText('No errors')).toBeInTheDocument()
    expect(screen.getByText('J1')).toBeInTheDocument()
  })

  it('the first revision says there is nothing to compare', () => {
    step('changes')
    expect(screen.getByText('Revision A is the first revision: nothing to compare.')).toBeInTheDocument()
  })

  it('each area is acknowledged on its own step', async () => {
    const s = step('emc', { acknowledged: ['coverage'] })
    await userEvent.click(screen.getByRole('button', { name: /Acknowledge/ }))
    expect(s.draft().acknowledged).toEqual(['coverage', 'emc'])
  })

  it('Decide has a note', () => {
    const s = step('decide')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ship it' } })
    expect(s.draft().note).toBe('Ship it')
    expect(screen.queryByRole('button', { name: /Acknowledge/ })).toBeNull()
  })

  it('the bar counts the draft at once', () => {
    expect(releaseChecks(view, { acknowledged: ['coverage', 'emc', 'bom', 'fab'] }).areas).toBe('not_met')
    expect(releaseChecks(view, { acknowledged: ['coverage', 'emc', 'bom', 'fab', 'changes'] }).areas).toBe('met')
    expect(releaseChecks(view, { choice: { option: 'return:layout' } }).decision).toBe('not_met')
    expect(releaseChecks(view, { choice: { option: 'return:layout' }, note: 'Move /SCK in.' }).decision).toBe('met')
    expect(releaseChecks(view, { parts_ack: ['ESP32-C3-MINI-1-N4'] }).single).toBe('not_met')
    expect(releaseChecks(view, { parts_ack: ['ESP32-C3-MINI-1-N4', 'AP2112K-3.3TRG1'] }).single).toBeUndefined()
  })
})

describe('the board picture with no drawing', () => {
  it('says the board exists when it does', () => {
    expect(boardEmpty({ file: 'hw/board.kicad_pcb' })).toMatch(/^The board exists, but no drawing/)
    expect(boardEmpty(undefined)).toMatch(/^No board yet/)
  })
})
