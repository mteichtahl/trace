/**
 * Where a guided skill returns to once submitted (#210): the project page it was opened from, else the project's
 * overview; never the browser's history, which may hold a page outside the project opened before it. Every page of
 * the signed-in shell (routes/_app.tsx) is remembered as it is shown; Focus mode's pages are not (the shell sees the
 * skill's own location once as it hands over), so while a skill is open the last one remembered is the page it was
 * opened from.
 */
import { projectId } from '@/lib/api'

let last: string | null = null

/** Focus mode's own pages: the shell's location can name one for a moment as it hands over to it. */
const FOCUS = /^\/(p\/[^/]+\/(do|gates)(\/|$)|projects\/new(\/|$))/

/** The page now shown (its href: path and search); Focus mode's pages are not remembered. */
export function rememberPage(href: string): void {
  if (!FOCUS.test(href)) last = href
}

/** The href to return to on `repo`: the last page shown, when it is one of the project's own, else its overview. */
export function returnTo(repo: string): string {
  const home = `/p/${projectId(repo)}`
  if (!last) return home
  let path: string
  try {
    path = decodeURIComponent(new URL(last, 'http://x').pathname)
  } catch {
    return home
  }
  return path === home || path.startsWith(`${home}/`) ? last : home
}
