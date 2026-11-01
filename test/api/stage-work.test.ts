/**
 * What each stage's signature starts (STAGE_WORK, src/api/actions-journey.ts): Architect's options, and Capture's
 * schematic with its review checks, so a project does not sit in a stage with nothing working on it.
 */
import { describe, expect, it } from 'vitest'
import { STAGE_WORK } from '../../src/api/actions-journey.js'

describe('STAGE_WORK', () => {
  it('Capture draws the schematic and runs each check the schematic review gate needs, leaving people their calls', () => {
    const c = STAGE_WORK.capture
    expect(c?.agent).toBe('impl')
    for (const needed of ['kicad.erc', 'capture.erc', 'parts.bom_check', 'capture.stock', 'capture.datasheets', 'design.pins', 'design.sheets', 'journey.ask']) expect(c?.request).toContain(needed)
    expect(c?.request).toMatch(/no \.kicad_pcb/)
    expect(c?.request).toMatch(/Do not agree it yourself/)
  })
})
