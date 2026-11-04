/**
 * journey.replay (docs/ontology-plan.md P8.4): one project's record played back, a page at a time, for the graph
 * view's player (web/src/components/graph/replay.tsx).
 *
 *   journey.replay   read   { repo, after?, limit? } → { events, next, total, range, chapters, people, nodes }
 *                           events     the record's events oldest first (src/ontology/replay.ts journeyEvents): the
 *                                      journey record with its history, the agents' facts, the job index and the
 *                                      project's database (default branch), each typed by the ontology, with the
 *                                      graph node it changes and a caption; `after` is the last event id of the page
 *                                      before, `limit` at most 1000 (default 500)
 *                           chapters   each stage the first time it started (the first stage with the journey), for
 *                                      the player's chapter marks
 *                           people     who appears in the events, for its filter
 *                           nodes      the graph view's nodes the page's events name, as graph.neighbourhood draws
 *                                      them (a node the record no longer has is named by its id)
 *
 * Read-only, after the read check, like journey.get; a person's project access only. It is not on the connected
 * systems' list (src/api/service-policy.ts SERVICE_ACTIONS), though nothing in it writes, so it can join later.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { STAGE_NAMES, type StageId } from '../core/journey-catalog.js'
import { journeyEvents } from '../ontology/replay.js'
import { type Context, Repo, agentFactsStore, def, withRecordDb } from './action-kit.js'
import { type GraphNode, projectGraph } from './actions-graph.js'
import { jobIndex } from './actions-jobs.js'

const installation = (): string => process.env.TRACE_PREFIX ?? 'trace'

/** A bucket database's bytes opened read-only in a scratch folder for the length of `fn`, or null when there is none. */
async function withBytes<T>(ctx: Context, bytes: Uint8Array | null, fn: (db: DatabaseSync | null) => T | Promise<T>): Promise<T> {
  if (!bytes) return fn(null)
  const dir = mkdtempSync(join(ctx.deps.scratch, 'replay-'))
  try {
    writeFileSync(join(dir, 'x.db'), bytes)
    const db = new DatabaseSync(join(dir, 'x.db'), { readOnly: true })
    try { return await fn(db) } finally { db.close() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const REPLAY_ACTIONS = {
  'journey.replay': def('read', Repo.extend({
    after: z.string().max(400).optional(),
    limit: z.number().int().min(1).max(1000).default(500),
  }), async (a, ctx) => {
    const facts = await agentFactsStore(ctx, a.repo).bytes()
    const jobs = await jobIndex(ctx, a.repo).bytes()
    return withRecordDb(ctx, a.repo, async (db) => withBytes(ctx, facts, async (f) => withBytes(ctx, jobs, (j) => {
      const all = journeyEvents({ journey: db, project: db, facts: f, jobs: j }, { installation: installation(), project: a.repo })
      const from = a.after ? all.findIndex((e) => e.id === a.after) + 1 : 0
      const page = all.slice(from, from + a.limit)
      const chapters: { stage: StageId; name: string; t: number; at: string }[] = []
      for (const e of all) {
        if ((e.kind !== 'stage.started' && e.kind !== 'journey.started') || !e.stage || chapters.some((c) => c.stage === e.stage)) continue
        chapters.push({ stage: e.stage, name: STAGE_NAMES[e.stage] ?? e.stage, t: e.t, at: e.at })
      }
      const people = [...new Set(all.map((e) => e.who).filter((w): w is string => Boolean(w)))].sort()
      const g = projectGraph(db, a.repo)
      const nodes: Record<string, GraphNode> = {}
      for (const e of page) {
        for (const id of [e.node, ...(e.links ?? [])]) {
          if (!id || nodes[id]) continue
          const n = g.nodes.get(id)
          nodes[id] = n ?? { id, kind: (id.split(':')[0] === 'test' ? 'run' : id.split(':')[0]) as GraphNode['kind'], label: id.slice(id.indexOf(':') + 1), title: id }
        }
      }
      return {
        repo: a.repo, events: page, next: from + page.length < all.length ? page.at(-1)?.id ?? null : null, total: all.length,
        range: all.length ? { from: all[0]!.at, to: all.at(-1)!.at } : null, chapters, people, nodes,
      }
    })))
  }),
}
