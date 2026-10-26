/** The project's rules file, .trace/rules.md: the authority every specialist (and the worker) works under. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const RULES_FILE = join('.trace', 'rules.md')

/** The most of CLAUDE.md passed to an agent (it goes into the system prompt). */
export const NOTES_MAX = 20_000

/**
 * The default branch's CLAUDE.md, read by trace itself. Claude Code is never told to load the checkout's project
 * settings (settingSources is empty): a branch's .claude/settings.json could otherwise add hooks that run commands
 * (even for a read-only specialist), MCP servers or permissions, and a PR's author controls that file.
 */
export function readProjectNotes(dir: string): string | null {
  const p = join(dir, 'CLAUDE.md')
  try {
    return existsSync(p) ? readFileSync(p, 'utf8').slice(0, NOTES_MAX) : null
  } catch {
    return null
  }
}

/** .trace/rules.md of a checkout (the default branch's, on the runtime), or null when there is none. */
export function readRules(dir: string): string | null {
  const p = join(dir, RULES_FILE)
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  } catch {
    return null
  }
}
