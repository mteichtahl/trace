/**
 * The event-driven worker (from Potroller's agent-events): picks the work that has appeared, claims each item, and
 * builds the prompt one Claude Code job per item runs with.
 *
 * Work: PRs labelled ci_red, PRs GitHub reports in conflict, and open issues labelled agent_fix. An item is skipped
 * while another worker (this one or the hourly cloud worker) holds a claim younger than worker.claim_hours, and after
 * worker.max_attempts attempts on the same head it is handed to worker.escalate_to once, then left alone. Branches
 * that don't start with worker.own_branch_prefix belong to a person: they are worked on only once that person has not
 * pushed for worker.others_branches_after_minutes, and only with merge commits.
 *
 * Mergeability is settled before it is judged (src/harness/mergeable.ts): a pick started by a push to the default branch
 * otherwise reads every pull request as "unknown" and misses the conflicts that push made.
 *
 * Asked again (RETRY, the workflow_dispatch input `retry`: numbers, comma separated; the app's "Bring it up to date"
 * starts it, src/api/conflicts.ts): each named item gets a retry marker, so the attempts before it no longer count, and
 * a person's branch named there is worked on at once (asking from trace is the go-ahead the idle wait stands in for).
 * Only someone allowed to start workflows can ask: the input is as trusted as the markers.
 *
 * Handing an item to worker.escalate_to is a mention on GitHub, which most people never read. So every pick also
 * brings the agents' facts in line (src/core/stuck-work.ts): a stuck note for each item at max attempts, saying what
 * was tried and trace's recommendation, which the app shows as a "Needs you" item; and the notes of items that moved
 * on, resolved. It needs the central bucket (TRACE_PROJECT_HOME or TRACE_HOME, and credentials that may write this
 * project's journey-agent/ folder: the worker runtime's role on AgentCore, the repository's TRACE_AWS_ROLE in GitHub
 * Actions); without them, or when the write fails, the GitHub mention is the only word and the pick goes on.
 */
import { z } from 'zod'
import { AgentFactsStore, projectsBackend, projectsFromEnv } from '../core/agent-facts.js'
import type { TraceConfig } from '../core/config.js'
import { type StuckItem, reportWords, sourceKey, syncStuckWork } from '../core/stuck-work.js'
import { SPECIALISTS } from '../agents/index.js'
import { type Route, RouteSchema, SpecialistKindSchema } from '../agents/kinds.js'
import { type CheckEvidence, type RouteInput, route } from '../agents/router.js'
import { jobLogTail } from './ci-doctor.js'
import { type CommentLike, comments, trustedAuthor } from './util.js'
import { type Deps, type GitHub, labelNames, short } from './types.js'
import { conflicted, settle } from './mergeable.js'
import { type Composed, Composer, type Layers, NO_LAYERS } from '../prompts/resolve.js'

export const WorkItemSchema = z.object({
  kind: z.enum(['ci-red', 'conflict', 'agent-fix']),
  number: z.number().int().positive(),
  sha: z.string(),
  ref: z.string(),
  own: z.boolean(),
  title: z.string(),
  /** The specialist it goes to and why (worker-pick routes it; the runtime routes an item without one). */
  route: RouteSchema.optional(),
}).strict()
export type WorkItem = z.infer<typeof WorkItemSchema>

/** At most this many failing jobs' logs are read per claimed item, and this much of the end of each. */
export const LOG_CHECKS = 5
export const LOG_TAIL = 6000

