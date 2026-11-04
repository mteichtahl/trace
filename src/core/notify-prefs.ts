/**
 * A person's notification preferences, as the server reads them (docs/push.md). The app writes them under
 * `notifications` in the person's preferences document (web/src/lib/settings-catalog.ts, which this follows: the same
 * kinds, channels and defaults), and the push sender reads them here.
 *
 *   kinds      gate, question, spend, stuck, renders (a revision's renders are ready): each with app, email and push switches (push is off until the person turns
 *              it on, which the app does when they allow notifications on a device)
 *   quiet      quiet hours: no push from `from` to `to` (local time on the device, which may run past midnight) on
 *              the days listed (0 Sunday). Nothing is lost: the item stays in Next, and is not pushed afterwards
 *   projects   per project: 'gates-spend' pushes only gates and spend for it
 */
export const NOTIFY_KINDS = ['gate', 'question', 'spend', 'stuck', 'renders'] as const
export type NotifyKind = (typeof NOTIFY_KINDS)[number]
export type Channel = 'app' | 'email' | 'push'

export interface NotifyPrefs {
  kinds: Record<NotifyKind, Record<Channel, boolean>>
  quiet: { on: boolean; from: string; to: string; days: number[] }
  projects: Record<string, 'normal' | 'gates-spend'>
}

export const DEFAULT_NOTIFY: NotifyPrefs = {
  kinds: {
    gate: { app: true, email: true, push: false },
    question: { app: true, email: true, push: false },
    spend: { app: true, email: true, push: false },
    stuck: { app: true, email: true, push: false },
    // news, not a request: in Next and pushed, never emailed by default
    renders: { app: true, email: false, push: false },
  },
  quiet: { on: false, from: '19:00', to: '07:00', days: [0, 1, 2, 3, 4, 5, 6] },
  projects: {},
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** The `notifications` part of a preferences document, merged over the defaults (anything malformed is the default). */
export function notifyPrefs(doc: unknown): NotifyPrefs {
  const n = obj(obj(doc).notifications)
  const kinds = { ...DEFAULT_NOTIFY.kinds }
  for (const k of NOTIFY_KINDS) {
    const given = obj(obj(n.kinds)[k])
    const base = DEFAULT_NOTIFY.kinds[k]
    kinds[k] = {
      app: typeof given.app === 'boolean' ? given.app : base.app,
      email: typeof given.email === 'boolean' ? given.email : base.email,
      push: typeof given.push === 'boolean' ? given.push : base.push,
    }
  }
  const q = obj(n.quiet)
  const days = Array.isArray(q.days) ? q.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6) : DEFAULT_NOTIFY.quiet.days
  const quiet = {
    on: q.on === true,
    from: typeof q.from === 'string' && HHMM.test(q.from) ? q.from : DEFAULT_NOTIFY.quiet.from,
    to: typeof q.to === 'string' && HHMM.test(q.to) ? q.to : DEFAULT_NOTIFY.quiet.to,
    days,
  }
  const projects: NotifyPrefs['projects'] = {}
  for (const [repo, v] of Object.entries(obj(n.projects))) if (v === 'gates-spend' || v === 'normal') projects[repo.toLowerCase()] = v
  return { kinds, quiet, projects }
}

/** The local day (0 Sunday) and minutes past midnight at `at` (ms) in `tz` (UTC when unknown). */
export function localTime(at: number, tz: string | null): { day: number; minutes: number } {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: tz ?? 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0'
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) }
}

const mins = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/**
 * Whether it is quiet hours on a device in `tz` at `at`. A window that runs past midnight (19:00 to 07:00) belongs to
 * the day it starts: Friday's quiet hours cover early Saturday too, whether Saturday is listed or not.
 */
export function isQuiet(p: NotifyPrefs['quiet'], at: number, tz: string | null): boolean {
  if (!p.on) return false
  const { day, minutes } = localTime(at, tz)
  const from = mins(p.from)
  const to = mins(p.to)
  if (from === to) return p.days.includes(day)
  if (from < to) return p.days.includes(day) && minutes >= from && minutes < to
  if (minutes >= from) return p.days.includes(day)
  if (minutes < to) return p.days.includes((day + 6) % 7)
  return false
}

/** Whether this kind, on this project, may be pushed to this person at all (quiet hours apart, which are per device). */
export function wantsPush(p: NotifyPrefs, kind: NotifyKind, repo: string): boolean {
  if (!p.kinds[kind].push) return false
  if (p.projects[repo.toLowerCase()] === 'gates-spend' && kind !== 'gate' && kind !== 'spend') return false
  return true
}
