import { createContext, useContext, type ReactNode } from 'react'

/** The Data table's current search words, for highlighting matches inside custom cells. */
export const SearchContext = createContext('')
export const useTableSearch = (): string => useContext(SearchContext)

/** `text` with every case-insensitive occurrence of the query marked. */
export function highlight(text: string, query: string): ReactNode {
  const q = query.trim()
  if (!q) return text
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  const out: ReactNode[] = []
  let i = 0
  let k = 0
  for (;;) {
    const j = lower.indexOf(needle, i)
    if (j < 0) break
    if (j > i) out.push(text.slice(i, j))
    out.push(
      <mark key={k++} className="match">
        {text.slice(j, j + needle.length)}
      </mark>,
    )
    i = j + needle.length
  }
  if (out.length === 0) return text
  if (i < text.length) out.push(text.slice(i))
  return out
}

/** Use inside a custom cell: <Highlight text={row.name} /> marks the table's search words. */
export function Highlight({ text }: { text: string }) {
  return <>{highlight(text, useTableSearch())}</>
}
