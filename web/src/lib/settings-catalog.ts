/**
 * Every setting on Preferences (docs/ui-design.md, "Preferences"), as data: its group, name, one-line explanation,
 * where it is kept and its default. Search on the screen and ⌘K both read this list. Settings that only make sense
 * on one device (the microphone, Bench mode) are kept per device and say so.
 */

export type GroupId = 'profile' | 'security' | 'notifications' | 'voice' | 'chat' | 'display' | 'formats' | 'work' | 'data'

export const GROUPS: { id: GroupId; label: string; line: string }[] = [
  { id: 'profile', label: 'Profile', line: 'Your name, time zone and the app\'s language.' },
  { id: 'security', label: 'Sign-in and security', line: 'Passkeys, password and authenticator app, and where you are signed in.' },
  { id: 'notifications', label: 'Notifications', line: 'The four kinds trace tells you about, and how.' },
  { id: 'voice', label: 'Voice', line: 'Reading replies aloud and dictating.' },
  { id: 'chat', label: 'Chat', line: 'How Ask trace behaves.' },
  { id: 'display', label: 'Display', line: 'Theme, density, text size, motion and status colours.' },
  { id: 'formats', label: 'Formats', line: 'Dates, units, currency and numbers.' },
  { id: 'work', label: 'Work', line: 'Home, the start screen, shortcuts and Bench mode.' },
  { id: 'data', label: 'Your data', line: 'Chat history and a copy of your data.' },
]

export interface Setting {
  /** a stable id; also the anchor on the screen */
  id: string
  group: GroupId
  label: string
  line: string
  /** where it is kept: a path under prefs (me.set prefs.<key>), or "device:<name>" for this device only */
  key?: string
  device?: boolean
  /** extra words search matches */
  keywords?: string[]
}

