/**
 * Onboarding: put a repository under trace — an existing one (`trace onboard`) or a new one (`trace new`).
 *
 * What a repository gets:
 *   .trace/project.db              its own database: settings (detected, then changed with `trace config set`) and,
 *                                  later, its run record
 *   .trace/rules.md                EMPTY. The owner writes the rules; the agents read them as the authority.
 *   .github/workflows/trace-*.yml  four thin workflows that call the harness's actions in the trace repository:
 *                                  prs (open, auto-merge, update queue), ci (CI doctor), worker (Claude fixes what
 *                                  breaks), deploy (off until deploy.enabled)
 *   .gitattributes                 the project database merges with `trace db merge`
 *   CLAUDE.md                      a short pointer to the rules and the tools (appended, never replacing anything)
 * and, with --apply-settings, the repository settings the loop needs (auto-merge allowed, branches deleted on merge,
 * the labels, and a ruleset requiring the build's check on the default branch).
 *
 * An existing repository is changed on a branch, `trace/onboard`, and a pull request labelled to hold it, so a person
 * reads what it adds before it runs. A new repository is created, scaffolded and pushed to its default branch.
 * GitHub is reached with the `gh` CLI (signed in as the person running this).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LABEL_STYLE } from '../harness/util.js'
import { ensureSchema, read, update } from './central.js'
import { type FirmwareTargetSchema, type ResolvedConfig, load, setValue } from './config.js'
import type { z } from 'zod'

export const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates')
export const SOURCE = process.env.TRACE_SOURCE || 'mteichtahl/trace'
export const REF = process.env.TRACE_REF || 'v1'
export const ONBOARD_BRANCH = 'trace/onboard'
export const CLAUDE_MARKER = '<!-- trace -->'

export class OnboardError extends Error {
  override name = 'OnboardError'
}

export interface RunOptions { cwd?: string; input?: string; check?: boolean }
export type Runner = (cmd: readonly string[], opts?: RunOptions) => string

/** Run a command; return stdout. Replaceable in tests. */
export const runCommand: Runner = (cmd, opts = {}) => {
  const [exe, ...args] = cmd
  if (!exe) throw new OnboardError('empty command')
  const p = spawnSync(exe, args, { cwd: opts.cwd, input: opts.input, encoding: 'utf8', timeout: 300_000 })
  if (p.error) throw new OnboardError(`${exe}: ${p.error.message}`)
  if ((opts.check ?? true) && p.status !== 0) throw new OnboardError(`${cmd.slice(0, 3).join(' ')}…: ${(p.stderr || p.stdout).trim().slice(0, 600)}`)
  return p.stdout
}

// ------------------------------------------------------------------ detection

export interface Workflow { file: string; name: string; jobs: string[]; triggers: string[] }
type FirmwareTarget = z.input<typeof FirmwareTargetSchema>
export type Language = 'empty' | 'python' | 'rust' | 'kicad'

export interface Detected {
  branch: string
  build: Workflow | null
  check: string
  kicadProjects: string[]
  firmwareTargets: FirmwareTarget[]
  language: Language
  notes: string[]
}

/** Name, job display names and triggers of a workflow, read with a few patterns: these are always top-level keys in
 * GitHub's format, so no YAML parser is needed. */
