/**
 * Code and text: Shiki highlighting in a light and a dark theme (the chat's own highlighter and languages), line
 * numbers, find, wrap, and Follow for a live log (asks again every few seconds and keeps the newest line in view).
 * The card shows the first 12 lines.
 */
import { WrapText } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Toggle } from '@/components/ui/toggle'
import { highlight, langOf } from '@/components/chat/code-block'
import { cn } from '@/lib/utils'
import { useFileText } from '../data'
import { codeLang, isLog } from '../kinds'
import { AREA, Controls, FindBox, ViewerError, ViewerLoading, type ViewerProps } from './common'

const MAX_HIGHLIGHT = 300_000

/** Shiki's HTML split into one HTML string per line (its own escaped output, never the file's raw text). */
function linesOf(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return [...doc.querySelectorAll('pre code > .line')].map((l) => l.innerHTML)
}

export function CodeText({ text, lang, size, follow = false, className }: { text: string; lang: string | null; size: ViewerProps['size']; follow?: boolean; className?: string }) {
  const card = size === 'card'
  const shown = card ? text.split('\n').slice(0, 12).join('\n') : text
  const raw = useMemo(() => shown.replace(/\n$/, '').split('\n'), [shown])
  const [html, setHtml] = useState<string[] | null>(null)
  const [wrap, setWrap] = useState(false)
  const [find, setFind] = useState('')
  const [at, setAt] = useState(0)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    const l = langOf(lang ?? undefined)
    setHtml(null)
    if (!l || shown.length > MAX_HIGHLIGHT) return
    void highlight(shown, l)
      .then((h) => live && setHtml(linesOf(h)))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [shown, lang])

  const matches = useMemo(() => {
    if (!find) return []
    const q = find.toLowerCase()
    return raw.flatMap((l, i) => (l.toLowerCase().includes(q) ? [i] : []))
  }, [raw, find])
  const current = matches.length ? matches[((at % matches.length) + matches.length) % matches.length]! : -1

  useEffect(() => {
    if (current < 0) return
    box.current?.querySelector(`[data-line="${current}"]`)?.scrollIntoView({ block: 'center' })
  }, [current])
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [follow, text])

  const digits = String(raw.length).length
  return (
    <div className={cn('flex flex-col', className)}>
      {!card && (
        <Controls>
          <FindBox value={find} onChange={(v) => { setFind(v); setAt(0) }} count={matches.length} index={((at % (matches.length || 1)) + (matches.length || 1)) % (matches.length || 1)} onStep={(d) => setAt((a) => a + d)} />
          <Toggle size="sm" pressed={wrap} onPressedChange={setWrap} aria-label="Wrap long lines" className="h-7 text-xs">
            <WrapText /> Wrap
          </Toggle>
          <span className="ml-auto text-muted-foreground">{raw.length.toLocaleString()} lines{lang ? ` · ${lang}` : ''}</span>
        </Controls>
      )}
      <div ref={box} className={cn('min-h-0 flex-1 overflow-auto bg-muted/20 py-2 font-mono text-[12.5px] leading-5', card ? 'max-h-[260px]' : '')}>
        <table className="border-collapse">
          <tbody>
            {raw.map((l, i) => (
              <tr key={i} data-line={i} className={cn(matches.includes(i) && 'bg-warning/15', i === current && 'bg-warning/35')}>
                <td className="select-none pl-3 pr-3 text-right align-top text-muted-foreground/70" style={{ minWidth: `${digits + 2}ch` }}>
                  {i + 1}
                </td>
                {html?.[i] !== undefined ? (
                  <td className={cn('shiki pr-4 align-top', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')} dangerouslySetInnerHTML={{ __html: html[i]! || ' ' }} />
                ) : (
                  <td className={cn('pr-4 align-top', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>{l || ' '}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {card && text.split('\n').length > 12 && <p className="px-3 py-1 text-xs text-muted-foreground">First 12 of {text.split('\n').length.toLocaleString()} lines</p>}
    </div>
  )
}

export default function CodeViewer({ file, size, commit }: ViewerProps) {
  const log = isLog(file.path) && !commit
  const [follow, setFollow] = useState(false)
  const q = useFileText(file, { commit, refetchMs: follow ? 3000 : false })
  if (q.isError) return <ViewerError error={q.error} onRetry={() => void q.refetch()} />
  if (q.data === undefined) return <ViewerLoading size={size} />
  return (
    <div className={cn('flex flex-col', size !== 'card' && AREA[size])}>
      {log && size !== 'card' && (
        <Controls className="justify-end">
          <Switch id={`follow-${file.path}`} checked={follow} onCheckedChange={setFollow} />
          <Label htmlFor={`follow-${file.path}`} className="text-xs font-normal">
            Follow the log {follow && <span className="text-muted-foreground">(checks every 3 seconds)</span>}
          </Label>
        </Controls>
      )}
      <CodeText text={q.data} lang={codeLang(file.path)} size={size} follow={follow} className="min-h-0 flex-1" />
    </div>
  )
}
