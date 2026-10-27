/**
 * Markdown: the chat's own renderer (raw HTML is shown as text, never rendered), with a contents list beside it and
 * Show source. The card shows the first section.
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
  const heads = useMemo(() => headingsOf(q.data ?? ''), [q.data])
  if (q.isError) return <ViewerError error={q.error} onRetry={() => void q.refetch()} />
  if (q.data === undefined) return <ViewerLoading size={size} />
  if (size === 'card')
    return (
      <div className="max-h-[260px] overflow-hidden px-3 text-sm [mask-image:linear-gradient(to_bottom,black_80%,transparent)]">
        <Markdown text={firstSection(q.data)} />
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
              <Markdown text={q.data} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
