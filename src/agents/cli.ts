/**
 * `trace agent …`: the specialists, for people.
 *
 *   trace agent list [--json]                 every specialist: what it does, whether it is enabled, model and
 *                                             turn limit, memory agent, and its tools (MCP names)
 *   trace agent route <issue|pr|text> [--repo OWNER/REPO] [--labels a,b] [--files f,g] [--checks c,d] [--model]
 *                                             a dry run of the router: a number reads that issue or PR from GitHub
 *                                             (gh: labels, text, changed files, failing checks); anything else is
 *                                             routed as text. --model asks the model when nothing else decides.
 *   trace agent prompt <kind>                 the composed system prompt, with this project's settings and
 *                                             .trace/rules.md, for review
 */
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { type TraceConfig, load } from '../core/config.js'
import { findRoot } from '../core/store.js'
import { SPECIALISTS, specialistPrompt, toolsOf } from './index.js'
import { SPECIALIST_KINDS, SpecialistKindSchema } from './kinds.js'
import { type QueryFn, type RouteInput, route, routeJob, sdkClassifier } from './router.js'
import { readRules } from './rules.js'
import { mcpName } from './specialist.js'

const out = (s: string): void => { process.stdout.write(`${s}\n`) }
const err = (s: string): void => { process.stderr.write(`${s}\n`) }

const USAGE = 'usage: trace agent list [--json] | route <issue|pr|text> [--repo OWNER/REPO] [--labels a,b] [--files f,g] [--checks c,d] [--model] | prompt <kind>'

const list = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

function gh(args: string[]): unknown {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.error?.message || '').trim().slice(0, 300)}`)
  return JSON.parse(r.stdout || 'null') as unknown
}

const Issue = z.object({
  title: z.string(), body: z.string().nullish(), labels: z.array(z.object({ name: z.string() }).loose()).default([]),
  pull_request: z.unknown().optional(),
}).loose()
const Pull = z.object({ head: z.object({ sha: z.string() }).loose() }).loose()
const Files = z.array(z.object({ filename: z.string() }).loose())
const Checks = z.object({ check_runs: z.array(z.object({ name: z.string(), conclusion: z.string().nullable(), output: z.object({ summary: z.string().nullish() }).loose().optional() }).loose()) }).loose()

function currentRepo(): string {
  const r = z.object({ nameWithOwner: z.string() }).loose().parse(gh(['repo', 'view', '--json', 'nameWithOwner']))
  return r.nameWithOwner
}

/** Read an issue or PR from GitHub into the router's input. */
export function evidenceFromGitHub(repo: string, n: number, cfg: TraceConfig): RouteInput {
  const issue = Issue.parse(gh(['api', `repos/${repo}/issues/${n}`]))
  const input: RouteInput = { labels: issue.labels.map((l) => l.name), text: `${issue.title}\n\n${issue.body ?? ''}`.trim() }
  if (issue.pull_request) {
    input.files = Files.parse(gh(['api', '--paginate', `repos/${repo}/pulls/${n}/files`])).map((f) => f.filename)
    const sha = Pull.parse(gh(['api', `repos/${repo}/pulls/${n}`])).head.sha
    const runs = Checks.parse(gh(['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`])).check_runs
    const failed = runs.filter((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out')
    input.checks = (failed.length > 1 ? failed.filter((r) => r.name !== cfg.build.required_check) : failed)
      .map((r) => ({ name: r.name, ...(r.output?.summary ? { log: r.output.summary } : {}) }))
  }
  return input
}

export async function cmdAgent(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  const cfg = load(undefined, { strict: false })
  switch (sub) {
    case 'list': {
      const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' } } })
      const rows = SPECIALIST_KINDS.map((k) => {
        const s = SPECIALISTS[k]
        const st = cfg.agents[k]
        return {
          kind: k, title: s.title, enabled: cfg.agents.enabled.includes(k), description: s.description,
          model: st.model || cfg.worker.model || '(the runtime default)', max_turns: st.max_turns, memory_agent: s.memoryAgent,
          tools: toolsOf(s).map(mcpName), hardware_tools: (s.hardwareTools ?? []).map(mcpName),
        }
      })
      if (values.json) { out(JSON.stringify(rows, null, 1)); return 0 }
      for (const r of rows) {
        out(`${r.kind.padEnd(7)} ${r.title}${r.enabled ? '' : '  (disabled: agents.enabled)'}${cfg.agents.default === r.kind ? '  (default)' : ''}`)
        out(`        ${r.description}`)
        out(`        model ${r.model}, max ${r.max_turns} turns, memory actor <owner>/<repo>/${r.memory_agent}`)
        out(`        tools: ${r.tools.join(', ')}`)
        if (r.hardware_tools.length) out(`        with hardware allowed: ${r.hardware_tools.join(', ')}`)
      }
      out('\nThe worker (shell, git, every tool) runs only when a specialist delegates to it (agent_delegate).')
      return 0
    }
    case 'route': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
        repo: { type: 'string' }, labels: { type: 'string' }, files: { type: 'string' }, checks: { type: 'string' }, model: { type: 'boolean' } } })
      const what = positionals.join(' ').trim()
      if (!what && !values.labels && !values.files && !values.checks) break
      const n = /^#?(\d+)$/.exec(what)?.[1]
      const base: RouteInput = n ? evidenceFromGitHub(values.repo ?? currentRepo(), Number(n), cfg) : { text: what }
      const input: RouteInput = {
        ...base,
        labels: [...(base.labels ?? []), ...list(values.labels)],
        files: [...(base.files ?? []), ...list(values.files)],
        checks: [...(base.checks ?? []), ...list(values.checks).map((name) => ({ name }))],
      }
      let r = route(input, cfg)
      if (values.model) {
        const { query } = await import('@anthropic-ai/claude-agent-sdk')
        r = await routeJob(input, cfg, sdkClassifier(query as unknown as QueryFn, { model: cfg.agents.router_model || cfg.worker.model || undefined }))
      } else if (r.source === 'default' && cfg.agents.route_with_model) {
        err('(nothing deterministic decided: on the runtime the model would be asked; --model asks it here)')
      }
      out(`${r.kind}  ${SPECIALISTS[r.kind].title}`)
      out(`source ${r.source}, confidence ${r.confidence.toFixed(2)}`)
      out(`reason ${r.reason}`)
      return 0
    }
    case 'prompt': {
      const k = SpecialistKindSchema.safeParse(rest[0])
      if (!k.success) { err(`trace agent prompt: one of ${SPECIALIST_KINDS.join(', ')}`); return 2 }
      const root = findRoot()
      const repository = (() => { try { return currentRepo() } catch { return 'OWNER/REPO' } })()
      out(specialistPrompt(SPECIALISTS[k.data], { cfg, repository, job: { kind: 'preview' }, rules: root ? readRules(root) : null, hardware: false, delivery: 'delegate' }))
      return 0
    }
  }
  err(USAGE)
  return 2
}
