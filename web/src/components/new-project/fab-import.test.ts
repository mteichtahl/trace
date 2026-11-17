import { describe, expect, it } from 'vitest'
import { mockFabCheck } from '@/mock/fab-import'
import type { NewProjectDraft } from '@/lib/types-s1'
import { boardWords, countWords, fabChecks, fileRefusal, guessFile, partsOf, partsWords, signedBefore, sourceWords } from './fab-import'
import { checks, recommendTemplate, stepOk, stepsFor } from './rules'

const OVERVIEW = 'The Potroller carrier hosts a Raspberry Pi CM5 and eight capability modules for a flight simulator cockpit. It runs from 12 to 24 V through a 30 A fuse and makes 5 V and 3.3 V rails. It talks USB, Ethernet, HDMI and I2C to each module through a header. It is 200 x 160 mm on standoffs in a rack enclosure. We build 5 boards for a prototype run, with a budget of 1500 USD.'
const ALL = new Set(['gerbers', 'bom', 'cpl'] as const)
const SOURCE = new Set(['source'] as const)

const d: NewProjectDraft = {
  name: 'Potroller carrier', description: '', icon: { glyph: 'board', colour: 'green' }, start: 'files', template: 'board',
  repository: { mode: 'new', owner: 'acme', name: 'potroller-carrier', branch: 'main' },
  advanced: { ownToken: false, memoryDays: 30, onboardingPr: true, applySettings: true }, people: [],
  build: { quantity: 5, later: { certify: false, produce: false, sustain: false }, fab: 'JLCPCB' },
  fab: { upload: 'u1', overview: OVERVIEW, built: false, files: { gerbers: { name: 'g.zip', bytes: 3 }, bom: { name: 'b.csv', bytes: 2 }, cpl: { name: 'c.csv', bytes: 1 } } },
}

