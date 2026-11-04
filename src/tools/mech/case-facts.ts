/**
 * What of a board a case depends on (plan P7.6): its outline, cutouts and thickness, its mounting and unplated holes
 * (a part's own plated holes move with the part, and count only for a part at the edge), the parts at its edge
 * (where they are: a connector there needs its opening, any part there is near a wall) and the parts' heights (how
 * tall and on which side, not where: the lid and floor are flat). A part moved in the middle of the board changes
 * none of these, so a case build stays current; an edge connector moved, a hole moved or a taller part makes it
 * stale, saying which.
 *
 *   caseFacts(facts)            those facts, from the board facts mech.build reads (./board.ts)
 *   caseFactHashes(facts)       one hash per group (outline, holes, heights) and one per part at the edge, by reference:
 *                               what a build records (BuildInputs.case_facts, ./stale.ts) to say what changed
 *   caseViewHash(path, bytes)   one hash over them all, from the board file's bytes: the hash lineage records for the
 *                               build's board input `<board>#case` (src/ontology/lineage.ts), so freshness everywhere
 *                               agrees with mech.fit
 *
 * The standoffs sit at the holes, which are in the facts; a part moved onto a standoff in the middle of the board is
 * caught by the next build's fit check, not here.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { type BoardFacts, boardFacts } from './board.js'

/** The view of a board file lineage records for a case build: `hardware/x.kicad_pcb#case`. */
export const CASE_VIEW = 'case'

const h = (x: unknown): string => createHash('sha256').update(JSON.stringify(x)).digest('hex')
const byKey = <T>(xs: T[], key: (x: T) => string): T[] => [...xs].sort((a, b) => key(a).localeCompare(key(b)))

export interface CaseFacts {
  outline: { outline: BoardFacts['outline']; cutouts: BoardFacts['cutouts']; thickness_mm: number }
  holes: BoardFacts['holes']
  /** each part at the board's edge, by reference: where it is, its box, height, side and whether it is a connector */
  edge: Record<string, unknown>
  /** every part's height, side and depth below the board, without where it is (sorted) */
  heights: [string, number, number][]
}

export function caseFacts(f: BoardFacts): CaseFacts {
  const edge: Record<string, unknown> = {}
  for (const p of byKey(f.parts.filter((x) => x.edge), (x) => x.ref)) {
    edge[p.ref] = { side: p.side, x: p.x, y: p.y, rotation_deg: p.rotation_deg, box: p.box, height_mm: p.height_mm, below_mm: p.below_mm, connector: p.connector, edge: p.edge }
  }
  return {
    outline: { outline: f.outline, cutouts: f.cutouts, thickness_mm: f.thickness_mm },
    holes: byKey(f.holes.filter((x) => x.kind !== 'pth'), (x) => `${x.x},${x.y},${x.d},${x.kind}`),
    edge,
    heights: f.parts.map((p) => [p.side, p.height_mm, p.below_mm] as [string, number, number]).sort((a, b) => a.join().localeCompare(b.join())),
  }
}

export interface CaseFactHashes { outline: string; holes: string; heights: string; edge: Record<string, string> }

export function caseFactHashes(f: BoardFacts): CaseFactHashes {
  const c = caseFacts(f)
  return { outline: h(c.outline), holes: h(c.holes), heights: h(c.heights), edge: Object.fromEntries(Object.entries(c.edge).map(([k, v]) => [k, h(v)])) }
}

/** What changed between two builds' case facts, in words; empty when nothing the case depends on did. */
export function caseFactChanges(was: CaseFactHashes, now: CaseFactHashes, board: string): string[] {
  const out: string[] = []
  if (was.outline !== now.outline) out.push(`${board}'s outline or thickness changed since the build`)
  if (was.holes !== now.holes) out.push(`${board}'s mounting holes changed since the build`)
  const refs = [...new Set([...Object.keys(was.edge ?? {}), ...Object.keys(now.edge ?? {})])].sort()
  const moved = refs.filter((r) => was.edge?.[r] !== undefined && now.edge?.[r] !== undefined && was.edge[r] !== now.edge[r])
  const gone = refs.filter((r) => now.edge?.[r] === undefined)
  const came = refs.filter((r) => was.edge?.[r] === undefined)
  if (moved.length) out.push(`${moved.join(', ')} at the board's edge moved or changed since the build`)
  if (gone.length) out.push(`${gone.join(', ')} ${gone.length === 1 ? 'is' : 'are'} no longer at the board's edge`)
  if (came.length) out.push(`${came.join(', ')} ${came.length === 1 ? 'is' : 'are'} now at the board's edge`)
  if (was.heights !== now.heights) out.push(`a part's height on ${board} changed since the build (or a part was added or removed)`)
  return out
}

/** The board's case facts from its bytes (written to a scratch folder for the reader), or why they cannot be read. */
export function caseFactsOf(path: string, bytes: Uint8Array): BoardFacts | { error: string } {
  const dir = mkdtempSync(join(tmpdir(), 'trace-case-facts-'))
  try {
    const p = join(dir, basename(path))
    writeFileSync(p, bytes)
    return boardFacts(p, dir)
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** One hash over what a case depends on, from the board's bytes; an unreadable board hashes its error. */
export function caseViewHash(path: string, bytes: Uint8Array): string {
  const f = caseFactsOf(path, bytes)
  return 'error' in f ? h({ unreadable: f.error }) : h(caseFacts(f))
}

/** From the facts mech.build already read: the same hash as caseViewHash over the board's bytes. */
export const caseViewHashOf = (f: BoardFacts): string => h(caseFacts(f))
