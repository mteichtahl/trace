/**
 * Keeping the mechanical capabilities current (./capabilities.ts), for the scheduled `capabilities` workflow
 * (.github/workflows/capabilities.yml, scripts/capabilities-sync.mjs): re-read each source page and decide, figure
 * by figure, what may change on its own and what needs a person.
 *
 *   same        the page still states the figure next to its label
 *   updated     the page states it differently in the same shape (the stored words with other numbers), and the
 *               figure has an `apply` that puts those numbers into the table: written to ./capabilities.updates.ts
 *   review      anything else: the page or the label could not be read, the figure changed shape, it has no `apply`,
 *               its numbers do not fit, or two figures of one table row now disagree. Never written; reported
 *
 * The plan's kind says what the workflow does:
 *
 *   update      one or more figures updated: a pull request a person reviews (never merged on its own)
 *   reverify    every figure still stated and the table last confirmed REVERIFY_DAYS or more ago: a pull request that
 *               only moves `checked` on, which may merge itself once CI passes
 *   none        nothing to write (review items are still reported)
 *
 * `checked` moves on only when nothing is left for review, so the table's date never claims a page that was not read.
 * A build is stale when the figures change, not when they are only confirmed again (capabilitiesStamp, ./stale.ts).
 */
import {
  BASE_CAPABILITIES, BASE_FIGURES, type CapabilityUpdates, type Figure, SOURCES, currentFigures, figureMatches, figureStatus, numbersIn, pageText, withUpdates,
} from './capabilities.js'
import { UPDATES as MECH_UPDATES } from './capabilities.updates.js'
import { BASE_BOARD_CAPABILITIES, BOARD_FIGURES, BOARD_SOURCES } from '../pcb/capabilities.js'
import { UPDATES as BOARD_UPDATES } from '../pcb/capabilities.updates.js'

/**
 * One capability table the check keeps current: its reviewed base, its figures, the updates file the check writes on
 * top of it and where that file imports its type from. Every table is checked the same way, on the same run.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface CapabilityTable<C extends { checked: string } = any> {
  id: 'mech' | 'board'
  /** whose pages, in words: "JLC3DP's or JLCCNC's", "JLCPCB's" */
  pages: string
  base: C
  figures: readonly Figure<C>[]
  sources: readonly string[]
  /** the updates file, relative to the repository */
  updatesFile: string
  /** the reviewed table, relative to the repository */
  tableFile: string
  /** the updates file's import of CapabilityUpdates */
  typeImport: string
  /** the updates file as it is now */
  updates: CapabilityUpdates
  /** what becomes stale when a figure changes, in words */
  stale: string
}

export const MECH_TABLE: CapabilityTable = {
  id: 'mech', pages: 'JLC3DP\'s or JLCCNC\'s', base: BASE_CAPABILITIES, figures: BASE_FIGURES, sources: SOURCES,
  updatesFile: 'src/tools/mech/capabilities.updates.ts', tableFile: 'src/tools/mech/capabilities.ts', typeImport: './capabilities.js', updates: MECH_UPDATES,
  stale: 'case builds made with the old figures become stale when this merges',
}
export const BOARD_TABLE: CapabilityTable = {
  id: 'board', pages: 'JLCPCB\'s', base: BASE_BOARD_CAPABILITIES, figures: BOARD_FIGURES, sources: BOARD_SOURCES,
  updatesFile: 'src/tools/pcb/capabilities.updates.ts', tableFile: 'src/tools/pcb/capabilities.ts', typeImport: '../mech/capabilities.js', updates: BOARD_UPDATES,
  stale: 'layouts checked against the old figures need checking again',
}
/** Every table the daily check keeps current. */
export const CAPABILITY_TABLES: readonly CapabilityTable[] = [MECH_TABLE, BOARD_TABLE]

/** Re-confirm the table this often when nothing changed, well inside its 90 days. */
export const REVERIFY_DAYS = 30
/** How much of the page after a label a person is shown for a figure to review. */
const CONTEXT_CHARS = 240

export interface Pages { [url: string]: { text: string | null; error: string | null } }

/** Fetch each page as plain text; a failure is recorded, never thrown. */
export async function fetchPages(urls: readonly string[] = [...new Set(CAPABILITY_TABLES.flatMap((t) => t.sources))], timeoutS = 30, fetchFn: typeof fetch = fetch): Promise<Pages> {
  const out: Pages = {}
  await Promise.all(urls.map(async (u) => {
    try {
      const res = await fetchFn(u, { signal: AbortSignal.timeout(timeoutS * 1000), headers: { 'user-agent': 'trace capabilities check' } })
      out[u] = res.ok ? { text: pageText(await res.text()), error: null } : { text: null, error: `HTTP ${res.status}` }
    } catch (e) {
      out[u] = { text: null, error: e instanceof Error ? (e.cause instanceof Error ? `${e.message}: ${e.cause.message}` : e.message) : String(e) }
    }
  }))
  return out
}

