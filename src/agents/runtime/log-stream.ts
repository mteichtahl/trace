/**
 * The worker runtime's run logs (docs/progress-and-logs.md, decision B): what each job and each tool call says, written
 * to the installation's runs log group (TRACE_RUNS_LOG_GROUP, src/core/run-logs.ts), one stream per run, kept a month,
 * and read by the app through the API (run.log). The 12-line tail in the job index stays for the lost-job summary.
 *
 *   job/<owner>/<repo>/<jobId>    streamJobs: listens to the jobs' events (src/agents/runtime/jobs.ts). A job's first
 *                                 event writes `▸ <its title>`, then every `log` event its line (at the line's own
 *                                 time), and its end `✓ done: <summary>`, `✗ <error>` or `⏸ paused: <why>`. A job with
 *                                 no repository (a sweep) has no stream
 *   tool/<owner>/<repo>/<runId>   toolRun: one forwarded tool call that came with a run id (ToolJob.runId): `▸ <tool>`,
 *                                 what the tool reports (src/core/progress.ts), then `✓ done in 12 s` or `✗ <why>`
 *                                 (src/agents/runtime/tool.ts)
 *   quiet                         when a job or a tool call ends, its longest silences per step are folded into the
 *                                 project's quiet profile (src/core/quiet.ts learnQuiet, projects/<slug>/progress/
 *                                 quiet.json in the central bucket), so the app can tell "quiet, as usual" from
 *                                 "later than usual". A job's from its in-memory log (JobInfo.log)
 *
 * The repository in a stream's name is the project's slug (lower case), as the API names it when it reads
 * (src/core/access.ts RepoSlug). The runtime role may write only job/<its slug>/* and tool/<its slug>/* of the group
 * (src/infra/project.ts).
 *
 * Nothing here fails or slows a job or a tool call: the writer only queues (src/core/cw-writer.ts), and learning the
 * quiet profile runs in the background and swallows its errors. Without TRACE_RUNS_LOG_GROUP (a laptop, tests, an
 * installation from before the group) nothing is written.
 */
import type { Backend } from '../../core/central.js'
import { type LogsApi, type RunLogWriter, awsLogsApi, runLogWriter } from '../../core/cw-writer.js'
import { projectSlug } from '../../core/project.js'
import type { ProgressSink } from '../../core/progress.js'
import { learnQuiet } from '../../core/quiet.js'
import { RUNS_LOG_GROUP_ENV, type RunKind, jobStream, stepGaps, stepLine, toolStream } from '../../core/run-logs.js'
import type { JobEvent, Jobs } from './jobs.js'
import { titleOf } from './job-index.js'
import type { JobInfo } from './schemas.js'

/** Fold one finished run's gaps into its project's quiet profile (learnQuiet with the store bound). */
export type LearnQuiet = (repo: string, run: string, kind: RunKind, what: string, gaps: Record<string, number>) => Promise<unknown>

/** learnQuiet on the central bucket's projects/ store (the job index's: src/agents/runtime/job-index.ts workerIndex). */
export const quietLearner = (projects: Backend): LearnQuiet => (repo, run, kind, what, gaps) => learnQuiet(projects, repo, run, kind, what, gaps)

/** The writer for the runs group named in the environment; null without one. `api`: tests give a fake. */
export function runLogsFromEnv(env: NodeJS.ProcessEnv = process.env, o: { api?: LogsApi; warn?: (l: string) => void } = {}): RunLogWriter | null {
  const group = env[RUNS_LOG_GROUP_ENV]?.trim()
  if (!group) return null
  return runLogWriter({ group, api: o.api ?? (() => awsLogsApi({ env })), ...(o.warn ? { warn: o.warn } : {}) })
}

let processWriter: RunLogWriter | null | undefined
/** This process's one writer (the jobs' and the tool calls' streams share its batching), from its environment. */
export function processRunLogs(): RunLogWriter | null {
  if (processWriter === undefined) processWriter = runLogsFromEnv()
  return processWriter
}

/** The stream's repository: the project's slug, or null for something that is not one. */
export function streamRepo(repository: string | undefined): string | null {
  if (!repository) return null
  try { return projectSlug(repository) } catch { return null }
}

/** "<ISO> text" (a JobInfo.log line, a `log` event's line) → its time and text; a line without a time is now's. */
export function parseJobLine(line: string, now: number = Date.now()): { at: number; text: string } {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)$/s.exec(line)
  const at = m ? Date.parse(m[1]!) : NaN
  return Number.isFinite(at) ? { at, text: m![2]! } : { at: now, text: line }
}

/** The last line of a run that ended, in the words the app reads (✓ passed, ✗ failed). */
export function endLine(job: Pick<JobInfo, 'state' | 'summary' | 'error'>): string {
  const one = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 500)
  switch (job.state) {
    case 'succeeded': return `✓ done${one(job.summary) ? `: ${one(job.summary)}` : ''}`
    case 'paused': return `⏸ paused${one(job.summary) ? `: ${one(job.summary)}` : ''}`
    case 'aborted': return `✗ stopped${one(job.error) ? `: ${one(job.error)}` : ''}`
    default: return `✗ ${one(job.error) || 'failed'}`
  }
}

