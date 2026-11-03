/**
 * A check's own log, while it runs on a CodeBuild runner (docs/progress-and-logs.md, "Why checks write their own
 * stream"): a CodeBuild-hosted runner's build log holds the runner's messages, not the job's steps, and GitHub serves a
 * job's log only once it has finished. So trace's own steps (`tracectl check`, src/cli.ts; the harness's `run` action,
 * src/harness/index.ts) copy their output into the check's stream as well as printing it:
 *
 *   gha/<owner>/<repo>/<GITHUB_RUN_ID>/<GITHUB_RUN_ATTEMPT>/<GITHUB_JOB>   (src/core/run-logs.ts checkStream)
 *
 *   when      checkStreamFromEnv: only on a CodeBuild runner (CODEBUILD_BUILD_ID) whose project names the runs group
 *             (TRACE_RUNS_LOG_GROUP, a project environment variable: src/infra/runner.ts), inside a GitHub Actions job
 *             (GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_JOB). On GitHub's own runners nothing is
 *             written: the log is GitHub's once the job ends
 *   who       the build's own credentials (the runner project's service role, which may write gha/<its repo>/* of the
 *             group), read from the container's credentials endpoint, even when a step put other credentials in the
 *             environment (configure-aws-credentials)
 *   how       teeCheckOutput: every line written to stdout and stderr also goes to the stream, batched
 *             (src/core/cw-writer.ts), and close() sends the rest before the process exits. A stream that cannot be
 *             written never fails the step: it says so once on stderr and carries on
 *
 * The repository in the stream's name is lower case, as the API names it when it reads (src/core/access.ts RepoSlug).
 */
import { type LogsApi, type RunLogWriter, awsLogsApi, runLogWriter } from './cw-writer.js'
import { lineSplitter } from './progress.js'
import { RUNS_LOG_GROUP_ENV, checkStream } from './run-logs.js'

const NEEDED = [RUNS_LOG_GROUP_ENV, 'CODEBUILD_BUILD_ID', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB'] as const

/** The check's stream on a CodeBuild runner that names the runs group, else null (see the module comment). */
export function checkStreamFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = Object.fromEntries(NEEDED.map((k) => [k, env[k]?.trim() ?? ''])) as Record<(typeof NEEDED)[number], string>
  if (NEEDED.some((k) => !v[k])) return null
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(v.GITHUB_REPOSITORY) || !/^\d+$/.test(v.GITHUB_RUN_ID) || !/^\d+$/.test(v.GITHUB_RUN_ATTEMPT)) return null
  // a job key is [A-Za-z0-9_-]; anything else would make a stream the API cannot parse
  const job = v.GITHUB_JOB.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128)
  return checkStream(v.GITHUB_REPOSITORY.toLowerCase(), v.GITHUB_RUN_ID, v.GITHUB_RUN_ATTEMPT, job)
}

/** A writer for the check's stream: write(line), close() before the process exits. */
export interface CheckLog {
  readonly stream: string
  write(line: string): void
  close(timeoutMs?: number): Promise<void>
}

/** The check's log from its environment, or null where checks write none. `api`: tests give a fake. */
export function checkLogFromEnv(env: NodeJS.ProcessEnv = process.env, o: { api?: LogsApi; warn?: (l: string) => void; now?: () => number } = {}): CheckLog | null {
  const stream = checkStreamFromEnv(env)
  const group = env[RUNS_LOG_GROUP_ENV]?.trim()
  if (!stream || !group) return null
  const writer: RunLogWriter = runLogWriter({
    group, api: o.api ?? (() => awsLogsApi({ container: true, env })),
    warn: o.warn ?? ((l) => { originalStderr(`${l}\n`) }),
    ...(o.now ? { now: o.now } : {}),
  })
  return {
    stream,
    write: (line) => { const t = line.replace(/\s+$/, ''); if (t) writer.write(stream, t) },
    close: (timeoutMs) => writer.close(timeoutMs),
  }
}

type Write = (chunk: string | Uint8Array, ...rest: unknown[]) => boolean
let restore: (() => void) | null = null
/** stderr as it was before any tee: the writer's own warning must not go back into the stream. */
let originalStderr: (s: string) => void = (s) => { process.stderr.write(s) }

/**
 * Copy everything this process writes to stdout and stderr, line by line, into the check's stream, while still
 * printing it. Returns close(): stop copying and send the rest (await it before exiting). Null where checks write
 * no stream (checkStreamFromEnv), when nothing is copied.
 */
export function teeCheckOutput(env: NodeJS.ProcessEnv = process.env, o: { api?: LogsApi; now?: () => number } = {}): { stream: string; close(timeoutMs?: number): Promise<void> } | null {
  if (restore) return null
  const stdoutWrite = process.stdout.write.bind(process.stdout) as Write
  const stderrWrite = process.stderr.write.bind(process.stderr) as Write
  originalStderr = (s) => { stderrWrite(s) }
  const log = checkLogFromEnv(env, o)
  if (!log) return null
  const out = lineSplitter((l) => log.write(l))
  const err = lineSplitter((l) => log.write(l))
  const tee = (orig: Write, split: ReturnType<typeof lineSplitter>): Write => (chunk, ...rest) => {
    try { split.push(typeof chunk === 'string' ? chunk : new Uint8Array(chunk)) } catch { /* never the step's failure */ }
    return orig(chunk, ...rest)
  }
  process.stdout.write = tee(stdoutWrite, out) as typeof process.stdout.write
  process.stderr.write = tee(stderrWrite, err) as typeof process.stderr.write
  restore = () => {
    process.stdout.write = stdoutWrite as typeof process.stdout.write
    process.stderr.write = stderrWrite as typeof process.stderr.write
    restore = null
  }
  return {
    stream: log.stream,
    async close(timeoutMs = 10_000) {
      out.end()
      err.end()
      restore?.()
      await log.close(timeoutMs)
    },
  }
}
