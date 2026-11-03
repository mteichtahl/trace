/**
 * Fixing the repository's rule from trace (docs/stay-in-trace.md "5. Fixing the repository rule"). The guided flow
 * expects a project's default branch to require passing checks only: trace records who accepted a change in the app,
 * and GitHub refuses an approval from the account that opened the pull request, so a rule that requires an approving
 * review stops every change. Before, Accept said "change the rule on GitHub"; now an admin fixes it from the change.
 *
 *   repo.rules.fix   admin   { repo } → { done, left }: the "trace" ruleset is created if it is missing, or updated so it
 *                            requires no approving review (code owners' included: traceRuleset); the default branch's
 *                            classic protection drops its required reviews; another ruleset that requires a review is
 *                            reported by name in `left`, never changed (it is someone's own rule). Records decision
 *                            repo.rules.fixed
 *
 * It needs the GitHub token to administer the repository (rulesets and branch protection need admin). A token that may
 * not is answered in plain words: what to grant, and that nothing changed.
 */
import { z } from 'zod'
import { decide, loadJourney } from '../core/journey.js'
import { traceRuleset } from '../installer/onboard-api.js'
import { ActionError, type Context, Repo, def, label, writeJourney } from './action-kit.js'
import { projectRule } from './actions-changes.js'
import { GitHubError, type GitHubApi } from './github.js'
import { readSettings, resolve } from '../core/config.js'
import { PROJECT_DB_PATH, tempDb } from './action-kit.js'

const Ruleset = z.object({ id: z.number(), name: z.string(), source_type: z.string().optional(), enforcement: z.string().optional() }).loose()
const Rule = z.object({ type: z.string(), parameters: z.record(z.string(), z.unknown()).optional() }).loose()
const RulesetDetail = Ruleset.extend({
  target: z.string().optional(),
  conditions: z.unknown().optional(),
  rules: z.array(Rule).default([]),
  bypass_actors: z.array(z.unknown()).optional(),
}).loose()

/** Whether a ruleset's rules require a review: an approving count above 0, or code owners' review. */
export function requiresReview(rules: readonly z.output<typeof Rule>[]): boolean {
  return rules.some((r) => r.type === 'pull_request' && (Number(r.parameters?.required_approving_review_count ?? 0) > 0 || r.parameters?.require_code_owner_review === true))
}

/** The rules with the pull request rule made to require no review (the rest as they are). */
export function withoutReview(rules: readonly z.output<typeof Rule>[]): z.output<typeof Rule>[] {
  return rules.map((r) => (r.type === 'pull_request'
    ? { ...r, parameters: { ...(r.parameters ?? {}), required_approving_review_count: 0, require_code_owner_review: false, require_last_push_approval: false } }
    : r))
}

/** The required check of the project's settings on its default branch ("build" when they cannot be read). */
async function requiredCheck(ctx: Context, gh: GitHubApi, repo: string, branch: string): Promise<string> {
  try {
    const t = tempDb(ctx.deps.scratch, await gh.rawFile(repo, PROJECT_DB_PATH, branch))
    try {
      return resolve(readSettings(t.db)).config.build.required_check
    } finally {
      t.cleanup()
    }
  } catch {
    return resolve({}).config.build.required_check
  }
}

/** GitHub refusing for want of admin, in plain words. */
const refusal = (e: unknown): ActionError | null => (e instanceof GitHubError && (e.status === 403 || e.status === 404)
  ? new ActionError('trace\'s GitHub token may not change this repository\'s rules: it needs "Administration: read and write" on it. Nothing was changed.')
  : null)

export async function fixRules(ctx: Context, repo: string): Promise<{ done: string[]; left: string[] }> {
  const gh = await ctx.deps.github()
  if (!gh.request) throw new ActionError('This installation cannot change a repository\'s rules.')
  const req = gh.request.bind(gh)
  const { branch } = await gh.defaultBranch(repo)
  const done: string[] = []
  const left: string[] = []
  try {
    // rulesets on the repository itself (an organization's own are read-only here and reported)
    const all = z.array(Ruleset).parse(await req('GET', `/repos/${repo}/rulesets?includes_parents=true&per_page=100`))
    const trace = all.find((r) => r.name === 'trace' && (r.source_type ?? 'Repository') === 'Repository')
    if (!trace) {
      await req('POST', `/repos/${repo}/rulesets`, traceRuleset(await requiredCheck(ctx, gh, repo, branch)))
      done.push(`Added trace's rule to ${branch}: changes go in once their checks pass, with no review required.`)
    }
    for (const r of all) {
      if (r.enforcement && r.enforcement !== 'active') continue
      const d = RulesetDetail.parse(await req('GET', `/repos/${repo}/rulesets/${r.id}`))
      if (!requiresReview(d.rules)) continue
      if (r.name === 'trace' && (r.source_type ?? 'Repository') === 'Repository') {
        await req('PUT', `/repos/${repo}/rulesets/${r.id}`, { rules: withoutReview(d.rules) })
        done.push('trace\'s rule no longer requires a review: changes go in once their checks pass.')
      } else {
        left.push(`The "${r.name}" rule${r.source_type === 'Organization' ? ' (set by the organization)' : ''} also requires a review. An admin of the ${r.source_type === 'Organization' ? 'organization' : 'repository'} changes it or removes it; trace does not change someone else's rule.`)
      }
    }
    // classic branch protection: its required reviews only (the rest of it stays)
    const reviews = await req('GET', `/repos/${repo}/branches/${encodeURIComponent(branch)}/protection/required_pull_request_reviews`).catch((e: unknown) => {
      if (e instanceof GitHubError && e.status === 404) return null
      throw e
    })
    if (reviews) {
      await req('DELETE', `/repos/${repo}/branches/${encodeURIComponent(branch)}/protection/required_pull_request_reviews`)
      done.push(`${branch}'s branch protection no longer requires a review.`)
    }
  } catch (e) {
    throw refusal(e) ?? e
  } finally {
    ctx.deps.githubCache?.bust(repo)
  }
  if (!done.length && !left.length) done.push('Nothing in this repository\'s rules requires a review now.')
  // its rule is read again on the next look
  await projectRule(ctx, repo).catch(() => null)
  await writeJourney(ctx, repo, (db) => {
    const r = loadJourney(db)
    if (!r) return { result: null, changed: false }
    decide(db, { kind: 'repo.rules.fixed', stage: r.journey.currentStage, ref: repo, by: label(ctx.principal), summary: `${label(ctx.principal)} put back trace's rule for ${branch}: ${done.join(' ')}${left.length ? ` Still: ${left.join(' ')}` : ''}`, detail: { done, left } })
    return { result: null }
  }).catch(() => undefined)
  return { done, left }
}

export const RULE_ACTIONS = {
  'repo.rules.fix': def('admin', Repo, async ({ repo }, ctx) => fixRules(ctx, repo)),
}
