/**
 * Moving a project between GitHub and trace's GitLab from the command line (an admin's; src/api/actions-move.ts, the
 * same as Settings › Where this project lives):
 *
 *   tracectl remote move OWNER/REPO --to gitlab|github [--now] [--watch]   ask for the move: once the work running now
 *                                                                       finishes, or --now (running tasks are asked
 *                                                                       to pause first); --watch prints each step
 *                                                                       until it is done or stops
 *   tracectl remote move status OWNER/REPO [--watch]                     where it lives, and the latest move
 *   tracectl remote move cancel OWNER/REPO                               take back a waiting move, or set aside a
 *                                                                       stopped one (it stays where it was)
 */
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { invokeApi } from './invoke.js'

const out = (s: string): void => { process.stdout.write(`${s}\n`) }
const err = (s: string): void => { process.stderr.write(`${s}\n`) }

const Repo = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected OWNER/REPO')
const Forge = z.enum(['github', 'gitlab'])
const name = (f: string): string => (f === 'gitlab' ? "trace's GitLab" : 'GitHub')

export const REMOTE_MOVE_USAGE = 'usage: tracectl remote move OWNER/REPO --to gitlab|github [--now] [--watch] | move status OWNER/REPO [--watch] | move cancel OWNER/REPO'

const STEP: Record<string, string> = {
  deploy: 'Getting the new home ready', copy: 'Copying every branch and tag', changes: 'Recreating open changes',
  issues: 'Recreating open issues', archive: 'Archiving the old home', setup: 'Setting up the new home for trace',
}

const Move = z.object({
  from: Forge, to: Forge, status: z.string(), step: z.string().nullable().optional(), requested_by: z.string(),
  changes: z.record(z.string(), z.number()).default({}), issues: z.record(z.string(), z.number()).default({}),
  error: z.string().optional(), todo: z.array(z.string()).default([]), idle_at: z.string().optional(), when: z.string().optional(),
}).loose()
type Move = z.infer<typeof Move>
const Status = z.object({ move: Move.nullable(), forge: Forge, gitlab: z.boolean() }).loose()

/** One line for where a move stands. Pure. */
export function moveLine(m: Move): string {
  switch (m.status) {
    case 'waiting': return m.when === 'idle' && !m.idle_at ? `Waiting for the work running now to finish, then moving to ${name(m.to)}.` : `Waiting for trace to update itself to move it to ${name(m.to)}.`
    case 'moving': return `Moving to ${name(m.to)}: ${STEP[m.step ?? ''] ?? 'under way'}.`
    case 'moved': {
      const renumbered = Object.entries(m.changes).map(([a, b]) => `#${a} → #${b}`).join(', ')
      return `Moved to ${name(m.to)}.${renumbered ? ` Open changes renumbered: ${renumbered}.` : ''} The old home on ${name(m.from)} is archived.`
    }
    case 'failed': return `The move to ${name(m.to)} stopped at "${STEP[m.step ?? ''] ?? m.step}": ${m.error ?? 'no reason given'}. It is still on ${name(m.from)}.`
    case 'cancelled': return `The move to ${name(m.to)} was cancelled: it stays on ${name(m.from)}.`
    default: return m.status
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Print each change of the move until it is done, stopped or cancelled. Exit 0 when moved. */
async function watch(repo: string, o: { every?: number } = {}): Promise<number> {
  let last = ''
  for (;;) {
    const s = Status.parse(await invokeApi('project.move_status', { repo }))
    const m = s.move
    if (!m) { out(`On ${name(s.forge)}; no move.`); return 0 }
    const line = moveLine(m)
    if (line !== last) { out(line); last = line }
    if (m.status === 'moved') { for (const t of m.todo) out(`- ${t}`); return 0 }
    if (m.status === 'failed' || m.status === 'cancelled') return 1
    await sleep(o.every ?? 10_000)
  }
}

export async function remoteMove(argv: string[], o: { every?: number } = {}): Promise<number> {
  const [first, ...rest] = argv
  if (first === 'status' || first === 'cancel') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { watch: { type: 'boolean' } } })
    if (!positionals[0]) { err(REMOTE_MOVE_USAGE); return 2 }
    const repo = Repo.parse(positionals[0])
    if (first === 'cancel') {
      out(z.object({ summary: z.string() }).loose().parse(await invokeApi('project.move_cancel', { repo })).summary)
      return 0
    }
    if (values.watch) return watch(repo, o)
    const s = Status.parse(await invokeApi('project.move_status', { repo }))
    out(`On ${name(s.forge)}.${s.gitlab ? '' : " This installation has no GitLab."}`)
    if (s.move) out(moveLine(s.move))
    return 0
  }
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { to: { type: 'string' }, now: { type: 'boolean' }, watch: { type: 'boolean' } } })
  if (!positionals[0] || !values.to) { err(REMOTE_MOVE_USAGE); return 2 }
  const repo = Repo.parse(positionals[0])
  const r = z.object({ summary: z.string() }).loose().parse(await invokeApi('project.move', { repo, to: Forge.parse(values.to), when: values.now ? 'now' : 'idle' }))
  out(r.summary)
  if (!values.watch) { out(`Follow it with: tracectl remote move status ${repo} --watch`); return 0 }
  return watch(repo, o)
}
