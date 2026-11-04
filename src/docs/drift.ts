/**
 * When the nightly drift check of the projects' documents runs (docs/scribe.md "Publishing"): the hooks function's
 * schedule (src/infra/web.ts), and what the app shows as the next check (documents.get). Pure, with no imports, so the
 * web backend's bundle takes it without the stores.
 */

/** The hour (UTC) the nightly drift check runs: 03:00 in eastern Australia in winter, 04:00 in summer. */
export const DRIFT_HOUR_UTC = 17

/** The scheduled event the hooks function is sent for the nightly check (src/infra/web.ts, src/web/hooks-lambda.ts). */
export const DRIFT_EVENT = { 'trace-schedule': 'docs-drift' } as const

/** When the nightly drift check next runs after `now`. Pure. */
export function nextDriftCheck(now: Date): Date {
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DRIFT_HOUR_UTC, 0, 0))
  if (t.getTime() <= now.getTime()) t.setUTCDate(t.getUTCDate() + 1)
  return t
}
