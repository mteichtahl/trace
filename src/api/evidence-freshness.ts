/**
 * Whether the runs trace's criteria cite as evidence still stand for the project (docs/ontology-plan.md P4.3): the
 * lineage of each (src/ontology/lineage.ts) against the default branch's files now. journey.get shows a criterion met on
 * out-of-date evidence as not met, with why, and journey.sign will not count it (src/core/journey.ts withStaleEvidence).
 *
 *   evidenceStaleness(ctx, repo, r)   a function from a run id to why it no longer stands (null: it does), or
 *                                     undefined when nothing can be told: no run is cited, the run record or a file
 *                                     cannot be read. Never a guess: a file that cannot be fetched is not "changed"
 */
import { type JourneyRecord } from '../core/journey.js'
import { filesRead, staleRuns } from '../ontology/lineage.js'
import { type Context, openProjectDb, withProjectDb } from './action-kit.js'

/** The runs cited as evidence by the met criteria trace owns. */
export const evidenceRuns = (r: JourneyRecord): string[] =>
  [...new Set(r.criteria.filter((c) => c.owner === 'trace' && c.status === 'met').flatMap((c) => c.evidence.filter((e) => e.kind === 'run').map((e) => e.ref)))]

export async function evidenceStaleness(ctx: Context, repo: string, r: JourneyRecord | null): Promise<((id: string) => string | null) | undefined> {
  if (!r) return undefined
  const runs = evidenceRuns(r)
  if (!runs.length) return undefined
  try {
    const gh = await ctx.deps.github()
    const { branch } = await gh.defaultBranch(repo)
    // one read of the run record (the default branch's), and each file it names from the same branch
    const stale = await withProjectDb(ctx, repo, async (path) => {
      const db = openProjectDb(path)
      try {
        const paths = filesRead(db, runs)
        if (!paths.length) return new Map<string, string>()
        const files = new Map(await Promise.all(paths.map(async (p) => [p, await gh.rawFile(repo, p, branch)] as const)))
        return staleRuns(db, runs, files)
      } finally {
        db.close()
      }
    })
    return stale.size ? (id) => stale.get(id) ?? null : undefined
  } catch {
    return undefined
  }
}
