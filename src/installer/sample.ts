/**
 * The sample project the installer can add: a repository holding one small, finished board design (templates/sample)
 * that exercises the whole of trace. Installing it:
 *
 *   1 before the deploy  the repository is created if it does not exist (pushSample's caller: github.ts ensureRepo) and
 *                        the design's files are committed onto its default branch through the Git data API (no clone,
 *                        no gh CLI). Nothing in an existing repository is deleted; files are added or updated
 *   2 the deploy and the repositories' variables treat it as one more project (withSample)
 *   3 onboarding         the trace files (project database with its settings, rules, workflows, CLAUDE.md, and the
 *                        sample's own rules) are written by the same code `trace onboard` uses, then committed straight
 *                        onto the default branch: the installer made this repository, and its tour must start without
 *                        anyone merging a PR first. Then its repository settings, like any onboarded repository's
 *   4 the tour           one issue per task in TOUR (templates/sample/tour.json), each labelled for the agent that takes
 *                        it. Together they run every agent and every simulation once. An issue already open with the
 *                        same title is left alone, so a second run opens only what is missing
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { Answers } from './answers.js'
import { type RepoFile, commitFiles, hasFile, listIssues, openIssue } from './github.js'

export const SAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'sample')

/** Said in the plan about what the sample is. */
export const SAMPLE_DESCRIPTION = 'a small sensor board (an intent, a KiCad schematic and board, analog, mixed-signal, logic, thermal, EMC and protocol models, firmware and a hardware-in-the-loop bench that runs on emulated instruments) that exercises every agent and every simulation.'

/** The sample's repository: the one named, else `<login>/trace-sample`. */
export function sampleRepo(a: Pick<Answers, 'sample' | 'github'>): string {
  if (a.sample.repo) return a.sample.repo
  if (!a.github.login) throw new Error('the sample\'s repository has no owner: check the GitHub token, or name the repository')
  return `${a.github.login}/trace-sample`
}

/** The answers with the sample as one more project (when asked for, and not listed already). */
export function withSample(a: Answers): Answers {
  if (!a.sample.enabled) return a
  const repo = sampleRepo(a)
  if (a.projects.some((p) => p.repo.toLowerCase() === repo.toLowerCase())) return a
  return { ...a, projects: [...a.projects, { repo, branch: 'main', onboard: true, applySettings: true, memoryEventExpiryDays: null, generation: 0 }] }
}

// ------------------------------------------------------------------ the files

/** Paths in templates/sample that are the installer's, not the sample repository's. */
const INSTALLER_ONLY = new Set(['tour.json', 'settings.json'])

function walk(dir: string, root = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, root, out)
    else out.push(relative(root, p))
  }
  return out.sort()
}

/** templates/sample's files as the repository holds them: `dot-x` becomes `.x` (npm drops dot-files from packages). */
export function sampleFiles(dir = SAMPLE_DIR): RepoFile[] {
  return walk(dir).filter((rel) => !INSTALLER_ONLY.has(rel)).map((rel) => ({
    path: rel.replace(/(^|\/)dot-/g, '$1.'),
    content: readFileSync(join(dir, rel)),
    executable: (statSync(join(dir, rel)).mode & 0o111) !== 0,
  }))
}

/** Commit the sample's design files onto `branch` (null: they are there already). */
export async function pushSample(token: string, repo: string, branch: string, dir = SAMPLE_DIR): Promise<string | null> {
  return commitFiles(token, repo, branch, sampleFiles(dir), 'The trace sample project\n\nOne small sensor board, from intent to fabrication files, that exercises every trace agent and every simulation.')
}

// ------------------------------------------------------------------ onboarding

export interface SampleOnboard { url: string; commit: string | null; settings: string[]; seeded?: string[] }

/**
 * Put the sample under trace: the files `trace onboard` writes (core/onboard.ts writeFiles, on a scratch copy of the
 * sample with its settings), committed onto the default branch, then the repository settings (labels, auto-merge, the
 * ruleset) when asked. A repository already under trace (it has .trace/project.db and the workflows) is left as it is.
 */
