/**
 * The sample project the installer can add: a new repository holding one small, finished board design
 * (templates/sample) that exercises the whole of trace. It is a project like any other, created by the installer
 * (ProjectAnswer.create, template 'sample'):
 *
 *   github step  the repository is created (github.ts createRepo), empty
 *   onboard      onboard-api.ts writes the sample's files (scaffoldSample: binary-safe, `dot-x` → `.x`, the
 *                installer-only files left out), puts it under trace with the sample's own settings (sampleSettings),
 *                seeds its project database (sample-seed.ts seedSample: requirements, test plan, specs, thermal data)
 *                and pushes it all to main in one commit
 *   tour         last, one issue per task in templates/sample/tour.json, each labelled for the agent that takes it.
 *                Together they run every agent and every simulation once. An issue already there with the same title
 *                is left alone, so a second run opens only what is missing
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { Answers } from './answers.js'
import { listIssues, openIssue } from './github.js'

export const SAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'sample')

/** Said in the plan about what the sample is. */
export const SAMPLE_DESCRIPTION = 'a small sensor board (an intent, a KiCad schematic and board, analog, mixed-signal, logic, thermal, EMC and protocol models, firmware and a hardware-in-the-loop bench that runs on emulated instruments) that exercises every agent and every simulation.'

/** The sample's repository: the one named, else `<login>/trace-sample` (the login is derived, when not given, before
 * the installer needs this). */
export function sampleRepo(a: Pick<Answers, 'sample' | 'github'>): string {
  if (a.sample.repo) return a.sample.repo
  if (!a.github.login) throw new Error('the sample\'s repository has no owner: check the GitHub token, or name the repository')
  return `${a.github.login}/trace-sample`
}

/** The answers with the sample as one more project, a new repository to create (when asked for, and not listed
 * already: once created, the saved answers list it as an existing repository). */
export function withSample(a: Answers): Answers {
  if (!a.sample.enabled) return a
  const repo = sampleRepo(a)
  if (a.projects.some((p) => p.repo.toLowerCase() === repo.toLowerCase())) return a
  return { ...a, projects: [...a.projects, { repo, branch: 'main', onboard: true, applySettings: true, memoryEventExpiryDays: null, generation: 0, create: { template: 'sample', private: a.sample.private } }] }
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
/** A file of the sample: its path in the repository and its bytes. */
export interface SampleFile { path: string; content: Buffer; executable: boolean }

export function sampleFiles(dir = SAMPLE_DIR): SampleFile[] {
  return walk(dir).filter((rel) => !INSTALLER_ONLY.has(rel)).map((rel) => ({
    path: rel.replace(/(^|\/)dot-/g, '$1.'),
    content: readFileSync(join(dir, rel)),
    executable: (statSync(join(dir, rel)).mode & 0o111) !== 0,
  }))
}

/** Write the sample's files into `repo` (a new repository's working tree). */
export function scaffoldSample(repo: string, dir = SAMPLE_DIR): string[] {
  const files = sampleFiles(dir)
  for (const f of files) {
    const out = join(repo, f.path)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, f.content)
    if (f.executable) chmodSync(out, 0o755)
  }
  return files.map((f) => f.path)
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