describe('starting from fabrication files', () => {
  it('adds the Fabrication files step only when the project starts from them', () => {
    expect(stepsFor('idea').map((s) => s.id)).toEqual(['about', 'start', 'repository', 'people', 'build', 'review'])
    expect(stepsFor('files').map((s) => s.id)).toEqual(['about', 'start', 'files', 'repository', 'people', 'build', 'review'])
  })

  it('holds Continue until design files (or Gerbers) are given, the overview covers four topics and nothing blocks', () => {
    const ctx = (fab = mockFabCheck('u1', ALL, OVERVIEW)) => ({ taken: [], fab })
    expect(stepOk(d, 'files', ctx())).toBe(true)
    expect(checks(d, ctx()).filter((c) => c.step === 'files').map((c) => c.text)).toEqual(['Design files or Gerbers given (BOM and pick and place are optional)', 'Overview covers 6 of 6 topics', 'Files checked, nothing to fix'])
    // a check of another upload (an older draft's) does not count
    expect(stepOk(d, 'files', ctx(mockFabCheck('u0', ALL, OVERVIEW)))).toBe(false)
    // no design files or Gerbers: blocked. The BOM and pick and place alone are not a design.
    expect(stepOk({ ...d, fab: { ...d.fab!, files: { bom: d.fab!.files.bom } } }, 'files', ctx(mockFabCheck('u1', new Set(['bom']), OVERVIEW)))).toBe(false)
    // Gerbers alone go on, and so do design files alone: the BOM and pick and place are optional
    expect(stepOk({ ...d, fab: { ...d.fab!, files: { gerbers: d.fab!.files.gerbers } } }, 'files', ctx(mockFabCheck('u1', new Set(['gerbers']), OVERVIEW)))).toBe(true)
    expect(stepOk({ ...d, fab: { ...d.fab!, files: { source: { name: 'd.zip', bytes: 9 } } } }, 'files', ctx(mockFabCheck('u1', SOURCE, OVERVIEW)))).toBe(true)
    const thin = mockFabCheck('u1', ALL, 'A board.')
    expect(stepOk({ ...d, fab: { ...d.fab!, overview: 'A board.' } }, 'files', ctx(thin))).toBe(false)
    expect(fabChecks(d.fab, undefined).every((c) => c.id === 'fab-files' ? c.ok : !c.ok)).toBe(true)
    // an idea's project has no such checks
    expect(checks({ ...d, start: 'idea' }, { taken: [] }).some((c) => c.id.startsWith('fab-'))).toBe(false)
  })

  it('recommends the Board template, and takes only a template with a Fabricate stage', () => {
    expect(recommendTemplate('an FPGA board', 'files').template).toBe('board')
    expect(stepOk({ ...d, template: 'firmware' }, 'start', { taken: [] })).toBe(false)
    expect(stepOk({ ...d, template: 'mixed' }, 'start', { taken: [] })).toBe(true)
  })

  it('takes each file by its type and size, and knows a dropped file by its name', () => {
    expect(fileRefusal('gerbers', 'board.zip', 3_000_000)).toBeNull()
    expect(fileRefusal('gerbers', 'board.gtl', 300)).toMatch(/Zip the Gerber/)
    expect(fileRefusal('bom', 'bom.csv', 3 * 1024 * 1024)).toBe('It is 3.0 MB; the bill of materials is at most 2.0 MB.')
    expect(fileRefusal('cpl', 'cpl.csv', 0)).toBe('The file is empty.')
    expect(guessFile('potroller-carrier-cpl-jlc.csv')).toBe('cpl')
    expect(guessFile('potroller-carrier-bom-jlc.csv')).toBe('bom')
    expect(guessFile('top-pos.csv')).toBe('cpl')
    expect(guessFile('gerbers.zip')).toBe('gerbers')
    expect(guessFile('potroller-kicad-project.zip')).toBe('source')
    expect(guessFile('board-design.zip')).toBe('source')
    expect(guessFile('board-jlc-fab.zip')).toBe('gerbers')
    expect(guessFile('board.zip')).toBe('gerbers')
    expect(fileRefusal('source', 'board.kicad_pcb', 300)).toMatch(/Zip the schematic, layout and net list/)
    expect(fileRefusal('source', 'design.zip', 26 * 1024 * 1024)).toBe('It is 26.0 MB; the design files is at most 25.0 MB.')
    expect(guessFile('notes.csv')).toBeNull()
  })

  it('cuts a file into parts of at most 3 MB', () => {
    expect(partsOf(new Uint8Array(7), 3).map((p) => p.length)).toEqual([3, 3, 1])
    expect(partsOf(new Uint8Array(0)).length).toBe(1)
  })

  it('says what trace found in a line each, and which stages the import signs', () => {
    const c = mockFabCheck('u1', ALL, OVERVIEW, { quantity: 5 })
    expect(boardWords(c.summary)).toBe('A 10-layer board, 200 × 160 mm, 1.6 mm thick, ENIG, impedance controlled')
    expect(partsWords(c.summary)).toBe('133 BOM lines (774 parts), 774 placements: 675 top, 99 bottom')
    // no design source files were given with these fabrication files: one more warning
    expect(countWords(c)).toBe('3 warnings')
    const withSource = mockFabCheck('u1', new Set(['source', 'gerbers', 'bom', 'cpl']), OVERVIEW, { quantity: 5 })
    expect(countWords(withSource)).toBe('2 warnings')
    expect(sourceWords(withSource.summary)).toBe('1 schematic, 1 board layout, 0 net lists, from KiCad')
    // design files alone: what is left out is a note, nothing blocks
    const only = mockFabCheck('u1', SOURCE, OVERVIEW)
    expect(only.ok).toBe(true)
    expect(only.findings.filter((f) => f.id.endsWith('.missing')).map((f) => [f.id, f.severity])).toEqual([['gerbers.missing', 'note'], ['bom.missing', 'note'], ['cpl.missing', 'note']])
    expect(countWords({ findings: [] })).toBe('No problems found')
    expect(signedBefore('fabricate')).toEqual(['Define', 'Architect', 'Capture', 'Prove', 'Layout', 'Sign-off'])
    expect(signedBefore('bringup')).toEqual(['Define', 'Architect', 'Capture', 'Prove', 'Layout', 'Sign-off', 'Fabricate'])
  })
})
