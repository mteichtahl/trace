/**
 * A request to move a project between GitHub and trace's GitLab (docs/gitlab-projects.md "Moving a project"), kept at
 * installation/pending-moves/<owner>/<repo>.json in the central bucket. The API writes it (project.move, an admin's)
 * and pauses the project; the installation's update applies it: it sets the project's forge in the settings, deploys
 * (the project's roles and runner for its new home), runs the mover (src/core/forge-move.ts), sets the new home up,
 * and resumes the project. The record carries how far that has got, so the web app shows each step as it happens.
 *
 *   waiting   asked for; the update has not taken it yet (an admin may still cancel it)
 *   moving    the update is on it: `step` names the step, `lines` the steps done
 *   moved     done: `changes` and `issues` map the old numbers to the new ones
 *   failed    stopped at `step` with `error`; the old home is as it was (it is archived only as the last step), and
 *             the project stays paused until it is tried again or cancelled
 *   cancelled an admin took it back before the update took it
 */
import { z } from 'zod'
import { projectSlug } from './project.js'

export const FORGES = ['github', 'gitlab'] as const
export type ForgeName = (typeof FORGES)[number]

export const forgeLabel = (f: ForgeName): string => (f === 'gitlab' ? "trace's GitLab" : 'GitHub')

/** Under the central bucket, with its trailing slash. */
export const MOVES_PREFIX = 'installation/pending-moves/'
/** A move's key under the `installation` store prefix (as the API's storeAt writes it). */
export const moveKey = (repo: string): string => `pending-moves/${projectSlug(repo)}.json`

/** The steps a move goes through, in order, as the progress view lists them. */
export const MOVE_STEPS = ['deploy', 'copy', 'changes', 'issues', 'setup', 'archive'] as const
export type MoveStep = (typeof MOVE_STEPS)[number]
export const MOVE_STEP_WORDS: Record<MoveStep, string> = {
  deploy: 'Getting the new home ready',
  copy: 'Copying every branch and tag',
  changes: 'Recreating open changes',
  issues: 'Recreating open issues',
  setup: 'Setting up the new home for trace',
  archive: 'Archiving the old home',
}

export const MoveRecordSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
  from: z.enum(FORGES),
  to: z.enum(FORGES),
  /** idle: once the project's running work has finished; now: running tasks are asked to pause first */
  when: z.enum(['idle', 'now']).default('idle'),
  requested_by: z.string(),
  requested_at: z.string(),
  status: z.enum(['waiting', 'moving', 'moved', 'failed', 'cancelled']).default('waiting'),
  step: z.enum(MOVE_STEPS).nullable().default(null),
  lines: z.array(z.string()).default([]),
  changes: z.record(z.string(), z.number()).default({}),
  issues: z.record(z.string(), z.number()).default({}),
  error: z.string().optional(),
  /** whether the project was paused for this move (and so is resumed when it is done or cancelled) */
  paused_for_move: z.boolean().default(true),
  finished_at: z.string().optional(),
}).loose()
export type MoveRecord = z.output<typeof MoveRecordSchema>

/** A move that is still going: one at a time per project. */
export const inFlight = (r: Pick<MoveRecord, 'status'> | null): boolean => r !== null && (r.status === 'waiting' || r.status === 'moving')

/** The reason the project is paused while it moves (project.pause's reason; a person reads it on the project). */
export const movePauseReason = (to: ForgeName): string => `moving to ${forgeLabel(to)}`
