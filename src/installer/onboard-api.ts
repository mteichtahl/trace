/**
 * Onboarding as the installer does it: GitHub's REST API with the installer's token, and `git` (which installing
 * trace from GitHub needs anyway) with that token passed in its environment, never in a URL, a file or its
 * arguments. No `gh` CLI and no `gh auth login`. `trace onboard` (src/core/onboard.ts) keeps using `gh` for people
 * at a terminal; both write the same files (writeFiles, writeWorkflows).
 *
 * Safe to run again on the same repository:
 *   not onboarded   a branch trace/onboard with what onboarding adds, and its pull request (held); an open one is
 *                   updated, not duplicated
 *   onboarded       the trace workflows are rendered again from the repository's own settings; when they differ
 *                   from the default branch's (a newer trace, e.g. the CodeBuild runners' `runs-on`), a branch
 *                   trace/refresh and its pull request; when they do not, nothing
 *   new (create)    the repository is created, scaffolded from its template and pushed to main
 * and, with `apply`, the repository settings the loop needs (auto-merge, branch deletion, labels, the ruleset). The
 * central registry of projects is written by the installer's people step, with the installation's credentials.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { LABEL_STYLE } from '../harness/util.js'
import { type ResolvedConfig, load } from '../core/config.js'
import {
  ONBOARD_BRANCH, type Runner, OnboardError, REF, SOURCE, checklist, detect, readWorkflow, scaffold, settingsFor, writeFiles, writeWorkflows,
} from '../core/onboard.js'
import { Github, GithubError, createRepo } from './github.js'

export const REFRESH_BRANCH = 'trace/refresh'

/** The environment that lets git reach github.com with the token and nothing else (git 2.31+ reads config from it). */
export function gitEnv(token: string, login: string): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    // no credential helper of this machine's is asked (or told) anything
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
    GIT_AUTHOR_NAME: login, GIT_AUTHOR_EMAIL: `${login}@users.noreply.github.com`,
    GIT_COMMITTER_NAME: login, GIT_COMMITTER_EMAIL: `${login}@users.noreply.github.com`,
  }
}

/** git with that environment (a Runner, so detect() and the tests use it the same way). */
export function gitRunner(env: Record<string, string>): Runner {
  return (cmd, opts = {}) => {
    const [exe, ...args] = cmd
    if (exe !== 'git') throw new OnboardError(`the installer runs git only, not ${exe ?? ''}`)
    const p = spawnSync('git', args, { cwd: opts.cwd, input: opts.input, encoding: 'utf8', timeout: 300_000, env: { ...process.env, ...env } })
    if (p.error) throw new OnboardError(`git: ${p.error.message}${(p.error as { code?: string }).code === 'ENOENT' ? ' (install git: it is the one local program onboarding needs)' : ''}`)
    if ((opts.check ?? true) && p.status !== 0) throw new OnboardError(`git ${args.slice(0, 2).join(' ')}…: ${(p.stderr || p.stdout).trim().slice(0, 600)}`)
    return p.stdout
  }
}

export interface ApiOnboardOptions {
  token: string
  login: string
  apply: boolean
  escalateTo?: string
  /** a repository to create (null: it exists) */
  create?: { template: 'empty' | 'python' | 'kicad' | 'rust'; private: boolean } | null
  source?: string
  ref?: string
  /** tests: git and GitHub */
  git?: Runner
  fetchImpl?: typeof fetch
}

export interface ApiOnboardResult { repo: string; state: 'opened' | 'updated' | 'refreshed' | 'unchanged' | 'created'; pr: string | null; settings: string[]; notes: string[] }

const Pull = z.object({ html_url: z.string(), number: z.number() }).loose()

/** Open the PR for `head`, or find the open one (then it was updated by the push). */
async function pullRequest(gh: Github, repo: string, head: string, base: string, title: string, body: string, label: string): Promise<{ url: string; existed: boolean }> {
  const owner = repo.split('/')[0] ?? ''
  const { data: open } = await gh.request('GET', `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`, z.array(Pull))
  if (open[0]) return { url: open[0].html_url, existed: true }
  const { data } = await gh.request('POST', `/repos/${repo}/pulls`, Pull, { title, head, base, body })
  await gh.request('POST', `/repos/${repo}/issues/${data.number}/labels`, z.unknown(), { labels: [label] }).catch(() => undefined)
  return { url: data.html_url, existed: false }
}

