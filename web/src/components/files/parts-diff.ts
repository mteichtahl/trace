/**
 * Two versions of a parts list compared row by row (docs/ui-design.md, "Comparing versions"): each line added,
 * removed, or changed in part, quantity or price, keyed by its reference designators.
 */
import { cellNumber, partsColumns, type Table } from './csv'

export type RowChange = 'added' | 'removed' | 'changed' | 'same'

export interface FieldChange {
  field: string
  before: string
  after: string
}

export interface PartsDiffRow {
  key: string
  change: RowChange
  before?: string[]
  after?: string[]
  fields: FieldChange[]
}

export interface PartsDiff {
  header: string[]
  rows: PartsDiffRow[]
  counts: Record<RowChange, number>
}

/** "C1, C2,C3" and "C3 C2 C1" are the same group. */
const normRefs = (s: string): string =>
  s.split(/[\s,;]+/).filter(Boolean).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).join(',')

const same = (a: string, b: string, numeric: boolean): boolean => {
  if (a.trim() === b.trim()) return true
  if (!numeric) return false
  const x = cellNumber(a)
  const y = cellNumber(b)
  return x !== null && y !== null && x === y
}

/** Compare two parts lists. Throws when either is not a parts list (no reference column). */
export function diffParts(before: Table, after: Table): PartsDiff {
  const cb = partsColumns(before.header)
  const ca = partsColumns(after.header)
  if (!cb || !ca) throw new Error('not a parts list: no reference and part columns')
  const index = (t: Table, ref: number) => {
    const m = new Map<string, string[]>()
    for (const r of t.rows) {
      const k = normRefs(r[ref] ?? '')
      if (k) m.set(k, r)
    }
    return m
  }
  const ib = index(before, cb.ref)
  const ia = index(after, ca.ref)
  const fields: { name: string; b: number; a: number; numeric: boolean }[] = [
    { name: 'Part', b: cb.part, a: ca.part, numeric: false },
    { name: 'Value', b: cb.value, a: ca.value, numeric: false },
    { name: 'Footprint', b: cb.footprint, a: ca.footprint, numeric: false },
    { name: 'Quantity', b: cb.qty, a: ca.qty, numeric: true },
    { name: 'Price', b: cb.price, a: ca.price, numeric: true },
  ].filter((f) => f.b >= 0 && f.a >= 0)

  const rows: PartsDiffRow[] = []
  for (const [key, a] of ia) {
    const b = ib.get(key)
    if (!b) {
      rows.push({ key, change: 'added', after: a, fields: [] })
      continue
    }
    const changed = fields
      .filter((f) => !same(b[f.b] ?? '', a[f.a] ?? '', f.numeric))
      .map((f) => ({ field: f.name, before: b[f.b] ?? '', after: a[f.a] ?? '' }))
    rows.push({ key, change: changed.length ? 'changed' : 'same', before: b, after: a, fields: changed })
  }
  for (const [key, b] of ib) if (!ia.has(key)) rows.push({ key, change: 'removed', before: b, fields: [] })

  const rank: Record<RowChange, number> = { removed: 0, added: 1, changed: 2, same: 3 }
  rows.sort((x, y) => rank[x.change] - rank[y.change] || x.key.localeCompare(y.key, 'en', { numeric: true }))
  const counts: Record<RowChange, number> = { added: 0, removed: 0, changed: 0, same: 0 }
  for (const r of rows) counts[r.change]++
  return { header: after.header, rows, counts }
}

/** "2 added, 1 removed, 3 changed" (or "No changes"). */
export function describeDiff(c: Record<RowChange, number>): string {
  const parts = [c.added && `${c.added} added`, c.removed && `${c.removed} removed`, c.changed && `${c.changed} changed`].filter(Boolean)
  return parts.length ? parts.join(', ') : 'No changes'
}
