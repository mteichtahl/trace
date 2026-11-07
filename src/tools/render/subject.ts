/**
 * What render.showcase's pictures are of, from the project's record rather than the folder it runs in:
 *
 *   name       the project's name for the file names (test-esp32 #215: the pictures were named after the agent's
 *              working folder, "task-revision-a-was-cut-on-2026-11"): the name given, else the journey's (the record,
 *              where the person named the project), else the KiCad project's, else the repository's, and the folder
 *              only when there is nothing else
 *   off board  the parts the architecture puts off the board (a display module on a header and its cable), and which
 *              of them the case's records hold a part for (mech.build writes it as mechanical/out/case-<part>.stl at
 *              its mount), so the pictures can draw them, and say which they do not (test-esp32 #214)
 */
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export type NameSource = 'given' | 'journey' | 'kicad' | 'repository' | 'folder'

/** The name the pictures carry, and where it came from (the module note). Pure. */
export function showcaseName(o: { given?: string | null | undefined; journey?: string | null | undefined; kicad?: string | null | undefined; repository?: string | null | undefined; folder: string }): { name: string; from: NameSource } {
  const pick: [NameSource, string | null | undefined][] = [
    ['given', o.given], ['journey', o.journey], ['kicad', o.kicad], ['repository', o.repository?.split('/').pop()], ['folder', o.folder],
  ]
  for (const [from, v] of pick) {
    const name = v?.trim()
    if (name && /[a-z0-9]/i.test(name)) return { name, from }
  }
  return { name: o.folder, from: 'folder' }
}

const hasTable = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))

export interface OffBoardPart { mpn: string; role: string | null; size_mm: number[] | null }

/** From a project database: the journey's name, and the parts the architecture puts off the board (each once, from
 * the blocks still proposed). Missing tables, or no database, give nothing. */
export function recordFacts(dbPath: string): { journey: string | null; offBoard: OffBoardPart[] } {
  if (!existsSync(dbPath)) return { journey: null, offBoard: [] }
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const j = hasTable(db, 'journey') ? db.prepare("SELECT name FROM journey WHERE id='current'").get() as { name?: unknown } | undefined : undefined
    const offBoard: OffBoardPart[] = []
    if (hasTable(db, 'arch_blocks')) {
      const seen = new Set<string>()
      for (const r of db.prepare("SELECT parts FROM arch_blocks WHERE status IS NULL OR status <> 'withdrawn' ORDER BY option, id").all() as { parts: unknown }[]) {
        let parts: unknown
        try { parts = JSON.parse(String(r.parts)) } catch { continue }
        if (!Array.isArray(parts)) continue
        for (const p of parts as Record<string, unknown>[]) {
          if (!p || p.off_board !== true || typeof p.mpn !== 'string') continue
          const key = p.mpn.trim().toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          const size = Array.isArray(p.size_mm) && p.size_mm.every((x) => typeof x === 'number' && x > 0) ? p.size_mm as number[] : null
          offBoard.push({ mpn: p.mpn.trim(), role: typeof p.role === 'string' ? p.role : null, size_mm: size })
        }
      }
    }
    return { journey: typeof j?.name === 'string' && j.name.trim() ? j.name.trim() : null, offBoard }
  } catch {
    return { journey: null, offBoard: [] }
  } finally {
    db?.close()
  }
}

/** A part of the case beyond its base and lid (a module mech.build placed at its mount), from the case's records. */
export interface CasePart { kind: string; size_mm: number[] | null }

/** The case's parts other than its base and lid (and a handed-in case), from case.jsonld. */
export function extraCaseParts(jsonld: unknown): CasePart[] {
  const graph = Array.isArray(jsonld) ? jsonld : (jsonld as { '@graph'?: unknown } | null)?.['@graph']
  if (!Array.isArray(graph)) return []
  return graph.flatMap((n: Record<string, unknown> | null) => {
    if (!n || n['@type'] !== 'EnclosurePart' || typeof n.partKind !== 'string') return []
    const kind = n.partKind
    if (['base', 'lid', 'case'].includes(kind) || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(kind)) return []
    const bb = Array.isArray(n.boundingBox) && n.boundingBox.length === 3 && n.boundingBox.every((x) => typeof x === 'number') ? n.boundingBox as number[] : null
    return [{ kind, size_mm: bb }]
  })
}

/** Words of a name, lower case, for matching a part to a case part. */
const words = (s: string): Set<string> => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && w !== 'module' && w !== 'part'))

/**
 * Which case part draws each off-board part: one whose plan size is the part's (the two larger sides within 1 mm,
 * either way round), else one that shares a word of its name. A part no case part draws, and a cable a part's role
 * names, are not drawn, each with why.
 */
export function offBoardDrawn(parts: readonly OffBoardPart[], caseParts: readonly (CasePart & { drawn: boolean })[]): { drawn: { part: string; as: string }[]; not_drawn: { part: string; why: string }[] } {
  const drawn: { part: string; as: string }[] = []
  const notDrawn: { part: string; why: string }[] = []
  const plan = (s: readonly number[]): number[] => [...s].sort((a, b) => b - a).slice(0, 2)
  const used = new Set<string>()
  for (const p of parts) {
    const free = caseParts.filter((c) => !used.has(c.kind))
    const bySize = p.size_mm ? free.find((c) => c.size_mm && plan(c.size_mm).every((v, i) => Math.abs(v - (plan(p.size_mm as number[])[i] as number)) <= 1)) : undefined
    const mine = words(`${p.mpn} ${p.role ?? ''}`)
    const byName = free.find((c) => [...words(c.kind)].some((w) => mine.has(w)))
    const c = bySize ?? byName
    if (c) used.add(c.kind)
    if (c?.drawn) drawn.push({ part: p.mpn, as: `case part ${c.kind}` })
    else if (c) notDrawn.push({ part: p.mpn, why: `the case's records hold it as ${c.kind}, but mechanical/out/case-${c.kind}.stl is not there (build the case again with mech.build)` })
    else notDrawn.push({ part: p.mpn, why: p.size_mm ? 'the case does not place it (mech.build has no part for it), so trace does not know where it sits' : 'the record has no size or place for it' })
    if (/\b(cable|wire|wired|harness|lead)s?\b/i.test(p.role ?? '')) notDrawn.push({ part: `${p.mpn} cable`, why: 'trace has no shape for cables' })
  }
  return { drawn, not_drawn: notDrawn }
}
