/** Numbers, units and times the way trace writes them: 4.7 kΩ, 2.2 µF, "3 hours ago", "about 15 minutes". */

const PREFIXES: [number, string][] = [
  [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f'],
]

/** Engineering prefix form: eng(4700, 'Ω') → "4.7 kΩ"; eng(0.0000022, 'F') → "2.2 µF". */
export function eng(value: number, unit = '', digits = 3): string {
  if (!Number.isFinite(value)) return `${value} ${unit}`.trim()
  if (value === 0) return `0 ${unit}`.trim()
  const abs = Math.abs(value)
  const [scale, prefix] = PREFIXES.find(([s]) => abs >= s * 0.9995) ?? PREFIXES[PREFIXES.length - 1]!
  const n = value / scale
  const s = Number(n.toPrecision(digits)).toString()
  return `${s} ${prefix}${unit}`.trim()
}

/** Plain or engineering, per the person's Number style. */
export const num = (value: number, unit = '', style: 'engineering' | 'plain' = 'engineering'): string =>
  style === 'engineering' ? eng(value, unit) : `${value.toLocaleString()} ${unit}`.trim()

/** Compact counts: 1140 → "1,140"; 1200000 → "1.2M"; 48000 → "48k". */
export function count(n: number): string {
  if (Math.abs(n) >= 1e6) return `${Number((n / 1e6).toPrecision(2))}M`
  if (Math.abs(n) >= 1e4) return `${Math.round(n / 1e3)}k`
  return n.toLocaleString('en-US')
}

export function money(amount: number, currency = 'USD'): string {
  const prefix = currency === 'USD' ? 'US$' : currency === 'AUD' ? 'A$' : `${currency} `
  const digits = Math.abs(amount) < 100 && amount % 1 !== 0 ? 2 : 0
  return `${prefix}${amount.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

/** Board dimensions in the person's unit. */
export function length(mm: number, unit: 'mm' | 'mil' | 'in' = 'mm'): string {
  if (unit === 'mil') return `${Math.round(mm / 0.0254)} mil`
  if (unit === 'in') return `${(mm / 25.4).toFixed(3)} in`
  return `${Number(mm.toPrecision(4))} mm`
}

const UNITS: [number, string][] = [[86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']]

/** A duration in words: 900 → "15 minutes"; 5400 → "1.5 hours"; 45 → "45 seconds". */
export function duration(seconds: number, o: { short?: boolean } = {}): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return o.short ? `${s} s` : `${s} second${s === 1 ? '' : 's'}`
  for (const [size, word] of UNITS) {
    if (s >= size) {
      const v = s / size
      const n = v >= 10 || Number.isInteger(v) ? Math.round(v) : Math.round(v * 2) / 2
      if (o.short) return `${n} ${word === 'minute' ? 'min' : word === 'hour' ? 'h' : word === 'day' ? 'd' : 's'}`
      return `${n} ${word}${n === 1 ? '' : 's'}`
    }
  }
  return `${s} seconds`
}

/** "about 15 minutes" — estimates are always approximate. */
export const about = (seconds: number): string => `about ${duration(seconds)}`

/** Time since a moment: "just now", "2 minutes ago", "3 hours ago", "Yesterday", "12 Oct". */
export function ago(at: string | number | Date, now: number = Date.now()): string {
  const t = new Date(at).getTime()
  const s = Math.round((now - t) / 1000)
  if (s < 0) return `in ${duration(-s)}`
  if (s < 45) return 'just now'
  if (s < 3600 * 20) return `${duration(s)} ago`
  const d = new Date(t)
  const today = new Date(now)
  const yesterday = new Date(now - 86400_000)
  if (d.toDateString() === today.toDateString()) return `Today ${time(d)}`
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) })
}

/** How long something has waited, short: "3 hours", "40 minutes", "2 days". */
export const waited = (since: string | number | Date, now: number = Date.now()): string => duration((now - new Date(since).getTime()) / 1000)

/** Time until a moment, for countdowns: "in 13 minutes", "in 9 seconds", "now". */
export function until(at: string | number | Date, now: number = Date.now()): string {
  const s = Math.round((new Date(at).getTime() - now) / 1000)
  if (s <= 0) return 'now'
  return `in ${duration(s)}`
}

export function time(d: Date | string | number, hour12 = false): string {
  return new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12 })
}

/** Initials for an avatar: "Marc Teichtahl" → "MT"; "priya@x.com" → "PR". */
export function initials(nameOrEmail: string): string {
  const base = nameOrEmail.includes('@') ? (nameOrEmail.split('@')[0] ?? '') : nameOrEmail
  const parts = base.split(/[\s._-]+/).filter(Boolean)
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase()
  return base.slice(0, 2).toUpperCase()
}

export const firstName = (nameOrEmail: string): string => {
  const base = nameOrEmail.includes('@') ? (nameOrEmail.split('@')[0] ?? '') : nameOrEmail
  const f = base.split(/[\s._-]+/)[0] ?? base
  return f.charAt(0).toUpperCase() + f.slice(1)
}

export function greeting(now = new Date()): string {
  const h = now.getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