export function readWorkflow(text: string): { name: string; jobs: string[]; triggers: string[] } {
  const name = /^name:\s*['"]?([^'"\n#]+?)['"]?\s*(#.*)?$/m.exec(text)?.[1]?.trim() ?? ''
  const triggers: string[] = []
  const on = /^(?:on|"on"|'on'):[ \t]*(.*)$/m.exec(text)
  if (on) {
    const inline = (on[1] ?? '').trim()
    if (inline) triggers.push(...(inline.match(/[a-z_]+/g) ?? []))
    else {
      for (const line of text.slice(on.index + on[0].length).split('\n').slice(1)) {
        if (line && !line.startsWith(' ') && !line.startsWith('#')) break
        const k = /^ {2}([a-z_]+):/.exec(line)
        if (k?.[1]) triggers.push(k[1])
      }
    }
  }
  const jobs: string[] = []
  const jm = /^jobs:\s*$/m.exec(text)
  if (jm) {
    const lines = text.slice(jm.index + jm[0].length).split('\n').slice(1)
    let current: { id: string; name: string | null } | null = null
    const flush = (): void => { if (current) jobs.push(current.name ?? current.id) }
    for (const line of lines) {
      if (line && !line.startsWith(' ') && !line.startsWith('#')) break
      const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
      if (job?.[1]) { flush(); current = { id: job[1], name: null }; continue }
      const nm = /^ {4}name:\s*['"]?([^'"\n#]+?)['"]?\s*$/.exec(line)
      if (nm?.[1] && current && current.name === null) current.name = nm[1].trim()
    }
    flush()
  }
  return { name, jobs, triggers }
}

function walk(dir: string, skip: (rel: string) => boolean, out: string[] = [], root = dir): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    const rel = relative(root, p)
    if (skip(rel)) continue
    if (e.isDirectory()) walk(p, skip, out, root)
    else out.push(rel)
  }
  return out
}

const skipDir = (rel: string): boolean => rel.split('/').some((part) => part.startsWith('.') || part === 'node_modules' || part === 'build' || part.endsWith('-backups'))

export async function detect(repo: string, branch?: string, run: Runner = runCommand): Promise<Detected> {
  const d: Detected = { branch: branch ?? '', build: null, check: '', kicadProjects: [], firmwareTargets: [], language: 'empty', notes: [] }
  if (!d.branch) {
    const head = run(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repo, check: false }).trim()
    d.branch = head.includes('/') ? head.split('/').slice(1).join('/') : run(['git', 'branch', '--show-current'], { cwd: repo, check: false }).trim() || 'main'
  }
  const wfDir = join(repo, '.github', 'workflows')
  const candidates: Workflow[] = []
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
      if (f.startsWith('trace-') && f !== 'trace-build.yml') continue
      const w = readWorkflow(readFileSync(join(wfDir, f), 'utf8'))
      if (w.triggers.includes('push') || w.triggers.includes('pull_request')) candidates.push({ file: f, name: w.name || f, jobs: w.jobs, triggers: w.triggers })
    }
  }
  const prefer = candidates.filter((w) => /build|ci|test|check/i.test(`${w.file} ${w.name}`))
  const chosen = prefer[0] ?? candidates[0]
  if (chosen) {
    d.build = chosen
    if (candidates.length > 1) d.notes.push(`Several workflows build on push/PR; chose ${chosen.file}. Change with \`trace config set build.workflow <file>\`.`)
    const gate = chosen.jobs.find((j) => /^(tests? pass(es|ed)?|all checks|ci ok|gate)$/i.test(j))
    if (gate) d.check = gate
    else if (chosen.jobs.length === 1) d.check = chosen.jobs[0] ?? ''
    else if (chosen.jobs.length) {
      d.check = chosen.jobs.at(-1) ?? ''
      d.notes.push(`${chosen.file} has several jobs and no single gate job; chose "${d.check}" as the required check. A gate job that needs all the others (named "tests pass") is safer.`)
    }
  }
  d.kicadProjects = walk(repo, skipDir).filter((p) => p.endsWith('.kicad_pro')).sort()
  try {
    const spec = '../firmware/detect.js'
    const mod = (await import(spec)) as { detectAll?: (root: string) => FirmwareTarget[] }
    d.firmwareTargets = mod.detectAll ? mod.detectAll(repo) : []
  } catch {
    d.firmwareTargets = [] // detection is a convenience, never a blocker
  }
  if (existsSync(join(repo, 'pyproject.toml')) || existsSync(join(repo, 'setup.py'))) d.language = 'python'
  else if (existsSync(join(repo, 'Cargo.toml'))) d.language = 'rust'
  else if (d.kicadProjects.length) d.language = 'kicad'
  return d
}

