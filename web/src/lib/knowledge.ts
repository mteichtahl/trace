/**
 * Knowledge, memory and the shared library, as the API gives them today (src/api/actions.ts): kb.search hits, memory
 * records (memory.list / memory.recall), and the read-only datasheets.* and parts.* tools run through `tool`. The
 * answers are loosely typed in lib/api.ts (`unknown[]`, `Record<string, unknown>`); this file reads them into shapes
 * the screens use, tolerantly, and holds the pure rules the screens follow (ranking with a relevance threshold, the
 * words to mark in a passage, agents' plain names).
 */

// ------------------------------------------------------------------ agents

/** The agents that make memories and run jobs (src/agents/runtime/memory.ts AGENTS), in the design's order. */
export const AGENTS = [
  { id: 'verify', name: 'Verification', does: 'Writes test plans, runs checks and simulations, and judges results against the requirements.' },
  { id: 'impl', name: 'Implementation', does: 'Captures and changes the design: schematic, placement and routing.' },
  { id: 'ams', name: 'Analog and mixed-signal', does: 'Sizes and checks analog circuits: regulators, filters, sensing and converters.' },
  { id: 'emc', name: 'EMC', does: 'Looks for radio interference problems in the layout and the parts.' },
  { id: 'render', name: 'Rendering', does: 'Makes pictures of the board and the product: renders, turntables and 3D models.' },
  { id: 'thermal', name: 'Thermal', does: 'Models how hot the board and its parts get, and where the heat goes.' },
  { id: 'worker', name: 'Worker', does: 'Makes code and file changes when a specialist asks for them.' },
] as const

export type AgentId = (typeof AGENTS)[number]['id']

const LEGACY: Record<string, string> = { 'ci-doctor': 'Build doctor', conflict: 'Merge helper', local: 'Local session' }

/** "ams" → "Analog and mixed-signal"; "person/…" → "You (your own)" or "A person on the project". */
export function agentName(actor: string | null | undefined, o: { own?: boolean } = {}): string {
  if (!actor) return 'Unknown'
  if (actor.startsWith('person/')) return o.own === false ? 'A person on the project' : 'You (your own)'
  return AGENTS.find((a) => a.id === actor)?.name ?? LEGACY[actor] ?? actor
}

// ------------------------------------------------------------------ memory records

export type MemoryKind = 'facts' | 'preferences' | 'sessions'

export interface MemoryView {
  id: string
  repo: string
  kind: MemoryKind | null
  /** the agent (verify, impl, …) or person/<hash> */
  actor: string | null
  text: string
  score: number | null
  createdAt: string | null
  active: boolean
  inactive?: { reason: string; byYou: boolean; at: string }
}

export const KIND_WORD: Record<MemoryKind, string> = { facts: 'Fact', preferences: 'Preference', sessions: 'Session summary' }
export const kindWord = (k: MemoryKind | null): string => (k ? KIND_WORD[k] : 'Memory')

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** One record of memory.list / memory.recall (recordView in src/api/actions.ts). */
export function readMemory(r: Record<string, unknown>, repo: string): MemoryView | null {
  const id = str(r.id)
  const text = str(r.text)
  if (!id || text === null) return null
  const k = str(r.strategy)
  const inactive = r.inactive && typeof r.inactive === 'object' ? (r.inactive as Record<string, unknown>) : null
  return {
    id,
    repo,
    kind: k === 'facts' || k === 'preferences' || k === 'sessions' ? k : null,
    actor: str(r.actor),
    text,
    score: numOrNull(r.score),
    createdAt: str(r.created_at),
    active: r.active !== false,
    ...(inactive ? { inactive: { reason: str(inactive.reason) ?? '', byYou: inactive.by_you === true, at: str(inactive.at) ?? '' } } : {}),
  }
}

export const readMemories = (records: Record<string, unknown>[] | undefined, repo: string): MemoryView[] =>
  (records ?? []).map((r) => readMemory(r, repo)).filter((m): m is MemoryView => m !== null)

/** Who switched it off, as trace records it: only a fingerprint, so "You" or "Someone on the project". */
export const switchedBy = (m: MemoryView): string => (m.inactive?.byYou ? 'You' : 'Someone on the project')

/** The memory may be switched off and on by this person: contributors and admins, and anyone for their own preferences. */
export function maySwitch(m: Pick<MemoryView, 'actor'>, o: { admin: boolean; part?: 'contributor' | 'reviewer' }): boolean {
  if (o.admin) return true
  if (m.actor?.startsWith('person/')) return true
  return o.part === 'contributor'
}

// ------------------------------------------------------------------ knowledge base hits (src/tools/kb/search.ts Hit)

export interface KbHit {
  text: string
  score: number | null
  source: string | null
  kind: string | null
  path: string | null
  commit: string | null
  citation: string
  datasheet?: { part: string; sha256: string; page: number }
}

