/**
 * A revision's renders apply on their own and say so (docs/revision-renders.md): a rendering agent's change is
 * renders only when it adds render runs and touches nothing else of the run record; an applied one's renders.ready
 * decision is a Next item for everyone on the project until they open the renders, newest decision per revision,
 * gone after RENDERS_FRESH_S; its push opens the Renders tab.
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { rendersOnly } from '../../src/api/apply-renders.js'
import { type JourneyRecord, type Viewer, RENDERS_FRESH_S, decide, inboxItems, loadJourney, recordOpen, startJourney } from '../../src/core/journey.js'
import { DEFAULT_NOTIFY, wantsPush } from '../../src/core/notify-prefs.js'
import { Work, openProject } from '../../src/core/store.js'
import { messageFor } from '../../src/web/push-sender.js'

const PNG = new Uint8Array([137, 80, 78, 71])

/** A run record with a DRC run and a setting: the default branch's. */
function base(): { dir: string; w: Work } {
  const dir = mkdtempSync(join(tmpdir(), 'trace-apply-renders-'))
  mkdirSync(join(dir, '.git'))
  const w = new Work(join(dir, 'project.db'))
  const drc = w.start('kicad.drc', { subject: 'hardware/x.kicad_pcb' })
  w.measure(drc, 'errors', 0)
  w.finish(drc, 'pass', 'clean')
  w.db.prepare("INSERT INTO settings (key, value, updated, by) VALUES ('render.device', '\"auto\"', 1, 'me')").run()
  return { dir, w }
}

/** A copy of `src`'s database, as the change's head starts from. */
function copyOf(src: Work): Work {
  const dir = mkdtempSync(join(tmpdir(), 'trace-apply-renders-head-'))
  mkdirSync(join(dir, '.git'))
  src.db.exec(`VACUUM INTO '${join(dir, 'project.db')}'`)
  return new Work(join(dir, 'project.db'))
}

function showcase(w: Work, revision = 'B'): string {
  const id = w.start('render.showcase', { subject: 'hardware/x.kicad_pcb' })
  w.artifact(id, `x_rev-${revision}_2026-11-05_board.png`, PNG, 'image/png')
  w.inputs(id, [{ kind: 'file', ref: 'hardware/x.kicad_pcb', sha256: 'ab'.repeat(32) }])
  w.measure(id, 'render_seconds', 12, 's')
  w.finish(id, 'pass', 'rendered', { revision, date: '2026-11-05', shots: { [`x_rev-${revision}_2026-11-05_board.png`]: 'board' } })
  return id
}

describe('renders only', () => {
  it('passes a change that adds render runs with their files, inputs and measurements, and nothing else', () => {
    const b = base()
    const h = copyOf(b.w)
    const id = showcase(h)
    const r = rendersOnly(b.w.db, h.db)
    expect(r.ok).toBe(true)
    expect(r.ok && r.runs.map((x) => [x.id, x.kind])).toEqual([[id, 'render.showcase']])
  })

  it('counts every run as added when the default branch has no run record yet', () => {
    const b = base()
    const h = copyOf(b.w)
    showcase(h)
    expect(rendersOnly(null, h.db)).toMatchObject({ ok: false, why: expect.stringMatching(/kicad\.drc/) })
  })

  it('holds a change that adds another kind of run, changes a setting, alters or removes an existing run, or adds nothing', () => {
    const cases: [string, (w: Work) => void, RegExp][] = [
      ['another run', (w) => { showcase(w); const d = w.start('kicad.drc'); w.finish(d, 'pass') }, /kicad\.drc run, which is not a render/],
      ['a setting', (w) => { showcase(w); w.db.prepare("UPDATE settings SET value='\"cpu\"' WHERE key='render.device'").run() }, /settings table/],
      ['an existing run', (w) => { showcase(w); w.db.prepare("UPDATE runs SET summary='edited' WHERE kind='kicad.drc'").run() }, /runs table/],
      ['an existing measurement', (w) => { showcase(w); w.db.prepare("UPDATE measurements SET value=3 WHERE name='errors'").run() }, /measurements table/],
      ['a removed run', (w) => { showcase(w); w.db.prepare("DELETE FROM runs WHERE kind='kicad.drc'").run() }, /removes run/],
      ['nothing', () => undefined, /adds no run/],
    ]
    for (const [what, change, why] of cases) {
      const b = base()
      const h = copyOf(b.w)
      change(h)
      const r = rendersOnly(b.w.db, h.db)
      expect(r, what).toMatchObject({ ok: false, why: expect.stringMatching(why) })
    }
  })
})

