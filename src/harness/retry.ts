/**
 * A GitHub read that a gateway timeout or a server error should not fail: GitHub answers a large git blob (the
 * project database, up to 100 MB) with a 504 now and then, which failed a whole worker run (testyyyu, pick). Only for
 * reads, which are safe to repeat; a 4xx is the request's own answer and is thrown at once.
 */
const TRANSIENT = new Set([500, 502, 503, 504])

export async function retried<T>(read: () => Promise<T>, o: { tries?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const tries = o.tries ?? 3
  const wait = o.waitMs ?? 2000
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let i = 1; ; i++) {
    try {
      return await read()
    } catch (e) {
      const status = (e as { status?: number }).status
      if (i >= tries || status === undefined || !TRANSIENT.has(status)) throw e
      await sleep(wait * i)
    }
  }
}
