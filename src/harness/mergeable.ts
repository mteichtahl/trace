/**
 * GitHub works out whether a pull request can merge lazily: right after a push to the default branch (a merge, which is
 * exactly when other changes fall into conflict) every open pull request reads `mergeable: null` /
 * `mergeable_state: 'unknown'` until GitHub has finished. A pick or queue run started by that push used to read
 * "unknown", skip the change, and leave a real conflict for the hourly safety net, so conflicts sat for up to an hour
 * looking like they needed a person.
 *
 *   settle   read each pull request once (that read is what starts GitHub's work), then read again only the ones still
 *            unknown, waiting SETTLE.waitMs between rounds, at most SETTLE.rounds rounds. What is still unknown after
 *            that is answered as GitHub last said: the next event or the safety net looks again
 *
 * SETTLE and its sleep are a module object so a test can make the waits instant.
 */
import type { GitHub } from './types.js'

export const SETTLE = {
  rounds: 5,
  waitMs: 3_000,
  sleep: (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms)),
}

export interface Mergeability { mergeable?: boolean | null | undefined; mergeable_state?: string | undefined }

/** GitHub has not finished working out whether it can merge. An absent field is not "unknown" (a test's fake). */
export const unsettled = (p: Mergeability): boolean => p.mergeable === null || p.mergeable_state === 'unknown'

/** In conflict with its base, once settled. */
export const conflicted = (p: Mergeability): boolean => p.mergeable === false || p.mergeable_state === 'dirty'

type Pull = Awaited<ReturnType<GitHub['rest']['pulls']['get']>>['data']

/** Each pull request in `numbers`, read until GitHub has settled whether it can merge (or SETTLE.rounds run out). */
export async function settle(github: GitHub, owner: string, repo: string, numbers: readonly number[]): Promise<Map<number, Pull>> {
  const get = async (n: number): Promise<Pull> => (await github.rest.pulls.get({ owner, repo, pull_number: n })).data
  const out = new Map<number, Pull>()
  for (const n of numbers) out.set(n, await get(n))
  for (let round = 1; round < SETTLE.rounds; round++) {
    const waiting = [...out.values()].filter(unsettled).map((p) => p.number)
    if (!waiting.length) break
    await SETTLE.sleep(SETTLE.waitMs)
    for (const n of waiting) out.set(n, await get(n))
  }
  return out
}
