/**
 * A KiCad net list (.net) as a connection table: each net and the pins it joins, with search. A file that is not a
 * net list parses to nothing and is shown as text instead, so nothing is lost.
 */
import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { useFileText } from '../data'
import { parseNetlist } from '../netlist'
import { CodeText } from './code'
import { AREA, Controls, Note, ViewerError, ViewerLoading, type ViewerProps } from './common'

export function NetTable({ text, size }: { text: string; size: ViewerProps['size'] }) {
  const nets = useMemo(() => parseNetlist(text), [text])
  const [find, setFind] = useState('')
  if (!nets) return <CodeText text={text} lang={null} size={size} className="min-h-0 flex-1" />
  const q = find.trim().toLowerCase()
  const shown = (q ? nets.filter((n) => n.name.toLowerCase().includes(q) || n.pins.some((p) => `${p.ref}.${p.pin}`.toLowerCase().includes(q))) : nets).slice(0, size === 'card' ? 8 : undefined)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {size !== 'card' && (
        <Controls>
          <input aria-label="Find a net or pin" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a net or pin" className="h-7 w-48 rounded-md border bg-background px-2 text-xs" />
          <span className="ml-auto text-muted-foreground">{nets.length.toLocaleString()} nets · {nets.reduce((n, x) => n + x.pins.length, 0).toLocaleString()} connections</span>
        </Controls>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-background"><tr className="border-b text-left text-xs text-muted-foreground"><th className="px-3 py-2 font-medium">Net</th><th className="px-3 py-2 font-medium">Pins</th><th className="px-3 py-2 text-right font-medium">Count</th></tr></thead>
          <tbody>
            {shown.map((n) => (
              <tr key={n.name} className="border-b align-top">
                <td className="px-3 py-1.5 font-mono text-xs">{n.name}</td>
                <td className={cn('px-3 py-1.5 font-mono text-xs text-muted-foreground')}>{n.pins.map((p) => `${p.ref}.${p.pin}${p.fn ? ` (${p.fn})` : ''}`).join(', ') || 'no pins'}</td>
                <td className="px-3 py-1.5 text-right text-xs">{n.pins.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <Note>No net or pin matches.</Note>}
      </div>
    </div>
  )
}

export default function NetlistViewer({ file, size, commit }: ViewerProps) {
  const q = useFileText(file, { commit })
  if (q.isError) return <ViewerError error={q.error} onRetry={() => void q.refetch()} />
  if (q.data === undefined) return <ViewerLoading size={size} />
  return <div className={cn('flex flex-col', size !== 'card' && AREA[size])}><NetTable text={q.data} size={size} /></div>
}