const squash = (s: string): string => s.replace(/\s+/g, '').toLowerCase()

/**
 * The figure's text as the page now states it, when it is the same shape: the stored words with each number allowed
 * to be another number, first after the label within its window. Null when there is no such text, and `ambiguous`
 * when the label's appearances are followed by different ones (which of them is this figure is a person's call).
 */
export function sameShape<C>(f: Figure<C>, text: string | null): { found: string; numbers: number[] } | { ambiguous: string[] } | null {
  if (text === null) return null
  const found = [...new Map((figureMatches(f, text) ?? []).map((m) => [squash(m), m])).values()]
  if (found.length > 1) return { ambiguous: found }
  return found[0] === undefined ? null : { found: found[0], numbers: numbersIn(found[0]) }
}

/** What a person sees for a figure: the page's words after its first label, as the page has them. */
export function contextFor<C>(f: Figure<C>, text: string | null): string | null {
  if (text === null) return null
  const i = text.toLowerCase().indexOf(f.label.toLowerCase())
  return i < 0 ? null : text.slice(i, i + f.label.length + CONTEXT_CHARS).trim()
}

export interface Updated { id: string; page: string; stored: string; found: string; numbers: number[] }
export interface Review { id: string; page: string; stored: string; why: string; found: string | null; context: string | null }

export interface SyncPlan {
  kind: 'update' | 'reverify' | 'none'
  /** the table this plan is for */
  table: CapabilityTable['id']
  today: string
  /** the base table's date and the date in force before this run */
  checked_before: string
  same: number
  updated: Updated[]
  review: Review[]
  pages: { url: string; read: boolean; error: string | null }[]
  /** what ./capabilities.updates.ts should hold after this run (unchanged when kind is none) */
  next: CapabilityUpdates
}

const days = (from: string, to: string): number => Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

/**
 * Decide what changes. `updates` is ./capabilities.updates.ts as it is; the figures compared are the current ones (an
 * earlier update's text, else the base table's). Pure: the pages are given.
 */
export function planSync(o: { pages: Pages; updates: CapabilityUpdates; today: string; table?: CapabilityTable; figures?: readonly Figure[]; reverifyDays?: number }): SyncPlan {
  const table = o.table ?? MECH_TABLE
  type Any = { checked: string }
  const base = (o.figures ?? table.figures) as unknown as readonly Figure<Any>[]
  const current = currentFigures(base, o.updates)
  const checkedBefore = withUpdates(table.base as Any, o.updates, base).checked
  const textOf = (f: Figure<Any>): string | null => o.pages[f.page]?.text ?? null
  let same = 0
  const updated: Updated[] = []
  const review: Review[] = []
  for (const f of current) {
    const text = textOf(f)
    const status = figureStatus(f, text)
    if (status === 'same') { same++; continue }
    const r = { id: f.id, page: f.page, stored: f.text, context: contextFor(f, text) }
    if (status === 'unreadable') { review.push({ ...r, why: text === null ? `the page could not be read (${o.pages[f.page]?.error ?? 'not fetched'})` : 'the label is no longer on the page', found: null }); continue }
    const shape = sameShape(f, text)
    if (!shape) { review.push({ ...r, why: 'the page states it differently, not as the same words with other numbers', found: null }); continue }
    if ('ambiguous' in shape) { review.push({ ...r, why: `the label is followed by different figures in different places (${shape.ambiguous.join('; ')})`, found: null }); continue }
    if (!f.apply) { review.push({ ...r, why: 'the page states other numbers, and this figure is not written back automatically (it is not a table value the engine reads, or it is computed in code)', found: shape.found }); continue }
    try {
      f.apply(structuredClone(table.base), shape.numbers)
    } catch (e) {
      review.push({ ...r, why: `the new numbers do not fit the table: ${e instanceof Error ? e.message : String(e)}`, found: shape.found })
      continue
    }
    updated.push({ id: f.id, page: f.page, stored: f.text, found: shape.found, numbers: shape.numbers })
  }

  // figures that share a table row must agree: apply every update, then check that each unchanged figure (and each
  // update) still puts its own numbers into the result unchanged; disagreeing updates go to review together
  const next: CapabilityUpdates = { checked: o.updates.checked, figures: { ...o.updates.figures } }
  for (const u of updated) {
    // back to what the reviewed table says: the update is dropped, not kept
    const baseText = base.find((f) => f.id === u.id)?.text ?? ''
    if (squash(baseText) === squash(u.found)) delete next.figures[u.id]
    else next.figures[u.id] = { text: u.found, read: o.today }
  }
  if (updated.length) {
    const result = withUpdates(table.base as Any, next, base)
    const nextFigures = currentFigures(base, next)
    const disagree = new Set<string>()
    for (const f of nextFigures) {
      if (!f.apply) continue
      const again = structuredClone(result)
      f.apply(again, numbersIn(f.text))
      if (JSON.stringify(again) !== JSON.stringify(result)) disagree.add(f.id)
    }
    if (disagree.size) {
      for (const u of updated.filter((x) => disagree.has(x.id) || [...disagree].some((d) => sharesRow(table.base, base, d, x.id)))) {
        review.push({ id: u.id, page: u.page, stored: u.stored, why: `the page's new figure disagrees with another figure for the same table row (${[...disagree].join(', ')})`, found: u.found, context: contextFor(current.find((f) => f.id === u.id)!, textOf(current.find((f) => f.id === u.id)!)) })
        delete next.figures[u.id]
      }
    }
  }
  const dropped = new Set(review.map((r) => r.id))
  const kept = updated.filter((u) => !dropped.has(u.id))
  const clean = review.length === 0
  if (clean) next.checked = o.today
  const age = days(checkedBefore, o.today)
  const kind: SyncPlan['kind'] = kept.length ? 'update' : clean && age >= (o.reverifyDays ?? REVERIFY_DAYS) ? 'reverify' : 'none'
  return {
    kind, table: table.id, today: o.today, checked_before: checkedBefore, same, updated: kept, review,
    pages: Object.entries(o.pages).map(([url, p]) => ({ url, read: p.text !== null, error: p.error })),
    next: kind === 'none' ? o.updates : next,
  }
}