const isActionsJob = (r: { id?: number; app?: { slug?: string } | null; details_url?: string | null }): r is { id: number } =>
  typeof r.id === 'number' && (r.app?.slug === 'github-actions' || /\/actions\/runs\/\d+\/job\//.test(r.details_url ?? ''))

/**
 * The evidence worker-pick gathers for routing: what the item's labels, failing checks (with their jobs' log tails),
 * files and text say. Called for the items it claims only.
 */
export async function evidenceOf(github: GitHub, owner: string, repo: string, item: WorkItem, cfg: TraceConfig,
  known: { labels?: readonly string[]; body?: string | null | undefined } = {}): Promise<RouteInput> {
  const input: RouteInput = { labels: [...(known.labels ?? [])], text: `${item.title}\n\n${known.body ?? ''}`.trim() }
  if (item.kind === 'agent-fix') return input
  try {
    const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: item.number, per_page: 100 })
    input.files = files.map((f) => f.filename).filter((f): f is string => typeof f === 'string')
  } catch { /* routing works with less */ }
  if (item.kind === 'ci-red') {
    try {
      const runs = (await github.rest.checks.listForRef({ owner, repo, ref: item.sha, per_page: 100 })).data.check_runs ?? []
      const failed = runs.filter((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out')
      // the summary gate fails whenever another job did: its name says nothing about the cause
      const judged = failed.length > 1 ? failed.filter((r) => r.name !== cfg.build.required_check) : failed
      // The failing jobs' own log tails, the way ci-doctor reads them (a GitHub Actions check run's id is its job's
      // id); a check's output.summary is usually empty for Actions jobs. Bounded: LOG_CHECKS jobs, LOG_TAIL each.
      const logs = await Promise.all(judged.map(async (r, i) =>
        i < LOG_CHECKS && isActionsJob(r) ? jobLogTail(github, owner, repo, r.id, LOG_TAIL) : ''))
      input.checks = judged.map((r, i): CheckEvidence => {
        const log = [logs[i] ?? '', r.output?.summary ? String(r.output.summary) : ''].filter(Boolean).join('\n').slice(-LOG_TAIL)
        return { name: r.name, ...(log ? { log } : {}) }
      })
    } catch { /* routing works with less */ }
  }
  return input
}

const CLAIM = /<!-- trace-claim: (\S+) -->/
const claimedAt = (cs: CommentLike[]): number[] =>
  cs.map((c) => CLAIM.exec(c.body ?? '')?.[1]).filter((t): t is string => Boolean(t)).map(Date.parse).filter(Number.isFinite)
/** The comments since the item was last asked again on `sha` (all of them when it never was). */
const sinceRetry = (cs: CommentLike[], sha: string): CommentLike[] => {
  const last = cs.map((c) => (c.body ?? '').includes(retryMarker(sha))).lastIndexOf(true)
  return last < 0 ? cs : cs.slice(last + 1)
}
const attempts = (cs: CommentLike[], sha: string): number => sinceRetry(cs, sha).filter((c) => (c.body ?? '').includes(`<!-- trace-attempt: ${sha} -->`)).length
export const retryMarker = (sha: string): string => `<!-- trace-retry: ${sha} -->`

/** The item numbers RETRY names ("12, 15"): positive whole numbers only, anything else ignored. */
export function retried(raw: string | undefined): Set<number> {
  return new Set((raw ?? '').split(/[\s,]+/).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))
}

/**
 * The agents' facts of `repository`, where this step can write them (src/core/agent-facts.ts projectsFromEnv), or
 * null. GITHUB_REPOSITORY is not trusted for which project: the repository the pick runs on is.
 */
export function factsStore(repository: string, env: Record<string, string | undefined> = process.env): AgentFactsStore | null {
  const where = projectsFromEnv({ ...env, TRACE_PROJECT: repository })
  return where ? new AgentFactsStore(projectsBackend(where.projects), where.repository) : null
}

/** Bring the stuck notes in line (src/core/stuck-work.ts). Never fails the pick: the GitHub mention stands either way. */
async function recordStuck(repository: string, stuck: readonly StuckItem[], claimed: readonly string[], core: Deps['core'], store: AgentFactsStore | null | undefined): Promise<void> {
  const s = store === undefined ? factsStore(repository) : store
  if (!s) {
    if (stuck.length) core.info('The stuck items are not recorded for the app: this step has no TRACE_HOME (or TRACE_PROJECT_HOME).')
    return
  }
  try {
    const { result } = await s.update((db) => {
      const r = syncStuckWork(db, stuck, claimed)
      return { result: r, changed: r.added.length + r.resolved.length > 0 }
    })
    if (result.added.length || result.resolved.length) core.info(`Stuck notes: added ${result.added.join(', ') || 'none'}; resolved ${result.resolved.join(', ') || 'none'}`)
  } catch (e) {
    core.warning(`The stuck items could not be recorded for the app: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`)
  }
}

