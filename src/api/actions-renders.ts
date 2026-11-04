/**
 * The Renders tab's record (docs/revision-renders.md "In the app"): each revision's photorealistic renders, newest
 * first, and the revisions whose renders are still being made.
 *
 *   renders.list   read   { repo } → { revisions: RevisionRenders[], making: MakingRenders[] }
 *   renders.seen   read   { repo, revision } → the person has seen a revision's renders: its Next item leaves their list
 *                         (src/core/journey.ts inboxItems). Nothing to commit when they had seen them already
 *
 * A revision's renders are its render.showcase runs in the run record (.trace/project.db, as committed): the newest
 * passing run of each revision, its pictures by shot and the colours they used (src/ontology/renders.ts reads the same
 * result). The pictures themselves are the runs' artifacts, fetched one at a time with `artifact`; the app makes the
 * zip from them, so no answer here carries image data. A revision whose renders are being made is a rendering job in
 * the project's job index that is queued or running, its revision and day read from its request
 * (src/api/actions-journey.ts rendersRequest).
 */
import type { DatabaseSync } from 'node:sqlite'
import { Work } from '../core/store.js'
import { SHOTS, type Shot, showcaseRecord } from '../ontology/renders.js'
import { z } from 'zod'
import { loadJourney, recordOpen } from '../core/journey.js'
import { type Context, Repo, def, hashOf, plainly, withProjectDb, writeJourney } from './action-kit.js'
import { listJobs } from './actions-jobs.js'

/** The order the app shows a revision's pictures in: the assembly first, the board's own views after. */
export const SHOT_ORDER: readonly Shot[] = ['exploded', 'board-in-case', 'case', 'board', 'board-top', 'board-bottom']
export const SHOT_LABEL: Readonly<Record<Shot, string>> = {
  exploded: 'Exploded', 'board-in-case': 'Board in case', case: 'Case', board: 'Board', 'board-top': 'Top', 'board-bottom': 'Underside',
}

export interface RenderPicture { name: string; shot: Shot; label: string; bytes: number | null; width: number | null; height: number | null }
export interface RevisionRenders {
  revision: string
  /** the day the revision was cut, YYYY-MM-DD */
  date: string
  run: string
  /** when the renders were made (ISO) */
  at: string | null
  commit: string | null
  palette: { source: 'logo' | 'neutral'; base: string; accent: string; neutral: string; background: [string, string]; logo: string | null }
  case: string | null
  pictures: RenderPicture[]
}
export interface MakingRenders { revision: string; date: string | null; job: string; state: string; step: string | null; since: string | null }

const has = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))
const iso = (t: number | null | undefined): string | null => (typeof t === 'number' ? new Date(t * 1000).toISOString() : null)

