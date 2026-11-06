/**
 * The release report's interference, parts list and open waivers sections (src/tools/verify/release.ts), and the open
 * items they add: a report of coverage alone said "Open items: None" while 17 waivers stood (test-esp32 #207).
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { type JourneyRecord, type WaiverRow, applyJourneySchema, startJourney } from '../../src/core/journey.js'
import { applyProjectSchema } from '../../src/core/store.js'
import type { Matrix } from '../../src/tools/verify/matrix.js'
import { reportMarkdown } from '../../src/tools/verify/matrix.js'
import { releaseReportRun } from '../../src/api/actions-skills.js'
import { releaseFacts, releaseMarkdown, releaseOpenItems } from '../../src/tools/verify/release.js'

function projectDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  applyProjectSchema(db)
  return db
}

const run = (db: DatabaseSync, id: string, kind: string, o: { status?: string; summary?: string; subject?: string; started: number; result?: unknown }): void => {
  db.prepare('INSERT INTO runs (id, kind, subject, started, finished, status, summary, result) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, kind, o.subject ?? null, o.started, o.started + 1, o.status ?? 'pass', o.summary ?? '', JSON.stringify(o.result ?? {}))
}

function record(quantity = 10): JourneyRecord {
  const db = new DatabaseSync(':memory:')
  applyJourneySchema(db)
  return startJourney(db, { template: 'board', by: 'a@example.com', name: 'x', build: { quantity } })
}

const waiver = (id: string, kind: WaiverRow['targetKind'], target: string, severity: WaiverRow['severity'], o: Partial<WaiverRow> = {}): WaiverRow => ({
  id, stage: 'signoff', gate: null, targetKind: kind, target, reason: 'r', risk: 'k', severity, caughtWhere: 'On the bench: B1', scope: 'this revision only',
  by: 'a@example.com', at: 1, acknowledgedBy: null, acknowledgedAt: null, closedAt: null, ...o,
})

const emptyMatrix: Matrix = {
  summary: { requirements: 0, set_aside: 0, tests: 0, tests_by_status: {}, verified: 0, coverage_gap: 0, failing: 0, partial: 0, untested: 0, no_test: 0, waived: 0 },
  requirements: [], orphan_tests: [], points: [], unplanned_hits: [], evidence_runs: [], code: null, code_runs: [],
}

describe('the release report', () => {
  it('lists interference, the parts list and every standing waiver', () => {
    const db = projectDb()
    run(db, 'pre-old', 'emc.precheck', { started: 1, result: { counts: { error: 9, warn: 0, info: 0 } } })
    run(db, 'pre-new', 'emc.precheck', { status: 'fail', subject: 'hw/board.kicad_pcb', started: 5, result: { counts: { error: 1, warn: 1, info: 1 } } })
    db.prepare('INSERT INTO artifacts VALUES (?,?,?,?)').run('pre-new', 'findings.json', 'application/json', new TextEncoder().encode(JSON.stringify([
      { rule: 'return_path', severity: 'error', net: '/SCK', message: 'SCK crosses a plane split' },
      { rule: 'edge_proximity', severity: 'warn', net: '/USB_D+', message: 'USB_D+ runs 0.4 mm from the edge' },
      { rule: 'decoupling', severity: 'info', net: null, message: 'a note' },
    ])))
    run(db, 'spec1', 'emc.spectrum', { subject: '8 MHz signal', started: 6, summary: 'worst margin 12 dB at 40 MHz' })
    run(db, 'bom1', 'parts.bom_check', { status: 'fail', started: 7, result: { boards: 10, total: 123.5, currency: 'USD', blocking: 1, unpriced: 0 } })
    const line = db.prepare('INSERT INTO parts_list_lines (run_id, line, mpn, order_code, refs, per_board, need, status, flags, stock, unit_price, line_total, currency) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    line.run('bom1', 1, 'ESP32-C3-MINI-1', 'C2838502', 'U1', 1, 10, 'ok', '[]', 5000, 2.1, 21, 'USD')
    line.run('bom1', 2, 'TPS62A01', null, 'U2', 1, 10, 'short', '["end-of-life"]', 4, 0.5, 5, 'USD')

    const rec = record(10)
    rec.waivers.push(
      waiver('w-req', 'requirement', 'REQ-1', 'degraded'),
      waiver('w-emc', 'criterion', 'signoff.emc', 'failure', { caughtWhere: 'At a later stage: the lab test' }),
      waiver('w-drc', 'finding', 'drc:clearance:J1', 'cosmetic', { caughtWhere: null }),
      waiver('w-closed', 'requirement', 'REQ-2', 'safety', { closedAt: 2 }),
    )
    const f = releaseFacts(db, rec, 'checkout')
    expect(f.interference.precheck?.id).toBe('pre-new')
    expect(f.interference.criterion?.status).toBe('waived')
    expect(f.parts.lines).toHaveLength(2)
    expect(f.waivers.map((w) => w.id)).toEqual(['w-req', 'w-emc', 'w-drc'])

    const md = releaseMarkdown(f).join('\n')
    expect(md).toMatch(/## Interference \(EMC\)/)
    expect(md).toMatch(/pre-compliance estimates/)
    expect(md).toMatch(/waived \(w-emc\)/)
    expect(md).toMatch(/\| error \| return_path \| \/SCK \| SCK crosses a plane split \|/)
    expect(md).not.toMatch(/a note/)
    expect(md).toMatch(/\| emc.spectrum \| 8 MHz signal \| pass \| worst margin 12 dB at 40 MHz \| spec1 \|/)
    expect(md).toMatch(/## Parts list/)
    expect(md).toMatch(/Cost for 10 boards: 123.5 USD, 12.35 USD a board/)
    expect(md).toMatch(/1 line out of stock, short or not found/)
    expect(md).toMatch(/\| 2 \| TPS62A01 \| U2 \| 10 \| 4 \| short, end-of-life \|/)
    expect(md).toMatch(/Build quantity: 10 boards, as checked/)
    expect(md).toMatch(/## Open waivers/)
    expect(md).toMatch(/3 waivers stand, most severe first/)
    // most severe first, each with where it is caught
    const rows = md.split('\n').filter((l) => /^\| w-/.test(l))
    expect(rows.map((l) => l.split('|')[1]?.trim())).toEqual(['w-emc', 'w-req', 'w-drc'])
    expect(rows[0]).toMatch(/the criterion “The radio interference prechecks are run and within the target” \| failure \| At a later stage: the lab test/)
    expect(rows[2]).toMatch(/\| cosmetic \| nowhere \|/)
    expect(md).not.toMatch(/w-closed/)

    // the interference criterion is waived, so its precheck errors are not open; the short line and the waivers are
    const open = releaseOpenItems(f)
    expect(open.some((x) => /interference/.test(x))).toBe(false)
    expect(open).toContain('1 parts list line out of stock, short or not found (run bom1).')
    expect(open).toContain('3 waivers stand: see Open waivers.')

    const report = reportMarkdown(emptyMatrix, [], { title: 'Release report', generated: 'now' }, f)
    const items = report.slice(report.indexOf('## Open items'))
    expect(items).not.toMatch(/None\./)
    expect(items).toMatch(/3 waivers stand/)
  })

  it('says "None" only when nothing is open', () => {
    const db = projectDb()
    run(db, 'pre', 'emc.precheck', { started: 1, result: { counts: { error: 0, warn: 0, info: 0 } } })
    run(db, 'bom', 'parts.bom_check', { started: 2, result: { boards: 10, total: 50, currency: 'USD', blocking: 0, unpriced: 0 } })
    const rec = record(10)
    for (const c of rec.criteria) if (c.id === 'signoff.emc' || c.id === 'signoff.bom') c.status = 'met'
    const f = releaseFacts(db, rec, 'live')
    expect(releaseOpenItems(f)).toEqual([])
    const report = reportMarkdown(emptyMatrix, [], { title: 'Release report', generated: 'now' }, f)
    expect(report.slice(report.indexOf('## Open items'))).toMatch(/None\./)
    expect(report).toMatch(/## Open waivers\n\nNone\./)
  })

  it('names what is missing, and never says nothing is open when the waivers cannot be read', () => {
    const db = projectDb()
    run(db, 'bom', 'parts.bom_check', { started: 2, result: { boards: 1, total: 5, currency: 'USD', blocking: 0, unpriced: 0 } })
    const f = releaseFacts(db, null, null)
    const open = releaseOpenItems(f)
    expect(open).toContain('No interference precheck is in the record.')
    expect(open).toContain('The waivers could not be read: the journey record was not in reach.')
    expect(releaseMarkdown(f).join('\n')).toMatch(/journey record was not in reach/)
    // the build quantity differs from the boards checked
    const g = releaseFacts(db, record(25), 'live')
    expect(releaseOpenItems(g)).toContain('The parts list was checked for 1 boards, not the build quantity of 25.')
    expect(releaseMarkdown(g).join('\n')).toMatch(/The check was for 1 boards, so its cost and stock are not for the build/)
  })
})

describe('the release review\'s evidence', () => {
  it('is the newest verify.report run with its report.md, not a file the repository does not have', () => {
    const db = projectDb()
    expect(releaseReportRun(db)).toBeNull()
    run(db, 'rep-old', 'verify.report', { started: 1 })
    run(db, 'rep-new', 'verify.report', { started: 3, status: 'fail' })
    run(db, 'rep-running', 'verify.report', { started: 4, status: 'running' })
    run(db, 'rep-bare', 'verify.report', { started: 5 })
    for (const id of ['rep-old', 'rep-new', 'rep-running']) db.prepare('INSERT INTO artifacts VALUES (?,?,?,?)').run(id, 'report.md', 'text/markdown', new TextEncoder().encode('# Release report'))
    // the newest that finished and has its report: a running one and one without report.md are passed over
    expect(releaseReportRun(db)).toEqual({ id: 'rep-new' })
  })
})
