/**
 * Revision renders as the ontology reads them (ontology/trace-board.ttl, "revision renders"; docs/revision-renders.md).
 * Each render.showcase run is already a RenderSet through the runs table's mapping; this adds what its result holds and
 * no column stores: the revision and the day it was cut, the colour palette and where it came from, and each picture
 * as a Render with its shot.
 *
 * The run's result (src/tools/render/showcase.ts) carries:
 *
 *   revision   the revision letter, such as B
 *   date       the day it was cut, YYYY-MM-DD
 *   palette    { source: 'logo' | 'neutral', logo?: { path, sha256 }, base, accent, neutral, background: [top, bottom] }
 *   shots      { <picture's file name>: <shot> }
 */
import type { DatabaseSync } from 'node:sqlite'
import { DataFactory, type NamedNode, type Store } from 'n3'
import { type GraphOptions, nodeIri } from './graph.js'
import { NS, RDF, XSD } from './vocab.js'

const { namedNode, literal, quad } = DataFactory
const T = (n: string): NamedNode => namedNode(`${NS}${n}`)
const TYPE = namedNode(`${RDF}type`)
const has = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))

/** What this reader writes, for the ontology's tests (test/ontology/vocabulary.test.ts). */
export const RENDER_CLASSES = ['RenderSet', 'Render', 'BrandPalette', 'FileArtifact'] as const
export const RENDER_PROPERTIES = [
  'ofRevision', 'revisionDate', 'usedPalette', 'paletteSource', 'paletteFromLogo', 'baseColour', 'accentColour', 'neutralColour',
  'backgroundColours', 'path', 'sha256', 'inRenderSet', 'shotKind',
] as const

export const SHOTS = ['board', 'board-top', 'board-bottom', 'case', 'board-in-case', 'exploded', 'turntable'] as const
export type Shot = (typeof SHOTS)[number]
/** The shots that are a video (MP4) rather than a picture (PNG). */
export const VIDEO_SHOTS: readonly Shot[] = ['turntable']
/** A shot's file extension. */
export const shotExt = (s: Shot): 'mp4' | 'png' => (VIDEO_SHOTS.includes(s) ? 'mp4' : 'png')

const HEX = /^#[0-9a-f]{6}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/
const REVISION = /^[A-Z]{1,3}$/

export interface ShowcaseRecord {
  revision: string
  date: string
  palette: {
    source: 'logo' | 'neutral'
    logo?: { path: string; sha256: string } | null
    base: string
    accent: string
    neutral: string
    background: [string, string]
  }
  shots: Record<string, Shot>
}

/** A showcase run's result as the record, or null when it is not one (an older or failed run). */
export function showcaseRecord(result: unknown): ShowcaseRecord | null {
  if (!result || typeof result !== 'object') return null
  const r = result as Record<string, unknown>
  const p = r.palette as Record<string, unknown> | undefined
  if (typeof r.revision !== 'string' || !REVISION.test(r.revision) || typeof r.date !== 'string' || !DATE.test(r.date)) return null
  if (!p || (p.source !== 'logo' && p.source !== 'neutral')) return null
  const colours = [p.base, p.accent, p.neutral, ...(Array.isArray(p.background) ? p.background : [])]
  if (colours.length !== 5 || !colours.every((c) => typeof c === 'string' && HEX.test(c))) return null
  const shots: Record<string, Shot> = {}
  if (r.shots && typeof r.shots === 'object') {
    for (const [name, shot] of Object.entries(r.shots as Record<string, unknown>)) {
      if (typeof shot === 'string' && (SHOTS as readonly string[]).includes(shot)) shots[name] = shot as Shot
    }
  }
  const logo = p.logo as Record<string, unknown> | null | undefined
  return {
    revision: r.revision,
    date: r.date,
    palette: {
      source: p.source,
      logo: logo && typeof logo.path === 'string' && typeof logo.sha256 === 'string' ? { path: logo.path, sha256: logo.sha256 } : null,
      base: p.base as string, accent: p.accent as string, neutral: p.neutral as string,
      background: [(p.background as string[])[0] as string, (p.background as string[])[1] as string],
    },
    shots,
  }
}

/** Every finished render.showcase run of `project` (the run record) into `store`. Returns how many were read. */
export function addRenders(store: Store, o: GraphOptions, project: DatabaseSync): number {
  if (!has(project, 'runs')) return 0
  const rows = project.prepare("SELECT id, result FROM runs WHERE kind='render.showcase' AND status='pass' ORDER BY started").all() as { id: string; result: string | null }[]
  let n = 0
  for (const row of rows) {
    let parsed: unknown = null
    try { parsed = row.result ? JSON.parse(row.result) : null } catch { parsed = null }
    const rec = showcaseRecord(parsed)
    if (!rec) continue
    const set = namedNode(nodeIri(o, 'run', row.id))
    store.addQuad(quad(set, TYPE, T('RenderSet')))
    store.addQuad(quad(set, T('ofRevision'), namedNode(nodeIri(o, 'revision', rec.revision))))
    store.addQuad(quad(set, T('revisionDate'), literal(rec.date, namedNode(`${XSD}date`))))
    const pal = namedNode(nodeIri(o, 'palette', row.id))
    store.addQuad(quad(pal, TYPE, T('BrandPalette')))
    store.addQuad(quad(set, T('usedPalette'), pal))
    store.addQuad(quad(pal, T('paletteSource'), literal(rec.palette.source)))
    store.addQuad(quad(pal, T('baseColour'), literal(rec.palette.base)))
    store.addQuad(quad(pal, T('accentColour'), literal(rec.palette.accent)))
    store.addQuad(quad(pal, T('neutralColour'), literal(rec.palette.neutral)))
    store.addQuad(quad(pal, T('backgroundColours'), literal(rec.palette.background.join(' '))))
    if (rec.palette.logo) {
      // the repository file, as the documentation module names the project's logo
      const logo = namedNode(nodeIri(o, 'file', rec.palette.logo.path))
      store.addQuad(quad(logo, TYPE, T('FileArtifact')))
      store.addQuad(quad(logo, T('path'), literal(rec.palette.logo.path)))
      store.addQuad(quad(logo, T('sha256'), literal(rec.palette.logo.sha256)))
      store.addQuad(quad(pal, T('paletteFromLogo'), logo))
    }
    for (const [name, shot] of Object.entries(rec.shots)) {
      const pic = namedNode(nodeIri(o, 'artifact', `${row.id}/${name}`))
      store.addQuad(quad(pic, TYPE, T('Render')))
      store.addQuad(quad(pic, T('inRenderSet'), set))
      store.addQuad(quad(pic, T('shotKind'), literal(shot)))
    }
    n++
  }
  return n
}
