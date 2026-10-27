/**
 * Archives (.zip, .tar, .tar.gz): unpacked in the browser (fflate), listed as a folder tree, and any file inside opens
 * in its own viewer. Nothing inside is run. The card shows the file list.
 */
import { ChevronLeft, FileText, Folder } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { eng } from '@/lib/format'
import { cn } from '@/lib/utils'
import { type FileRef, useFileBytes } from '../data'
import { type Entry, unpack } from '../archive'
import { extOf, kindLabel } from '../kinds'
import { AREA, Controls, Note, ViewerError, ViewerLoading, type ViewerProps } from './common'

export default function ArchiveViewer({ file, size, commit, renderInner }: ViewerProps & { renderInner?: (f: FileRef) => React.ReactNode }) {
  const q = useFileBytes(file, { commit })
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [dir, setDir] = useState('')
  const [open, setOpen] = useState<Entry | null>(null)
  useEffect(() => {
    if (!q.data) return
    let live = true
    unpack(q.data, extOf(file.path))
      .then((e) => live && setEntries(e))
      .catch((e: Error) => live && setErr(e.message))
    return () => {
      live = false
    }
  }, [q.data, file.path])

  const listing = useMemo(() => {
    if (!entries) return { dirs: [] as string[], files: [] as Entry[] }
    const dirs = new Set<string>()
    const files: Entry[] = []
    for (const e of entries) {
      if (!e.path.startsWith(dir)) continue
      const rest = e.path.slice(dir.length)
      const i = rest.indexOf('/')
      if (i >= 0) dirs.add(rest.slice(0, i + 1))
      else files.push(e)
    }
    return { dirs: [...dirs].sort(), files: files.sort((a, b) => a.path.localeCompare(b.path)) }
  }, [entries, dir])

  const inner = useMemo<FileRef | null>(() => {
    if (!open) return null
    return { repo: file.repo, path: `${file.path}/${open.path}`, size: open.size, url: URL.createObjectURL(new Blob([open.bytes as Uint8Array<ArrayBuffer>])) }
  }, [open, file.repo, file.path])
  useEffect(() => () => { if (inner?.url) URL.revokeObjectURL(inner.url) }, [inner])

  if (q.isError) return <ViewerError error={q.error} onRetry={() => void q.refetch()} />
  if (err) return <Note>This archive could not be opened here: {err}</Note>
  if (!entries) return <ViewerLoading size={size} label="Unpacking the archive" />

  if (size === 'card')
    return (
      <ul className="max-h-[220px] overflow-auto px-3 py-2 text-xs">
        {entries.slice(0, 12).map((e) => (
          <li key={e.path} className="flex gap-2 py-0.5">
            <span className="min-w-0 flex-1 truncate font-mono">{e.path}</span>
            <span className="text-muted-foreground">{eng(e.size, 'B')}</span>
          </li>
        ))}
        {entries.length > 12 && <li className="pt-1 text-muted-foreground">and {entries.length - 12} more</li>}
      </ul>
    )

  if (open && inner)
    return (
      <div className={cn('flex flex-col', AREA[size])}>
        <Controls>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setOpen(null)}>
            <ChevronLeft /> Back to the archive
          </Button>
          <span className="font-mono">{open.path}</span>
        </Controls>
        <div className="min-h-0 flex-1 overflow-auto">{renderInner?.(inner)}</div>
      </div>
    )

  return (
    <div className={cn('flex flex-col', AREA[size])}>
      <Controls>
        {dir && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setDir(dir.replace(/[^/]+\/$/, ''))}>
            <ChevronLeft /> Up
          </Button>
        )}
        <span className="font-mono">/{dir}</span>
        <span className="ml-auto text-muted-foreground">{entries.length} files · unpacked in your browser</span>
      </Controls>
      <ul className="min-h-0 flex-1 divide-y overflow-auto text-sm">
        {listing.dirs.map((d) => (
          <li key={d}>
            <button type="button" className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-accent" onClick={() => setDir(dir + d)}>
              <Folder className="size-4 text-muted-foreground" aria-hidden /> <span className="font-mono">{d}</span>
            </button>
          </li>
        ))}
        {listing.files.map((e) => (
          <li key={e.path}>
            <button type="button" className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-accent" onClick={() => setOpen(e)}>
              <FileText className="size-4 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-mono">{e.path.slice(dir.length)}</span>
              <span className="hidden text-xs text-muted-foreground sm:inline">{kindLabel(e.path)}</span>
              <span className="w-20 text-right text-xs text-muted-foreground">{eng(e.size, 'B')}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
