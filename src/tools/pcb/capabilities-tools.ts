/**
 * JLCPCB's board capabilities as tools (./capabilities.ts): the table as trace stores it, and a check that re-reads its
 * page now. The daily capabilities workflow keeps the table current (src/tools/mech/capsync.ts); these let a specialist
 * read the limits a layout is held to, and see whether the page still states them.
 *
 *   pcb.capabilities         the table, its page, the day it was last confirmed and whether that is past 90 days
 *   pcb.capabilities_check   fetch the page and say, figure by figure, same, changed or unreadable. Changes nothing
 */
import { z } from 'zod'
import { defineTool } from '../../core/registry.js'
import { recorded } from '../kicad/record.js'
import { type FigureStatus, STALE_DAYS, figureStatus, pageText } from '../mech/capabilities.js'
import { BOARD_CAPABILITIES, BOARD_SOURCES, CURRENT_BOARD_FIGURES } from './capabilities.js'

function staleness(now: Date = new Date()): { checked: string; age_days: number; stale: boolean; stale_after_days: number } {
  const age = Math.floor((now.getTime() - Date.parse(`${BOARD_CAPABILITIES.checked}T00:00:00Z`)) / 86_400_000)
  return { checked: BOARD_CAPABILITIES.checked, age_days: age, stale: age > STALE_DAYS, stale_after_days: STALE_DAYS }
}

export const boardCapabilitiesTool = defineTool({
  name: 'pcb.capabilities',
  description: 'What JLCPCB makes as a standard bare board, as trace stores it: layer counts, the narrowest track and gap at 1 oz (two-layer and multilayer), the smallest via, annular rings, hole-to-hole gaps, the smallest unplated hole and board, the solder mask bridge, silkscreen line and text height, and copper back from a routed edge; with the page it was read from, the day it was last confirmed and whether that is older than 90 days. Kept current by trace\'s daily capabilities check. Recorded; returns run_id.',
  input: z.object({}),
  run: async (a) => recorded('pcb.capabilities', null, a, async () => {
    const st = staleness()
    return {
      status: st.stale ? 'fail' as const : 'pass' as const,
      summary: `JLCPCB board capabilities, confirmed ${st.checked} (${st.age_days} days ago${st.stale ? ', stale: re-check them' : ''})`,
      result: { ...st, capabilities: BOARD_CAPABILITIES },
    }
  }),
})

export const boardCapabilitiesCheckTool = defineTool({
  name: 'pcb.capabilities_check',
  description: 'Fetch JLCPCB\'s board capabilities page and report, for each stored figure, whether the page still states it next to its label: same, changed (the label is there, the figure is not) or unreadable. Changes nothing: the daily capabilities workflow proposes changed figures on a pull request and reports the rest for a person. Plain fetch (set NODE_USE_ENV_PROXY=1 for a proxy). Recorded; returns run_id.',
  input: z.object({ timeout_s: z.number().int().min(5).max(120).default(30) }),
  run: async (a) => recorded('pcb.capabilities_check', null, a, async (run) => {
    const pages = new Map<string, { text: string | null; error: string | null }>()
    await Promise.all(BOARD_SOURCES.map(async (u) => {
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(a.timeout_s * 1000), headers: { 'user-agent': 'trace pcb.capabilities_check' } })
        pages.set(u, res.ok ? { text: pageText(await res.text()), error: null } : { text: null, error: `HTTP ${res.status}` })
      } catch (e) {
        pages.set(u, { text: null, error: e instanceof Error ? (e.cause instanceof Error ? `${e.message}: ${e.cause.message}` : e.message) : String(e) })
      }
    }))
    const figures = CURRENT_BOARD_FIGURES.map((f) => ({ id: f.id, label: f.label, stored: f.text, status: figureStatus(f, pages.get(f.page)?.text ?? null) as FigureStatus }))
    const count = (k: FigureStatus): number => figures.filter((f) => f.status === k).length
    run.measure('same', count('same'))
    run.measure('changed', count('changed'))
    run.measure('unreadable', count('unreadable'))
    const ok = count('changed') === 0 && count('unreadable') === 0
    return {
      status: ok ? 'pass' as const : 'fail' as const,
      summary: `${figures.length} figures: ${count('same')} same, ${count('changed')} changed, ${count('unreadable')} unreadable (stored ${BOARD_CAPABILITIES.checked})`,
      result: {
        checked: BOARD_CAPABILITIES.checked, pages: [...pages].map(([url, p]) => ({ url, read: p.text !== null, error: p.error })),
        changed: figures.filter((f) => f.status === 'changed'), unreadable: figures.filter((f) => f.status === 'unreadable'), same: count('same'),
      },
    }
  }),
})
