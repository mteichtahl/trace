/**
 * POST /api/hooks/github: GitHub tells trace that a change moved (docs/guided-flow.md "Live updates"), so the screens
 * of the people on that project look again at once instead of at their next poll.
 *
 *   accept   only a delivery signed with the webhook secret (X-Hub-Signature-256: HMAC SHA-256 of the exact body,
 *            compared in constant time), of the events the installer subscribes to (pull_request, check_run,
 *            check_suite, status), at most MAX_BODY bytes, naming a repository that is a trace project. Anything else
 *            is dropped: 204 and one log line saying why (never the body). A good one is 202
 *   secret   Secrets Manager, `<prefix>/web/github-hooks` (JSON: the webhook secret, and the backend's own client
 *            secret below), made and filled by the installer, which registers the hooks with it. Kept SECRET_TTL_MS;
 *            a signature that does not match a copy older than SECRET_RECHECK_MS reads it again once, so a secret the
 *            installer replaced is picked up without waiting
 *   who      the API runtime decides: `hook.members { repo }` (src/api/actions-hooks.ts), called with the backend's
 *            own token (client credentials of `<prefix>-web-hooks`, scope trace-internal/members;
 *            src/api/backend-auth.ts). It answers whether the repository is a project and the subs of the people on
 *            it, nothing else. The backend never reads the access store. Kept MEMBERS_TTL_MS per repository, so a burst
 *            asks once. Asked before answering, for at most MEMBERS_WAIT_MS: a repository that is not a project is a
 *            204; when the API is slower than that, the delivery is taken (202) and the answer is awaited after
 *   publish  `record.changed { repo, kind: 'change', number? }` to each person's channel (src/web/events.ts), naming no
 *            content, as every live event. One push sets off dozens of check_run and status deliveries, each its own
 *            invocation and often its own container, so the debounce is shared (Debounce over a DebounceStore: the
 *            DynamoDB table `<prefix>-web-hooks` in production). The first delivery of a quiet repository publishes
 *            at once and holds the window (DEBOUNCE_MS); deliveries inside it only note their number; when the window
 *            ends the holder takes what was noted and publishes once more (the number when one change was noted,
 *            else none: "something on this project moved"), and holds a new window while deliveries keep coming, for
 *            at most MAX_ROUNDS. When the store cannot be reached the delivery publishes on its own (fail open: the
 *            app looks again once more, nothing is lost)
 *
 * Reached through CloudFront's /api/hooks/* behaviour, which goes to a function of its own (`<prefix>-web-hooks`,
 * src/web/hooks-lambda.ts, the backend's code and role) behind a function URL without IAM: origin access control signs
 * every request to the backend's URL, and Lambda refuses a signed POST without x-amz-content-sha256, which GitHub never
 * sends. The signature checked here is what keeps others out; that function serves this path and nothing else.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { callApi } from './call.js'
import type { WebConfig } from './config.js'
import type { WebDeps } from './deps.js'
import { type LiveEvent, type Publisher, appsyncPublisher, publishToEach } from './events.js'
import { type Reply, type WebRequest, route } from './http.js'

/** The events the installer subscribes each project's hook to (src/installer/hooks.ts registers exactly these). */
export const HOOK_EVENTS = ['pull_request', 'check_run', 'check_suite', 'status'] as const
/** The largest delivery read: none of these four comes near it (GitHub's own cap is 25 MB). */
export const MAX_BODY = 1024 * 1024
export const SECRET_TTL_MS = 5 * 60_000
export const SECRET_RECHECK_MS = 30_000
export const MEMBERS_TTL_MS = 60_000
/** How long a delivery waits for hook.members before it is answered anyway (GitHub waits ten seconds). */
export const MEMBERS_WAIT_MS = 6_000
export const DEBOUNCE_MS = 5_000
/** Windows one holder keeps while deliveries keep coming (the hooks function's 60 s timeout bounds it too). */
export const MAX_ROUNDS = 6
/** Repositories remembered for the members' cache (the oldest goes first). */
const MAX_REPOS = 500