/** Create a label, or update its colour and description (gh label create --force). */
async function ensureLabel(gh: Github, repo: string, name: string, color: string, description: string): Promise<void> {
  try {
    await gh.request('POST', `/repos/${repo}/labels`, z.unknown(), { name, color, description })
  } catch (e) {
    if (!(e instanceof GithubError) || e.status !== 422) throw e
    await gh.request('PATCH', `/repos/${repo}/labels/${encodeURIComponent(name)}`, z.unknown(), { color, description })
  }
}

/** The repository settings the loop needs (src/core/onboard.ts applySettings, over REST). Returns what was done. */
export async function applySettingsApi(gh: Github, repo: string, cfg: ResolvedConfig, ruleset = true): Promise<string[]> {
  const done: string[] = []
  await gh.request('PATCH', `/repos/${repo}`, z.unknown(), { allow_auto_merge: true, delete_branch_on_merge: true, allow_update_branch: true })
  done.push('allowed auto-merge and updating branches, and deleting branches on merge')
  for (const [key, [color, description]] of Object.entries(LABEL_STYLE) as [keyof ResolvedConfig['labels'], readonly [string, string]][]) {
    await ensureLabel(gh, repo, cfg.labels[key], color, description)
  }
  done.push('created the labels')
  if (ruleset) {
    const { data: existing } = await gh.request('GET', `/repos/${repo}/rulesets`, z.array(z.object({ name: z.string() }).loose()))
    if (!existing.some((r) => r.name === 'trace')) {
      await gh.request('POST', `/repos/${repo}/rulesets`, z.unknown(), {
        name: 'trace', target: 'branch', enforcement: 'active',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        rules: [
          { type: 'deletion' }, { type: 'non_fast_forward' },
          { type: 'pull_request', parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: Boolean(cfg.worker.escalate_to.trim()), require_last_push_approval: false, required_review_thread_resolution: false } },
          { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: cfg.build.required_check }] } },
        ],
      })
      done.push(`added the "trace" ruleset: ${cfg.branch} takes changes by PR only, and only when "${cfg.build.required_check}" passes`)
    }
  }
  return done
}