// ------------------------------------------------------------------ writing

export function render(text: string, values: Readonly<Record<string, string>>): string {
  let out = text
  for (const [k, v] of Object.entries(values)) out = out.replaceAll(`__TR_${k}__`, v)
  const left = [...new Set(out.match(/__TR_[A-Z_]+__/g) ?? [])]
  if (left.length) throw new OnboardError(`template placeholders left unfilled: ${left.sort().join(', ')}`)
  return out
}

export function settingsFor(d: Detected, escalateTo = ''): Record<string, unknown> {
  const s: Record<string, unknown> = { branch: d.branch }
  if (d.build) s['build.workflow'] = d.build.file
  if (d.check) s['build.required_check'] = d.check
  if (d.kicadProjects.length) s['electronics.projects'] = d.kicadProjects
  if (d.firmwareTargets.length) s['firmware.targets'] = d.firmwareTargets
  if (escalateTo) s['worker.escalate_to'] = escalateTo
  return s
}

const tpl = (rel: string): string => readFileSync(join(TEMPLATES, rel), 'utf8')

/** Write everything onboarding adds. Returns the paths written (relative). */
export function writeFiles(repo: string, d: Detected, settings: Record<string, unknown>, source = SOURCE, ref = REF): string[] {
  const written: string[] = []
  for (const [k, v] of Object.entries(settings)) setValue(k, v, repo, 'trace onboard')
  let cfg: ResolvedConfig = load(repo)
  written.push('.trace/project.db')
  const rules = join(repo, '.trace', 'rules.md')
  if (!existsSync(rules)) { writeFileSync(rules, tpl('rules.md')); written.push('.trace/rules.md') }
  const wf = join(repo, '.github', 'workflows')
  mkdirSync(wf, { recursive: true })
  if (!d.build) {
    const starter = existsSync(join(TEMPLATES, 'build', `${d.language}.yml`)) ? `build/${d.language}.yml` : 'build/empty.yml'
    writeFileSync(join(wf, 'trace-build.yml'), render(tpl(starter), { BRANCH: cfg.branch, SOURCE: source, REF: ref }))
    written.push('.github/workflows/trace-build.yml')
    d.build = { file: 'trace-build.yml', name: 'build', jobs: ['tests pass'], triggers: ['push', 'pull_request'] }
    setValue('build.workflow', 'trace-build.yml', repo, 'trace onboard')
    setValue('build.required_check', 'tests pass', repo, 'trace onboard')
    cfg = load(repo)
  }
  written.push(...writeWorkflows(repo, cfg, d.build.name, source, ref))
  const ga = join(repo, '.gitattributes')
  const line = '.trace/project.db binary merge=trace-db'
  const existing = existsSync(ga) ? readFileSync(ga, 'utf8') : ''
  if (!existing.includes(line)) {
    writeFileSync(ga, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${line}\n`)
    written.push('.gitattributes')
  }
  const owners = codeOwners(repo, cfg)
  if (owners) written.push(owners)
  const cm = join(repo, 'CLAUDE.md')
  const text = existsSync(cm) ? readFileSync(cm, 'utf8') : ''
  if (!text.includes(CLAUDE_MARKER)) {
    writeFileSync(cm, `${text}${text && !text.endsWith('\n\n') ? (text.endsWith('\n') ? '\n' : '\n\n') : ''}${tpl('claude-section.md')}`)
    written.push('CLAUDE.md')
  }
  return written
}

/** The trace workflows (templates/workflows/trace-*.yml), rendered for this project's settings, into
 * .github/workflows. `buildName`: the build workflow's name (what trace-ci watches). Returns the paths written. */
export function writeWorkflows(repo: string, cfg: ResolvedConfig, buildName: string, source = SOURCE, ref = REF): string[] {
  const values = {
    SOURCE: source, REF: ref, BRANCH: cfg.branch, BUILD_NAME: buildName,
    HOLD: cfg.labels.hold, CI_RED: cfg.labels.ci_red, AGENT_FIX: cfg.labels.agent_fix,
    DEPLOY: cfg.labels.deploy, DEPLOY_HELD: cfg.labels.deploy_held, ENVIRONMENT: cfg.deploy.environment,
  }
  const wf = join(repo, '.github', 'workflows')
  mkdirSync(wf, { recursive: true })
  const written: string[] = []
  for (const f of readdirSync(join(TEMPLATES, 'workflows')).filter((n) => n.startsWith('trace-')).sort()) {
    writeFileSync(join(wf, f), render(tpl(`workflows/${f}`), values))
    written.push(`.github/workflows/${f}`)
  }
  return written
}

const OWNERS_BEGIN = '# trace: files that steer trace need a person (worker.escalate_to) to approve'
const OWNERS_END = '# end trace'

/** prs.protected_paths glob → a CODEOWNERS pattern. */
export function ownersPattern(glob: string): string {
  const g = glob.replace(/\/\*\*$/, '/')
  return g.startsWith('**/') ? g.slice(3) : `/${g}`
}

/** With worker.escalate_to set, give that person or team ownership of prs.protected_paths, so the ruleset's code
 * owner review makes a PR that changes them wait for their approval (the agent's own token can't approve its PR).
 * Uses the CODEOWNERS file GitHub would read; the trace section is rewritten in place. Returns the path written. */
export function codeOwners(repo: string, cfg: ResolvedConfig): string | null {
  const who = cfg.worker.escalate_to.trim()
  if (!who) return null
  const owner = who.startsWith('@') ? who : `@${who}`
  const rel = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].find((f) => existsSync(join(repo, f))) ?? '.github/CODEOWNERS'
  const path = join(repo, rel)
  const before = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const section = [OWNERS_BEGIN, ...cfg.prs.protected_paths.map((g) => `${ownersPattern(g)} ${owner}`), OWNERS_END].join('\n')
  const start = before.indexOf(OWNERS_BEGIN)
  const end = before.indexOf(OWNERS_END)
  // Last match wins in CODEOWNERS, so the trace section goes at the end where nothing later can override it.
  const rest = start >= 0 && end > start ? before.slice(0, start) + before.slice(end + OWNERS_END.length).replace(/^\n/, '') : before
  const next = `${rest}${rest && !rest.endsWith('\n') ? '\n' : ''}${section}\n`
  if (next === before) return null
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, next)
  return rel
}

// ------------------------------------------------------------------ GitHub

/** Every label the harness uses, the specialists' routing labels (agent:verify, …) included. */
const LABELS = LABEL_STYLE

/** Repository settings the loop needs. Returns what was done. */
export function applySettings(slug: string, cfg: ResolvedConfig, ruleset = true, run: Runner = runCommand): string[] {
  const done: string[] = []
  run(['gh', 'api', '-X', 'PATCH', `repos/${slug}`, '-F', 'allow_auto_merge=true', '-F', 'delete_branch_on_merge=true', '-F', 'allow_update_branch=true'])
  done.push('allowed auto-merge and updating branches, and deleting branches on merge')
  for (const [key, [color, description]] of Object.entries(LABELS) as [keyof ResolvedConfig['labels'], readonly [string, string]][]) {
    run(['gh', 'label', 'create', cfg.labels[key], '-R', slug, '--color', color, '--description', description, '--force'], { check: false })
  }
  done.push('created the labels')
  if (ruleset) {
    let existing: unknown = []
    try { existing = JSON.parse(run(['gh', 'api', `repos/${slug}/rulesets`], { check: false }) || '[]') } catch { existing = [] }
    const has = Array.isArray(existing) && existing.some((r) => typeof r === 'object' && r !== null && (r as { name?: unknown }).name === 'trace')
    if (!has) {
      const body = {
        name: 'trace', target: 'branch', enforcement: 'active',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        rules: [
          { type: 'deletion' }, { type: 'non_fast_forward' },
          { type: 'pull_request', parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: Boolean(cfg.worker.escalate_to.trim()), require_last_push_approval: false, required_review_thread_resolution: false } },
          { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: cfg.build.required_check }] } },
        ],
      }
      run(['gh', 'api', '-X', 'POST', `repos/${slug}/rulesets`, '--input', '-'], { input: JSON.stringify(body) })
      done.push(`added the "trace" ruleset: ${cfg.branch} takes changes by PR only, and only when "${cfg.build.required_check}" passes`)
    }
  }
  return done
}

export function checklist(slug: string): string[] {
  return [
    `Secret TRACE_TOKEN on ${slug}: a fine-grained token for this repository with Contents, Pull requests, Issues, Workflows and Actions read/write (merges, PRs and pushes made with it start the build).`,
    'Model access for the worker: repository variable TRACE_AWS_ROLE (+ TRACE_AWS_REGION) for Amazon Bedrock, or secret ANTHROPIC_API_KEY.',
    'The central database (shared datasheets and parts): variable TRACE_HOME = s3://<bucket>/<prefix>, set once for the account or organisation, with read/write on it granted to TRACE_AWS_ROLE.',
    `The trace repository (${SOURCE}) must let this one use its actions: in its Settings → Actions → General → Access, allow repositories owned by the same account.`,
    'Write the rules in .trace/rules.md (it starts empty).',
  ]
}

// ------------------------------------------------------------------ the registry of projects (central database)

const PROJECTS_SQL = 'CREATE TABLE IF NOT EXISTS projects (repo TEXT PRIMARY KEY, added REAL NOT NULL, path TEXT)'
ensureSchema(PROJECTS_SQL)

/** Add the repository to the central registry of projects. */
export async function register(slug: string, path: string | null): Promise<void> {
  await update((db) => { db.prepare('INSERT OR IGNORE INTO projects (repo, added, path) VALUES (?,?,?)').run(slug.toLowerCase(), Date.now() / 1000, path) })
}

export async function projects(): Promise<string[]> {
  const db = await read()
  try {
    return db.prepare('SELECT repo FROM projects ORDER BY repo').all().map((r) => String(r.repo))
  } finally {
    db.close()
  }
}

// ------------------------------------------------------------------ the two flows

export interface OnboardOptions {
  path?: string
  push?: boolean
  apply?: boolean
  ruleset?: boolean
  escalateTo?: string
  source?: string
  ref?: string
  run?: Runner
}

export interface OnboardResult {
  repo: string
  branch: string
  build: ResolvedConfig['build']
  kicadProjects: string[]
  firmwareTargets: number
  written: string[]
  notes: string[]
  pr: string | null
  settings: string[]
  checklist: string[]
}

export async function onboard(slug: string, o: OnboardOptions = {}): Promise<OnboardResult> {
  const run = o.run ?? runCommand
  const push = o.push ?? true
  let tmp: string | null = null
  let repo: string
  if (o.path) repo = resolvePath(o.path)
  else {
    tmp = mkdtempSync(join(tmpdir(), 'trace-onboard-'))
    repo = join(tmp, 'repo')
    run(['gh', 'repo', 'clone', slug, repo, '--', '--depth', '50'])
  }
  try {
    const d = await detect(repo, undefined, run)
    if (push) run(['git', 'checkout', '-B', ONBOARD_BRANCH], { cwd: repo })
    const written = writeFiles(repo, d, settingsFor(d, o.escalateTo), o.source, o.ref)
    const cfg = load(repo)
    const result: OnboardResult = {
      repo: slug, branch: cfg.branch, build: cfg.build, kicadProjects: d.kicadProjects, firmwareTargets: d.firmwareTargets.length,
      written, notes: d.notes, pr: null, settings: [], checklist: checklist(slug),
    }
    if (push) {
      run(['git', 'add', '-A', '.trace', '.github/workflows', '.gitattributes', 'CLAUDE.md'], { cwd: repo })
      run(['git', 'commit', '-m', 'Put this repository under trace\n\nAdds the project database with detected settings, empty rules, the trace workflows, and the merge driver for the database.'], { cwd: repo })
      run(['git', 'push', '-u', 'origin', ONBOARD_BRANCH, '--force-with-lease'], { cwd: repo })
      const body = [
        'Puts this repository under trace: it opens and merges its own PRs, triages CI failures, and fixes them with Claude; deploys stay off until enabled.',
        '',
        ...written.map((w) => `- \`${w}\``),
        ...(d.notes.length ? ['', '**Notes**', ...d.notes.map((n) => `- ${n}`)] : []),
        '', '**Before it runs**', ...result.checklist.map((c) => `- ${c}`),
        '', `Held with the \`${cfg.labels.hold}\` label: merge it yourself once the above is set.`,
      ].join('\n')
      run(['gh', 'label', 'create', cfg.labels.hold, '-R', slug, '--color', 'fbca04', '--force'], { check: false })
      result.pr = run(['gh', 'pr', 'create', '-R', slug, '--head', ONBOARD_BRANCH, '--base', cfg.branch, '--title', 'Put this repository under trace', '--body', body, '--label', cfg.labels.hold], { cwd: repo }).trim()
    }
    if (o.apply) result.settings = applySettings(slug, cfg, o.ruleset ?? true, run)
    await register(slug, o.path ? repo : null)
    return result
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }
}

