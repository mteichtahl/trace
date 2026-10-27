/**
 * Delimited text (CSV, TSV, KiCad's placement files) into a header and rows: quoted fields with doubled quotes and line
 * breaks inside them, CRLF, a byte-order mark, ragged rows padded. And the reading of a parts list's columns.
 */

export interface Table {
  header: string[]
  rows: string[][]
}

/** Comma, tab or semicolon: whichever splits the first line into the most fields outside quotes. */
export function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? ''
  let best = ','
  let most = 0
  for (const d of [',', '\t', ';']) {
    let n = 0
    let q = false
    for (const ch of first) {
      if (ch === '"') q = !q
      else if (ch === d && !q) n++
    }
    if (n > most) {
      most = n
      best = d
    }
  }
  return best
}

export function parseDelimited(input: string, delimiter?: string): Table {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const d = delimiter ?? detectDelimiter(text)
  const records: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    records.push(row)
    row = []
  }
  while (i < text.length) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
      } else field += ch
      i++
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === d) endField()
    else if (ch === '\n') endRow()
    else if (ch === '\r') {
      if (text[i + 1] === '\n') i++
      endRow()
    } else field += ch
    i++
  }
  if (field !== '' || row.length) endRow()
  // drop blank lines (a lone empty field)
  const nonBlank = records.filter((r) => !(r.length === 1 && r[0]!.trim() === ''))
  const header = (nonBlank[0] ?? []).map((h) => h.trim())
  const width = Math.max(header.length, ...nonBlank.slice(1).map((r) => r.length))
  while (header.length < width) header.push(`Column ${header.length + 1}`)
  const rows = nonBlank.slice(1).map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill('')] : r))
  return { header, rows }
}

export interface PartsColumns {
  ref: number
  part: number
  qty: number
  value: number
  price: number
  footprint: number
}

const find = (header: string[], ...names: RegExp[]): number => {
  for (const re of names) {
    const i = header.findIndex((h) => re.test(h.trim()))
    if (i >= 0) return i
  }
  return -1
}

/** The columns of a parts list, or null when the table is not one (it needs a reference and a part or value). */
export function partsColumns(header: string[]): PartsColumns | null {
  const ref = find(header, /^(ref|refs|reference|references|designator|designators|ref\s*des)$/i, /designator|reference/i)
  const part = find(header, /^(mpn|part|part\s*number|manufacturer\s*part(\s*number)?|lcsc(\s*part)?(\s*#)?|jlcpcb part #)$/i, /\bmpn\b|part\s*(no|number|#)/i)
  const value = find(header, /^(value|comment|val)$/i)
  if (ref < 0 || (part < 0 && value < 0)) return null
  return {
    ref,
    part,
    value,
    qty: find(header, /^(qty|quantity|count)$/i),
    price: find(header, /^(price|unit\s*price|cost|unit\s*cost)/i),
    footprint: find(header, /^(footprint|package|case)$/i),
  }
}

/** A number from a cell ("US$0.012", "1,000", "2 pcs"), or null. */
export function cellNumber(s: string | undefined): number | null {
  if (s === undefined) return null
  const m = /-?\d[\d,]*(\.\d+)?|-?\.\d+/.exec(s.replace(/\s/g, ''))
  if (!m) return null
  const n = Number(m[0].replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}
