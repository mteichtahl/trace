/**
 * The event-driven worker (from Potroller's agent-events): picks the work that has appeared, claims each item, and
 * builds the prompt one Claude Code job per item runs with.
 *
 * Work: PRs labelled ci_red, PRs GitHub reports in conflict, and open issues labelled agent_fix. An item is skipped
 * while another worker (this one or the hourly cloud worker) holds a claim younger than worker.claim_hours, and after
 * worker.max_attempts attempts on the same head it is handed to worker.escalate_to once, then left alone. Branches
 * that don't start with worker.own_branch_prefix belong to a person: they are worked on only once that person has not
 * pushed for worker.others_branches_after_minutes, and only with merge commits.
 */
import { z } from 'zod'
import type { TraceConfig } from '../core/config.js'
import { SPECIALISTS } from '../agents/index.js'
import { type Route, RouteSchema, SpecialistKindSchema } from '../agents/kinds.js'
import { type CheckEvidence, type RouteInput, route } from '../agents/router.js'
import { jobLogTail } from './ci-doctor.js'
import { type CommentLike, comments, trustedAuthor } from './util.js'
import { type Deps, type GitHub, labelNames, short } from './types.js'
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
const attempts = (cs: CommentLike[], sha: string): number => cs.filter((c) => (c.body ?? '').includes(`<!-- trace-attempt: ${sha} -->`)).length

export async function pick({ github, context, core, cfg, env }: Deps, now: number = Date.now(), via?: string): Promise<void> {
  const { owner, repo } = context.repo
  core.setOutput('items', '[]')
  core.setOutput('runner', cfg.worker.runner)
  if (!cfg.worker.enabled) return core.info('worker.enabled is off.')
  const items: WorkItem[] = []
  const known = new Map<number, { labels: string[]; body: string | null | undefined }>()
  const blocked: { n: number; kind: WorkItem['kind']; sha: string; marker: string }[] = []

  const consider = async (item: WorkItem): Promise<void> => {
    // Only markers left by the workflows or the agents count: anyone who can comment could otherwise stall an item.
    const cs = (await comments(github, owner, repo, item.number)).filter((c) => trustedAuthor(c, env.AGENT_LOGIN))
    if (claimedAt(cs).some((t) => now - t < cfg.worker.claim_hours * 3600e3)) return core.info(`#${item.number} (${item.kind}) is claimed: skipped`)
    if (attempts(cs, item.sha) >= cfg.worker.max_attempts) {
      const marker = `<!-- trace-escalated: ${item.sha} -->`
      if (!cs.some((c) => (c.body ?? '').includes(marker))) blocked.push({ n: item.number, kind: item.kind, sha: item.sha, marker })
      return core.info(`#${item.number} had ${cfg.worker.max_attempts} attempts on ${item.sha === 'issue' ? 'this issue' : short(item.sha)}: left for a person`)
    }
    items.push(item)
  }

  const prs = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 })
  for (const p of prs) {
    if (p.draft || p.head.repo?.full_name !== `${owner}/${repo}` || p.head.ref.startsWith('dependabot/')) continue
    let kind: WorkItem['kind'] | null = labelNames(p.labels).includes(cfg.labels.ci_red) ? 'ci-red' : null
    if (!kind) {
      const full = (await github.rest.pulls.get({ owner, repo, pull_number: p.number })).data
      if (full.mergeable === false || full.mergeable_state === 'dirty') kind = 'conflict'
    }
    if (!kind) continue
    const own = Boolean(cfg.worker.own_branch_prefix) && p.head.ref.startsWith(cfg.worker.own_branch_prefix)
    if (!own) {
      const head = (await github.rest.repos.getCommit({ owner, repo, ref: p.head.sha })).data
      const at = Date.parse(head.commit.committer?.date ?? head.commit.author?.date ?? '1970-01-01')
      const idle = (now - at) / 60e3
      if (idle < cfg.worker.others_branches_after_minutes) { core.info(`#${p.number} is someone's branch, pushed ${Math.round(idle)} min ago: waiting`); continue }
    }
    known.set(p.number, { labels: labelNames(p.labels), body: p.body })
    await consider({ kind, number: p.number, sha: p.head.sha, ref: p.head.ref, own, title: p.title.slice(0, 200) })
  }
  const issues = (await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: 'open', labels: cfg.labels.agent_fix, per_page: 100 }))
    .filter((i) => !i.pull_request)
  for (const i of issues) known.set(i.number, { labels: labelNames(i.labels), body: i.body })
  for (const i of issues) await consider({ kind: 'agent-fix', number: i.number, sha: 'issue', ref: '', own: true, title: i.title.slice(0, 200) })

  for (const b of blocked) {
    const who = cfg.worker.escalate_to ? `${cfg.worker.escalate_to} ` : ''
    await github.rest.issues.createComment({ owner, repo, issue_number: b.n,
      body: `${who}the worker has tried this ${cfg.worker.max_attempts} times (${b.kind}${b.sha === 'issue' ? '' : ` on ${short(b.sha)}`}) without resolving it, so it is left for a person. The attempts' comments above say what was tried. A new push, or deleting the attempt comments, puts it back in the queue.\n${b.marker}` })
  }

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
  p.add('worker.tools')
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
