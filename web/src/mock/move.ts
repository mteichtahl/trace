/**
 * Mock answers for moving a project between GitHub and trace's GitLab (src/api/actions-move.ts): project.move_status,
 * project.move and project.move_cancel, kept in memory for the session. A move goes through its steps by the clock
 * (about four seconds each, after a short wait for the "update"), so the progress view can be watched; the move ends
 * moved, and the project is resumed then, as project.move_status resumes it. acme/motor-driver starts on trace's GitLab.
 * VITE_MOCK_MOVE picks a state to show on acme/soil-sensor at load: moving (at its copy step), failed, or moved.
 * Registered in handlers.ts.
 */
import type { Forge, ForgeMove, MoveStep } from '@/lib/types'
import { ME } from './fixtures'
import { setMovePause } from './lifecycle'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown) => json({ ok: true, result })
const refuse = (error: string) => json({ ok: false, error })

const STEPS: MoveStep[] = ['deploy', 'copy', 'changes', 'issues', 'archive', 'setup']
const LINES: Record<MoveStep, (m: ForgeMove) => string> = {
  deploy: () => 'the new home deployed',
  copy: () => 'copied every branch and tag',
  changes: () => 'recreated 2 open changes',
  issues: () => 'recreated 1 open issue',
  archive: (m) => `archived ${m.repo} (read-only, not deleted)`,
  setup: (m) => `set up on ${m.to === 'gitlab' ? "trace's GitLab" : 'GitHub'} for trace`,
}
const WAIT_MS = 3000
const STEP_MS = 4000
const name = (f: Forge) => (f === 'gitlab' ? "trace's GitLab" : 'GitHub')

const homes = new Map<string, Forge>([['acme/motor-driver', 'gitlab']])
const moves = new Map<string, { move: ForgeMove; started: number }>()
const forgeOf = (repo: string): Forge => homes.get(repo) ?? 'github'

function start(repo: string, to: Forge, when: 'idle' | 'now', o: { at?: number } = {}): ForgeMove {
  const move: ForgeMove = {
    repo, from: forgeOf(repo), to, when, requested_by: ME.email, requested_at: new Date().toISOString(), status: 'waiting', step: null,
    lines: [], changes: {}, issues: {}, todo: [], idle_at: new Date().toISOString(),
  }
  moves.set(repo, { move, started: o.at ?? Date.now() })
  setMovePause(repo, `moving to ${name(to)}`)
  return move
}

/** The move as the clock leaves it. */
function advance(repo: string): ForgeMove | null {
  const m = moves.get(repo)
  if (!m) return null
  const { move } = m
  if (move.status !== 'waiting' && move.status !== 'moving') return move
  const t = Date.now() - m.started - WAIT_MS
  if (t < 0) return move
  const i = Math.floor(t / STEP_MS)
  if (i >= STEPS.length) {
    const done: ForgeMove = { ...move, status: 'moved', step: null, lines: STEPS.map((s) => LINES[s](move)), changes: { 12: 3, 14: 4 }, issues: { 9: 5 }, finished_at: new Date().toISOString() }
    m.move = done
    homes.set(repo, move.to)
    setMovePause(repo, null)
    return done
  }
  m.move = { ...move, status: 'moving', step: STEPS[i] ?? null, lines: STEPS.slice(0, i).map((s) => LINES[s](move)) }
  return m.move
}

// a state to show at load (screenshots of each screen)
const show = import.meta.env.VITE_MOCK_MOVE as string | undefined
if (show === 'moving') start('acme/soil-sensor', 'gitlab', 'now', { at: Date.now() - WAIT_MS - STEP_MS - 1000 })
if (show === 'failed') {
  const m = start('acme/soil-sensor', 'gitlab', 'now')
  moves.set('acme/soil-sensor', { started: 0, move: { ...m, status: 'failed', step: 'changes', lines: ['copied every branch and tag'], error: "trace's GitLab refused the open change trace/power: 500 Internal Server Error", finished_at: new Date().toISOString() } })
}
if (show === 'moved') {
  start('acme/soil-sensor', 'gitlab', 'now', { at: Date.now() - WAIT_MS - STEP_MS * STEPS.length - 1000 })
  advance('acme/soil-sensor')
}

export function moveAction(action: string, a: Record<string, unknown>): Response | undefined {
  const repo = String(a.repo ?? '')
  switch (action) {
    case 'project.move_status':
      return ok({ move: advance(repo), forge: forgeOf(repo), gitlab: true })
    case 'project.move': {
      const to = a.to === 'gitlab' ? 'gitlab' : 'github'
      const had = advance(repo)
      if (forgeOf(repo) === to) return refuse(`It is on ${name(to)} already.`)
      if (had && (had.status === 'waiting' || had.status === 'moving')) return refuse(`A move to ${name(had.to)} is under way already.`)
      const move = start(repo, to, a.when === 'now' ? 'now' : 'idle')
      return ok({ move, started: true, summary: `Moving to ${name(to)}. The project is paused meanwhile. trace is updating itself to make the move; this page shows each step.` })
    }
    case 'project.move_cancel': {
      const m = advance(repo)
      if (!m || (m.status !== 'waiting' && m.status !== 'failed')) return refuse(m?.status === 'moving' ? 'The move is under way: it cannot be taken back now.' : 'There is no move to cancel.')
      const move: ForgeMove = { ...m, status: 'cancelled', finished_at: new Date().toISOString() }
      moves.set(repo, { move, started: 0 })
      setMovePause(repo, null)
      return ok({ move, summary: `The move was ${m.status === 'failed' ? 'set aside' : 'cancelled'}: the project stays on ${name(m.from)}. It is resumed.` })
    }
  }
  return undefined
}
