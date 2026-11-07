/**
 * Markdown: the chat's own renderer (raw HTML is shown as text, never rendered), with a contents list beside it and
 * Show source. The card shows the first section.
 *
 * A document trace writes starts with YAML front matter (project, document, revision, commit, updated) and carries
 * hidden markers for its sections and figures (`<!-- scribe:section id="overview" -->`). The renderer showed the front
 * matter as one bold paragraph and the markers as text (test-esp32 #41). Now the front matter is a small card above
 * the document and HTML comments are left out; Show source still shows both.
 */
import { useMemo, useRef, useState } from 'react'
import { Toggle } from '@/components/ui/toggle'
import { Markdown } from '@/components/chat/markdown'
import { cn } from '@/lib/utils'
import { useFileText } from '../data'
import { CodeText } from './code'
import { AREA, Controls, ViewerError, ViewerLoading, type ViewerProps } from './common'

export interface Heading {
  depth: number
  text: string
}

/** The headings outside code fences, in order. */
export function headingsOf(md: string): Heading[] {
  const out: Heading[] = []
  let fence = false
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) continue
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) out.push({ depth: m[1]!.length, text: m[2]!.replace(/[*_`]/g, '') })
  }
  return out
}

/**
 * The YAML front matter at the top of a document (between two "---" lines), as its key and value pairs, and the
 * document after it. Only plain "key: value" lines are read; anything else in it is left out. No front matter: null.
 */
export function splitFrontMatter(md: string): { front: [string, string][] | null; body: string } {
  const lines = md.replace(/^﻿/, '').split('\n')
  if (lines[0]?.trim() !== '---') return { front: null, body: md }
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l))
  if (end < 0) return { front: null, body: md }
  const front: [string, string][] = []
  for (const l of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(l)
    if (m && m[2]) front.push([m[1]!, m[2].replace(/^(["'])(.*)\1$/, '$2')])
  }
  return { front, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') }
}

/** The document without its HTML comments (trace's hidden markers), outside code fences and inline code. */
export function withoutComments(md: string): string {
  const out: string[] = []
  let fence = false
  let open = false
  for (const line of md.split('\n')) {
    if (!open && /^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) { out.push(line); continue }
    const inside = open
    if (!inside && !line.includes('<!--')) { out.push(line); continue }
    let rest = line
    let kept = ''
    let cut = inside
    while (rest) {
      if (open) {
        const close = rest.indexOf('-->')
        if (close < 0) { rest = ''; break }
        rest = rest.slice(close + 3)
        open = false
        continue
      }
      // inline code keeps what it shows
      const start = rest.search(/<!--|`/)
      if (start < 0) { kept += rest; break }
      kept += rest.slice(0, start)
      rest = rest.slice(start)
      if (rest.startsWith('`')) {
        const end = rest.indexOf('`', 1)
        if (end < 0) { kept += rest; break }
        kept += rest.slice(0, end + 1)
        rest = rest.slice(end + 1)
      } else {
        open = true
        cut = true
        rest = rest.slice(4)
      }
    }
    // a line that held only a comment goes, so it leaves no blank line of its own
    if (!cut) out.push(kept)
    else if (kept.trim()) out.push(kept.trimEnd())
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

/** "updated" → "Updated", "build_quantity" → "Build quantity". */
const label = (k: string): string => {
  const s = k.replace(/[_-]+/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** The front matter as a small card: what the document is, then its other fields. */
export function FrontMatter({ front }: { front: [string, string][] }) {
  if (!front.length) return null
  return (
    <dl aria-label="About this document" className="mb-4 flex flex-wrap gap-x-5 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
      {front.map(([k, v]) => (
        <div key={k} className="flex min-w-0 gap-1.5">
          <dt className="shrink-0 text-muted-foreground">{label(k)}</dt>
          <dd className={cn('min-w-0 break-words', /^[0-9a-f]{7,40}$/.test(v) && 'font-mono')}>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Up to the second heading (the first section). */
export function firstSection(md: string): string {
  const lines = md.split('\n')
  let seen = 0
  let fence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i]!)) fence = !fence
    if (!fence && /^#{1,6}\s/.test(lines[i]!) && ++seen === 2) return lines.slice(0, i).join('\n')
  }
  return md
}

export default function MarkdownViewer({ file, size, commit }: ViewerProps) {
  const q = useFileText(file, { commit })
  const [source, setSource] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const doc = useMemo(() => {
    const { front, body } = splitFrontMatter(q.data ?? '')
    return { front, body: withoutComments(body) }
  }, [q.data])
  const heads = useMemo(() => headingsOf(doc.body), [doc.body])
  if (q.isError) return <ViewerError error={q.error} onRetry={() => void q.refetch()} />
  if (q.data === undefined) return <ViewerLoading size={size} />
  if (size === 'card')
    return (
      <div className="max-h-[260px] overflow-hidden px-3 text-sm [mask-image:linear-gradient(to_bottom,black_80%,transparent)]">
        <Markdown text={firstSection(doc.body)} />
      </div>
    )
  const jump = (i: number) => body.current?.querySelectorAll('h1,h2,h3,h4,h5,h6')[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return (
    <div className={cn('flex flex-col', AREA[size])}>
      <Controls>
        <span className="text-muted-foreground">{heads.length} headings</span>
        <Toggle size="sm" pressed={source} onPressedChange={setSource} className="ml-auto h-7 text-xs">
          Show source
        </Toggle>
      </Controls>
      <div className="flex min-h-0 flex-1">
        {heads.length > 1 && (
          <nav aria-label="Contents" className="hidden w-56 shrink-0 overflow-auto border-r p-3 text-sm md:block">
            <p className="section-label mb-2">Contents</p>
            <ol className="space-y-1">
              {heads.map((h, i) => (
                <li key={i} style={{ paddingLeft: (h.depth - 1) * 12 }}>
                  <button type="button" className="text-left text-muted-foreground hover:text-foreground" onClick={() => jump(i)}>
                    {h.text}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        )}
        {source ? (
          <CodeText text={q.data} lang="markdown" size={size} className="min-h-0 flex-1" />
        ) : (
          <div ref={body} className="min-h-0 flex-1 overflow-auto px-6 py-4">
            <div className="mx-auto max-w-[760px] text-sm">
              {doc.front && <FrontMatter front={doc.front} />}
              <Markdown text={doc.body} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