/** Every revision's renders in a run record, newest revision first; the newest passing run of each revision wins. */
export function readRenders(db: DatabaseSync): RevisionRenders[] {
  if (!has(db, 'runs')) return []
  const rows = db.prepare("SELECT id, result, git_sha, finished, started FROM runs WHERE kind='render.showcase' AND status='pass' ORDER BY started DESC, id DESC").all() as
    { id: string; result: string | null; git_sha: string | null; finished: number | null; started: number }[]
  const sizes = has(db, 'artifacts') ? db.prepare('SELECT name, length(bytes) AS n FROM artifacts WHERE run_id=?') : null
  const out = new Map<string, RevisionRenders>()
  for (const r of rows) {
    let raw: Record<string, unknown> | null = null
    try { raw = r.result ? JSON.parse(r.result) as Record<string, unknown> : null } catch { raw = null }
    const rec = showcaseRecord(raw)
    if (!rec || out.has(rec.revision)) continue
    const stored = new Map(((sizes?.all(r.id) ?? []) as { name: string; n: number }[]).map((x) => [x.name, x.n]))
    const dims = new Map(((Array.isArray(raw?.artifacts) ? raw.artifacts : []) as { name?: unknown; width?: unknown; height?: unknown; bytes?: unknown }[])
      .filter((a) => typeof a.name === 'string').map((a) => [a.name as string, a]))
    const pictures = Object.entries(rec.shots)
      .filter(([name]) => stored.has(name))
      .map(([name, shot]) => {
        const d = dims.get(name)
        return {
          name, shot, label: SHOT_LABEL[shot],
          bytes: typeof d?.bytes === 'number' ? d.bytes : null,
          width: typeof d?.width === 'number' ? d.width : null,
          height: typeof d?.height === 'number' ? d.height : null,
        }
      })
      .sort((a, b) => SHOT_ORDER.indexOf(a.shot) - SHOT_ORDER.indexOf(b.shot))
    if (!pictures.length) continue
    const look = (raw?.case as { look?: unknown } | null | undefined)?.look
    out.set(rec.revision, {
      revision: rec.revision, date: rec.date, run: r.id, at: iso(r.finished ?? r.started), commit: r.git_sha,
      palette: { ...rec.palette, logo: rec.palette.logo?.path ?? null },
      case: typeof look === 'string' ? look : null,
      pictures,
    })
  }
  // newest revision first: B before A, AA after Z
  return [...out.values()].sort((a, b) => b.revision.length - a.revision.length || b.revision.localeCompare(a.revision))
}

/** The revision and day a rendering job's request names (rendersRequest), or null for any other job. */
export function revisionOfRequest(text: string | null | undefined): { revision: string; date: string } | null {
  const m = /Revision ([A-Z]{1,3}) was cut on (\d{4}-\d{2}-\d{2})/.exec(text ?? '')
  return m ? { revision: m[1] as string, date: m[2] as string } : null
}

async function making(ctx: Context, repo: string): Promise<MakingRenders[]> {
  const { rows } = await listJobs(ctx, repo)
  const out: MakingRenders[] = []
  for (const j of rows) {
    if (j.agent !== 'render' || !['queued', 'running', 'paused'].includes(j.state)) continue
    let request: string | null = null
    try { request = j.payload ? String((JSON.parse(j.payload) as { request?: unknown }).request ?? '') : null } catch { request = null }
    const rev = revisionOfRequest(request) ?? revisionOfRequest(j.title)
    if (!rev) continue
    out.push({ revision: rev.revision, date: rev.date, job: j.id, state: j.state, step: j.step, since: iso(j.startedAt ?? j.queuedAt) })
  }
  return out
}

export const RENDER_ACTIONS = {
  'renders.list': def('read', Repo, async (a, ctx) => {
    const [revisions, now] = await Promise.all([
      withProjectDb(ctx, a.repo, (path) => { const w = new Work(path); try { return readRenders(w.db) } finally { w.close() } }).catch(() => [] as RevisionRenders[]),
      // the job index may not answer (no jobs runtime here): the made renders still show
      making(ctx, a.repo).catch(() => [] as MakingRenders[]),
    ])
    return { repo: a.repo, revisions, making: now, shots: SHOTS }
  }),
  'renders.seen': def('read', Repo.extend({ revision: z.string().regex(/^[A-Z]{1,3}$/) }), async (a, ctx) => {
    const who = hashOf(ctx.principal)
    return plainly(() => writeJourney(ctx, a.repo, (db) => {
      const before = loadJourney(db)
      const ready = before?.decisions.find((d) => d.kind === 'renders.ready' && (d.detail as { revision?: unknown } | null)?.revision === a.revision)
      // no renders recorded as ready (made before this, or by hand): nothing to clear
      if (!ready) return { result: { repo: a.repo, revision: a.revision, seen: false }, changed: false }
      const seen = before?.opens.some((o) => o.item === `renders:${a.revision}` && o.who === who && o.at >= ready.at) ?? false
      if (seen) return { result: { repo: a.repo, revision: a.revision, seen: true }, changed: false }
      recordOpen(db, { renders: a.revision }, who)
      return { result: { repo: a.repo, revision: a.revision, seen: true } }
    }))
  }),
}
