/**
 * A JSON document as a collapsible tree (keys, values, counts), opened two levels deep, with the keys a change touched
 * marked when a comparison gives them. Values are drawn as text, never as markup.
 */
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { KeyChange } from '../json-diff'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const MARK: Record<KeyChange, string> = { added: 'bg-verified/10', removed: 'bg-destructive/10', changed: 'bg-warning/15' }

function Leaf({ v }: { v: unknown }) {
  if (typeof v === 'string') return <span className="break-all text-verified">{JSON.stringify(v)}</span>
  if (typeof v === 'number') return <span className="text-primary">{String(v)}</span>
  return <span className="text-muted-foreground">{String(v)}</span>
}

function Node({ name, value, path, marks, depth }: { name?: string; value: unknown; path: string; marks?: Map<string, KeyChange>; depth: number }) {
  const [open, setOpen] = useState(depth < 2)
  const mark = marks?.get(path)
  const label = name !== undefined ? <span className="text-foreground">{name}<span className="text-muted-foreground">: </span></span> : null
  if (!isObj(value) && !Array.isArray(value)) return <div className={cn('py-0.5 pl-5', mark && MARK[mark])}>{label}<Leaf v={value} /></div>
  const entries: [string, unknown][] = Array.isArray(value) ? value.map((x, i) => [String(i), x]) : Object.entries(value)
  const child = (k: string) => (Array.isArray(value) ? `${path}[${k}]` : path ? `${path}.${k}` : k)
  // a branch holding a marked key opens, so a changed key is never hidden
  const hasMark = !!marks && [...marks.keys()].some((m) => path === '' || m === path || m.startsWith(`${path}.`) || m.startsWith(`${path}[`))
  return (
    <div>
      <button type="button" className={cn('flex w-full items-center gap-1 py-0.5 text-left hover:bg-muted/50', mark && MARK[mark])} aria-expanded={open || hasMark} onClick={() => setOpen((o) => !o)}>
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', (open || hasMark) && 'rotate-90')} aria-hidden />
        {label}
        <span className="text-muted-foreground">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </button>
      {(open || hasMark) && (
        <div className="ml-2 border-l pl-2">
          {entries.map(([k, v]) => <Node key={k} name={k} value={v} path={child(k)} marks={marks} depth={depth + 1} />)}
        </div>
      )}
    </div>
  )
}

export function JsonTree({ value, marks, className }: { value: unknown; marks?: Map<string, KeyChange>; className?: string }) {
  return (
    <div role="tree" aria-label="JSON tree" className={cn('min-h-0 flex-1 overflow-auto bg-muted/20 p-3 font-mono text-[12.5px] leading-5', className)}>
      <Node value={value} path="" marks={marks} depth={0} />
    </div>
  )
}
