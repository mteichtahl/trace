/**
 * `trace doctor OWNER/REPO`: what the loop needs that the repository doesn't have yet, each with how to fix it.
 *
 * Read-only. Some checks need admin on the repository (secrets and rulesets are only listed to admins); a check it
 * cannot read is reported as such rather than guessed.
 */
import { type Runner, runCommand } from './onboard.js'

export interface Finding { ok: boolean; what: string; fix: string }

const WORKFLOWS = ['trace-prs.yml', 'trace-ci.yml', 'trace-worker.yml', 'trace-deploy.yml']

type Api = (path: string) => unknown

function apiWith(run: Runner): Api {
  return (path) => {
    try {
      const out = run(['gh', 'api', path], { check: true })
      return out.trim() ? (JSON.parse(out) as unknown) : null
    } catch {
      return null
    }
  }
}

const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const names = (v: unknown, key: string): Set<string> => {
  const list = obj(v)?.[key]
  return new Set(Array.isArray(list) ? list.map((x) => String(obj(x)?.name ?? '')) : [])
}

export function doctor(slug: string, run: Runner = runCommand): Finding[] {
  const api = apiWith(run)
  const out: Finding[] = []
  const add = (ok: boolean, what: string, fix: string): void => { out.push({ ok, what, fix }) }
  const repo = obj(api(`repos/${slug}`))
  if (!repo) return [{ ok: false, what: `${slug} is reachable`, fix: 'Check the name, and `gh auth status`.' }]
  const branch = String(repo.default_branch ?? 'main')
  add(repo.allow_auto_merge === true, 'auto-merge is allowed', `trace onboard ${slug} --apply-settings (or Settings → General → Allow auto-merge).`)
  add(repo.delete_branch_on_merge === true, 'merged branches are deleted', 'Settings → General → Automatically delete head branches.')
  add(obj(api(`repos/${slug}/contents/.trace/project.db?ref=${branch}`)) !== null, `.trace/project.db is on ${branch}`, `Merge the onboarding PR (trace onboard ${slug}).`)
  const rules = obj(api(`repos/${slug}/contents/.trace/rules.md?ref=${branch}`))
  add(Number(rules?.size ?? 0) > 0, '.trace/rules.md has rules', 'Write the rules the agents must follow in .trace/rules.md.')
  for (const wf of WORKFLOWS) add(obj(api(`repos/${slug}/contents/.github/workflows/${wf}?ref=${branch}`)) !== null, `workflow ${wf}`, `trace onboard ${slug} (it writes the workflows).`)
  const secrets = api(`repos/${slug}/actions/secrets`)
  if (obj(secrets)) {
    const s = names(secrets, 'secrets')
    const v = names(api(`repos/${slug}/actions/variables`), 'variables')
    const orgHome = obj(api(`orgs/${slug.split('/')[0]}/actions/variables/TRACE_HOME`))
    add(s.has('TRACE_TOKEN'), 'secret TRACE_TOKEN', 'A fine-grained token for this repository (Contents, Pull requests, Issues, Workflows, Actions: read/write).')
    add(s.has('ANTHROPIC_API_KEY') || v.has('TRACE_AWS_ROLE'), 'model access for the worker', 'Variable TRACE_AWS_ROLE (Bedrock, via GitHub OIDC) or secret ANTHROPIC_API_KEY.')
    add(v.has('TRACE_HOME') || Boolean(orgHome?.value), 'TRACE_HOME (the central database)', 'Set TRACE_HOME = s3://<bucket>/<prefix> once for the organisation, or on this repository.')
  } else {
    add(false, 'secrets and variables readable', 'Run doctor as an admin of the repository.')
  }
  const rulesets = api(`repos/${slug}/rulesets`)
  if (Array.isArray(rulesets)) add(rulesets.some((r) => obj(r)?.name === 'trace'), "a ruleset requires the build's check", `trace onboard ${slug} --apply-settings (adds the "trace" ruleset).`)
  const labels = api(`repos/${slug}/labels?per_page=100`)
  if (Array.isArray(labels)) {
    const have = new Set(labels.map((l) => String(obj(l)?.name ?? '')))
    const missing = ['no-automerge', 'ci-red', 'agent-fix', 'deploy', 'deploy-held'].filter((l) => !have.has(l))
    add(!missing.length, 'labels', `Missing ${missing.join(', ')}: trace onboard ${slug} --apply-settings.`)
  }
  return out
}
