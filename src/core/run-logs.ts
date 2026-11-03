/**
 * Run logs: what a check, a specialist's job or a tool says while it runs, kept in one CloudWatch Logs group per
 * installation (`/trace/<prefix>/runs`, src/infra/stack.ts) and read by the app (run.log, src/api/actions-progress.ts).
 * docs/progress-and-logs.md has the whole design; this module is the contract every writer and reader shares.
 *
 *   streams   job/<owner>/<repo>/<jobId>                  a specialist's job (the worker runtime, src/agents/runtime/log-stream.ts)
 *             tool/<owner>/<repo>/<runId>                 one tool call (the worker runtime's tool runner)
 *             gha/<owner>/<repo>/<runId>/<attempt>/<job>  a check: one GitHub Actions job on a CodeBuild runner, written
 *                                                         by trace's own steps (tracectl, the harness actions); <job> is
 *                                                         GITHUB_JOB, the job's key in its workflow
 *   runs      how the API and the app name one: job:<jobId>, tool:<runId>, check:<GitHub job id>
 *   lines     plain text. A line starting "▸ " opens a step (its name follows); "✓ " says something passed, "⚠ " a
 *             warning, "✗ " a failure. Anything else is ordinary output; markOf also reads the usual tool and GitHub
 *             wordings (error:, warning:, ##[error], FAILED)
 *   secrets   every line leaves the API through maskSecrets: a reader never sees a token, key or password, whoever
 *             wrote it
 *   quiet     how long a step usually goes without a line (stepGaps over finished runs, src/core/quiet.ts): past that,
 *             the app says "later than usual"; until a step has history, DEFAULT_QUIET_S
 *
 * Pure: no AWS here, so the runtime, the CLI, the API and the events function all import it.
 */

/** The log group every run writes to. */
export const runsLogGroup = (prefix: string): string => `/trace/${prefix}/runs`
/** The environment variable that names it, wherever a writer runs (worker runtime, CodeBuild runner, API). */
export const RUNS_LOG_GROUP_ENV = 'TRACE_RUNS_LOG_GROUP'

export type RunKind = 'job' | 'tool' | 'check'
/** How the app and the API name a run: job:<jobId>, tool:<runId>, check:<GitHub job id>. */
export type RunRef = `${RunKind}:${string}`

const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const ID = /^[A-Za-z0-9._-]{1,128}$/

export const jobStream = (repo: string, jobId: string): string => `job/${repo}/${jobId}`
export const toolStream = (repo: string, runId: string): string => `tool/${repo}/${runId}`
export const checkStream = (repo: string, runId: number | string, attempt: number | string, job: string): string => `gha/${repo}/${runId}/${attempt}/${job}`
/** Every check stream of one workflow run attempt starts with this. */
export const checkStreamPrefix = (repo: string, runId: number | string, attempt: number | string): string => `gha/${repo}/${runId}/${attempt}/`
export const toolStreamPrefix = (repo: string): string => `tool/${repo}/`

export type ParsedStream =
  | { kind: 'job'; repo: string; id: string }
  | { kind: 'tool'; repo: string; id: string }
  | { kind: 'check'; repo: string; runId: string; attempt: string; job: string }

/** What a stream belongs to, or null for one trace did not name (CodeBuild's own build streams). */
export function parseStream(name: string): ParsedStream | null {
  const p = name.split('/')
  if ((p[0] === 'job' || p[0] === 'tool') && p.length === 4) {
    const repo = `${p[1]}/${p[2]}`
    if (!REPO.test(repo) || !ID.test(p[3]!)) return null
    return { kind: p[0], repo, id: p[3]! }
  }
  if (p[0] === 'gha' && p.length === 6) {
    const repo = `${p[1]}/${p[2]}`
    if (!REPO.test(repo) || !/^\d+$/.test(p[3]!) || !/^\d+$/.test(p[4]!) || !p[5]) return null
    return { kind: 'check', repo, runId: p[3]!, attempt: p[4]!, job: p[5]! }
  }
  return null
}

export function parseRunRef(ref: string): { kind: RunKind; id: string } | null {
  const m = /^(job|tool|check):([A-Za-z0-9._-]{1,300})$/.exec(ref)
  if (!m) return null
  if (m[1] === 'check' && !/^\d+$/.test(m[2]!)) return null
  return { kind: m[1] as RunKind, id: m[2]! }
}

/** A tool run's id: time-ordered (base36 milliseconds) then random, so a stream listing sorted by name is newest last. */
export function newToolRunId(now: number = Date.now(), rand: () => string = () => Math.random().toString(16).slice(2, 10).padEnd(8, '0')): string {
  return `t${now.toString(36)}${rand()}`
}
export const TOOL_RUN_ID = /^t[0-9a-z]{8,12}[0-9a-f]{8}$/

// ------------------------------------------------------------------ lines

