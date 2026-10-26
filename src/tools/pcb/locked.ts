/**
 * Locked copper in a board file, and the checks that keep it locked across a router's round trip.
 *
 *   lockedItems(text)        every locked track, arc and via (KiCad 8–10 `(locked yes)`, KiCad 6–7's bare `locked`
 *                            flag, or the 5.99 development builds' `(locked)`), as comparable keys
 *   lockedChanges(a, b)      what of a's locked copper is missing or moved in b
 *   dsnWiring(dsn)           a Specctra DSN's wiring by type: KiCad writes locked copper as `(type fix)`, which is
 *                            what Freerouting must see so it routes around it instead of ripping it up
 */
import * as sx from '../kicad/sexpr.js'

export interface LockedItem { kind: 'segment' | 'arc' | 'via'; key: string }

const r4 = (s: string | undefined): string => (s === undefined ? '?' : String(Math.round(Number(s) * 1e4) / 1e4))

function netOf(node: sx.SList, codes: Map<string, string>): string {
  const n = sx.find(node, 'net')
  const a = sx.atomAt(n, 1) ?? ''
  return sx.atomAt(n, 2) ?? codes.get(a) ?? a
}

const isLocked = (node: sx.SList): boolean => {
  if (node.slice(1).includes('locked')) return true
  const l = sx.find(node, 'locked')
  return l !== undefined && (l.length === 1 || sx.atomAt(l, 1) === 'yes')
}

/** Every locked track, arc and via in a .kicad_pcb's text. */
export function lockedItems(text: string): LockedItem[] {
  const tree = sx.parse(text)
  const codes = new Map<string, string>()
  for (const n of sx.findAll(tree, 'net')) {
    const c = sx.atomAt(n, 1)
    const name = sx.atomAt(n, 2)
    if (c !== undefined && name !== undefined) codes.set(c, name)
  }
  const out: LockedItem[] = []
  for (const node of sx.children(tree)) {
    const kind = sx.head(node)
    if ((kind !== 'segment' && kind !== 'arc' && kind !== 'via') || !isLocked(node)) continue
    const net = netOf(node, codes)
    if (kind === 'via') {
      const at = sx.find(node, 'at')
      const layers = sx.find(node, 'layers')
      out.push({ kind, key: `via|${net}|${r4(sx.atomAt(at, 1))},${r4(sx.atomAt(at, 2))}|${layers ? sx.atoms(layers).join('-') : ''}` })
    } else {
      const s = sx.find(node, 'start')
      const e = sx.find(node, 'end')
      const ends = [`${r4(sx.atomAt(s, 1))},${r4(sx.atomAt(s, 2))}`, `${r4(sx.atomAt(e, 1))},${r4(sx.atomAt(e, 2))}`].sort()
      const mid = kind === 'arc' ? `|${r4(sx.atomAt(sx.find(node, 'mid'), 1))},${r4(sx.atomAt(sx.find(node, 'mid'), 2))}` : ''
      out.push({ kind, key: `${kind}|${net}|${sx.value(node, 'layer') ?? ''}|${ends.join('|')}${mid}|w${r4(sx.value(node, 'width'))}` })
    }
  }
  return out
}

/** The locked items of `before` that `after` no longer has where they were (moved, resized, unlocked or gone). */
export function lockedChanges(before: readonly LockedItem[], after: readonly LockedItem[]): LockedItem[] {
  const have = new Map<string, number>()
  for (const i of after) have.set(i.key, (have.get(i.key) ?? 0) + 1)
  const lost: LockedItem[] = []
  for (const i of before) {
    const n = have.get(i.key) ?? 0
    if (n > 0) have.set(i.key, n - 1)
    else lost.push(i)
  }
  return lost
}

/** A DSN's wires and vias counted by their `(type …)`: route, fix, protect, … */
export function dsnWiring(dsn: string): { wires: Record<string, number>; vias: Record<string, number> } {
  const wires: Record<string, number> = {}
  const vias: Record<string, number> = {}
  const section = dsn.slice(Math.max(0, dsn.search(/\(wiring\b/)))
  if (!/\(wiring\b/.test(dsn)) return { wires, vias }
  for (const m of section.matchAll(/\((wire|via)\b[^\n]*?\(type\s+(\w+)\)/g)) {
    const t = m[1] === 'wire' ? wires : vias
    t[m[2] as string] = (t[m[2] as string] ?? 0) + 1
  }
  return { wires, vias }
}
