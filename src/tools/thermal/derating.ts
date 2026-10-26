/**
 * Derating curves: the allowed value of a quantity (power, current) against temperature, as a datasheet draws or
 * tabulates it (e.g. a resistor's power derating against ambient, a connector's current against temperature, a
 * regulator's output current against ambient). Points are joined linearly; outside the curve the end values hold
 * only if the datasheet says so, so a check outside the curve's range is reported as out of range, not passed.
 */
import { ToolError } from '../../core/registry.js'

export function allowedAt(points: readonly (readonly [number, number])[], x: number): { y: number | null; in_range: boolean } {
  const p = [...points].sort((a, b) => a[0] - b[0])
  if (p.length < 2) throw new ToolError('a derating curve needs at least two points')
  if (x < p[0]![0] || x > p[p.length - 1]![0]) return { y: null, in_range: false }
  for (let i = 1; i < p.length; i++) {
    const [x0, y0] = p[i - 1]!
    const [x1, y1] = p[i]!
    if (x <= x1) return { y: x1 === x0 ? Math.min(y0, y1) : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0), in_range: true }
  }
  return { y: p[p.length - 1]![1], in_range: true }
}

export interface DeratingCheck { x: number; y: number; allowed: number | null; margin: number | null; margin_fraction: number | null; status: 'pass' | 'fail' | 'out-of-range' }

export function checkPoint(points: readonly (readonly [number, number])[], x: number, y: number): DeratingCheck {
  const a = allowedAt(points, x)
  if (a.y === null) return { x, y, allowed: null, margin: null, margin_fraction: null, status: 'out-of-range' }
  return { x, y, allowed: a.y, margin: a.y - y, margin_fraction: a.y > 0 ? (a.y - y) / a.y : null, status: y <= a.y ? 'pass' : 'fail' }
}

/** Points from a datasheet table's rows: the numeric cells of two columns (units and footnote marks stripped). */
export function pointsFromTable(rows: readonly (readonly string[])[], xCol: number, yCol: number): [number, number][] {
  const n = (s: string | undefined): number => Number((s ?? '').replace(/[^0-9eE+\-.]/g, ''))
  const out: [number, number][] = []
  for (const r of rows) {
    const x = n(r[xCol])
    const y = n(r[yCol])
    if (/\d/.test(r[xCol] ?? '') && /\d/.test(r[yCol] ?? '') && Number.isFinite(x) && Number.isFinite(y)) out.push([x, y])
  }
  if (out.length < 2) throw new ToolError(`the table has fewer than two numeric rows in columns ${xCol} and ${yCol}`)
  return out
}
