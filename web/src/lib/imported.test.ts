import { describe, expect, it } from 'vitest'
import { designWords, importedDesign, importedRelease } from './imported'

const m20 = { entry: 'fabricate', name: 'potroller-supervisor', revision: 'M.20', tool: 'KiCad Pcbnew 10.0.8', dir: 'hardware/potroller-supervisor/release/revA' }

describe('a project started from fabrication files, in words', () => {
  it('names the design as its Gerbers do', () => {
    expect(designWords(m20)).toBe('revision M.20 of potroller-supervisor, made in KiCad Pcbnew 10.0.8')
    expect(designWords({ entry: 'fabricate' })).toBe('')
  })
  it('the Design tab says there is no design in trace, and where the files and the order are', () => {
    const said = importedDesign(m20)
    expect(said).toMatch(/^This board was designed outside trace and started from its fabrication files \(revision M\.20 of potroller-supervisor, made in KiCad Pcbnew 10\.0\.8\)\./)
    expect(said).toContain('runs no rule checks on it')
    expect(said).not.toMatch(/Capture|Architect\b/)
    expect(importedDesign({ entry: 'bringup' })).toMatch(/^This board was designed outside trace and started from its fabrication files\. /)
  })
  it('Build says the package is the imported one', () => {
    expect(importedRelease(m20)).toBe('No release made in trace: the package is the imported one, revision M.20 of potroller-supervisor, made in KiCad Pcbnew 10.0.8, kept under hardware/potroller-supervisor/release/revA. Open it from Files.')
  })
})