export const SETTINGS: Setting[] = [
  { id: 'profile.name', group: 'profile', label: 'Name and photo', line: 'How you appear to others on your projects.', key: 'profile.name', keywords: ['photo', 'avatar'] },
  { id: 'profile.timeZone', group: 'profile', label: 'Time zone', line: 'Times on screen and in emails use it.', key: 'profile.timeZone' },
  { id: 'profile.language', group: 'profile', label: 'Language of the app', line: 'English first; others as they are translated.', key: 'profile.language' },

  { id: 'security.passkeys', group: 'security', label: 'Passkeys', line: 'Sign in with your device: nothing to remember and it cannot be phished.', keywords: ['webauthn', 'touch id', 'face id', 'security key'] },
  { id: 'security.password', group: 'security', label: 'Password and authenticator app', line: 'A password with a six-digit code from an app on your phone.', keywords: ['totp', 'two-factor', '2fa', 'mfa', 'code'] },
  { id: 'security.sessions', group: 'security', label: 'Where you are signed in', line: 'Each browser and tracectl login session, with Sign out.', keywords: ['sessions', 'devices', 'sign out'] },

  { id: 'notifications.kinds', group: 'notifications', label: 'Each kind, and how', line: 'Gate ready, question, spend and agent stuck: in the app, by email, by push.', key: 'notifications.kinds', keywords: ['email', 'push', 'gate', 'question', 'spend', 'stuck'] },
  { id: 'notifications.emailAfter', group: 'notifications', label: 'Email when unanswered for', line: 'An email follows only if you have not acted in the app by then.', key: 'notifications.emailAfter' },
  { id: 'notifications.quiet', group: 'notifications', label: 'Quiet hours', line: 'No email or push in this window; everything waits in the Inbox.', key: 'notifications.quiet', keywords: ['do not disturb', 'night'] },
  { id: 'notifications.projects', group: 'notifications', label: 'Per project', line: 'Normal, or only gates and spend.', key: 'notifications.projects' },

  { id: 'voice.voice', group: 'voice', label: 'Voice', line: 'Who reads trace\'s replies aloud.', key: 'voice.voice', keywords: ['polly', 'speech'] },
  { id: 'voice.rate', group: 'voice', label: 'Speaking speed', line: 'How fast replies are read.', key: 'voice.rate', keywords: ['speed'] },
  { id: 'voice.readAloud', group: 'voice', label: 'Read replies aloud', line: 'Speak trace\'s replies as they arrive.', key: 'voice.readAloud' },
  { id: 'voice.language', group: 'voice', label: 'Dictation language', line: 'The language you speak when dictating.', key: 'voice.language', keywords: ['transcribe'] },
  { id: 'voice.mic', group: 'voice', label: 'Microphone', line: 'How dictation starts, and which microphone it uses.', key: 'voice.mic', keywords: ['hold to talk', 'tap'] },
  { id: 'voice.sendOnStop', group: 'voice', label: 'Send when I stop talking', line: 'Send the message after a short pause instead of waiting for you to press send.', key: 'voice.sendOnStop' },
  { id: 'voice.commands', group: 'voice', label: 'Spoken commands (send, cancel, stop, read again)', line: 'Say a command word at the end of dictation to act on it.', key: 'voice.commands' },

  { id: 'chat.dock', group: 'chat', label: 'Open Ask trace on wide screens', line: 'Docked beside every screen, or only when you ask.', key: 'chat.dock' },
  { id: 'chat.enter', group: 'chat', label: 'Enter key', line: 'What pressing Enter does in a message box.', key: 'chat.enter' },
  { id: 'chat.recall', group: 'chat', label: 'Up and down recall sent messages', line: 'In an empty box, the arrow keys bring back what you sent earlier.', key: 'chat.recall' },
  { id: 'chat.toolRows', group: 'chat', label: 'Tool rows', line: 'The one-line rows for what trace looked up: folded or open.', key: 'chat.toolRows' },
  { id: 'chat.reasoning', group: 'chat', label: 'Show reasoning', line: 'trace\'s working, before its answer.', key: 'chat.reasoning' },
  { id: 'chat.terms', group: 'chat', label: 'Explain technical terms', line: 'When trace adds a short plain-words explanation after a term.', key: 'chat.terms', keywords: ['glossary'] },
  { id: 'chat.recommendations', group: 'chat', label: 'Recommendations', line: 'Short (the option and why), or full with the trade-off and alternatives open.', key: 'chat.recommendations' },
  { id: 'chat.tables', group: 'chat', label: 'Tables', line: 'Bring every table back to its default columns, sort and filters.', keywords: ['reset', 'views', 'columns'] },

  { id: 'display.theme', group: 'display', label: 'Theme', line: 'System follows your device.', key: 'display.theme', keywords: ['dark', 'light', 'mode'] },
  { id: 'display.density', group: 'display', label: 'Density', line: 'Comfortable, or compact to fit more on screen.', key: 'display.density' },
  { id: 'display.textSize', group: 'display', label: 'Text size', line: 'Every screen, from 90% to 125%.', key: 'display.textSize', keywords: ['font', 'zoom'] },
  { id: 'display.motion', group: 'display', label: 'Motion', line: 'Fades and slides; reduced turns them off.', key: 'display.motion', keywords: ['animation'] },
  { id: 'display.contrast', group: 'display', label: 'Status colours', line: 'High-contrast makes Verified, Warning and Failing easier to tell apart.', key: 'display.contrast', keywords: ['contrast', 'colour', 'color'] },

  { id: 'formats.dates', group: 'formats', label: 'Dates and times', line: '12 or 24 hour, and the first day of the week.', key: 'formats.hour12', keywords: ['clock', 'week'] },
  { id: 'formats.units', group: 'formats', label: 'Board dimensions', line: 'Millimetres, mils or inches.', key: 'formats.units', keywords: ['mm', 'mil', 'inch'] },
  { id: 'formats.currency', group: 'formats', label: 'Currency for costs', line: 'Converted at the day\'s rate, with the original shown on hover.', key: 'formats.currency', keywords: ['money', 'dollars'] },
  { id: 'formats.numbers', group: 'formats', label: 'Number style', line: 'Engineering prefixes (4.7 kΩ), or plain.', key: 'formats.numbers' },

  { id: 'work.home', group: 'work', label: 'Home page', line: 'Pin and order projects; hide finished ones.', key: 'work.pinned', keywords: ['pinned', 'order'] },
  { id: 'work.start', group: 'work', label: 'Start screen', line: 'Where trace opens: Home, or the last project.', key: 'work.start' },
  { id: 'work.tour', group: 'work', label: 'Show the tour again', line: 'The four-stop tour of the next step, the stage rail, Ask trace and the bell.', keywords: ['help', 'onboarding'] },
  { id: 'work.shortcuts', group: 'work', label: 'Keyboard shortcuts', line: 'Every shortcut, as listed under ?.', keywords: ['keys', 'hotkeys'] },
  { id: 'work.bench', group: 'work', label: 'Bench mode on this device', line: 'Bring-up screens in large print with a big Stop.', device: true, keywords: ['large print'] },

  { id: 'data.retention', group: 'data', label: 'Chat history', line: 'Keep your threads, or delete them after a while.', key: 'data.chatRetention', keywords: ['delete', 'retention'] },
  { id: 'data.download', group: 'data', label: 'Download my data', line: 'A file of your preferences, messages and decisions.', keywords: ['export', 'json'] },
]

