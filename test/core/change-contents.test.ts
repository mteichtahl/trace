/**
 * What a change holds, said in its title and summary (src/core/change-contents.ts): test-esp32 log #144 (a change
 * titled "the docs specialist's record" carried the whole case design) and #133 (a docs change's summary did not say it
 * added an intent statement).
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { betterTitle, changeTitle, contentBullets, designAreas, recordChanges, recordTitle } from '../../src/core/change-contents.js'

const DOCS = 'trace: the docs specialist\'s record (job-mw3ashi6-e8b5d222)'
const IMPL = 'trace: the impl specialist\'s record (job-mw3awisf-29f0f73e)\n\nWhat its tools wrote to the project\'s record.'
const CASE = 'Case: printed two-part shell, MJF PA12-HP at JLC3DP, board on M2 screws\n\nper answer aq2a9a1fe5888743'

describe('a change\'s title', () => {
  it('knows a record title, as committed and as opened with more commits', () => {
    expect(recordTitle(DOCS)).toBe(true)
    expect(recordTitle(`${DOCS} (+9 more)`)).toBe(true)
    expect(recordTitle('Case: printed two-part shell')).toBe(false)
    expect(recordTitle('trace: the docs specialist\'s record of the case')).toBe(false)
  })

  it('is named by the first commit that is not a record', () => {
    expect(changeTitle([DOCS, IMPL, CASE])).toBe('Case: printed two-part shell, MJF PA12-HP at JLC3DP, board on M2 screws (+2 more)')
    expect(changeTitle([DOCS])).toBe(DOCS)
    expect(changeTitle([DOCS, IMPL])).toBe(`${DOCS} (+1 more)`)
    expect(changeTitle(['Fix the divider.', 'tests'])).toBe('Fix the divider (+1 more)')
    expect(changeTitle([])).toBe('')
  })

  it('shows a record change that came to hold work by that work; any other title as it is', () => {
    expect(betterTitle(`${DOCS}`, [DOCS, IMPL, CASE])).toMatch(/^Case: printed two-part shell/)
    expect(betterTitle(DOCS, [DOCS, IMPL])).toBe(DOCS)
    expect(betterTitle('Case design, reviewed', [DOCS, CASE])).toBe('Case design, reviewed')
  })
})

describe('what a change holds', () => {
  const PR20 = ['.trace/project.db', 'hardware/desk-gadget/desk-gadget.kicad_pcb', 'hardware/desk-gadget/oled.kicad_sch', 'mechanical/case.json', 'mechanical/case.py', 'mechanical/out/case-base.stl', 'docs/user-guide.md']

  it('finds the design files, by area', () => {
    expect(designAreas(PR20)).toEqual([
      { area: 'hardware', files: ['hardware/desk-gadget/desk-gadget.kicad_pcb', 'hardware/desk-gadget/oled.kicad_sch'] },
      { area: 'mechanical', files: ['mechanical/case.json', 'mechanical/case.py', 'mechanical/out/case-base.stl'] },
    ])
    expect(designAreas(['board.kicad_pcb', 'firmware/src/main.c', 'README.md']).map((a) => a.area)).toEqual(['hardware', 'firmware'])
    expect(designAreas(['.trace/project.db', 'docs/a.md'])).toEqual([])
  })

  it('reads the intent statements and requirements a change adds or changes', () => {
    const design = new DatabaseSync(':memory:')
    const head = new DatabaseSync(':memory:')
    for (const db of [design, head]) {
      db.exec('CREATE TABLE intent_statements (id TEXT PRIMARY KEY, topic TEXT, kind TEXT, text TEXT, status TEXT, updated REAL)')
      db.exec('CREATE TABLE requirements (id TEXT PRIMARY KEY, text TEXT, acceptance TEXT, status TEXT, updated REAL)')
      db.prepare("INSERT INTO intent_statements VALUES ('INT-power', 'power', 'statement', 'Runs from USB-C', 'proposed', 1)").run()
      db.prepare("INSERT INTO requirements VALUES ('REQ-1', 'Boots in 2 s', '< 2 s', 'accepted', 1)").run()
    }
    head.prepare("INSERT INTO intent_statements VALUES ('INT-wifiprov', 'interfaces', 'statement', 'Setup access point reopens after 60 s without the saved network', 'proposed', 2)").run()
    head.prepare("UPDATE requirements SET text='Boots in 3 s', updated=2 WHERE id='REQ-1'").run()
    const r = recordChanges(design, head)
    expect(r.intent).toEqual({ added: [{ id: 'INT-wifiprov', text: 'Setup access point reopens after 60 s without the saved network', status: 'proposed' }], changed: [] })
    expect(r.requirements.changed.map((x) => x.id)).toEqual(['REQ-1'])
    expect(r.requirements.added).toEqual([])
    // a database with neither table adds nothing
    expect(recordChanges(new DatabaseSync(':memory:'), new DatabaseSync(':memory:'))).toEqual({ intent: { added: [], changed: [] }, requirements: { added: [], changed: [] } })

    expect(contentBullets({ paths: PR20, record: r })).toEqual([
      'Changes the design: 2 hardware files and 3 mechanical files',
      'Adds intent statement INT-wifiprov (proposed): "Setup access point reopens after 60 s without the saved network"',
      'Changes requirement REQ-1 (accepted): "Boots in 3 s"',
    ])
  })

  it('says nothing for a record that adds nothing to the intent or the requirements', () => {
    expect(contentBullets({ paths: ['.trace/project.db'], record: null })).toEqual([])
    expect(contentBullets({ paths: ['docs/guide.md'], record: { intent: { added: [], changed: [] }, requirements: { added: [], changed: [] } } })).toEqual([])
  })
})
