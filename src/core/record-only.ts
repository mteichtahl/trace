/**
 * A pull request that changes only trace's records (.trace/, the project database a specialist's job writes) has
 * nothing to build: no schematic, board, firmware or case of its own. Its build checked the whole design anyway, so a
 * record change stacked on a change whose case fit failed showed "1 check failing: build" for a failure that was not
 * its own (test-esp32 #141: the docs and EMC records, built on the case change). `tracectl check` asks this first
 * and, for such a pull request, says so and passes; the change it builds on carries its own failure, and the build
 * on the default branch still checks everything once it merges.
 *
 * In a GitHub Actions run of a pull_request event the checkout is the pull request merged into its base: the files it
 * changes are those that differ from the base commit, which is fetched (one commit, no history) to compare.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Where trace keeps its records in a repository. */
export const RECORDS_DIR = '.trace/'

/** Whether every changed path is one of trace's records (and there is at least one). Pure. */
export function onlyRecords(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every((p) => p.startsWith(RECORDS_DIR))
}

/** The base commit of the pull request this run is for, from the event (null outside a pull request's run). */
export function pullBase(env: NodeJS.ProcessEnv, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): string | null {
  if (!env.GITHUB_ACTIONS || !/^pull_request(?:_target)?$/.test(env.GITHUB_EVENT_NAME ?? '') || !env.GITHUB_EVENT_PATH) return null
  try {
    const sha = (JSON.parse(read(env.GITHUB_EVENT_PATH)) as { pull_request?: { base?: { sha?: unknown } } }).pull_request?.base?.sha
    return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : null
  } catch {
    return null
  }
}

/** Runs git in `root` and gives its output (throws when it fails). */
export type Git = (args: readonly string[], root: string) => string

const git: Git = (args, root) => execFileSync('git', [...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 })

/**
 * Why this run has nothing to check, when it is a pull request that changes only trace's records; else null (not a
 * pull request, other files changed, or the base could not be read: then everything is checked).
 */
export function recordOnlyReason(root: string, env: NodeJS.ProcessEnv = process.env, o: { git?: Git; read?: (path: string) => string } = {}): string | null {
  const base = pullBase(env, o.read)
  if (!base) return null
  const run = o.git ?? git
  try {
    try { run(['cat-file', '-e', `${base}^{commit}`], root) } catch { run(['fetch', '--no-tags', '--depth=1', 'origin', base], root) }
    const paths = run(['diff', '--name-only', base, 'HEAD'], root).split('\n').map((l) => l.trim()).filter(Boolean)
    if (!onlyRecords(paths)) return null
    return `this change touches only trace's records (${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', …' : ''}): it has no design files to check. The change it builds on is checked on its own, and the default branch is checked in full once it merges.`
  } catch {
    return null
  }
}