/** Whether `signature` (the X-Hub-Signature-256 header, `sha256=<hex>`) is the HMAC of `body` with `secret`. */
export function signatureOk(secret: string, body: string, signature: string | undefined): boolean {
  if (!secret || !signature?.startsWith('sha256=')) return false
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`)
  const got = Buffer.from(signature)
  return got.length === want.length && timingSafeEqual(got, want)
}

const Slug = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/)
const Num = z.number().int().positive()
const Prs = z.array(z.object({ number: Num }).loose()).optional()
const Delivery = z.object({
  repository: z.object({ full_name: Slug }).loose(),
  pull_request: z.object({ number: Num }).loose().optional(),
  number: Num.optional(),
  check_run: z.object({ pull_requests: Prs }).loose().optional(),
  check_suite: z.object({ pull_requests: Prs }).loose().optional(),
}).loose()

export interface HookEvent { repo: string; number: number | null; event: string }

/** Whether trace takes this kind of event at all (X-GitHub-Event). */
export const takes = (event: string | undefined): event is (typeof HOOK_EVENTS)[number] => Boolean(event) && (HOOK_EVENTS as readonly string[]).includes(event ?? '')

/** What a delivery is about, or why it is dropped. Pure: the signature is checked before. */
export function readDelivery(event: string | undefined, body: string): HookEvent | { drop: string } {
  if (!takes(event)) return { drop: `not an event trace takes (${event ? event.slice(0, 40) : 'none'})` }
  let json: unknown
  try { json = JSON.parse(body) } catch { return { drop: 'not JSON' } }
  const d = Delivery.safeParse(json)
  if (!d.success) return { drop: 'no repository in it' }
  const v = d.data
  // a status names a commit, not a change; a check names the changes it ran for (same-repository ones only)
  const number = v.pull_request?.number ?? v.number ?? v.check_run?.pull_requests?.[0]?.number ?? v.check_suite?.pull_requests?.[0]?.number ?? null
  return { repo: v.repository.full_name.toLowerCase(), number, event }
}

// ------------------------------------------------------------------ the debounce, shared between containers

/**
 * One window per repository, shared by every container. `claim` takes the window when it is free (or over) and holds it
 * until `until`; `join` notes a number in a window someone holds; `release` frees the window and answers what was noted
 * in it. Numbers are noted as given, null for a delivery that named none.
 */
export interface DebounceStore {
  claim(repo: string, until: number, now: number): Promise<boolean>
  join(repo: string, number: number | null, now: number): Promise<boolean>
  release(repo: string, now: number): Promise<(number | null)[]>
}

/** The store in this container's memory (tests, and a backend without the table). */
export class MemoryDebounceStore implements DebounceStore {
  private readonly at = new Map<string, { until: number; noted: Set<number | null> }>()
  async claim(repo: string, until: number, now: number): Promise<boolean> {
    const w = this.at.get(repo)
    if (w && w.until > now) return false
    this.at.delete(repo)
    this.at.set(repo, { until, noted: new Set() })
    if (this.at.size > MAX_REPOS) this.at.delete(this.at.keys().next().value as string)
    return true
  }
  async join(repo: string, number: number | null, now: number): Promise<boolean> {
    const w = this.at.get(repo)
    if (!w || w.until <= now) return false
    w.noted.add(number)
    return true
  }
  async release(repo: string, now: number): Promise<(number | null)[]> {
    const w = this.at.get(repo)
    if (!w) return []
    w.until = now
    const noted = [...w.noted]
    w.noted.clear()
    return noted
  }
}

/**
 * The debounce (see the file's comment). `offer` resolves when this delivery's part is done: 'published' (it held the
 * window: it published at once, and what came in its windows after), 'joined' (a holder publishes it), or 'alone' (the
 * store could not be reached: it published on its own).
 */
export class Debounce {
  constructor(
    private readonly store: DebounceStore,
    private readonly o: { windowMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; log?: (l: Record<string, unknown>) => void } = {},
  ) {}

  private get windowMs(): number { return this.o.windowMs ?? DEBOUNCE_MS }
  private now(): number { return (this.o.now ?? Date.now)() }
  private sleep(ms: number): Promise<void> { return (this.o.sleep ?? ((t) => new Promise((ok) => setTimeout(ok, t))))(ms) }

  async offer(repo: string, number: number | null, publish: (number: number | null) => Promise<void>): Promise<'published' | 'joined' | 'alone'> {
    try {
      // claim, else join; a window that ends between the two is claimed on the next try
      for (let i = 0; i < 3; i++) {
        if (await this.store.claim(repo, this.now() + this.windowMs, this.now())) {
          await publish(number)
          await this.hold(repo, publish)
          return 'published'
        }
        if (await this.store.join(repo, number, this.now())) return 'joined'
      }
    } catch (e) {
      this.o.log?.({ warning: 'hooks: the debounce store failed: publishing this one on its own', repo, error: e instanceof Error ? e.message.slice(0, 200) : String(e) })
    }
    await publish(number)
    return 'alone'
  }

  /** The holder: at each window's end, publish what was noted (once), and hold another window while there was any. */
  private async hold(repo: string, publish: (number: number | null) => Promise<void>): Promise<void> {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      await this.sleep(this.windowMs)
      const noted = [...new Set(await this.store.release(repo, this.now()))]
      if (!noted.length) return
      await publish(noted.length === 1 ? noted[0] ?? null : null)
      // keep the window while deliveries keep coming; someone else may have claimed it in between: then they hold it
      if (round === MAX_ROUNDS - 1 || !(await this.store.claim(repo, this.now() + this.windowMs, this.now()))) return
    }
  }
}

// ------------------------------------------------------------------ the route

const HooksSecret = z.object({ webhookSecret: z.string().min(16), clientSecret: z.string().min(1).optional() }).loose()
const TokenAnswer = z.object({ access_token: z.string().min(1), expires_in: z.number().positive().default(3600) }).loose()
const MembersAnswer = z.object({ ok: z.literal(true), result: z.object({ project: z.boolean(), subs: z.array(z.string().min(1)) }).loose() }).loose()

export interface HooksOptions {
  publisher?: () => Publisher
  /** the debounce (default: over deps.hookStore, else this container's memory) */
  debounce?: Debounce
}

interface Members { at: number; project: boolean; subs: string[] }

/** The route, and what it keeps between deliveries in this container. */
export function hooksRoutes(deps: WebDeps, o: HooksOptions = {}) {
  let debounce = o.debounce ?? null
  let secret: { at: number; value: z.output<typeof HooksSecret> } | null = null
  let token: { value: string; until: number } | null = null
  const members = new Map<string, Members>()

  /** A delivery trace does not act on: 204, and one line saying why (never its body). */
  const drop = (why: string, req: WebRequest, more: Record<string, unknown> = {}): Reply => {
    deps.log({ hook: 'dropped', why, event: req.headers['x-github-event']?.slice(0, 40) ?? null, delivery: req.headers['x-github-delivery']?.slice(0, 64) ?? null, ...more })
    return { status: 204, body: null }
  }

  /** The secret (cached); `again`: read it now unless the copy is younger than SECRET_RECHECK_MS. */
  async function hooksSecret(cfg: WebConfig, again = false): Promise<{ value: z.output<typeof HooksSecret>; read: boolean }> {
    const t = deps.now()
    if (secret && t - secret.at < (again ? SECRET_RECHECK_MS : SECRET_TTL_MS)) return { value: secret.value, read: false }
    const port = deps.secrets?.(cfg)
    if (!port || !cfg.hooks) throw new Error('no secrets port')
    secret = { at: t, value: HooksSecret.parse(JSON.parse(await port.get(cfg.hooks.secret))) }
    return { value: secret.value, read: true }
  }

  /** The backend's own access token for hook.members (client credentials), kept until a minute before it expires. */
  async function backendToken(cfg: WebConfig): Promise<string> {
    const h = cfg.hooks
    if (!h) throw new Error('live updates from GitHub are off')
    if (token && deps.now() < token.until) return token.value
    const clientSecret = (await hooksSecret(cfg)).value.clientSecret
    if (!clientSecret) throw new Error('the backend\'s client secret is not stored yet (the installer stores it)')
    const r = await deps.fetch(h.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${h.clientId}:${clientSecret}`).toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: h.scope }).toString(),
      signal: AbortSignal.timeout(5000),
    })
    const t = TokenAnswer.safeParse(await r.json().catch(() => null))
    if (!r.ok || !t.success) throw new Error(`the sign-in address answered ${r.status} for the backend's token`)
    token = { value: t.data.access_token, until: deps.now() + (t.data.expires_in - 60) * 1000 }
    return token.value
  }

  /** Who is on `repo`, as the API runtime says (cached). Throws when it cannot say. */
  async function whoIsOn(cfg: WebConfig, repo: string, firstByteMs?: number): Promise<Members> {
    const hit = members.get(repo)
    if (hit && deps.now() - hit.at < MEMBERS_TTL_MS) return hit
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await backendToken(cfg)
      const a = await callApi(deps, { config: cfg, token: t, sub: 'backend:web-hooks' }, 'hook.members', { repo }, firstByteMs ? { firstByteMs } : {})
      // a token the runtime no longer takes (a rotated client secret): one fresh token, then give up
      if (a.status === 401 && attempt === 0) { token = null; continue }
      const m = MembersAnswer.safeParse(a.json)
      if (!m.success) throw new Error(`hook.members answered ${a.status}`)
      const v = { at: deps.now(), project: m.data.result.project, subs: m.data.result.subs }
      members.delete(repo)
      members.set(repo, v)
      if (members.size > MAX_REPOS) members.delete(members.keys().next().value as string)
      return v
    }
    throw new Error('hook.members refused the backend\'s token')
  }

  async function publish(cfg: WebConfig, d: HookEvent, number: number | null): Promise<void> {
    const on = await whoIsOn(cfg, d.repo)
    if (!on.project) return
    const e: LiveEvent = { type: 'record.changed', repo: d.repo, kind: 'change', ...(number ? { number } : {}), at: new Date(deps.now()).toISOString() }
    const pub = o.publisher?.() ?? appsyncPublisher(cfg, deps.credentials, deps.fetch)
    const { failed, of } = await publishToEach(pub, on.subs, e)
    deps.log({ hook: 'published', repo: d.repo, event: d.event, number, people: of, ...(failed ? { failed } : {}) })
  }

  return [
    route('POST', '/api/hooks/github', async (req) => {
      const cfg = await deps.config()
      if (!cfg.hooks) return drop('live updates from GitHub are off', req)
      const bytes = Buffer.byteLength(req.body)
      if (bytes > MAX_BODY) return drop('too large', req, { bytes })
      const sig = req.headers['x-hub-signature-256']
      if (!sig) return drop('unsigned', req)
      // the kind is read before the secret: one trace does not take costs no Secrets Manager call
      const event = req.headers['x-github-event']
      if (!takes(event)) return drop(`not an event trace takes (${event ? event.slice(0, 40) : 'none'})`, req)
      let ok: boolean
      try {
        const s = await hooksSecret(cfg)
        ok = signatureOk(s.value.webhookSecret, req.body, sig)
        // the installer may have replaced it: read it again once, unless this copy was just read
        if (!ok && !s.read) ok = signatureOk((await hooksSecret(cfg, true)).value.webhookSecret, req.body, sig)
      } catch (e) {
        // no secret yet (the installer makes it), or none readable: nothing can be checked, so nothing is taken
        return drop('the webhook secret cannot be read', req, { error: e instanceof Error ? e.name : 'error' })
      }
      if (!ok) return drop('bad signature', req)
      const d = readDelivery(event, req.body)
      if ('drop' in d) return drop(d.drop, req)
      // a repository that is not a project is dropped before answering, when the API says so in time
      const asked = whoIsOn(cfg, d.repo, MEMBERS_WAIT_MS)
      let timer: ReturnType<typeof setTimeout> | undefined
      const known = await Promise.race([asked.then((m) => m, () => null), new Promise<'late'>((ok) => { timer = setTimeout(() => ok('late'), MEMBERS_WAIT_MS) })])
      clearTimeout(timer)
      if (known !== 'late' && known && !known.project) return drop('not a trace project', req, { repo: d.repo })
      return {
        stream: async (sink) => {
          // GitHub has its answer now; the rest runs on in this invocation
          sink.open(202, { 'cache-control': 'no-store' })
          sink.end()
          try {
            const m = await asked
            if (!m.project) { deps.log({ hook: 'dropped', why: 'not a trace project', repo: d.repo, event: d.event }); return }
            debounce ??= new Debounce(deps.hookStore?.(cfg) ?? new MemoryDebounceStore(), { now: deps.now, log: deps.log })
            const how = await debounce.offer(d.repo, d.number, (n) => publish(cfg, d, n))
            if (how === 'joined') deps.log({ hook: 'debounced', repo: d.repo, event: d.event, number: d.number })
          } catch (e) {
            deps.log({ warning: 'hooks: not published', repo: d.repo, event: d.event, error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) })
          }
        },
      }
    }),
  ]
}
