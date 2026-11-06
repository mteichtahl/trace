/**
 * The key parts of the architecture going ahead, as Architecture choice's "Accept the key parts" step shows them
 * (test-esp32 #38, #96: the step showed no parts, though "Every key part in stock or excepted" was met): each key part
 * of the option's blocks with its part number, the supplier code its stock check was pinned to, the stock and price
 * at the build quantity from the newest parts check of it (parts.bom_check, parts_list_lines), and its exception: an
 * open waiver of its own architect.stock finding, or of the whole criterion. Pure, over rows; read by skill.get.
 *
 * The same parts and the same newest check as the architect.stock shape (ontology/shapes/architect.stock.ttl): a block
 * that is withdrawn is left out, and a part's finding is `architect.stock@<block node>/usesPart/<n>` (src/ontology/
 * graph.ts names a block's n-th part so, src/tools/shape/tools.ts findingId).
 */
import type { WaiverRow } from '../../core/journey.js'
import { mpnKey } from '../datasheets/mpn.js'
import type { OptionView } from './record.js'

/** One line of a parts check, with its run's start and the boards it was checked for. */
export interface StockLine {
  run: string; started: number; boards: number | null
  mpn: string | null; part_key: string | null; order_code: string | null
  need: number; status: string; flags: string[]; stock: number | null; unit_price: number | null; currency: string | null; note: string | null
}

export interface KeyPartView {
  block: string; block_name: string; mpn: string; role: string | null; off_board: boolean
  /** the newest parts check of it; null: not checked for stock yet */
  check: {
    run: string; at: string; boards: number | null; order_code: string | null; need: number
    status: string; flags: string[]; stock: number | null; unit_price: number | null; currency: string | null; note: string | null
  } | null
  /** what the step asks of it: in stock at the build quantity, or else why not, in words */
  standing: 'ok' | 'problem' | 'unchecked'
  why: string | null
  /** its exception, when one is signed: of the part on its own, or of the whole stock criterion */
  exception: { reason: string; by: string; scope: 'part' | 'criterion' } | null
}

export interface KeyPartsView { option: string; quantity: number | null; parts: KeyPartView[] }

const iso = (t: number): string => new Date(t * 1000).toISOString()

/** Whether a waiver target names the n-th part of a block (option/block): the end of its finding's node. */
const namesPart = (target: string, option: string, block: string, n: number): boolean =>
  target.startsWith('architect.stock@') && target.endsWith(`:block:${encodeURIComponent(`${option}/${block}`)}/usesPart/${n}`)

/** Why a key part does not yet stand, in the shape's words; null when it does. */
function problem(c: KeyPartView['check'], quantity: number | null): string | null {
  if (!c) return 'Not checked for stock yet: trace runs the parts check at the build quantity.'
  if (quantity !== null && c.boards !== null && c.boards < quantity) return `Checked for ${c.boards} boards, fewer than the ${quantity} the project builds: check it again.`
  if (c.status === 'out') return `Out of stock: ${c.need} needed.`
  if (c.status === 'short') return `Short: ${c.need} needed, ${c.stock ?? 0} in stock.`
  if (c.status === 'not-found') return 'Not found at any supplier.'
  if (c.status === 'error') return 'Could not be checked: check it again.'
  return null
}

export function keyPartsView(o: OptionView, lines: readonly StockLine[], quantity: number | null, waivers: readonly WaiverRow[]): KeyPartsView {
  const open = waivers.filter((w) => w.closedAt === null)
  const whole = open.find((w) => w.targetKind === 'criterion' && w.target === 'architect.stock')
  // the newest line per part (the lines come in any order)
  const newest = new Map<string, StockLine>()
  for (const l of lines) {
    const key = l.part_key ?? (l.mpn ? mpnKey(l.mpn) : null)
    if (!key) continue
    const had = newest.get(key)
    if (!had || l.started > had.started) newest.set(key, l)
  }
  const parts = o.blocks.flatMap((b) => b.parts.flatMap((p, n) => {
    if (!p.key) return []
    const l = newest.get(mpnKey(p.mpn))
    const check: KeyPartView['check'] = l ? {
      run: l.run, at: iso(l.started), boards: l.boards, order_code: l.order_code, need: l.need, status: l.status, flags: l.flags,
      stock: l.stock, unit_price: l.unit_price, currency: l.currency, note: l.note,
    } : null
    const why = problem(check, quantity)
    const own = open.find((w) => w.targetKind === 'finding' && namesPart(w.target, o.id, b.id, n))
    const w = own ?? (why ? whole : undefined)
    return [{
      block: b.id, block_name: b.name, mpn: p.mpn, role: p.role ?? null, off_board: p.off_board === true, check,
      standing: !check ? 'unchecked' as const : why ? 'problem' as const : 'ok' as const, why,
      exception: w ? { reason: w.reason, by: w.by, scope: own ? 'part' as const : 'criterion' as const } : null,
    }]
  }))
  return { option: o.id, quantity, parts }
}
