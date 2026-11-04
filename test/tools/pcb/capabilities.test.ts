/**
 * JLCPCB's board capability table (src/tools/pcb/capabilities.ts) and the daily check over every table
 * (src/tools/mech/capsync.ts CAPABILITY_TABLES; docs/ontology-plan.md P3.5, P3.6): each figure puts its own numbers
 * back unchanged, a page that states one with other numbers proposes it, an unchanged page proposes nothing, an
 * unreadable one goes to a person, and one run writes one pull request and one issue for every table.
 */
import { describe, expect, it } from 'vitest'
import { BASE_BOARD_CAPABILITIES, BOARD_FIGURES, PCB, BOARD_CHECKED, type BoardCapabilities } from '../../../src/tools/pcb/capabilities.js'
import { numbersIn, withUpdates, type CapabilityUpdates, type Figure } from '../../../src/tools/mech/capabilities.js'
import { BOARD_TABLE, CAPABILITY_TABLES, MECH_TABLE, type Pages, combinedKind, planSync, pullRequest, renderUpdates, reviewIssue } from '../../../src/tools/mech/capsync.js'

const NONE: CapabilityUpdates = { checked: null, figures: {} }
const days = (n: number): string => new Date(Date.parse(`${BOARD_CHECKED}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/** A page stating every figure as stored, "label [earlier texts of the shape] text", with `edit` applied. */
function pages<C>(figures: readonly Figure<C>[], edit: (id: string, t: string) => string | null = (_, t) => t): Pages {
  const by: Record<string, string[]> = {}
  const labels = new Set<string>()
  for (const f of figures) {
    const t = edit(f.id, f.text)
    if (t === null) continue
    // figures that share a label (the 1 oz row: two-layer, then multilayer) are stated once, in order
    if (labels.has(f.label)) { (by[f.page] ??= []).push(t); continue }
    labels.add(f.label)
    // a figure that is a later text of its shape in its row (nth) gets that many others of the shape before it
    const before = Array.from({ length: f.nth ?? 0 }, () => f.text.replace(/\d+(?:\.\d+)?/g, '999')).join(' ')
    ;(by[f.page] ??= []).push(`${f.label} ${before ? `${before} ` : ''}${t}`)
  }
  return Object.fromEntries(Object.entries(by).map(([u, parts]) => [u, { text: parts.join(' | '), error: null }]))
}

describe('the board capability table', () => {
  it('every figure accepts its own stored numbers without changing the table', () => {
    for (const f of BOARD_FIGURES) {
      const c = structuredClone(BASE_BOARD_CAPABILITIES)
      f.apply!(c, numbersIn(f.text))
      expect(JSON.stringify(c), f.id).toBe(JSON.stringify(BASE_BOARD_CAPABILITIES))
    }
    expect(BOARD_FIGURES.every((f) => f.page === PCB)).toBe(true)
    expect(BOARD_TABLE.base).toBe(BASE_BOARD_CAPABILITIES)
  })

  it('reads two figures of one row in order: the two-layer track before the multilayer one', () => {
    const p = planSync({ pages: pages(BOARD_FIGURES), updates: NONE, today: days(3), table: BOARD_TABLE })
    expect(p).toMatchObject({ kind: 'none', table: 'board', same: BOARD_FIGURES.length, review: [] })
  })

  it('proposes a figure the page states with other numbers, and applies it', () => {
    const pg = pages(BOARD_FIGURES, (id, t) => (id === 'via_mm' ? '0.20/0.30mm' : t))
    const p = planSync({ pages: pg, updates: NONE, today: days(2), table: BOARD_TABLE })
    expect(p.kind).toBe('update')
    expect(p.updated.map((u) => u.id)).toEqual(['via_mm'])
    const caps = withUpdates<BoardCapabilities>(BASE_BOARD_CAPABILITIES, p.next, BOARD_FIGURES)
    expect(caps.via_mm).toEqual({ drill: 0.2, diameter: 0.3 })
    expect(caps.track_mm.two_layer).toEqual({ width: 0.1, spacing: 0.1 })
    expect(renderUpdates(p.next, BOARD_TABLE)).toMatch(/import type \{ CapabilityUpdates \} from '\.\.\/mech\/capabilities\.js'/)
  })

  it('sends an unreadable page to a person and changes nothing', () => {
    const p = planSync({ pages: { [PCB]: { text: null, error: 'HTTP 403' } }, updates: NONE, today: days(40), table: BOARD_TABLE })
    expect(p.kind).toBe('none')
    expect(p.review).toHaveLength(BOARD_FIGURES.length)
    expect(p.next).toEqual(NONE)
  })
})

describe('one run of the daily check over every table', () => {
  it('checks the mechanical and the board tables', () => {
    expect(CAPABILITY_TABLES.map((t) => t.id)).toEqual(['mech', 'board'])
    expect(new Set(CAPABILITY_TABLES.map((t) => t.updatesFile)).size).toBe(2)
  })

  it('opens one pull request naming each table\'s changes, and one issue for what needs a person', () => {
    const mechPages = pages(MECH_TABLE.figures)
    const boardPages = pages(BOARD_FIGURES, (id, t) => (id === 'soldermask_bridge_mm' ? '0.08mm' : id === 'layers' ? null : t))
    const all = { ...mechPages, ...boardPages }
    const plans = CAPABILITY_TABLES.map((table) => planSync({ pages: all, updates: NONE, today: days(2), table }))
    expect(plans.map((p) => p.kind)).toEqual(['none', 'update'])
    expect(combinedKind(plans)).toBe('update')
    const pr = pullRequest(plans)
    expect(pr.title).toBe('Capabilities: 1 figure changed on JLCPCB\'s pages')
    expect(pr.body).toContain('| `soldermask_bridge_mm` | 0.10mm | 0.08mm |')
    expect(pr.body).toContain('layouts checked against the old figures need checking again')
    const issue = reviewIssue(plans)!
    expect(issue.body).toContain('| `layers` | src/tools/pcb/capabilities.ts |')
  })

  it('moves the dates on when every figure of every table is stated and one is due', () => {
    const all = { ...pages(MECH_TABLE.figures), ...pages(BOARD_FIGURES) }
    const plans = CAPABILITY_TABLES.map((table) => planSync({ pages: all, updates: NONE, today: '2026-12-15', table }))
    expect(combinedKind(plans)).toBe('reverify')
    expect(pullRequest(plans).title).toBe('Capabilities: every figure confirmed on 2026-12-15')
    expect(reviewIssue(plans)).toBeNull()
  })
})