/** Whether two figures write to the same table values (each applied alone to a copy changes some of the same paths). */
function sharesRow<C>(table: C, figures: readonly Figure<C>[], a: string, b: string): boolean {
  const touched = (id: string): Set<string> => {
    const f = figures.find((x) => x.id === id)
    if (!f?.apply) return new Set()
    const before = structuredClone(table)
    const after = structuredClone(table)
    try { f.apply(after, numbersIn(f.text).map((n) => n + 1)) } catch { return new Set() }
    const out = new Set<string>()
    const walk = (x: unknown, y: unknown, path: string): void => {
      if (JSON.stringify(x) === JSON.stringify(y)) return
      if (x && y && typeof x === 'object' && typeof y === 'object') {
        for (const k of Object.keys(x as object)) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${path}.${k}`)
      } else out.add(path)
    }
    walk(before, after, '')
    return out
  }
  const ta = touched(a)
  return [...touched(b)].some((p) => ta.has(p))
}

/** ./capabilities.updates.ts for `u`, deterministic: figures sorted by id. */
export function renderUpdates(u: CapabilityUpdates, table: CapabilityTable = MECH_TABLE): string {
  const figures = Object.keys(u.figures).sort().map((id) => `    ${JSON.stringify(id)}: { text: ${JSON.stringify(u.figures[id]!.text)}, read: ${JSON.stringify(u.figures[id]!.read)} },`)
  return `/**
 * Written by the scheduled capability check (${table.id === 'mech' ? './capsync.ts' : '../mech/capsync.ts'}, the \`capabilities\` workflow), not by hand: the figures the
 * capability pages now state differently from ./capabilities.ts, and the day every figure was last found stated.
 * ./capabilities.ts applies them on top of its reviewed table. Each change arrives on a pull request a person reviews;
 * to fold an update into the base table, edit ./capabilities.ts and remove the entry here in the same change.
 */
import type { CapabilityUpdates } from '${table.typeImport}'

export const UPDATES: CapabilityUpdates = {
  checked: ${u.checked === null ? 'null' : JSON.stringify(u.checked)},
  figures: {${figures.length ? `\n${figures.join('\n')}\n  ` : ''}},
}
`
}

const cell = (s: string | null): string => (s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—'

const tableOf = (id: CapabilityTable['id']): CapabilityTable => CAPABILITY_TABLES.find((t) => t.id === id) ?? MECH_TABLE
const list = (p: SyncPlan | readonly SyncPlan[]): SyncPlan[] => (Array.isArray(p) ? [...p] : [p as SyncPlan])
const s_ = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`

/**
 * What one run of the check does with every table: update when any table has an update; otherwise reverify when no
 * table has anything for a person and at least one is due; otherwise nothing.
 */
export function combinedKind(plans: readonly SyncPlan[]): SyncPlan['kind'] {
  if (plans.some((p) => p.kind === 'update')) return 'update'
  return plans.some((p) => p.kind === 'reverify') ? 'reverify' : 'none'
}

/** The pull request's title and body for the plans of one run (one table's plan, or every table's). */
export function pullRequest(plans: SyncPlan | readonly SyncPlan[]): { title: string; body: string } {
  const ps = list(plans).filter((p) => p.kind !== 'none')
  const updated = ps.filter((p) => p.kind === 'update')
  const lines: string[] = []
  const day = ps[0]?.today ?? ''
  if (updated.length) {
    const n = updated.reduce((k, p) => k + p.updated.length, 0)
    lines.push(`The scheduled capability check read the source pages on ${day} and found ${s_(n, 'figure')} stated differently, in the same words with other numbers. Each is written to its table's updates file and applied on top of the reviewed table. Check each against its page before merging: ${updated.map((p) => tableOf(p.table).stale).join('; ')}.`, '')
    lines.push('| Figure | Stored | The page now states | Page |', '| --- | --- | --- | --- |')
    for (const p of updated) for (const u of p.updated) lines.push(`| \`${u.id}\` | ${cell(u.stored)} | ${cell(u.found)} | ${u.page} |`)
    for (const p of ps.filter((x) => x.kind === 'reverify')) lines.push('', `Every figure of ${tableOf(p.table).pages} table (${p.same}) is still stated as stored: its \`checked\` date moves from ${p.checked_before} to ${p.today}.`)
  } else {
    const same = ps.reduce((k, p) => k + p.same, 0)
    const moved = ps.map((p) => `${tableOf(p.table).tableFile} from ${p.checked_before}`).join(', ')
    lines.push(`The scheduled capability check read the source pages on ${day} and every one of the ${same} figures is still stated as stored. This moves the \`checked\` date of ${moved} to ${day}, so it does not go stale; no figure changes and nothing becomes stale. It may merge itself once CI passes.`)
  }
  const review = list(plans).reduce((k, p) => k + p.review.length, 0)
  if (review) lines.push('', `${s_(review, 'figure')} need a person (see the capability check issue); the tables keep their last reviewed values.`)
  lines.push('', '🤖 Opened by the scheduled `capabilities` workflow (scripts/capabilities-sync.mjs).')
  const pages = [...new Set(updated.map((p) => tableOf(p.table).pages))].join(' or ')
  const n = updated.reduce((k, p) => k + p.updated.length, 0)
  return { title: updated.length ? `Capabilities: ${s_(n, 'figure')} changed on ${pages} pages` : `Capabilities: every figure confirmed on ${day}`, body: lines.join('\n') }
}

/** The issue's body for the figures that need a person, or null when there are none. */
export function reviewIssue(plans: SyncPlan | readonly SyncPlan[]): { title: string; body: string } | null {
  const ps = list(plans)
  const review = ps.flatMap((p) => p.review.map((r) => ({ ...r, table: tableOf(p.table) })))
  if (!review.length) return null
  const day = ps[0]?.today ?? ''
  const files = [...new Set(review.map((r) => r.table.tableFile))]
  const lines = [
    `The scheduled capability check read the source pages on ${day}. ${s_(review.length, 'figure')} could not be confirmed or written back automatically, so ${files.map((f) => `\`${f}\``).join(' and ')} keep${files.length === 1 ? 's' : ''} the last reviewed value for each, and ${files.length === 1 ? 'its' : 'their'} \`checked\` date does not move on (a table is stale ${90} days after it was last confirmed: ${ps.filter((p) => p.review.length).map((p) => `${tableOf(p.table).tableFile} ${p.checked_before}`).join(', ')}).`,
    '',
    'For each: open the page, and either correct the figure in its table (and the figure\'s stored text, with the new date), or, when the page only reworded it, update the stored text so the check finds it again.',
    '',
    '| Figure | Table | Stored | Why | The page now says |',
    '| --- | --- | --- | --- | --- |',
    ...review.map((r) => `| \`${r.id}\` | ${r.table.tableFile} | ${cell(r.stored)} | ${cell(r.why)} | ${cell(r.found ?? r.context)} |`),
    '',
    'Pages: ' + [...new Map(ps.flatMap((p) => p.pages).map((x) => [x.url, x])).values()].map((x) => `${x.url} (${x.read ? 'read' : `not read: ${x.error ?? 'unknown'}`})`).join('; '),
    '',
    '🤖 Updated by the scheduled `capabilities` workflow (scripts/capabilities-sync.mjs); closed by it once every figure is confirmed again.',
  ]
  return { title: 'Capabilities: figures that need a person', body: lines.join('\n') }
}