export interface StreamJobsOptions {
  /** fold an ended job's gaps into its project's quiet profile; absent: not learned */
  learn?: LearnQuiet
  now?: () => number
}

/**
 * Write every job's log to its stream (see the module comment). Returns the function that stops listening. Listeners
 * of the jobs' events must not throw or block: everything here only queues.
 */
export function streamJobs(jobs: Jobs, writer: RunLogWriter, o: StreamJobsOptions = {}): () => void {
  const now = o.now ?? Date.now
  /** the jobs whose stream has its first line, by id: the stream's name and its first step (the title) */
  const open = new Map<string, { stream: string; title: string }>()
  const streamOf = (jobId: string, job?: JobInfo): string | null => {
    const known = open.get(jobId)
    if (known) return known.stream
    const info = job ?? jobs.jobStatus(jobId)[0]
    const repo = streamRepo(info?.repository)
    if (!info || !repo) return null
    const stream = jobStream(repo, jobId)
    // its first line names it: the request, as the job index titles it (src/agents/runtime/job-index.ts titleOf)
    const payload = jobs.payloadOf(jobId)
    const title = (payload ? titleOf(payload) : info.key).replace(/\s+/g, ' ').trim().slice(0, 160) || info.kind
    open.set(jobId, { stream, title })
    writer.write(stream, stepLine(title), Date.parse(info.startedAt) || now())
    return stream
  }
  const onEvent = (e: JobEvent): void => {
    try {
      if (e.type === 'started') { streamOf(e.jobId, e.job); return }
      if (e.type === 'log') {
        const stream = streamOf(e.jobId)
        if (!stream) return
        const l = parseJobLine(e.line, now())
        writer.write(stream, l.text, l.at)
        return
      }
      if (e.type === 'ended') {
        const stream = streamOf(e.jobId, e.job)
        const title = open.get(e.jobId)?.title
        open.delete(e.jobId)
        if (!stream) return
        writer.write(stream, endLine(e.job), Date.parse(e.job.endedAt ?? '') || now())
        void writer.flush(stream)
        const repo = streamRepo(e.job.repository)
        if (o.learn && repo) {
          // its gaps as its stream has them: the title is its first step, as the API reads the stream (currentStep)
          const lines = [
            ...(title ? [{ at: e.job.startedAt, text: stepLine(title) }] : []),
            ...e.job.log.map((l) => { const p = parseJobLine(l); return { at: new Date(p.at).toISOString(), text: p.text } }),
          ]
          void Promise.resolve().then(() => o.learn?.(repo, `job:${e.jobId}`, 'job', e.job.agent ?? e.job.kind, stepGaps(lines))).catch(() => undefined)
        }
      }
    } catch { /* a log is never worth a failure */ }
  }
  return jobs.events.on(onEvent)
}

/** One tool call's stream, while it runs: its progress sink, and how it ends. */
export interface ToolRunLog {
  readonly stream: string
  readonly sink: ProgressSink
  done(): void
  failed(e: unknown): void
}

/** "12 s", or "0.4 s" under ten seconds. */
export const seconds = (ms: number): string => {
  const s = Math.max(0, ms) / 1000
  return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`
}

/** An error in one short line, for `✗ <why>`. */
export const shortError = (e: unknown): string => ((e instanceof Error ? e.message : String(e)).split('\n').find((l) => l.trim()) ?? 'failed').trim().slice(0, 300) || 'failed'

/**
 * Open a tool call's stream: `▸ <tool>` now; then whatever the tool reports through the sink; then done() or
 * failed(e) writes the last line, flushes, and learns the call's gaps (as `tool:<runId>`, what = the tool's name).
 */
export function toolRun(writer: RunLogWriter, o: { repository: string; runId: string; name: string; learn?: LearnQuiet | undefined; now?: () => number }): ToolRunLog | null {
  const repo = streamRepo(o.repository)
  if (!repo) return null
  const now = o.now ?? Date.now
  const stream = toolStream(repo, o.runId)
  const t0 = now()
  const lines: { at: string; text: string }[] = []
  let ended = false
  const write = (text: string): void => {
    const at = now()
    if (lines.length < 5_000) lines.push({ at: new Date(at).toISOString(), text })
    writer.write(stream, text, at)
  }
  const end = (text: string): void => {
    if (ended) return
    ended = true
    write(text)
    void writer.flush(stream)
    if (o.learn) void Promise.resolve().then(() => o.learn?.(repo, `tool:${o.runId}`, 'tool', o.name, stepGaps(lines))).catch(() => undefined)
  }
  write(stepLine(o.name))
  return {
    stream,
    sink: { line: (text) => { if (!ended) write(text) } },
    done: () => end(`✓ done in ${seconds(now() - t0)}`),
    failed: (e) => end(`✗ ${shortError(e)}`),
  }
}