/** Settings whose name, explanation, group or keywords contain every word of the search. */
export function searchSettings(text: string, list: Setting[] = SETTINGS): Setting[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return list
  return list.filter((s) => {
    const hay = [s.label, s.line, GROUPS.find((g) => g.id === s.group)?.label ?? '', ...(s.keywords ?? [])].join(' ').toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

// ------------------------------------------------------------------ notifications

export type NotifyKind = 'gate' | 'question' | 'spend' | 'stuck'
export type Channel = 'app' | 'email' | 'push'
export const NOTIFY_KINDS: { id: NotifyKind; label: string }[] = [
  { id: 'gate', label: 'A gate is ready' },
  { id: 'question', label: 'A question blocks work' },
  { id: 'spend', label: 'Money is about to be spent' },
  { id: 'stuck', label: 'An agent is stuck' },
]
export const CHANNELS: { id: Channel; label: string }[] = [
  { id: 'app', label: 'In app' },
  { id: 'email', label: 'Email' },
  { id: 'push', label: 'Push' },
]

export interface NotifyPrefs {
  kinds: Record<NotifyKind, Record<Channel, boolean>>
  emailAfter: 'never' | '15m' | '1h' | '4h' | 'morning'
  quiet: { on: boolean; from: string; to: string; days: number[] }
  projects: Record<string, 'normal' | 'gates-spend'>
}

export const DEFAULT_NOTIFY: NotifyPrefs = {
  kinds: {
    gate: { app: true, email: true, push: false },
    question: { app: true, email: true, push: false },
    spend: { app: true, email: true, push: false },
    stuck: { app: true, email: true, push: false },
  },
  emailAfter: '1h',
  quiet: { on: false, from: '19:00', to: '07:00', days: [0, 1, 2, 3, 4, 5, 6] },
  projects: {},
}

/** Spend notifications cannot be turned off for admins: the reason, or null when the switch is free. */
export function notifyLock(kind: NotifyKind, channel: Channel, admin: boolean): string | null {
  if (kind === 'spend' && channel === 'app' && admin) return 'Admins approve spend, so spend notifications stay on in the app.'
  return null
}

/** The person's notification preferences merged over the defaults. */
export function notifyPrefs(stored: unknown): NotifyPrefs {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<NotifyPrefs>
  const kinds = { ...DEFAULT_NOTIFY.kinds }
  for (const k of NOTIFY_KINDS) kinds[k.id] = { ...DEFAULT_NOTIFY.kinds[k.id], ...(s.kinds?.[k.id] ?? {}) }
  return { ...DEFAULT_NOTIFY, ...s, kinds, quiet: { ...DEFAULT_NOTIFY.quiet, ...(s.quiet ?? {}) }, projects: { ...(s.projects ?? {}) } }
}