export function readHits(results: unknown[] | undefined): KbHit[] {
  return (results ?? []).flatMap((x) => {
    if (!x || typeof x !== 'object') return []
    const r = x as Record<string, unknown>
    const text = str(r.text)
    if (text === null) return []
    const ds = r.datasheet && typeof r.datasheet === 'object' ? (r.datasheet as Record<string, unknown>) : null
    return [{
      text,
      score: numOrNull(r.score),
      source: str(r.source),
      kind: str(r.kind),
      path: str(r.path),
      commit: str(r.commit),
      citation: str(r.citation) ?? str(r.path) ?? 'unknown',
      ...(ds && str(ds.part) && typeof ds.page === 'number' ? { datasheet: { part: String(ds.part), sha256: str(ds.sha256) ?? '', page: ds.page } } : {}),
    }]
  })
}

// ------------------------------------------------------------------ one result list across sources

export type ResultKind = 'document' | 'datasheet' | 'memory' | 'part'

export interface KnowledgeResult {
  id: string
  kind: ResultKind
  /** the project it belongs to; null for the shared library */
  repo: string | null
  score: number | null
  /** the one-line summary */
  summary: string
  /** the matching passage, words marked by the screen */
  passage?: string
  /** "docs/power-notes.md", "TLV755 · p.12", "Analog and mixed-signal · 14 Oct" */
  source: string
  path?: string
  page?: number
  mpn?: string
  memory?: MemoryView
}

/** At or above this relevance a match is "strong"; below it waits behind Show weaker matches. */
export const STRONG = 0.45

/**
 * Best first; results without a score (library listings) after the scored ones in the order given. Strong matches
 * are those at or above the threshold, and unscored ones; the rest are weak.
 */
export function rankResults<T extends { score: number | null }>(results: T[], threshold = STRONG): { strong: T[]; weak: T[] } {
  const scored = results.filter((r) => r.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const unscored = results.filter((r) => r.score === null)
  return {
    strong: [...scored.filter((r) => (r.score ?? 0) >= threshold), ...unscored],
    weak: scored.filter((r) => (r.score ?? 0) < threshold),
  }
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'what', 'how', 'why', 'are', 'was', 'its', 'from', 'into', 'does', 'did', 'can', 'not', 'any', 'our', 'your', 'about'])

/** The words of a query worth marking in a passage (three letters or more, not filler). */
export function queryTerms(q: string): string[] {
  const words = q.toLowerCase().split(/[^\p{L}\p{N}.µ]+/u).map((w) => w.replace(/^\.+|\.+$/g, '')).filter((w) => w.length >= 3 && !STOP.has(w))
  return [...new Set(words)].sort((a, b) => b.length - a.length)
}