export async function onboardViaApi(slug: string, o: ApiOnboardOptions): Promise<ApiOnboardResult> {
  const git = o.git ?? gitRunner(gitEnv(o.token, o.login))
  const gh = new Github(o.token, o.fetchImpl)
  const source = o.source ?? SOURCE
  const ref = o.ref ?? REF
  const tmp = mkdtempSync(join(tmpdir(), 'trace-onboard-'))
  const repo = join(tmp, 'repo')
  try {
    // ---------------------------------------------------------------- a new repository
    if (o.create) {
      await createRepo(o.token, slug, { private: o.create.private, description: 'Put under trace by `trace install`' }, o.fetchImpl)
      git(['git', 'init', '-q', '-b', 'main', repo])
      scaffold(repo, o.create.template, slug.split('/')[1] ?? 'project')
      const d = await detect(repo, 'main', git)
      d.language = o.create.template
      d.build = null
      writeFiles(repo, d, settingsFor(d, o.escalateTo), source, ref)
      git(['git', 'add', '-A'], { cwd: repo })
      git(['git', 'commit', '-q', '-m', `Start ${slug} under trace`], { cwd: repo })
      git(['git', 'push', '-q', `https://github.com/${slug}.git`, 'HEAD:refs/heads/main'], { cwd: repo })
      const settings = o.apply ? await applySettingsApi(gh, slug, load(repo)) : []
      return { repo: slug, state: 'created', pr: null, settings, notes: [] }
    }
    git(['git', 'clone', '-q', '--depth', '50', `https://github.com/${slug}.git`, repo])
    const onboarded = existsSync(join(repo, '.trace', 'project.db'))
    // ---------------------------------------------------------------- onboarded already: refresh the workflows
    if (onboarded) {
      const cfg = load(repo)
      const buildFile = join(repo, '.github', 'workflows', cfg.build.workflow)
      const buildName = existsSync(buildFile) ? readWorkflow(readFileSync(buildFile, 'utf8')).name || cfg.build.workflow : cfg.build.workflow
      git(['git', 'checkout', '-q', '-B', REFRESH_BRANCH], { cwd: repo })
      writeWorkflows(repo, cfg, buildName, source, ref)
      const changed = git(['git', 'status', '--porcelain', '--', '.github/workflows'], { cwd: repo }).trim()
      const settings = o.apply ? await applySettingsApi(gh, slug, cfg) : []
      if (!changed) return { repo: slug, state: 'unchanged', pr: null, settings, notes: ['the trace workflows are current'] }
      git(['git', 'add', '-A', '.github/workflows'], { cwd: repo })
      git(['git', 'commit', '-q', '-m', 'Refresh the trace workflows\n\nRendered again by `trace install` from this repository\'s settings, for the trace version it installed (for example: jobs on its CodeBuild-hosted runner when TRACE_CODEBUILD_PROJECT is set).'], { cwd: repo })
      git(['git', 'push', '-q', '--force', 'origin', `HEAD:refs/heads/${REFRESH_BRANCH}`], { cwd: repo })
      const pr = await pullRequest(gh, slug, REFRESH_BRANCH, cfg.branch, 'Refresh the trace workflows', [
        'The trace workflows, rendered again by `trace install` from this repository\'s own settings for the trace version now installed.',
        '', ...changed.split('\n').map((l) => `- \`${l.slice(3)}\``),
        '', `Held with the \`${cfg.labels.hold}\` label: merge it yourself.`,
      ].join('\n'), cfg.labels.hold)
      return { repo: slug, state: 'refreshed', pr: pr.url, settings, notes: [] }
    }
    // ---------------------------------------------------------------- the first onboarding: a held PR
    const d = await detect(repo, undefined, git)
    git(['git', 'checkout', '-q', '-B', ONBOARD_BRANCH], { cwd: repo })
    const written = writeFiles(repo, d, settingsFor(d, o.escalateTo), source, ref)
    const cfg = load(repo)
    git(['git', 'add', '-A', '.trace', '.github', '.gitattributes', 'CLAUDE.md'], { cwd: repo })
    git(['git', 'commit', '-q', '-m', 'Put this repository under trace\n\nAdds the project database with detected settings, empty rules, the trace workflows, and the merge driver for the database.'], { cwd: repo })
    git(['git', 'push', '-q', '--force', 'origin', `HEAD:refs/heads/${ONBOARD_BRANCH}`], { cwd: repo })
    await ensureLabel(gh, slug, cfg.labels.hold, 'fbca04', 'Held: not merged automatically')
    const body = [
      'Puts this repository under trace: it opens and merges its own PRs, triages CI failures, and fixes them with Claude; deploys stay off until enabled.',
      '', ...written.map((w) => `- \`${w}\``),
      ...(d.notes.length ? ['', '**Notes**', ...d.notes.map((n) => `- ${n}`)] : []),
      '', '**Set up by `trace install`**: this repository\'s AWS role, runtime and memory variables, its TRACE_TOKEN secret, and (when it could) its CodeBuild runner.',
      '', '**Before it runs**', `- ${checklist(slug).at(-1) ?? 'Write the rules in .trace/rules.md (it starts empty).'}`,
      '', `Held with the \`${cfg.labels.hold}\` label: merge it yourself.`,
    ].join('\n')
    const pr = await pullRequest(gh, slug, ONBOARD_BRANCH, cfg.branch, 'Put this repository under trace', body, cfg.labels.hold)
    const settings = o.apply ? await applySettingsApi(gh, slug, cfg) : []
    return { repo: slug, state: pr.existed ? 'updated' : 'opened', pr: pr.url, settings, notes: d.notes }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
