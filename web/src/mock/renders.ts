/**
 * The Renders tab in mock mode (renders.list and the pictures' artifact): Soil sensor has Rev B's seven renders (the
 * exploded view, the turntable, the board in its case, the case, the board from three sides), Rev A's three board shots from before
 * it had a case, and Rev C's renders being made. The pictures are real renders of trace's sample board in its case,
 * made by render.showcase, kept small.
 */
import type { MakingRenders, RenderPicture, RendersView, RevisionRenders, Shot } from '@/lib/types-renders'
import boardTop from './renders/board-top.jpg?inline'
import boardBottom from './renders/board-bottom.jpg?inline'
import board from './renders/board.jpg?inline'
import boardInCase from './renders/board-in-case.jpg?inline'
import caseShot from './renders/case.jpg?inline'
import exploded from './renders/exploded.jpg?inline'
import turntable from './renders/turntable.mp4?inline'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown) => json({ ok: true, result })
const fail = (error: string) => json({ ok: false, error })
const SOIL = 'acme/soil-sensor'
const NOW = Date.now()
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const IMAGES: Readonly<Record<Shot, string>> = {
  exploded, turntable, 'board-in-case': boardInCase, case: caseShot, board, 'board-top': boardTop, 'board-bottom': boardBottom,
}
const LABEL: Readonly<Record<Shot, string>> = { exploded: 'Exploded', turntable: 'Turntable', 'board-in-case': 'Board in case', case: 'Case', board: 'Board', 'board-top': 'Top', 'board-bottom': 'Underside' }

const pics = (revision: string, date: string, shots: Shot[]): RenderPicture[] =>
  shots.map((shot) => shot === 'turntable'
    ? { name: `soil-sensor_rev-${revision}_${date}_turntable.mp4`, shot, label: LABEL[shot], bytes: 3_100_000, width: 1920, height: 1200 }
    : { name: `soil-sensor_rev-${revision}_${date}_${shot}.png`, shot, label: LABEL[shot], bytes: 4_800_000, width: 2560, height: 1600 })

const LOGO = { source: 'logo' as const, base: '#1d3557', accent: '#e63946', neutral: '#a8b0ba', background: ['#4075bf', '#14253d'] as [string, string], logo: 'docs/design/logo.png' }

const REVISIONS: RevisionRenders[] = [
  { revision: 'B', date: '2026-11-05', run: 'run_rnd_b', at: iso(22 * 60_000), commit: 'a41e9d0', palette: LOGO, case: 'nylon', pictures: pics('B', '2026-11-05', ['exploded', 'turntable', 'board-in-case', 'case', 'board', 'board-top', 'board-bottom']) },
  { revision: 'A', date: '2026-10-21', run: 'run_rnd_a', at: iso(15 * 86_400_000), commit: '9c02e1f', palette: LOGO, case: null, pictures: pics('A', '2026-10-21', ['board', 'board-top', 'board-bottom']) },
]
const MAKING: MakingRenders[] = [
  { revision: 'C', date: '2026-11-06', job: 'rnd_c', state: 'running', step: 'Rendering the board in its case (4 of 7).', since: iso(9 * 60_000) },
]

const shotOf = (name: string): Shot | null => (name.match(/_([a-z-]+)\.(?:png|mp4)$/)?.[1] as Shot | undefined) ?? null

/** renders.list, renders.seen and the renders' artifacts; undefined for anything else. */
export function rendersAction(name: string, a: Record<string, unknown>): Response | undefined {
  const repo = String(a.repo ?? '')
  if (name === 'renders.list') {
    const v: RendersView = repo === SOIL
      ? { repo, revisions: REVISIONS, making: MAKING, shots: ['board', 'board-top', 'board-bottom', 'case', 'board-in-case', 'exploded', 'turntable'] }
      : { repo, revisions: [], making: [], shots: [] }
    return ok(v)
  }
  if (name === 'renders.seen') return ok({ repo, revision: a.revision, seen: true })
  if (name === 'artifact' && typeof a.id === 'string' && a.id.startsWith('run_rnd_')) {
    const shot = shotOf(String(a.name))
    const url = shot ? IMAGES[shot] : undefined
    if (!url) return fail(`no artifact ${String(a.name)} on run ${a.id}`)
    const base64 = url.slice(url.indexOf(',') + 1)
    return ok({ id: a.id, name: a.name, mime: shot === 'turntable' ? 'video/mp4' : 'image/jpeg', size: Math.floor((base64.length * 3) / 4), base64 })
  }
  return undefined
}
