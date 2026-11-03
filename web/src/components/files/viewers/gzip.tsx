/**
 * Single-file gzip (netlist.json.gz, netlist.edif.gz, a bitstream .gz): unpacked in the browser (DecompressionStream)
 * and the file inside drawn with its own viewer, by its name without .gz (a netlist as code, a bitstream as firmware).
 */
import { useEffect, useMemo, useState } from 'react'
import { eng } from '@/lib/format'
import { cn } from '@/lib/utils'
import { type FileRef, useFileBytes } from '../data'
import { baseName } from '../kinds'
import { gunzip, innerName } from '../parse/gzip'
import { AREA, Controls, Note, ViewerError, ViewerLoading, type ViewerProps } from './common'

export default function GzipViewer({ file, size, commit, renderInner }: ViewerProps & { renderInner?: (f: FileRef) => React.ReactNode }) {
  const q = useFileBytes(file, { commit })
  const [out, setOut] = useState<Uint8Array | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (!q.data) return
    let live = true
    gunzip(q.data)
      .then((b) => live && setOut(b))
      .catch((e: Error) => live && setErr(e.message))
    return () => {
      live = false
    }
  }, [q.data])
  const name = innerName(file.path) ?? file.path.replace(/\.gz$/i, '')
  const inner = useMemo<FileRef | null>(
    () => (out ? { repo: file.repo, path: name, size: out.length, url: URL.createObjectURL(new Blob([out as Uint8Array<ArrayBuffer>])) } : null),
    [out, file.repo, name],
  )
  useEffect(() => () => { if (inner?.url) URL.revokeObjectURL(inner.url) }, [inner])
  if (q.isError) return <ViewerError error={q.error} onRetry={() => void q.refetch()} />
  if (err) return <Note>This compressed file could not be opened here: {err}</Note>
  if (!inner || !q.data) return <ViewerLoading size={size} label="Unpacking the file" />
  if (size === 'card') return <>{renderInner?.(inner)}</>
  return (
    <div className={cn('flex min-w-0 flex-col', AREA[size])}>
      <Controls>
        <span className="min-w-0 truncate font-mono">{baseName(name)}</span>
        <span className="text-muted-foreground">
          {eng(out!.length, 'B')} unpacked from {eng(q.data.byteLength, 'B')} in your browser
        </span>
      </Controls>
      <div className="min-h-0 flex-1 overflow-auto [&>*]:h-full">{renderInner?.(inner)}</div>
    </div>
  )
}