export async function onboardSample(token: string, repo: string, branch: string, o: { escalateTo: string; applySettings: boolean }, dir = SAMPLE_DIR): Promise<SampleOnboard> {
  const url = `https://github.com/${repo}`
  const { applySettings, detect, settingsFor, writeFiles } = await import('../core/onboard.js')
  const { load } = await import('../core/config.js')
  const tmp = mkdtempSync(join(tmpdir(), 'trace-sample-'))
  try {
    // a scratch copy of the repository as pushSample left it
    const work = join(tmp, 'repo')
    for (const f of sampleFiles(dir)) {
      mkdirSync(dirname(join(work, f.path)), { recursive: true })
      writeFileSync(join(work, f.path), f.content)
    }
    let commit: string | null = null
    const lines: string[] = []
    const under = await hasFile(token, repo, branch, '.trace/project.db') && await hasFile(token, repo, branch, '.github/workflows/trace-worker.yml')
    if (!under) {
      const d = await detect(work, branch, () => '')
      const settings = { ...settingsFor(d, o.escalateTo), ...sampleSettings(dir) }
      const written = writeFiles(work, d, settings)
      // the sample's requirements, test plan, specs and thermal data, in the same project database
      const { seedSample } = await import('./sample-seed.js')
      for (const l of seedSample(work)) lines.push(l)
      const files: RepoFile[] = [...new Set(written)].map((rel) => ({ path: rel, content: readFileSync(join(work, rel)) }))
      commit = await commitFiles(token, repo, branch, files, 'Put the sample project under trace\n\nThe project database with its settings, the trace workflows, the merge driver for the database and CLAUDE.md. Committed by the installer, which created this repository.')
    }
    let settings: string[] = []
    if (o.applySettings) {
      const prior = process.env.GH_TOKEN
      process.env.GH_TOKEN = token
      try {
        settings = applySettings(repo, load(work))
      } finally {
        if (prior === undefined) delete process.env.GH_TOKEN
        else process.env.GH_TOKEN = prior
      }
    }
    return { url, commit, settings, seeded: lines }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** The sample's own settings, beyond what onboarding detects (templates/sample/settings.json). */
export function sampleSettings(dir = SAMPLE_DIR): Record<string, unknown> {
  const p = join(dir, 'settings.json')
  return existsSync(p) ? z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(p, 'utf8'))) : {}
}

// ------------------------------------------------------------------ the tour

export const TourTask = z.object({
  /** stable id, also in the issue body, so a re-run recognises the task */
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(5),
  /** the agent that takes it (src/agents/kinds.ts) */
  agent: z.string(),
  /** labels the issue gets (the agent's routing label first) */
  labels: z.array(z.string()).min(1),
  /** the tools and simulations it is there to run, as tool names (src/tools) */
  exercises: z.array(z.string()).min(1),
  /** runs as a GPU or CPU Batch job: left out when GPU jobs are off */
  remote: z.enum(['gpu', 'cpu']).nullable().default(null),
  body: z.string().min(20),
}).strict()
export type TourTask = z.infer<typeof TourTask>

export function tour(dir = SAMPLE_DIR): TourTask[] {
  return z.array(TourTask).parse(JSON.parse(readFileSync(join(dir, 'tour.json'), 'utf8')))
}

const MARK = (id: string): string => `<!-- trace-sample-tour:${id} -->`

/** Said in the plan about the tour. */
export function tourPlan(repo: string, gpu: boolean, dir = SAMPLE_DIR): string {
  const t = tour(dir)
  const agents = [...new Set(t.map((x) => x.agent))]
  const remote = t.filter((x) => x.remote)
  return `once everything else is installed, open ${t.length - (gpu ? 0 : remote.length)} tasks in ${repo}, each labelled for the agent that takes it (${agents.join(', ')}), so every agent and every simulation runs once${gpu ? '' : `; ${remote.length} that need GPU or CPU jobs are left out because GPU jobs are off`}. They run on AWS like any other work and cost what that work costs`
}

export interface TourResult { url: string; opened: number; existing: number; skipped: string[]; lines: string[] }

/** Open the tour's issues that are not open yet. */
export async function startTour(token: string, repo: string, o: { gpu: boolean }, dir = SAMPLE_DIR): Promise<TourResult> {
  const tasks = tour(dir)
  const have = await listIssues(token, repo)
  const titles = new Set(have.map((i) => i.title))
  const lines: string[] = []
  const skipped: string[] = []
  let opened = 0
  let existing = 0
  for (const t of tasks) {
    if (t.remote && !o.gpu) { skipped.push(`${t.title}: needs ${t.remote.toUpperCase()} jobs, which are off`); continue }
    if (titles.has(t.title)) { existing++; lines.push(`${t.title}: already there`); continue }
    const body = `${t.body}\n\n---\nPart of the sample's tour: this task is for the **${t.agent}** agent and runs ${t.exercises.map((x) => `\`${x}\``).join(', ')}.\n${MARK(t.id)}`
    const r = await openIssue(token, repo, { title: t.title, body, labels: t.labels })
    opened++
    lines.push(`${t.title}: ${r.url}`)
  }
  return { url: `https://github.com/${repo}/issues`, opened, existing, skipped, lines }
}