/** `facts`: where the stuck notes go (tests); absent, from the step's environment; null, nowhere. */
export async function pick({ github, context, core, cfg, env }: Deps, now: number = Date.now(), via?: string, facts?: AgentFactsStore | null): Promise<void> {
  const { owner, repo } = context.repo
  core.setOutput('items', '[]')
  core.setOutput('runner', cfg.worker.runner)
  if (!cfg.worker.enabled) return core.info('worker.enabled is off.')
  const items: WorkItem[] = []
  const known = new Map<number, { labels: string[]; body: string | null | undefined }>()
  const blocked: { n: number; kind: WorkItem['kind']; sha: string; marker: string }[] = []
  const stuck: StuckItem[] = []
  const claimed: string[] = []

  const consider = async (item: WorkItem): Promise<void> => {
    // Only markers left by the workflows or the agents count: anyone who can comment could otherwise stall an item.
    const cs = (await comments(github, owner, repo, item.number)).filter((c) => trustedAuthor(c, env.AGENT_LOGIN))
    if (claimedAt(cs).some((t) => now - t < cfg.worker.claim_hours * 3600e3)) {
      claimed.push(sourceKey(item))
      return core.info(`#${item.number} (${item.kind}) is claimed: skipped`)
    }
    if (attempts(cs, item.sha) >= cfg.worker.max_attempts) {
      const marker = `<!-- trace-escalated: ${item.sha} -->`
      if (!sinceRetry(cs, item.sha).some((c) => (c.body ?? '').includes(marker))) blocked.push({ n: item.number, kind: item.kind, sha: item.sha, marker })
      // the newest report an attempt left (an Actions report, or the AgentCore agent's last words)
      const report = [...cs].reverse().find((c) => /<!-- trace-(report|agent-done):/.test(c.body ?? ''))
      stuck.push({ kind: item.kind, number: item.number, sha: item.sha, title: item.title, attempts: cfg.worker.max_attempts, lastReport: report ? reportWords(report.body ?? '') : null })
      return core.info(`#${item.number} had ${cfg.worker.max_attempts} attempts on ${item.sha === 'issue' ? 'this issue' : short(item.sha)}: left for a person`)
    }
    items.push(item)
  }

  const again = retried(env.RETRY)
  /** Asked again from trace: a marker on the item, so the attempts before it are set aside. */
  const askAgain = async (n: number, sha: string): Promise<void> => {
    if (!again.has(n)) return
    await github.rest.issues.createComment({ owner, repo, issue_number: n,
      body: `Asked again from trace: the earlier attempts${sha === 'issue' ? '' : ` on ${short(sha)}`} are set aside and the worker takes it from here.\n${retryMarker(sha)}` })
  }

  const prs = (await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 }))
    .filter((p) => !p.draft && p.head.repo?.full_name === `${owner}/${repo}` && !p.head.ref.startsWith('dependabot/'))
  const red = (p: (typeof prs)[number]): boolean => labelNames(p.labels).includes(cfg.labels.ci_red)
  // one read of each starts GitHub's work out of whether it can merge; then only the ones it has not finished, again
  const settled = await settle(github, owner, repo, prs.filter((p) => !red(p)).map((p) => p.number))
  for (const p of prs) {
    let kind: WorkItem['kind'] | null = red(p) ? 'ci-red' : null
    if (!kind) {
      const full = settled.get(p.number)
      if (full && conflicted(full)) kind = 'conflict'
    }
    if (!kind) continue
    const own = Boolean(cfg.worker.own_branch_prefix) && p.head.ref.startsWith(cfg.worker.own_branch_prefix)
    if (!own && !again.has(p.number)) {
      const head = (await github.rest.repos.getCommit({ owner, repo, ref: p.head.sha })).data
      const at = Date.parse(head.commit.committer?.date ?? head.commit.author?.date ?? '1970-01-01')
      const idle = (now - at) / 60e3
      if (idle < cfg.worker.others_branches_after_minutes) { core.info(`#${p.number} is someone's branch, pushed ${Math.round(idle)} min ago: waiting`); continue }
    }
    known.set(p.number, { labels: labelNames(p.labels), body: p.body })
    await askAgain(p.number, p.head.sha)
    await consider({ kind, number: p.number, sha: p.head.sha, ref: p.head.ref, own, title: p.title.slice(0, 200) })
  }
  const issues = (await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: 'open', labels: cfg.labels.agent_fix, per_page: 100 }))
    .filter((i) => !i.pull_request)
  for (const i of issues) known.set(i.number, { labels: labelNames(i.labels), body: i.body })
  for (const i of issues) await askAgain(i.number, 'issue')
  for (const i of issues) await consider({ kind: 'agent-fix', number: i.number, sha: 'issue', ref: '', own: true, title: i.title.slice(0, 200) })

  for (const b of blocked) {
    const who = cfg.worker.escalate_to ? `${cfg.worker.escalate_to} ` : ''
    await github.rest.issues.createComment({ owner, repo, issue_number: b.n,
      body: `${who}the worker has tried this ${cfg.worker.max_attempts} times (${b.kind}${b.sha === 'issue' ? '' : ` on ${short(b.sha)}`}) without resolving it, so it is left for a person. The attempts' comments above say what was tried. A new push, or deleting the attempt comments, puts it back in the queue.\n${b.marker}` })
  }
  await recordStuck(`${owner}/${repo}`, stuck, claimed, core, facts)

  const picked: WorkItem[] = []
  for (const it of items.slice(0, cfg.worker.max_parallel)) {
    // the deterministic route only: no model here; the runtime asks the model when this fell to the default
    const r = route(await evidenceOf(github, owner, repo, it, cfg, known.get(it.number)), cfg)
    picked.push(r.source === 'default' ? it : { ...it, route: r })
  }
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`
  for (const it of picked) {
    await github.rest.issues.createComment({ owner, repo, issue_number: it.number,
      body: `Picked up by trace (${it.kind}): ${via ?? `[run](${runUrl})`}. ${routeLine(it.route)}\n<!-- trace-claim: ${new Date(now).toISOString()} -->\n<!-- trace-attempt: ${it.sha} -->` })
  }
  core.info(picked.length ? `Work: ${picked.map((i) => `#${i.number} ${i.kind} → ${i.route?.kind ?? '(routed by the runtime)'}`).join(', ')}` : 'Nothing to do.')
  core.setOutput('items', JSON.stringify(picked))
}

/** The item a workflow step passes (ITEM), with the specialist the step names (AGENT, when one) as its route. */
export function itemFromEnv(env: { ITEM?: string | undefined; AGENT?: string | undefined }): WorkItem {
  const item = WorkItemSchema.parse(JSON.parse(env.ITEM || '{}'))
  const kind = SpecialistKindSchema.safeParse(env.AGENT?.trim())
  if (!kind.success || item.route?.kind === kind.data) return item
  return { ...item, route: { kind: kind.data, reason: `the workflow asked for the ${kind.data} specialist`, confidence: 1, source: 'explicit' } }
}

/** One line for a comment: which specialist takes the item, and why. */
export function routeLine(r: Route | undefined): string {
  if (!r) return 'Nothing here decides the specialist: the runtime routes it (the model, else agents.default).'
  return `It goes to the **${SPECIALISTS[r.kind].title}** specialist (\`${r.kind}\`): ${r.reason} (${r.source}, confidence ${r.confidence.toFixed(2)}).`
}

