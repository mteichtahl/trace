/**
 * Reading and changing Scribe's documents through their markers (docs/scribe.md, "Markers"):
 *
 *   <!-- scribe:section id="…" --> … <!-- scribe:end id="…" -->   a section Scribe owns; text outside belongs to people
 *   <!-- scribe:figure kind="…" source="…" -->                     the next image or ```mermaid block, then an italic caption
 *   <!-- scribe:values kind="…" -->                                the next table: Quantity | Value | Limit | Margin | Basis | Source
 *
 * Pure functions on strings: no I/O.
 */
export interface Figure {
  kind: string
  source: string
  /** The image path, when the figure is an image. */
  image?: string
  /** The Mermaid code, when the figure is a ```mermaid block. */
  mermaid?: string
  caption?: string
  /** 1-based line of the marker. */
  line: number
}

export interface ValueRow {
  quantity: string
  value: string
  limit: string
  margin: string
  basis: string
  source: string
  line: number
}

export interface ValuesTable {
  kind: string
  /** The header cells as written, lower-cased. */
  columns: string[]
  rows: ValueRow[]
  line: number
}

export interface Section {
  id: string
  /** The first heading inside the markers, without its hashes. */
  title: string
  /** Everything between the markers. */
  body: string
  /** Only "_Pending: …_" (or nothing) inside the heading. */
  pending: boolean
  figures: Figure[]
  values: ValuesTable[]
  /** 1-based line of the opening marker. */
  line: number
}

export interface ParsedDoc {
  front: Record<string, string> | null
  sections: Section[]
  /** Markers that do not pair up or repeat an id: each a line and what is wrong. */
  problems: { line: number; text: string }[]
}

export const VALUE_COLUMNS = ['quantity', 'value', 'limit', 'margin', 'basis', 'source'] as const

const OPEN = /^<!--\s*scribe:section\s+id="([a-z0-9-]+)"\s*-->\s*$/
const CLOSE = /^<!--\s*scribe:end\s+id="([a-z0-9-]+)"\s*-->\s*$/
const FIGURE = /^<!--\s*scribe:figure\s+(.*?)\s*-->\s*$/
const VALUES = /^<!--\s*scribe:values\s+(.*?)\s*-->\s*$/
const ATTR = /([a-z]+)="([^"]*)"/g
const PENDING = /^_Pending:[^\n]*_$/

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of s.matchAll(ATTR)) out[m[1]!] = m[2]!
  return out
}

function frontMatter(lines: string[]): { front: Record<string, string> | null; skip: number } {
  if (lines[0]?.trim() !== '---') return { front: null, skip: 0 }
  const end = lines.indexOf('---', 1)
  if (end < 0) return { front: null, skip: 0 }
  const front: Record<string, string> = {}
  for (const l of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(l)
    if (m) front[m[1]!] = m[2]!.trim()
  }
  return { front, skip: end + 1 }
}

const cells = (row: string): string[] => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())

