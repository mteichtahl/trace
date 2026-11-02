/**
 * What the changes cost GitHub, held down (docs/guided-flow.md "Decisions from the security review", GitHub's
 * allowance). Every project's calls go out on one shared token, whose limit is GitHub's (5,000 an hour), and one open
 * review page, an overview and an inbox each look again every minute or so; without these, one person's open tabs
 * could spend the token everyone's agents need.
 *
 *   GitHubCache   answers kept in this container for a short while (TTL_MS): the open pull requests (per repository),
 *                 a pull request's status and a commit's check runs (per repository and head commit), and a pull
 *                 request's files (per repository, number and head commit). A push makes a new head commit, so the
 *                 next look misses at once; what does not change the head (a check finishing, a merge) shows within
 *                 TTL_MS. Two looks at once share one call. A failure is never kept. `bust` forgets one repository
 *                 (after accepting, asking or discarding there, and when GitHub's webhook names it). Each AgentCore
 *                 session is its own container, so this is per person, and a bust reaches only the container it runs in:
 *                 the TTL is what bounds everyone else's
 *   GitHubBudget  how many GitHub-touching change actions one principal may make a minute (PER_MINUTE), counted apart
 *                 from the runtime's request limit: a person, or a script with their token, that asks for more is
 *                 told in plain words when to try again
 */
import { ActionError } from './action-kit.js'

export const TTL_MS = 20_000
/** The repository's settings that decide which pull requests are trace's (default branch, prefix, agent login) change
 * rarely; they are kept longer. */
export const SETTINGS_TTL_MS = 5 * 60_000
export const PER_MINUTE = 60
/** Entries kept at most (the oldest goes first). */
const MAX_ENTRIES = 2_000

interface Entry { at: number; ttl: number; value: Promise<unknown> }

export class GitHubCache {
  private readonly entries = new Map<string, Entry>()
  constructor(private readonly o: { now?: () => number; ttlMs?: number } = {}) {}

  private now(): number { return (this.o.now ?? Date.now)() }

  /**
   * The answer kept under `repo` and `key`, or `fn`'s (kept for `ttlMs`, TTL_MS by default). A look while one is on its
   * way waits for that one. A failed look is forgotten, so the next tries again.
   */
  async get<T>(repo: string, key: string, fn: () => Promise<T>, ttlMs?: number): Promise<T> {
    const k = `${repo.toLowerCase()}\u0000${key}`
    const hit = this.entries.get(k)
    if (hit && this.now() - hit.at < hit.ttl) return hit.value as Promise<T>
    const value = fn()
    this.entries.delete(k)
    this.entries.set(k, { at: this.now(), ttl: ttlMs ?? this.o.ttlMs ?? TTL_MS, value })
    if (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value as string)
    value.catch(() => { if (this.entries.get(k)?.value === value) this.entries.delete(k) })
    return value
  }

  /** Forget everything kept for `repo`. */
  bust(repo: string): void {
    const pre = `${repo.toLowerCase()}\u0000`
    for (const k of [...this.entries.keys()]) if (k.startsWith(pre)) this.entries.delete(k)
  }
}

/** A call through `cache` when there is one, else straight to GitHub (tests, and a runtime made without one). */
export const cached = <T>(cache: GitHubCache | undefined, repo: string, key: string, fn: () => Promise<T>, ttlMs?: number): Promise<T> =>
  (cache ? cache.get(repo, key, fn, ttlMs) : fn())

/** A fixed window per principal (by sub), in this container: at most `perMinute` GitHub-touching change actions. */
export class GitHubBudget {
  private readonly windows = new Map<string, { minute: number; n: number }>()
  constructor(private readonly perMinute = PER_MINUTE, private readonly now: () => number = Date.now) {}

  /** Count one; throws an ActionError saying when to try again once over the budget. */
  take(sub: string): void {
    const t = this.now() / 1000
    const minute = Math.floor(t / 60)
    const w = this.windows.get(sub)
    const cur = w && w.minute === minute ? w : { minute, n: 0 }
    if (cur.n >= this.perMinute) {
      const wait = Math.max(1, Math.ceil((minute + 1) * 60 - t))
      throw new ActionError(`You looked at changes on GitHub more than ${this.perMinute} times in a minute, and they share trace's GitHub allowance with everyone's agents. Try again in ${wait} s.`)
    }
    cur.n++
    this.windows.delete(sub)
    this.windows.set(sub, cur)
    if (this.windows.size > 10_000) this.windows.delete(this.windows.keys().next().value as string)
  }
}