export const SCAFFOLDS = ['empty', 'python', 'kicad', 'rust'] as const
export type Scaffold = (typeof SCAFFOLDS)[number]

export function scaffold(repo: string, template: Scaffold, name: string): void {
  const src = join(TEMPLATES, 'scaffold', template)
  if (!existsSync(src)) return
  for (const rel of walk(src, () => false)) {
    if (!statSync(join(src, rel)).isFile()) continue
    const out = join(repo, rel.replaceAll('__name__', name.replaceAll('-', '_')).replace(/(^|\/)dot-/g, '$1.'))
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, readFileSync(join(src, rel), 'utf8').replaceAll('__TR_NAME__', name))
  }
}

export interface NewOptions { template?: Scaffold; private?: boolean; description?: string; path?: string; apply?: boolean; escalateTo?: string; source?: string; ref?: string; run?: Runner }

export async function createNew(slug: string, o: NewOptions = {}): Promise<{ repo: string; template: Scaffold; written: string[]; settings: string[]; checklist: string[] }> {
  const run = o.run ?? runCommand
  const template = o.template ?? 'empty'
  const name = slug.split('/')[1]
  if (!name) throw new OnboardError(`expected OWNER/REPO, got ${slug}`)
  run(['gh', 'repo', 'create', slug, o.private === false ? '--public' : '--private', ...(o.description ? ['--description', o.description] : [])])
  const tmp = o.path ? null : mkdtempSync(join(tmpdir(), 'trace-new-'))
  const repo = o.path ? resolvePath(o.path) : join(tmp!, name)
  try {
    mkdirSync(repo, { recursive: true })
    run(['git', 'init', '-q', '-b', 'main'], { cwd: repo })
    scaffold(repo, template, name)
    const d = await detect(repo, 'main', run)
    d.language = template
    d.build = null // the starter build for this template
    const written = writeFiles(repo, d, settingsFor(d, o.escalateTo), o.source, o.ref)
    run(['git', 'add', '-A'], { cwd: repo })
    run(['git', 'commit', '-q', '-m', `Start ${slug} under trace`], { cwd: repo })
    run(['git', 'remote', 'add', 'origin', `https://github.com/${slug}.git`], { cwd: repo })
    run(['git', 'push', '-u', 'origin', 'main'], { cwd: repo })
    const settings = (o.apply ?? true) ? applySettings(slug, load(repo), true, run) : []
    await register(slug, o.path ? repo : null)
    return { repo: slug, template, written, settings, checklist: checklist(slug) }
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }
}
