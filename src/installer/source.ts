/**
 * Which GitHub repository the running trace came from, so the installer can build that repository on AWS too
 * (`ciRepositories`, src/infra/props.ts). In this order, the first that names a GitHub repository:
 *
 *   TRACE_SOURCE   the environment variable onboarding already honours for the repository its workflows' actions come
 *                  from (src/core/onboard.ts SOURCE), when it is set
 *   the checkout   trace run from a git clone (development, a fork): its `origin` remote
 *   package.json   its `repository` field (`github:mteichtahl/trace`). `npm install -g github:mteichtahl/trace#v1`
 *                  installs a packed copy with no .git, and npm writes no install metadata into package.json, so this
 *                  field is what an installed copy knows of where it came from
 *
 * Null when none does (a copy with no repository field, not on GitHub).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** OWNER/REPO from the ways a GitHub repository is written: `github:o/r`, `o/r`, `https://github.com/o/r(.git)`,
 * `git+https://…`, `git@github.com:o/r.git`, `ssh://git@github.com/o/r`; null for anything else. */
export function githubRepository(text: string): string | null {
  const t = text.trim().replace(/#.*$/, '')
  const m = /^(?:github:|(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:)?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.][A-Za-z0-9._-]{0,99}?)(?:\.git)?\/?$/.exec(t)
  if (!m || t.includes('..')) return null
  // a bare `o/r` is GitHub's shorthand only without a scheme or host of another kind
  if (/^[a-z+]+:/i.test(t) && !/^(github:|(git\+)?(https?|ssh|git):\/\/([^@/]+@)?github\.com\/)/i.test(t)) return null
  return `${m[1]}/${m[2]}`
}

export interface SourceDeps {
  env?: NodeJS.ProcessEnv
  /** trace's root (where package.json is) */
  root: string
  /** the checkout's `origin` URL, or null (default: `git config --get remote.origin.url` when root has a .git) */
  origin?: (root: string) => string | null
  /** package.json's text (default: read from root) */
  packageJson?: (root: string) => string | null
}

const gitOrigin = (root: string): string | null => {
  if (!existsSync(join(root, '.git'))) return null
  const r = spawnSync('git', ['-C', root, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 10_000 })
  return r.status === 0 ? r.stdout.trim() || null : null
}

const readPackage = (root: string): string | null => {
  try { return readFileSync(join(root, 'package.json'), 'utf8') } catch { return null }
}

/** The repository the running trace came from (see the file's header), or null. */
export function traceRepository(d: SourceDeps): string | null {
  const env = d.env ?? process.env
  if (env.TRACE_SOURCE) {
    const r = githubRepository(env.TRACE_SOURCE)
    if (r) return r
  }
  const origin = (d.origin ?? gitOrigin)(d.root)
  if (origin) {
    const r = githubRepository(origin)
    if (r) return r
  }
  const text = (d.packageJson ?? readPackage)(d.root)
  if (!text) return null
  try {
    const repo = (JSON.parse(text) as { repository?: unknown }).repository
    const url = typeof repo === 'string' ? repo : repo && typeof repo === 'object' ? (repo as { url?: unknown }).url : undefined
    return typeof url === 'string' ? githubRepository(url) : null
  } catch {
    return null
  }
}