/** Split `text` into plain and marked pieces for the query's words. */
export function markPieces(text: string, terms: string[]): { text: string; mark: boolean }[] {
  if (!terms.length) return [{ text, mark: false }]
  const esc = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(${esc.join('|')})`, 'giu')
  const out: { text: string; mark: boolean }[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) out.push({ text: text.slice(last, i), mark: false })
    out.push({ text: m[0], mark: true })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), mark: false })
  return out
}

/** The first sentence, at most `max` characters. */
export function firstSentence(text: string, max = 160): string {
  const t = text.replace(/\s+/g, ' ').trim()
  const m = /^(.+?[.!?])(\s|$)/.exec(t)
  const s = m?.[1] ?? t
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

/** The part of `text` around the first query word, about `len` characters, with … where it was cut. */
export function snippet(text: string, terms: string[], len = 260): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= len) return t
  const lower = t.toLowerCase()
  const at = terms.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0
  const start = Math.max(0, at - Math.floor(len / 3))
  const end = Math.min(t.length, start + len)
  return `${start > 0 ? '…' : ''}${t.slice(start, end).trim()}${end < t.length ? '…' : ''}`
}

const docTitle = (h: KbHit): string => {
  if (h.datasheet) return `${h.datasheet.part} · p.${h.datasheet.page}`
  return h.path ?? h.citation
}

export function hitToResult(h: KbHit, repo: string, terms: string[], i: number): KnowledgeResult {
  const isDatasheet = !!h.datasheet
  return {
    id: `kb:${repo}:${h.citation}:${i}`,
    kind: isDatasheet ? 'datasheet' : 'document',
    repo,
    score: h.score,
    summary: firstSentence(h.text),
    passage: snippet(h.text, terms),
    source: docTitle(h),
    ...(h.path ? { path: h.path } : {}),
    ...(h.datasheet ? { page: h.datasheet.page, mpn: h.datasheet.part } : {}),
  }
}

export function memoryToResult(m: MemoryView): KnowledgeResult {
  return { id: `mem:${m.repo}:${m.id}`, kind: 'memory', repo: m.repo, score: m.score, summary: m.text, source: agentName(m.actor), memory: m }
}

// ------------------------------------------------------------------ the shared library (datasheets.list, parts.search)

export interface LibraryDatasheet {
  mpn: string
  manufacturer: string | null
  title: string | null
  status: string | null
  pages: number | null
  versions: number
  changed: boolean
  addedAt: string | null
}

export function readDatasheets(r: unknown): LibraryDatasheet[] {
  const parts = r && typeof r === 'object' && Array.isArray((r as { parts?: unknown }).parts) ? ((r as { parts: Record<string, unknown>[] }).parts) : []
  return parts.flatMap((p) => {
    const mpn = str(p.mpn)
    if (!mpn) return []
    const cur = p.current && typeof p.current === 'object' ? (p.current as Record<string, unknown>) : null
    return [{
      mpn,
      manufacturer: str(p.manufacturer),
      title: str(p.title),
      status: str(p.status),
      pages: cur ? numOrNull(cur.pages) : null,
      versions: numOrNull(p.versions) ?? 1,
      changed: !!p.changed,
      addedAt: cur ? (typeof cur.at === 'number' ? new Date(cur.at * (cur.at < 1e12 ? 1000 : 1)).toISOString() : str(cur.at)) : null,
    }]
  })
}

export interface PartOffer {
  mpn: string
  manufacturer: string | null
  description: string | null
  provider: string | null
  stock: number | null
  moq: number | null
  /** the unit price at the smallest break */
  price: number | null
  priceBreaks: { qty: number; price: number }[]
  lifecycle: string | null
  package: string | null
  url: string | null
}

export function readOffers(r: unknown): PartOffer[] {
  const offers = r && typeof r === 'object' && Array.isArray((r as { offers?: unknown }).offers) ? ((r as { offers: Record<string, unknown>[] }).offers) : []
  return offers.flatMap((o) => {
    const mpn = str(o.mpn)
    if (!mpn) return []
    const breaks = Array.isArray(o.price_breaks)
      ? (o.price_breaks as Record<string, unknown>[]).map((b) => ({ qty: numOrNull(b.qty) ?? numOrNull(b.quantity) ?? 1, price: numOrNull(b.price) ?? numOrNull(b.unit_price) ?? 0 })).filter((b) => b.price > 0)
      : []
    return [{
      mpn,
      manufacturer: str(o.manufacturer),
      description: str(o.description),
      provider: str(o.provider),
      stock: numOrNull(o.stock),
      moq: numOrNull(o.moq),
      price: breaks[0]?.price ?? null,
      priceBreaks: breaks,
      lifecycle: str(o.lifecycle),
      package: str(o.package),
      url: str(o.url),
    }]
  })
}

/** The unit price when buying `qty`: the last break at or below it. */
export function priceAt(breaks: { qty: number; price: number }[], qty: number): number | null {
  const sorted = [...breaks].sort((a, b) => a.qty - b.qty)
  let p: number | null = sorted[0]?.price ?? null
  for (const b of sorted) if (b.qty <= qty) p = b.price
  return p
}

export const LIFECYCLE_WORD: Record<string, string> = { active: 'Active', nrnd: 'Not for new designs', eol: 'End of life', obsolete: 'Obsolete', unknown: 'Not stated' }
export const lifecycleWord = (l: string | null): string => (l ? LIFECYCLE_WORD[l.toLowerCase()] ?? l : 'Not stated')

/** Group by the day of `at`, newest day first; each day's items newest first. */
export function byDay<T>(items: T[], at: (x: T) => string | null, now = Date.now()): { key: string; label: string; items: T[] }[] {
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const today = day(new Date(now))
  const yesterday = day(new Date(now - 86_400_000))
  const groups = new Map<string, T[]>()
  for (const x of [...items].sort((a, b) => (at(b) ?? '').localeCompare(at(a) ?? ''))) {
    const a = at(x)
    const k = a ? day(new Date(a)) : 'unknown'
    groups.set(k, [...(groups.get(k) ?? []), x])
  }
  return [...groups.entries()].map(([key, list]) => ({
    key,
    label: key === today ? 'Today' : key === yesterday ? 'Yesterday' : key === 'unknown' ? 'Date not recorded' : new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    items: list,
  }))
}

/** Days left before something made at `at` passes `retentionDays`; never below 0. */
export function expiresInDays(at: string, retentionDays: number, now = Date.now()): number {
  const left = new Date(at).getTime() + retentionDays * 86_400_000 - now
  return Math.max(0, Math.ceil(left / 86_400_000))
}

/** The retention the installation uses unless an admin set the project's own (src/infra/props.ts). */
export const DEFAULT_RETENTION_DAYS = 30
