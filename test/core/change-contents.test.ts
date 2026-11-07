/**
 * What a change holds, said in its title and summary (src/core/change-contents.ts): test-esp32 log #144 (a change
 * titled "the docs specialist's record" carried the whole case design) and #133 (a docs change's summary did not say it
 * added an intent statement).
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { betterTitle, changeTitle, contentBullets, contentPhrase, designAreas, kindName, mergeTitle, oneRowTitle, plumbingTitle, recordChanges, recordKind, recordRequirementIds, recordTitle, type RecordChanges } from '../../src/core/change-contents.js'

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
    // only records: the record's name, never its job's id (log #14, #59)
    expect(changeTitle([DOCS])).toBe('The docs specialist\'s record')
    expect(changeTitle([DOCS, IMPL])).toBe('The docs specialist\'s record')
    expect(changeTitle(['Fix the divider.', 'tests'])).toBe('Fix the divider (+1 more)')
    expect(changeTitle([])).toBe('')
  })

  it('shows a record change that came to hold work by that work; any other title as it is', () => {
    expect(betterTitle(`${DOCS}`, [DOCS, IMPL, CASE])).toMatch(/^Case: printed two-part shell/)
    expect(betterTitle(DOCS, [DOCS, IMPL])).toBe('The docs specialist\'s record')
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
    expect(recordChanges(new DatabaseSync(':memory:'), new DatabaseSync(':memory:'))).toEqual({ intent: { added: [], changed: [] }, requirements: { added: [], changed: [] }, tables: [], options: null, tested: { requirements: [], tests: [] } })

    expect(contentBullets({ paths: PR20, record: r })).toEqual([
      'Changes the design: 2 hardware files and 3 mechanical files',
      'Changes 1 other file: docs/user-guide.md',
      'Adds intent statement INT-wifiprov (proposed): "Setup access point reopens after 60 s without the saved network"',
      'Changes requirement REQ-1 (accepted): "Boots in 3 s"',
    ])
  })

  it('says nothing for a record that adds nothing to the intent or the requirements', () => {
    expect(contentBullets({ paths: ['.trace/project.db'], record: null })).toEqual([])
    expect(contentBullets({ paths: ['.trace/project.db'], record: { intent: { added: [], changed: [] }, requirements: { added: [], changed: [] } } })).toEqual([])
    expect(contentBullets({ paths: ['docs/guide.md', '.trace/project.db'], record: null })).toEqual(['Changes 1 other file: docs/guide.md'])
  })
})

// test-esp32 #87 (test-esp32-e2e #2): the fix to one intent statement was titled "trace: the verify specialist's record
// (job-mw2z45d1-28a54551)", then "The verification specialist's record: 1 intent statement"
describe('a record that holds one intent statement or requirement', () => {
  const WIFI = { id: 'INT-8dd269', text: "(4) Wi-Fi 2.4 GHz 802.11 b/g/n on the module's PCB antenna, NTP in, HTTP on port 80.", status: 'proposed' }
  const none = { added: [], changed: [] }
  const record = (o: Partial<RecordChanges>): RecordChanges => ({ intent: none, requirements: none, tables: [], options: null, ...o })
  const RECORD = 'trace: the verify specialist\'s record (job-mw2z45d1-28a54551)'

  it('is titled by what it does to it', () => {
    const one = oneRowTitle({ paths: ['.trace/project.db'], record: record({ intent: { added: [], changed: [WIFI] } }) })
    expect(one).toBe("Changes intent statement INT-8dd269: (4) Wi-Fi 2.4 GHz 802.11 b/g/n on the module's PCB antenna, NTP in, HTTP on port 80.")
    expect(betterTitle(RECORD, [RECORD], { holds: '1 intent statement', one })).toBe(one)
    expect(oneRowTitle({ paths: ['.trace/project.db'], record: record({ requirements: { added: [{ id: 'REQ-1', text: 'Boots in 2 s', status: 'proposed' }], changed: [] }, tables: [{ table: 'requirement_intent', one: 'l', many: 'ls', added: 1, changed: 0, statuses: {} }] }) }))
      .toBe('Adds requirement REQ-1: Boots in 2 s')
  })

  it('is named as before when it holds more, or other files', () => {
    expect(oneRowTitle({ paths: ['.trace/project.db'], record: record({ intent: { added: [WIFI], changed: [WIFI] } }) })).toBeNull()
    expect(oneRowTitle({ paths: ['.trace/project.db'], record: record({ intent: { added: [], changed: [WIFI] }, tables: [{ table: 'test_items', one: 'test', many: 'tests', added: 2, changed: 0, statuses: {} }] }) })).toBeNull()
    expect(oneRowTitle({ paths: ['.trace/project.db', 'docs/design/high-level-design.md'], record: record({ intent: { added: [], changed: [WIFI] } }) })).toBeNull()
    expect(oneRowTitle({ paths: ['.trace/project.db'], record: null })).toBeNull()
    expect(betterTitle(RECORD, [RECORD], { holds: '2 tests', one: null })).toBe("The verification specialist's record: 2 tests")
  })
})

// test-esp32 log #154 (titled by a merge commit), #14 and #59 (titled, and summarised, by the record's job id), #37
// (three architecture options summarised as what they share), #27 (22 requirements added, "none named")
describe('a change that holds only a record, or was brought up to date by a merge', () => {
  const MERGE = 'Merge claude/handoff-hoac40d08bf1664e into claude/handoff-hobe8233b1531243 (trace: the project database merged)'
  const EMC = 'trace: the emc specialist\'s record (job-mw4emc01-0a1b2c3d)'
  const VERIFY = 'trace: the verify specialist\'s record (job-mw2jvo2g-171210c3)'

  it('knows a merge commit, git\'s and trace\'s, and never titles a change by one', () => {
    for (const m of [MERGE, `${MERGE} (+2 more)`, 'Merge branch \'main\' into claude/x', 'Merge pull request #12 from mteichtahl/claude/x', 'Merge remote-tracking branch \'origin/main\' into claude/x']) {
      expect(mergeTitle(m)).toBe(true)
      expect(plumbingTitle(m)).toBe(true)
    }
    expect(mergeTitle('Merge the two power rails into one')).toBe(false)
    expect(plumbingTitle('Layout: board placed and routed')).toBe(false)
    // the record's work under a merge: named by the work
    expect(changeTitle([MERGE, EMC, 'EMC: ferrite on the USB shield, 2 findings'])).toBe('EMC: ferrite on the USB shield, 2 findings (+2 more)')
    // only a merge and a record: the record's name, not the merge's branches
    expect(changeTitle([MERGE, EMC])).toBe('The EMC specialist\'s record')
    expect(betterTitle(`${MERGE} (+2 more)`, [MERGE, EMC, MERGE], { holds: '3 board checks' })).toBe('The EMC specialist\'s record: 3 board checks')
    // no record subject either: the specialist the change is from
    expect(betterTitle(MERGE, [MERGE], { kind: 'thermal' })).toBe('The thermal specialist\'s record')
    expect(recordKind(VERIFY)).toBe('verify')
  })

  const db = (): DatabaseSync => {
    const d = new DatabaseSync(':memory:')
    d.exec(`CREATE TABLE requirements (id TEXT PRIMARY KEY, text TEXT, acceptance TEXT, status TEXT, updated REAL);
      CREATE TABLE test_items (id TEXT PRIMARY KEY, title TEXT, method TEXT, status TEXT, updated REAL);
      CREATE TABLE test_results (run_id TEXT PRIMARY KEY, test_id TEXT, status TEXT, reason TEXT, at REAL);
      CREATE TABLE arch_options (id TEXT PRIMARY KEY, name TEXT, summary TEXT, recommended INTEGER, why TEXT, status TEXT, updated REAL);
      CREATE TABLE arch_blocks (option TEXT, id TEXT, name TEXT, parts TEXT, status TEXT, updated REAL, PRIMARY KEY (option, id));
      CREATE TABLE runs (id TEXT PRIMARY KEY, kind TEXT)`)
    return d
  }

  it('a verify record is named and summarised by its results, by table, never by its job', () => {
    const design = db()
    const head = db()
    for (let i = 1; i <= 39; i++) head.prepare('INSERT INTO test_items VALUES (?, ?, ?, ?, 1)').run(`TST-${i}`, `test ${i}`, 'inspection', i <= 17 ? 'pass' : 'planned')
    for (let i = 1; i <= 17; i++) head.prepare('INSERT INTO test_results VALUES (?, ?, \'pass\', \'ok\', 1)').run(`run-${i}`, `TST-${i}`)
    // tool runs are bookkeeping, not what the change holds
    head.prepare('INSERT INTO runs VALUES (\'run-1\', \'verify.run\')').run()
    const record = recordChanges(design, head)
    expect(contentBullets({ paths: ['.trace/project.db'], record })).toEqual(['Adds 39 tests (22 planned, 17 passed)', 'Adds 17 test results (17 passed)'])
    const holds = contentPhrase({ paths: ['.trace/project.db'], record })
    expect(holds).toBe('39 tests and 17 test results')
    expect(betterTitle(VERIFY, [VERIFY], { holds })).toBe('The verification specialist\'s record: 39 tests and 17 test results')
  })

  it('three architecture options are said with what sets them apart and which is recommended', () => {
    const design = db()
    const head = db()
    const opt = head.prepare('INSERT INTO arch_options VALUES (?, ?, \'\', ?, ?, \'proposed\', 1)')
    opt.run('A', 'Linear regulator', 1, 'fewest parts, and 150 mA is well inside its limit')
    opt.run('B', 'Buck converter', 0, null)
    opt.run('C', 'Low-dropout regulator', 0, null)
    const block = head.prepare('INSERT INTO arch_blocks VALUES (?, ?, ?, ?, \'proposed\', 1)')
    for (const [o, mpn] of [['A', 'AMS1117-3.3'], ['B', 'TLV62569'], ['C', 'AP2112K-3.3']] as const) {
      block.run(o, 'mcu', 'Microcontroller', JSON.stringify([{ mpn: 'ESP32-C3-MINI-1' }]))
      block.run(o, 'supply', '3.3 V supply', JSON.stringify([{ mpn }]))
    }
    block.run('A', 'reset', 'Auto-reset', JSON.stringify([{ mpn: 'MMBT3904' }, { mpn: 'MMBT3904' }]))
    const record = recordChanges(design, head)
    const bullets = contentBullets({ paths: ['.trace/project.db'], record })
    expect(bullets.slice(0, 3)).toEqual([
      'Adds 3 architecture options: A Linear regulator, B Buck converter and C Low-dropout regulator',
      'They differ in Auto-reset (A: MMBT3904 + MMBT3904, B: none, C: none) and 3.3 V supply (A: AMS1117-3.3, B: TLV62569, C: AP2112K-3.3)',
      'Recommends A: fewest parts, and 150 mA is well inside its limit',
    ])
    // what they share (the microcontroller) is not a difference
    expect(bullets.join('\n')).not.toMatch(/Microcontroller \(/)
    expect(contentPhrase({ paths: [], record })).toBe('3 architecture options')
  })

  // test-esp32-run2 R30: the row was labelled "ESP32-C3 Wi-Fi module" (option A's name) over C3, S3 and WROOM, and the
  // recommendation quoted the parts check by its id
  it('labels a block by what it is in every option, and says the runs its words cite', () => {
    const design = db()
    const head = db()
    const opt = head.prepare('INSERT INTO arch_options VALUES (?, ?, \'\', ?, ?, \'proposed\', 1)')
    opt.run('A', 'ESP32-C3-MINI-1-H4X with native USB', 1, 'Lowest order estimate of the three (84ac569329e8472d: USD 60.54-89.77 vs 75.05-104.28 for B)')
    opt.run('B', 'ESP32-S3-MINI-1-N8 with native USB', 0, null)
    opt.run('C', 'ESP32-WROOM-32E-N4 with CH340C', 0, null)
    head.prepare('INSERT INTO runs VALUES (\'84ac569329e8472d\', \'parts.bom_check\')').run()
    const block = head.prepare('INSERT INTO arch_blocks VALUES (?, ?, ?, ?, \'proposed\', 1)')
    for (const [o, name, mpn] of [['A', 'ESP32-C3 Wi-Fi module', 'ESP32-C3-MINI-1-H4X'], ['B', 'ESP32-S3 Wi-Fi module', 'ESP32-S3-MINI-1-N8'], ['C', 'ESP32 Wi-Fi module', 'ESP32-WROOM-32E-N4']] as const) {
      block.run(o, 'mcu', name, JSON.stringify([{ mpn }]))
    }
    const bullets = contentBullets({ paths: ['.trace/project.db'], record: recordChanges(design, head) })
    expect(bullets[1]).toBe('They differ in Wi-Fi module (A: ESP32-C3-MINI-1-H4X, B: ESP32-S3-MINI-1-N8, C: ESP32-WROOM-32E-N4)')
    expect(bullets[2]).toBe('Recommends A: Lowest order estimate of the three (the parts check: USD 60.54-89.77 vs 75.05-104.28 for B)')
    expect(kindName(['USB-C input', 'USB-C power'])).toBe('USB-C')
    expect(kindName(['3.3 V supply', '3.3 V supply'])).toBe('3.3 V supply')
    expect(kindName(['Bridge', 'Radio'])).toBe('')
  })

  it('the requirements a record adds are ones the change names', () => {
    const head = db()
    for (let i = 1; i <= 22; i++) head.prepare('INSERT INTO requirements VALUES (?, \'x\', null, \'proposed\', 1)').run(`REQ-${String(i).padStart(3, '0')}`)
    const record = recordChanges(db(), head)
    expect(recordRequirementIds(record)).toHaveLength(22)
    expect(recordRequirementIds(null)).toEqual([])
    expect(contentPhrase({ paths: [], record })).toBe('22 requirements')
  })

  it('a record change that re-runs tests covers the requirements those tests name (test-esp32 #200)', () => {
    const withReqs = (): DatabaseSync => {
      const d = db()
      d.exec('ALTER TABLE test_items ADD COLUMN requirements TEXT')
      for (const id of ['REQ-f3f79d', 'REQ-4ce9e8', 'REQ-d16b43', 'REQ-other']) d.prepare('INSERT INTO requirements VALUES (?, \'x\', null, \'accepted\', 1)').run(id)
      const t = d.prepare('INSERT INTO test_items (id, title, method, status, updated, requirements) VALUES (?, ?, \'inspection\', \'pass\', 1, ?)')
      t.run('TST-029', 'Cost per board', '["REQ-f3f79d"]')
      t.run('TST-030', 'Cost in all', '["REQ-4ce9e8"]')
      t.run('TST-020', 'Order cost', '["REQ-d16b43", "REQ-gone"]')
      t.run('TST-001', 'Boots', '["REQ-other"]')
      return d
    }
    const design = withReqs()
    const head = withReqs()
    // the cost tests re-run: new results for TST-029 and TST-030, and TST-020's row changed (its last run)
    head.prepare('INSERT INTO test_results VALUES (\'run-29\', \'TST-029\', \'pass\', \'ok\', 2)').run()
    head.prepare('INSERT INTO test_results VALUES (\'run-30\', \'TST-030\', \'pass\', \'ok\', 2)').run()
    head.prepare('UPDATE test_items SET updated=2 WHERE id=\'TST-020\'').run()
    const record = recordChanges(design, head)
    expect(record.tested).toEqual({ requirements: ['REQ-d16b43', 'REQ-f3f79d', 'REQ-4ce9e8'], tests: ['TST-020', 'TST-029', 'TST-030'] })
    // only the requirements the record has, and none for tests it does not touch
    expect(recordRequirementIds(record)).toEqual(['REQ-d16b43', 'REQ-f3f79d', 'REQ-4ce9e8'])
    // an older record change read before this (no tested field) still reads
    expect(recordRequirementIds({ intent: { added: [], changed: [] }, requirements: { added: [], changed: [] } })).toEqual([])
  })
})
