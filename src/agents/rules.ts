/** The project's rules file, .trace/rules.md: the authority every specialist (and the worker) works under. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const RULES_FILE = join('.trace', 'rules.md')

/** .trace/rules.md of a checkout (the default branch's, on the runtime), or null when there is none. */
export function readRules(dir: string): string | null {
  const p = join(dir, RULES_FILE)
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  } catch {
    return null
  }
}