const ADMIN: Viewer = { hash: 'a'.repeat(16), label: 'admin@example.com', admin: true, part: 'contributor' }
const REVIEWER: Viewer = { hash: 'r'.repeat(16), label: 'rev@example.com', admin: false, part: 'reviewer' }

function journey(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'trace-renders-next-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed', name: 'Soil sensor' })
  return db
}
const ready = (db: DatabaseSync, revision: string, pictures: number, at?: number): void => {
  decide(db, { kind: 'renders.ready', stage: 'release', ref: `run-${revision}`, by: 'trace', summary: 'ready', detail: { revision, date: '2026-11-05', run: `run-${revision}`, pictures } })
  if (at !== undefined) db.prepare("UPDATE decisions SET at=? WHERE kind='renders.ready' AND json_extract(detail, '$.revision')=?").run(at, revision)
}
const renders = (db: DatabaseSync, v: Viewer, at?: number) => inboxItems('acme/soil', loadJourney(db) as JourneyRecord, v, at).filter((i) => i.kind === 'renders')

describe('renders ready in Next', () => {
  it('is an item for everyone on the project, one per revision, until each person opens the renders', () => {
    const db = journey()
    ready(db, 'A', 3)
    ready(db, 'B', 6)
    expect(renders(db, ADMIN).map((i) => [i.id, i.summary, i.ref])).toEqual([
      ['renders:B', "Soil sensor: Revision B's renders are ready: 6 pictures.", { kind: 'renders', id: 'B' }],
      ['renders:A', "Soil sensor: Revision A's renders are ready: 3 pictures.", { kind: 'renders', id: 'A' }],
    ])
    expect(renders(db, REVIEWER)).toHaveLength(2)
    recordOpen(db, { renders: 'B' }, REVIEWER.hash)
    expect(renders(db, REVIEWER).map((i) => i.id)).toEqual(['renders:A'])
    expect(renders(db, ADMIN)).toHaveLength(2)
    expect(renders(db, ADMIN)[0]).toMatchObject({ blocking: false, action: 'See the renders' })
  })

  it('comes back for renders made again after they were opened, and leaves after RENDERS_FRESH_S', () => {
    const db = journey()
    ready(db, 'B', 6, 1000)
    recordOpen(db, { renders: 'B' }, ADMIN.hash)
    expect(renders(db, ADMIN)).toEqual([])
    ready(db, 'C', 6)
    const now = Date.now() / 1000
    expect(renders(db, ADMIN, now).map((i) => i.id)).toEqual(['renders:C'])
    expect(renders(db, ADMIN, now + RENDERS_FRESH_S + 60)).toEqual([])
  })

  it('refuses to mark renders seen that were never ready', () => {
    expect(() => recordOpen(journey(), { renders: 'Z' }, ADMIN.hash)).toThrow(/no renders yet/)
  })

  it('pushes as "Renders ready", opening the Renders tab, when the person turned push on for it', () => {
    const db = journey()
    ready(db, 'B', 6)
    const m = messageFor(renders(db, ADMIN)[0]!)
    expect(m).toMatchObject({ title: 'Soil sensor · Renders ready', body: "Revision B's renders are ready: 6 pictures.", url: '/p/acme~soil/renders' })
    expect(wantsPush(DEFAULT_NOTIFY, 'renders', 'acme/soil')).toBe(false)
    const on = { ...DEFAULT_NOTIFY, kinds: { ...DEFAULT_NOTIFY.kinds, renders: { app: true, email: false, push: true } } }
    expect(wantsPush(on, 'renders', 'acme/soil')).toBe(true)
    expect(wantsPush({ ...on, projects: { 'acme/soil': 'gates-spend' } }, 'renders', 'acme/soil')).toBe(false)
  })
})