/** The worker's validation line and the locked "never weaken a test" after it (the task prompt's too). */
export function addValidate(p: Composer, cfg: TraceConfig): void {
  if (cfg.worker.validate) p.add('worker.validate.command', { command: cfg.worker.validate })
  else p.add('worker.validate.generic')
  p.add('worker.tests')
}

/**
 * The worker's prompt for one item, from the prompt catalog (src/prompts/catalog.ts) with the overrides in force.
 * `delegated`: a specialist's brief and acceptance criteria (GitHub Actions' worker step): they are its request, and
 * the specialist, not the worker, reports on the item.
 */
export function composeItem(item: WorkItem, cfg: TraceConfig, repository: string, delegated?: string,
  o: { where?: string; prompts?: Layers | undefined } = {}): Composed {
  const p = new Composer(o.prompts ?? NO_LAYERS)
  p.add('worker.role', { repository, where: o.where ?? 'in GitHub Actions' }).add('worker.data.item')
  p.add('worker.item', { item_kind: item.kind, number: item.number, ref: item.ref, sha: item.sha, title: JSON.stringify(item.title) })
  if (!item.own) p.add('worker.item.not-own')
  p.add('worker.tools').add('design.silkscreen')
  p.add(`worker.item.${item.kind}`, {
    repository, number: item.number, sha: item.sha, default_branch: cfg.branch, branch_prefix: cfg.worker.own_branch_prefix, ci_red_label: cfg.labels.ci_red,
  })
  addValidate(p, cfg)
  const esc = cfg.worker.escalate_to
  p.add('worker.escalate.item', { number: item.number, mention: esc ? p.text('mention.starting', { escalate_to: esc }) : '' })
  if (delegated) p.add('worker.delegated', { number: item.number, request: delegated.split('\n').map((l) => `> ${l}`).join('\n') })
  else p.add('worker.finish.item', { number: item.number })
  p.add('worker.guardrails')
  return p.done()
}

export function promptFor(item: WorkItem, cfg: TraceConfig, repository: string, delegated?: string, o: { where?: string; prompts?: Layers | undefined } = {}): string {
  return composeItem(item, cfg, repository, delegated, o).text
}

/** .trace/rules.md on the default branch (null when there is none). */
export async function rulesOf(github: GitHub, owner: string, repo: string, branch: string): Promise<string | null> {
  try {
    const meta = (await github.rest.repos.getContent({ owner, repo, path: '.trace/rules.md', ref: branch })).data
    if (Array.isArray(meta) || meta.type !== 'file' || !meta.content) return null
    return Buffer.from(meta.content, 'base64').toString('utf8')
  } catch {
    return null
  }
}