/** Figures and value tables in a section's lines (offset: the 1-based line of lines[0]). */
function contents(lines: string[], offset: number): { figures: Figure[]; values: ValuesTable[] } {
  const figures: Figure[] = []
  const values: ValuesTable[] = []
  for (let i = 0; i < lines.length; i++) {
    const f = FIGURE.exec(lines[i]!.trim())
    if (f) {
      const a = attrs(f[1]!)
      const fig: Figure = { kind: a.kind ?? '', source: a.source ?? '', line: offset + i }
      let j = i + 1
      while (j < lines.length && !lines[j]!.trim()) j++
      const img = /^!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/.exec(lines[j]?.trim() ?? '')
      if (img) { fig.image = img[1]!; j++ }
      else if (/^```mermaid\s*$/.test(lines[j]?.trim() ?? '')) {
        const close = lines.findIndex((l, k) => k > j && l.trim() === '```')
        if (close > j) { fig.mermaid = lines.slice(j + 1, close).join('\n'); j = close + 1 }
      }
      while (j < lines.length && !lines[j]!.trim()) j++
      const cap = /^_(.+)_$/.exec(lines[j]?.trim() ?? '')
      if (cap && !PENDING.test(lines[j]!.trim())) fig.caption = cap[1]!
      figures.push(fig)
      continue
    }
    const v = VALUES.exec(lines[i]!.trim())
    if (v) {
      let j = i + 1
      while (j < lines.length && !lines[j]!.trim()) j++
      const table: ValuesTable = { kind: attrs(v[1]!).kind ?? '', columns: [], rows: [], line: offset + i }
      if (lines[j]?.trim().startsWith('|')) {
        table.columns = cells(lines[j]!).map((c) => c.toLowerCase())
        j += 2 // header and its |---| rule
        for (; j < lines.length && lines[j]!.trim().startsWith('|'); j++) {
          const c = cells(lines[j]!)
          const at = (name: (typeof VALUE_COLUMNS)[number]): string => c[table.columns.indexOf(name)] ?? ''
          table.rows.push({ quantity: at('quantity'), value: at('value'), limit: at('limit'), margin: at('margin'), basis: at('basis').toLowerCase(), source: at('source'), line: offset + j })
        }
      }
      values.push(table)
    }
  }
  return { figures, values }
}

export function parseDoc(md: string): ParsedDoc {
  const lines = md.split('\n')
  const { front, skip } = frontMatter(lines)
  const sections: Section[] = []
  const problems: ParsedDoc['problems'] = []
  const seen = new Set<string>()
  let open: { id: string; at: number } | null = null
  for (let i = skip; i < lines.length; i++) {
    const t = lines[i]!.trim()
    const o = OPEN.exec(t)
    if (o) {
      if (open) problems.push({ line: open.at + 1, text: `section ${open.id} is not closed before ${o[1]} opens` })
      open = { id: o[1]!, at: i }
      continue
    }
    const c = CLOSE.exec(t)
    if (c) {
      if (!open || open.id !== c[1]) { problems.push({ line: i + 1, text: `end of ${c[1]} without its opening marker` }); continue }
      const inner = lines.slice(open.at + 1, i)
      const heading = inner.findIndex((l) => /^#{1,6}\s/.test(l))
      const rest = inner.slice(heading + 1).map((l) => l.trim()).filter(Boolean)
      if (seen.has(open.id)) problems.push({ line: open.at + 1, text: `section ${open.id} appears twice` })
      seen.add(open.id)
      sections.push({
        id: open.id,
        title: heading >= 0 ? inner[heading]!.replace(/^#+\s*/, '').trim() : '',
        body: inner.join('\n'),
        pending: rest.length === 0 || (rest.length === 1 && PENDING.test(rest[0]!)),
        ...contents(inner, open.at + 2),
        line: open.at + 1,
      })
      open = null
    }
  }
  if (open) problems.push({ line: open.at + 1, text: `section ${open.id} is never closed` })
  return { front, sections, problems }
}

/** The document with section `id`'s body replaced; everything outside its markers is kept byte for byte. */
export function replaceSection(md: string, id: string, body: string): string {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => OPEN.exec(l.trim())?.[1] === id)
  const end = lines.findIndex((l, i) => i > start && CLOSE.exec(l.trim())?.[1] === id)
  if (start < 0 || end < 0) throw new Error(`section ${id} is not in the document`)
  return [...lines.slice(0, start + 1), ...body.replace(/\n+$/, '').split('\n'), ...lines.slice(end)].join('\n')
}

/** The document with front-matter field `key` set (added at the end of the front matter when missing). */
export function setFront(md: string, key: string, value: string): string {
  const lines = md.split('\n')
  if (lines[0]?.trim() !== '---') throw new Error('the document has no front matter')
  const end = lines.indexOf('---', 1)
  if (end < 0) throw new Error('the front matter is never closed')
  const at = lines.findIndex((l, i) => i > 0 && i < end && l.startsWith(`${key}:`))
  if (at > 0) lines[at] = `${key}: ${value}`
  else lines.splice(end, 0, `${key}: ${value}`)
  return lines.join('\n')
}