export type Mark = 'step' | 'ok' | 'warn' | 'error' | null
export interface LogLine { at: string; text: string; mark: Mark }

/** Step lines as writers write them. */
export const stepLine = (name: string): string => `▸ ${name}`

/** What kind of line it is, for the viewer's colours and "jump to the first problem". */
export function markOf(text: string): Mark {
  const t = text.trimStart()
  if (t.startsWith('▸ ') || /^##\[group\]/.test(t)) return 'step'
  if (t.startsWith('✗') || /^##\[error\]/.test(t) || /^(error|fatal)(\[|:|\s)/i.test(t) || /\b(FAILED|FAILURE)\b/.test(t) || /^Error:/.test(t)) return 'error'
  if (t.startsWith('⚠') || /^##\[warning\]/.test(t) || /^warning(\[|:|\s)/i.test(t)) return 'warn'
  if (t.startsWith('✓')) return 'ok'
  return null
}

/** A step line's name ("▸ Load the board" → "Load the board"; GitHub's "##[group]Run tracectl check" → "Run tracectl check"). */
export function stepName(text: string): string | null {
  const t = text.trimStart()
  if (t.startsWith('▸ ')) return t.slice(2).trim() || null
  const g = /^##\[group\](.*)$/.exec(t)
  return g ? g[1]!.trim() || null : null
}

// ------------------------------------------------------------------ secrets

const MASK = '••••••'
const SECRET_PATTERNS: readonly RegExp[] = [
  // GitHub tokens
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  // AWS access key ids
  /\b(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/g,
  // JSON web tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Slack and Anthropic style keys
  /\b(?:xox[abposr]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,})\b/g,
]
/** key=value / key: value / "key": "value" where the key names a secret: the value goes. */
const NAMED = /((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9_]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|auth)[A-Za-z0-9_]*)["']?\s*[:=]\s*["']?)(?:Bearer\s+|Basic\s+)?([^\s"',;&]{6,})/gi
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g
const URL_CREDS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi

/** One line with every token, key and password it shows replaced by ••••••. */
export function maskSecrets(text: string): string {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return `${MASK} (a private key)`
  let t = text
  for (const re of SECRET_PATTERNS) t = t.replace(re, MASK)
  t = t.replace(URL_CREDS, `$1${MASK}@`)
  t = t.replace(BEARER, `$1 ${MASK}`)
  t = t.replace(NAMED, (_m, k: string, v: string) => (v === MASK ? `${k}${v}` : `${k}${MASK}`))
  return t
}

/** A line as the app is given it: masked, at most MAX_LINE characters, marked. */
export const MAX_LINE = 2000
export function toLogLine(at: number | string, raw: string): LogLine {
  const text = maskSecrets(raw.replace(/\r$/, '')).slice(0, MAX_LINE)
  return { at: typeof at === 'number' ? new Date(at).toISOString() : at, text, mark: markOf(text) }
}

// ------------------------------------------------------------------ GitHub's own log

/** GitHub's job log ("2026-11-03T10:44:02.1234567Z text" per line) as lines; the ANSI colours go. */
export function githubLogLines(raw: string): LogLine[] {
  const out: LogLine[] = []
  let last = ''
  for (const l of raw.split('\n')) {
    if (!l) continue
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?(.*)$/.exec(l)
    // eslint-disable-next-line no-control-regex
    const body = (m ? m[2]! : l).replace(/\x1b\[[0-9;]*m/g, '').replace(/^\uFEFF/, '')
    if (/^##\[endgroup\]/.test(body)) continue
    const at = m ? new Date(m[1]!.replace(/(\.\d{3})\d+Z$/, '$1Z')).toISOString() : last
    last = at || last
    out.push(toLogLine(at || new Date(0).toISOString(), body))
  }
  return out
}

// ------------------------------------------------------------------ quiet

/** How long a step may go without a line before the app says "later than usual", until it has history. */
export const DEFAULT_QUIET_S = 120
/** Shorter than this, quiet is never worth saying. */
export const MIN_QUIET_S = 20

/** Each step's longest silence (seconds) in one finished run: the step a line falls in is the last step line before it. */
export function stepGaps(lines: readonly { at: string; text: string }[], firstStep = 'Starting'): Record<string, number> {
  const out: Record<string, number> = {}
  let step = firstStep
  let prev: number | null = null
  for (const l of lines) {
    const at = Date.parse(l.at)
    if (!Number.isFinite(at)) continue
    const name = stepName(l.text)
    if (prev !== null) {
      const gap = Math.max(0, (at - prev) / 1000)
      out[step] = Math.max(out[step] ?? 0, Math.round(gap))
    }
    if (name) step = name
    prev = at
  }
  return out
}

/** The step a run is in now: the last step line's name (null before the first). */
export function currentStep(lines: readonly { text: string }[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const n = stepName(lines[i]!.text)
    if (n) return n
  }
  return null
}
