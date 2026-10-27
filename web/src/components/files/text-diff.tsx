/** Two texts compared line by line (the `diff` package), unchanged runs folded to three lines of context. */
import { diffLines } from 'diff'
import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { AREA, Controls, type ViewerSize } from './viewers/common'

export interface DiffLine {
  kind: 'add' | 'del' | 'same' | 'fold'
  text: string
  a?: number
  b?: number
  /** for a fold: how many lines it hides */
  hidden?: number
}

/** The diff as numbered lines, with long unchanged runs folded (context lines kept at each edge). */
export function lineDiff(before: string, after: string, context = 3): { lines: DiffLine[]; added: number; removed: number } {
  const parts = diffLines(before, after)
  const out: DiffLine[] = []
  let a = 1
  let b = 1
  let added = 0
  let removed = 0
  parts.forEach((p, idx) => {
    const ls = p.value.replace(/\n$/, '').split('\n')
    if (p.added) {
      for (const t of ls) out.push({ kind: 'add', text: t, b: b++ })
      added += ls.length
    } else if (p.removed) {
      for (const t of ls) out.push({ kind: 'del', text: t, a: a++ })
      removed += ls.length
    } else {
      const first = idx === 0
      const last = idx === parts.length - 1
      const keepHead = first ? 0 : context
      const keepTail = last ? 0 : context
      if (ls.length > keepHead + keepTail + 1) {
        for (const t of ls.slice(0, keepHead)) out.push({ kind: 'same', text: t, a: a++, b: b++ })
        const hidden = ls.length - keepHead - keepTail
        out.push({ kind: 'fold', text: '', hidden })
        a += hidden
        b += hidden
        for (const t of ls.slice(ls.length - keepTail)) out.push({ kind: 'same', text: t, a: a++, b: b++ })
      } else for (const t of ls) out.push({ kind: 'same', text: t, a: a++, b: b++ })
    }
  })
  return { lines: out, added, removed }
}

export function TextDiff({ before, after, size }: { before: string; after: string; size: ViewerSize }) {
  const [all, setAll] = useState(false)
  const d = useMemo(() => lineDiff(before, after, all ? Infinity : 3), [before, after, all])
  return (
    <div className={cn('flex flex-col', AREA[size])}>
      <Controls>
        <span className="font-medium">
          <span className="text-verified">+{d.added}</span> <span className="text-destructive">−{d.removed}</span> lines
        </span>
        <label className="ml-auto flex items-center gap-1.5">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show unchanged lines
        </label>
      </Controls>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[12.5px] leading-5">
        {d.added + d.removed === 0 && <p className="p-4 font-sans text-sm text-muted-foreground">The two versions are the same.</p>}
        <table className="w-full border-collapse">
          <tbody>
            {d.lines.map((l, i) =>
              l.kind === 'fold' ? (
                <tr key={i} className="bg-muted/50 text-muted-foreground">
                  <td colSpan={3} className="px-3 py-0.5 font-sans text-xs">
                    {l.hidden} unchanged lines
                  </td>
                </tr>
              ) : (
                <tr key={i} className={cn(l.kind === 'add' && 'bg-verified/10', l.kind === 'del' && 'bg-destructive/10')}>
                  <td className="w-12 select-none px-2 text-right text-muted-foreground/70">{l.a ?? ''}</td>
                  <td className="w-12 select-none px-2 text-right text-muted-foreground/70">{l.b ?? ''}</td>
                  <td className="whitespace-pre-wrap break-all pr-4">
                    <span className="select-none text-muted-foreground" aria-label={l.kind === 'add' ? 'added' : l.kind === 'del' ? 'removed' : undefined}>
                      {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '− ' : '  '}
                    </span>
                    {l.text}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
