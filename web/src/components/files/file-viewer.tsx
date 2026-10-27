/**
 * The File viewer (docs/ui-design.md, "File viewers"): one component, three sizes, the same toolbar for every format.
 *
 *   card   in a chat: a compact preview (first page, thumbnail, first rows or lines) with name, kind and size;
 *          Expand opens it larger in place, Open opens the full page.
 *   sheet  from any list or link, without leaving the screen (a right sheet; a bottom drawer on phones).
 *   page   /p/:id/files/<path>, the whole screen; Pop out opens /view/p/:id/files/<path> without the shell.
 *
 * Toolbar: name, kind, revision and commit (and the release mark when frozen); Download; Copy link (the app's own
 * address, never the signed link); Versions (every earlier version, with Compare); Ask about this file (opens Ask trace
 * with the file as context); and below it the format's own controls (each viewer's).
 */
import { useNavigate } from '@tanstack/react-router'
import { ArrowLeft, Check, ChevronDown, Download, ExternalLink, Link2, Lock, Maximize2, Minimize2, MoreHorizontal, Sparkles, SquareArrowOutUpRight } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { openPanel } from '@/components/chat/chat-state'
import { contextStore, useTraceContext } from '@/components/chat/context'
import { useMediaQuery } from '@/hooks/use-media-query'
import { ago, eng } from '@/lib/format'
import { cn } from '@/lib/utils'
import { type FileRef, downloadFile, fileHref, fileName } from './data'
import { compareMode, kindLabel, viewerKind } from './kinds'
import { ViewerFor } from './viewers'
import { ViewerLoading, type ViewerSize } from './viewers/common'

const CompareView = lazy(() => import('./compare').then((m) => ({ default: m.CompareView })))

const short = (c?: string) => (c ? c.slice(0, 7) : undefined)

/** What trace is told about a file in view. */
function contextFor(f: FileRef) {
  return {
    label: fileName(f),
    description: 'The file the person is looking at in the File viewer',
    value: { repo: f.repo, path: f.run ? `runs/${f.run.id}/${f.run.name}` : f.path, kind: kindLabel(f.path), commit: f.commit ?? null, release: f.release ?? null },
    mono: true,
  }
}

/** Ask about this file: put it in Ask trace's context (a removable chip) and open the panel. */
export function askAbout(f: FileRef) {
  const e = { ...contextFor(f), id: 'file' }
  contextStore.set((s) => {
    const removed = new Set(s.removed)
    removed.delete('file')
    return { entries: [...s.entries.filter((x) => x.id !== 'file'), e], removed }
  })
  openPanel(true)
}

async function copyLink(f: FileRef) {
  const href = `${location.origin}${fileHref(f)}`
  try {
    await navigator.clipboard.writeText(href)
    toast('Link copied. It opens this file for anyone on the project.')
  } catch {
    toast('Could not copy the link', { description: href })
  }
}

export interface FileViewerProps {
  file: FileRef
  size: ViewerSize
  /** sheet: the full page; card: Open */
  onOpenPage?: () => void
  /** the page offers Pop out (not inside the popped-out window itself) */
  popOut?: boolean
  className?: string
}

