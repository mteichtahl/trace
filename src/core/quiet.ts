/**
 * How long each step of a project's runs usually goes without saying anything, learned from its finished runs, so the
 * app can tell "quiet, as usual" from "later than usual" (docs/progress-and-logs.md, choice E).
 *
 *   where     projects/<slug>/progress/quiet.json in the central bucket (the store rooted at PROJECTS_PREFIX, key
 *             quietKey(repo)), written with a conditional put
 *   what      per step key (quietStepKey: the run's kind, what it is, the step's name) the longest silences of its last
 *             SAMPLES runs; the run refs already counted, so a run is learned once whoever reads it
 *   usual     usualQuietS: a quarter above the slowest of the recent samples (never under MIN_QUIET_S); DEFAULT_QUIET_S
 *             until the step has MIN_SAMPLES of them
 *
 * Learned by the API whenever it reads a finished run's whole log (run.log, change.runs), and by the worker runtime when
 * a job or tool run ends. Losing a write (a conflict past the retries) only means one run is not learned.
 */
import type { Backend } from './central.js'
import { Conflict } from './central.js'
import { projectSlug } from './project.js'
import { DEFAULT_QUIET_S, MIN_QUIET_S, type RunKind } from './run-logs.js'

export const SAMPLES = 10
export const MIN_SAMPLES = 2
const MAX_SEEN = 400
const MAX_STEPS = 500

export interface QuietProfile { v: 1; steps: Record<string, number[]>; seen: string[] }
export const emptyQuiet = (): QuietProfile => ({ v: 1, steps: {}, seen: [] })

export const quietKey = (repo: string): string => `${projectSlug(repo)}/progress/quiet.json`
/** One step of one kind of run: "check|board checks|Design rule check", "tool|sim.transient|Starting". */
export const quietStepKey = (kind: RunKind, what: string, step: string): string => `${kind}|${what.toLowerCase().slice(0, 80)}|${step.slice(0, 120)}`

/** The step's usual silence, in seconds. */
export function usualQuietS(p: QuietProfile | null | undefined, key: string): number {
  const s = p?.steps[key]
  if (!s || s.length < MIN_SAMPLES) return DEFAULT_QUIET_S
  return Math.max(MIN_QUIET_S, Math.round(Math.max(...s) * 1.25))
}

/** The profile with one finished run's gaps (stepGaps) folded in; unchanged when the run was already learned. Pure. */
export function learn(p: QuietProfile, run: string, kind: RunKind, what: string, gaps: Record<string, number>): QuietProfile {
  if (p.seen.includes(run)) return p
  const steps = { ...p.steps }
  for (const [step, gap] of Object.entries(gaps)) {
    const k = quietStepKey(kind, what, step)
    steps[k] = [...(steps[k] ?? []), gap].slice(-SAMPLES)
  }
  const keys = Object.keys(steps)
  if (keys.length > MAX_STEPS) for (const k of keys.slice(0, keys.length - MAX_STEPS)) delete steps[k]
  return { v: 1, steps, seen: [...p.seen, run].slice(-MAX_SEEN) }
}

function parse(b: Uint8Array | undefined): QuietProfile {
  if (!b) return emptyQuiet()
  try {
    const j = JSON.parse(new TextDecoder().decode(b)) as Partial<QuietProfile>
    if (j && j.v === 1 && j.steps && typeof j.steps === 'object' && Array.isArray(j.seen)) return { v: 1, steps: j.steps, seen: j.seen }
  } catch { /* a damaged file starts over */ }
  return emptyQuiet()
}

/** The project's profile (empty when there is none or the store cannot be read). */
export async function readQuiet(store: Backend, repo: string): Promise<QuietProfile> {
  const got = await store.get(quietKey(repo)).catch(() => null)
  return parse(got?.body)
}

/** Fold one finished run in, with a conditional put (three tries). Never throws. */
export async function learnQuiet(store: Backend, repo: string, run: string, kind: RunKind, what: string, gaps: Record<string, number>): Promise<boolean> {
  if (!Object.keys(gaps).length) return false
  for (let i = 0; i < 3; i++) {
    try {
      const got = await store.get(quietKey(repo))
      const before = parse(got?.body)
      const after = learn(before, run, kind, what, gaps)
      if (after === before) return false
      await store.put(quietKey(repo), new TextEncoder().encode(JSON.stringify(after)), got ? { ifMatch: got.etag, contentType: 'application/json' } : { ifNoneMatch: true, contentType: 'application/json' })
      return true
    } catch (e) {
      if (!(e instanceof Conflict)) return false
    }
  }
  return false
}