export function FileViewer({ file, size, onOpenPage, popOut, className }: FileViewerProps) {
  const [expanded, setExpanded] = useState(false)
  const [version, setVersion] = useState<string | undefined>(undefined)
  const [compare, setCompare] = useState<{ before: string; after: string } | null>(null)
  const [inner, setInner] = useState<FileRef | null>(null)
  const phone = useMediaQuery('(max-width: 639px)')
  // the screen's file is context for trace while it is open at sheet or page size
  useTraceContext(size !== 'card' ? contextFor(file) : null, 'file')

  const kind = viewerKind(file.path)
  const versions = file.versions ?? []
  const canCompare = !!compareMode(kind) && !file.run
  const shown = inner ?? file
  const effectiveSize: ViewerSize = size === 'card' && expanded ? 'sheet' : size

  const meta = (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
      <Badge variant="outline" className="rounded-md font-normal">{kindLabel(shown.path)}</Badge>
      {file.revision && <span>{file.revision}</span>}
      {(version || file.commit) && <span className="font-mono">commit {short(version ?? file.commit)}{version ? ' (earlier)' : ''}</span>}
      {file.run && <span className="font-mono">run {file.run.id}</span>}
      {file.frozen && (
        <span className="inline-flex items-center gap-1"><Lock className="size-3" aria-hidden /> Frozen in {file.release ?? 'a release'}</span>
      )}
      {size === 'card' && shown.size !== undefined && <span>{eng(shown.size, 'B')}</span>}
    </span>
  )

  const versionsMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          Versions <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {versions.length > 1 && canCompare && (
          <>
            <DropdownMenuItem onSelect={() => { setCompare({ before: versions[1]!.commit, after: 'current' }); setVersion(undefined) }}>Compare with previous</DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{versions.length ? 'Open a version' : 'Versions'}</DropdownMenuLabel>
        {versions.length === 0 && <p className="px-2 pb-2 text-xs text-muted-foreground">Only this version is recorded for this file.</p>}
        {versions.map((v, i) => {
          const current = i === 0
          const on = current ? !version && !compare : version === v.commit
          return (
            <DropdownMenuItem key={v.commit} onSelect={() => { setCompare(null); setVersion(current ? undefined : v.commit) }} className="flex items-center gap-2">
              <span className="w-4">{on && <Check className="size-3.5" />}</span>
              <span className="font-mono text-xs">{short(v.commit)}</span>
              <span className="truncate text-xs text-muted-foreground">
                {v.at ? ago(v.at) : ''}
                {current ? ' · current' : ''}
                {v.release ? ` · ${v.release}` : ''}
              </span>
              {!current && canCompare && (
                <button
                  type="button"
                  className="ml-auto rounded px-1.5 text-xs text-primary hover:underline"
                  onClick={(e) => {
                    e.stopPropagation()
                    setCompare({ before: v.commit, after: 'current' })
                    setVersion(undefined)
                  }}
                >
                  Compare
                </button>
              )}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const actions = phone ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label="File actions">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void downloadFile(shown, version)}><Download /> Download</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copyLink(file)}><Link2 /> Copy link</DropdownMenuItem>
        {versions.length > 1 && canCompare && <DropdownMenuItem onSelect={() => setCompare({ before: versions[1]!.commit, after: 'current' })}>Compare with previous</DropdownMenuItem>}
        {onOpenPage && <DropdownMenuItem onSelect={onOpenPage}><ExternalLink /> Open full page</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : (
    <>
      <Button variant="outline" size="sm" onClick={() => void downloadFile(shown, version).catch((e: Error) => toast('Could not download the file', { description: e.message }))}>
        <Download /> Download
      </Button>
      <Button variant="outline" size="sm" onClick={() => void copyLink(file)}>
        <Link2 /> Copy link
      </Button>
      {!file.run && versionsMenu}
    </>
  )

  const toolbar = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
      <div className="flex min-w-[min(100%,16rem)] flex-1 flex-col gap-0.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
        <h2 className="max-w-full truncate font-mono text-[15px] font-semibold" title={file.path}>{fileName(shown)}</h2>
        {meta}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {actions}
        <Button size="sm" onClick={() => askAbout(file)}>
          <Sparkles /> {phone ? 'Ask' : 'Ask about this file'}
        </Button>
        {popOut && !phone && (
          <Button variant="outline" size="sm" onClick={() => window.open(fileHref(file, { bare: true }), '_blank', 'noopener,popup,width=1280,height=900')}>
            <SquareArrowOutUpRight /> Pop out
          </Button>
        )}
        {onOpenPage && size === 'sheet' && !phone && (
          <Button variant="ghost" size="sm" onClick={onOpenPage}>
            <ExternalLink /> Full page
          </Button>
        )}
        {size === 'card' && (
          <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>
            <Minimize2 /> Smaller
          </Button>
        )}
      </div>
    </div>
  )

  const banner = (version || compare || inner) && (
    <div className="flex flex-wrap items-center gap-2 border-b bg-muted/50 px-4 py-1.5 text-xs">
      {inner ? (
        <>
          <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setInner(null)}>
            <ArrowLeft /> Back to {fileName(file)}
          </Button>
          <span className="font-mono text-muted-foreground">{inner.path}</span>
        </>
      ) : compare ? (
        <>
          <span>
            Comparing <span className="font-mono">{short(compare.before)}</span> with the current version
          </span>
          <select
            aria-label="Compare with"
            className="h-6 rounded border bg-background px-1"
            value={compare.before}
            onChange={(e) => setCompare({ ...compare, before: e.target.value })}
          >
            {versions.slice(1).map((v) => (
              <option key={v.commit} value={v.commit}>
                {short(v.commit)} {v.at ? `· ${ago(v.at)}` : ''}
              </option>
            ))}
          </select>
          <Button size="sm" variant="ghost" className="ml-auto h-6 text-xs" onClick={() => setCompare(null)}>
            Stop comparing
          </Button>
        </>
      ) : (
        <>
          <span>
            Showing an earlier version, <span className="font-mono">{short(version)}</span>. The current one is <span className="font-mono">{short(versions[0]?.commit ?? file.commit)}</span>.
          </span>
          <Button size="sm" variant="ghost" className="ml-auto h-6 text-xs" onClick={() => setVersion(undefined)}>
            Back to current
          </Button>
        </>
      )}
    </div>
  )

  const body = compare ? (
    <Suspense fallback={<ViewerLoading size={effectiveSize} label="Opening both versions" />}>
      <CompareView file={file} before={compare.before} after={compare.after} size={effectiveSize} />
    </Suspense>
  ) : (
    <ViewerFor file={shown} size={effectiveSize} commit={inner ? undefined : version} onOpenEntry={setInner} />
  )

  if (size === 'card' && !expanded) {
    return (
      <div className={cn('my-2 overflow-hidden rounded-xl border bg-card text-sm', className)}>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium" title={file.path}>{fileName(file)}</span>
          {meta}
        </div>
        <ViewerFor file={file} size="card" />
        <div className="flex items-center gap-1 border-t px-2 py-1">
          {onOpenPage && (
            <Button variant="ghost" size="sm" className="h-7 text-xs text-primary" onClick={onOpenPage}>
              Open
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setExpanded(true)}>
            <Maximize2 /> Expand
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="ml-auto size-7" aria-label="Ask about this file" onClick={() => askAbout(file)}>
                <Sparkles />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Ask about this file</TooltipContent>
          </Tooltip>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex min-h-0 flex-col bg-background', size === 'card' && 'my-2 h-[70vh] overflow-hidden rounded-xl border', className)}>
      {toolbar}
      {banner}
      <div className="flex min-h-0 flex-1 flex-col [&>*]:min-h-0 [&>*]:flex-1">{body}</div>
    </div>
  )
}

/** The side sheet size: a right sheet on wider screens, a bottom drawer on phones. */
export function FileSheet({ file, open, onOpenChange }: { file: FileRef | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const phone = useMediaQuery('(max-width: 767px)')
  const navigate = useNavigate()
  const openPage = file ? () => { onOpenChange(false); void navigate({ to: fileHref(file) }) } : undefined
  if (phone)
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="h-[92dvh] max-h-none">
          <DrawerHeader className="sr-only">
            <DrawerTitle>{file ? fileName(file) : 'File'}</DrawerTitle>
          </DrawerHeader>
          {file && <FileViewer file={file} size="sheet" onOpenPage={openPage} className="min-h-0 flex-1" />}
        </DrawerContent>
      </Drawer>
    )
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-[min(960px,92vw)]" aria-describedby={undefined}>
        <SheetTitle className="sr-only">{file ? fileName(file) : 'File'}</SheetTitle>
        <SheetDescription className="sr-only">The file viewer</SheetDescription>
        {file && <FileViewer file={file} size="sheet" onOpenPage={openPage} className="h-full pr-8" />}
      </SheetContent>
    </Sheet>
  )
}
