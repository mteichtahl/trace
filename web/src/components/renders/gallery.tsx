/**
 * A revision's renders (docs/revision-renders.md "In the app"): the gallery card, the viewer, the card for renders
 * still being made, and downloading one picture or all of them as a zip made here in the browser (a full set is over
 * the API's 8 MB answer limit, so the server never builds it).
 */
import { ChevronLeft, ChevronRight, Download, Images, Loader2, X } from 'lucide-react'
import { type KeyboardEvent, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { type FileRef, fetchBytes, useFileUrl } from '@/components/files/data'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { ago } from '@/lib/format'
import type { MakingRenders, RenderPicture, RevisionRenders } from '@/lib/types-renders'
import { cn } from '@/lib/utils'
import { saveBytes, zipStored } from '@/lib/zip'

const LOOK: Readonly<Record<string, string>> = { nylon: 'grey nylon', resin: 'resin', black: 'black', pla: 'PLA', aluminium: 'aluminium' }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 2026-11-05 as 5 Nov 2026 (the day as cut: no time zone shift). */
export function dayWords(d: string): string {
  const [y, m, day] = d.split('-').map(Number)
  return y && m && day ? `${day} ${MONTHS[m - 1]} ${y}` : d
}

const fileOf = (repo: string, r: RevisionRenders, p: RenderPicture): FileRef => ({ repo, path: p.name, run: { id: r.run, name: p.name } })

/** The zip's name: the pictures' common part, <project>_rev-<revision>_<date>_renders.zip */
export function zipName(r: RevisionRenders): string {
  const first = r.pictures[0]?.name ?? `rev-${r.revision}_${r.date}_x.png`
  return `${first.slice(0, first.lastIndexOf('_'))}_renders.zip`
}

/** One picture, fetched as its run's artifact. */
export function Picture({ repo, r, p, className, alt }: { repo: string; r: RevisionRenders; p: RenderPicture; className?: string; alt?: string }) {
  const f = useMemo(() => fileOf(repo, r, p), [repo, r, p])
  const u = useFileUrl(f)
  if (!u.data) return <Skeleton className={cn('bg-muted', className)} aria-label={u.isError ? `${p.label} could not be loaded` : `Loading ${p.label}`} />
  return <img src={u.data.url} alt={alt ?? `Rev ${r.revision}, ${p.label.toLowerCase()}`} className={cn('block object-cover', className)} />
}

/** Download one picture. */
export async function downloadPicture(repo: string, r: RevisionRenders, p: RenderPicture): Promise<void> {
  const bytes = new Uint8Array(await fetchBytes(fileOf(repo, r, p)))
  saveBytes(p.name, bytes, 'image/png')
}

/** Download every picture of a revision as one zip; `onStep` hears how many are fetched. */
export async function downloadAll(repo: string, r: RevisionRenders, onStep?: (done: number, of: number) => void): Promise<void> {
  const files: { name: string; bytes: Uint8Array }[] = []
  for (const p of r.pictures) {
    onStep?.(files.length, r.pictures.length)
    files.push({ name: p.name, bytes: new Uint8Array(await fetchBytes(fileOf(repo, r, p))) })
  }
  onStep?.(files.length, r.pictures.length)
  saveBytes(zipName(r), zipStored(files), 'application/zip')
}

function useZip(repo: string, r: RevisionRenders) {
  const [step, setStep] = useState<[number, number] | null>(null)
  const run = () => {
    if (step) return
    setStep([0, r.pictures.length])
    downloadAll(repo, r, (d, of) => setStep([d, of]))
      .catch((e: unknown) => toast.error('The renders could not be downloaded.', { description: e instanceof Error ? e.message : String(e) }))
      .finally(() => setStep(null))
  }
  return { step, run }
}

function Swatches({ r }: { r: RevisionRenders }) {
  const cols = [r.palette.base, r.palette.accent, r.palette.neutral]
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <span className="flex" aria-hidden="true">
        {cols.map((c, i) => <span key={c + i} className={cn('size-3.5 rounded border border-background', i > 0 && '-ml-1')} style={{ background: c }} />)}
      </span>
      {r.palette.source === 'logo' ? 'Colours from your logo' : 'Neutral studio colours'}
    </span>
  )
}

/** The newest revision's gallery: the first picture large, the rest beside it; a phone shows the first and a count. */
export function RevisionCard({ repo, r, onOpen, compact }: { repo: string; r: RevisionRenders; onOpen: (i: number) => void; compact?: boolean }) {
  const zip = useZip(repo, r)
  const n = r.pictures.length
  const zipLabel = zip.step ? `Fetching ${Math.min(zip.step[0] + 1, zip.step[1])} of ${zip.step[1]}` : 'Download all (.zip)'
  if (compact) {
    return (
      <article className="flex flex-wrap items-center gap-3 rounded-xl border p-4">
        <h3 className="text-[15px] font-semibold">Rev {r.revision}</h3>
        <span className="text-sm text-muted-foreground">Cut {dayWords(r.date)}</span>
        <span className="flex gap-1">
          {r.pictures.slice(0, 4).map((p, i) => (
            <button key={p.name} type="button" onClick={() => onOpen(i)} aria-label={`Open ${p.label}`} className="overflow-hidden rounded border">
              <Picture repo={repo} r={r} p={p} className="h-9 w-14" alt="" />
            </button>
          ))}
        </span>
        <button type="button" className="text-sm font-medium underline-offset-4 hover:underline" onClick={() => onOpen(0)}>{n} {n === 1 ? 'render' : 'renders'}</button>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={zip.run} disabled={!!zip.step}>
          {zip.step ? <Loader2 className="animate-spin" /> : <Download />}<span className="max-sm:sr-only">{zipLabel}</span>
        </Button>
      </article>
    )
  }
  const [first, ...rest] = r.pictures
  return (
    <article className="rounded-xl border p-4 shadow-xs md:p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold">Rev {r.revision}</h3>
        {r.commit && <span className="font-mono text-xs text-muted-foreground">{r.commit.slice(0, 7)}</span>}
        <span className="text-sm text-muted-foreground">Cut {dayWords(r.date)}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-sm text-muted-foreground">{n} {n === 1 ? 'picture' : 'pictures'}{r.at ? ` · made ${ago(r.at)}` : ''}</span>
        <Swatches r={r} />
        <span className="flex gap-2 max-md:w-full md:ml-auto">
          <Button variant="outline" className="max-md:flex-1" onClick={() => onOpen(0)}><Images /> {`See all ${n}`}</Button>
          <Button className="max-md:flex-1" onClick={zip.run} disabled={!!zip.step}>{zip.step ? <Loader2 className="animate-spin" /> : <Download />} {zipLabel}</Button>
        </span>
      </div>
      {first && (
        <div className="mt-4 grid gap-2.5 md:grid-cols-3">
          <button type="button" onClick={() => onOpen(0)} className="group relative overflow-hidden rounded-lg border md:col-span-2 md:row-span-2" aria-label={`Open ${first.label}`}>
            <Picture repo={repo} r={r} p={first} className="h-52 w-full md:h-[380px]" />
            <span className="absolute bottom-2.5 left-2.5 rounded-md bg-background/90 px-2 py-1 text-xs font-medium">{first.label}</span>
            <span className="absolute right-2.5 bottom-2.5 rounded-md bg-foreground/75 px-2 py-1 text-xs font-medium text-background md:hidden">1 of {n}</span>
          </button>
          {rest.map((p, i) => (
            <button key={p.name} type="button" onClick={() => onOpen(i + 1)} className={cn('relative overflow-hidden rounded-lg border max-md:hidden', i < 2 ? 'h-[185px]' : 'h-[150px]')} aria-label={`Open ${p.label}`}>
              <Picture repo={repo} r={r} p={p} className="h-full w-full" />
              <span className="absolute bottom-2 left-2 rounded-md bg-background/90 px-1.5 py-0.5 text-xs font-medium">{p.label}</span>
            </button>
          ))}
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Named <span className="font-mono">{zipName(r).replace(/_renders\.zip$/, '_<shot>.png')}</span>
        {r.commit ? ` · made from ${r.commit.slice(0, 7)}${r.case ? ' and the case built from it' : ''}` : ''}
      </p>
    </article>
  )
}

/** A revision whose renders are still being made: what the rendering agent is doing, and its log. */
export function MakingCard({ m, onLog }: { m: MakingRenders; onLog: () => void }) {
  const queued = m.state === 'queued'
  return (
    <article className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-blue-950 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
      <div className="flex items-center gap-2">
        <Loader2 className={cn('size-4 text-blue-700 dark:text-blue-300', !queued && 'animate-spin')} aria-hidden="true" />
        <h3 className="text-sm font-semibold">Rev {m.revision} · {queued ? 'renders waiting to start' : 'making renders'}</h3>
      </div>
      <p className="mt-1.5 text-sm">
        {m.step ?? (queued ? 'The rendering agent starts when the queue has room.' : 'Rendering the board, then the case.')}
        {m.since ? ` Started ${ago(m.since)}.` : ''}
      </p>
      {!queued && <div aria-hidden="true" className="mt-3 h-1.5 overflow-hidden rounded-full bg-blue-200 dark:bg-blue-900"><div className="h-full w-1/3 animate-pulse rounded-full bg-blue-600 dark:bg-blue-400" /></div>}
      <div className="mt-2 flex flex-wrap items-center gap-x-4">
        <button type="button" onClick={onLog} className="py-1.5 text-sm font-medium text-blue-800 underline-offset-4 hover:underline dark:text-blue-200">Show the log</button>
        <span className="text-xs">You'll get a notification when they're ready.</span>
      </div>
    </article>
  )
}

/** The viewer: one picture large, the others below; arrows step through them. Full screen and dark on a phone. */
export function RendersViewer({ repo, r, index, onIndex, onClose }: { repo: string; r: RevisionRenders | null; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const n = r?.pictures.length ?? 0
  const p = r?.pictures[index]
  const zip = useZip(repo, r ?? ({ pictures: [] } as unknown as RevisionRenders))
  const [saving, setSaving] = useState(false)
  const step = (d: number) => n && onIndex((index + d + n) % n)
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
  }
  const one = () => {
    if (!r || !p || saving) return
    setSaving(true)
    downloadPicture(repo, r, p).catch((e: unknown) => toast.error('The picture could not be downloaded.', { description: e instanceof Error ? e.message : String(e) })).finally(() => setSaving(false))
  }
  return (
    <Dialog open={!!r} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent
        showCloseButton={false}
        onKeyDown={keys}
        className="flex h-[100dvh] max-h-none w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 bg-neutral-950 p-0 text-neutral-50 sm:max-w-none md:h-[min(800px,calc(100dvh-4rem))] md:w-[min(1240px,calc(100vw-4rem))] md:flex-row md:rounded-xl md:border md:bg-background md:text-foreground"
      >
        {r && p && (
          <>
            <div className="flex min-h-0 flex-1 flex-col md:bg-muted">
              <div className="flex items-start gap-2 px-4 pt-3 pb-2 md:hidden">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-neutral-400">Rev {r.revision} · {index + 1} of {n}</p>
                  <p className="text-base font-semibold">{p.label}</p>
                </div>
                <Button variant="ghost" size="icon" className="size-11 text-neutral-50 hover:bg-neutral-800" onClick={onClose} aria-label="Close"><X /></Button>
              </div>
              <div className="relative flex min-h-0 flex-1 items-center justify-center p-2 md:p-5">
                <Picture repo={repo} r={r} p={p} className="max-h-full w-full rounded-lg object-contain md:w-auto md:max-w-full md:shadow-sm" />
                <Button variant="outline" size="icon" className="absolute top-1/2 left-3 size-11 -translate-y-1/2 rounded-full max-md:hidden" onClick={() => step(-1)} aria-label="Previous picture"><ChevronLeft /></Button>
                <Button variant="outline" size="icon" className="absolute top-1/2 right-3 size-11 -translate-y-1/2 rounded-full max-md:hidden" onClick={() => step(1)} aria-label="Next picture"><ChevronRight /></Button>
                <button type="button" className="absolute inset-y-0 left-0 w-2/5 md:hidden" onClick={() => step(-1)} aria-label="Previous picture" />
                <button type="button" className="absolute inset-y-0 right-0 w-2/5 md:hidden" onClick={() => step(1)} aria-label="Next picture" />
              </div>
              <div className="flex gap-1.5 overflow-x-auto px-4 pb-3 md:justify-center md:gap-2 md:pb-4">
                {r.pictures.map((q, i) => (
                  <button key={q.name} type="button" onClick={() => onIndex(i)} aria-label={q.label} aria-current={i === index}
                    className={cn('shrink-0 overflow-hidden rounded-md border-2', i === index ? 'border-neutral-50 md:border-foreground' : 'border-transparent')}>
                    <Picture repo={repo} r={r} p={q} className="h-9 w-14 md:h-16 md:w-[104px]" alt="" />
                  </button>
                ))}
              </div>
              <p className="px-4 pb-2 font-mono text-xs break-all text-neutral-400 md:hidden">{p.name}</p>
              <div className="flex gap-2 px-4 pb-5 md:hidden">
                <Button className="flex-1 bg-neutral-50 text-neutral-950 hover:bg-neutral-200" onClick={one} disabled={saving}>{saving ? <Loader2 className="animate-spin" /> : <Download />} Download</Button>
                <Button variant="outline" className="flex-1 border-neutral-700 bg-transparent text-neutral-50 hover:bg-neutral-800" onClick={zip.run} disabled={!!zip.step}>{zip.step ? `${zip.step[0]} of ${zip.step[1]}` : 'All (.zip)'}</Button>
              </div>
            </div>
            <aside className="flex w-80 shrink-0 flex-col gap-5 border-l p-5 max-md:hidden">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground">Rev {r.revision} renders · {index + 1} of {n}</p>
                  <DialogTitle className="mt-1 text-xl">{p.label}</DialogTitle>
                  <DialogDescription className="sr-only">Rev {r.revision}'s renders. Use the arrow keys to move between pictures.</DialogDescription>
                </div>
                <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X /></Button>
              </div>
              <div className="flex flex-col gap-2">
                <Button onClick={one} disabled={saving}>{saving ? <Loader2 className="animate-spin" /> : <Download />} Download this picture</Button>
                <Button variant="outline" onClick={zip.run} disabled={!!zip.step}>{zip.step ? `Fetching ${Math.min(zip.step[0] + 1, zip.step[1])} of ${zip.step[1]}` : `Download all ${n} (.zip)`}</Button>
              </div>
              <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-sm">
                <dt className="text-muted-foreground">File</dt><dd className="font-mono text-xs break-all">{p.name}</dd>
                <dt className="text-muted-foreground">Revision</dt><dd>{r.revision}, cut {dayWords(r.date)}</dd>
                {r.commit && <><dt className="text-muted-foreground">Made from</dt><dd>board <span className="font-mono text-xs">{r.commit.slice(0, 7)}</span>{r.case ? ` and its case (${LOOK[r.case] ?? r.case})` : ''}</dd></>}
                {p.width && p.height && <><dt className="text-muted-foreground">Size</dt><dd>{p.width} × {p.height}</dd></>}
              </dl>
              <div>
                <p className="text-sm font-semibold">Colours</p>
                <div className="mt-2 flex gap-3">
                  {([['Base', r.palette.base], ['Accent', r.palette.accent], ['Neutral', r.palette.neutral]] as const).map(([l, c]) => (
                    <span key={l} className="flex flex-col items-center gap-1 text-[11px] text-muted-foreground"><span aria-hidden="true" className="h-7 w-10 rounded-md border" style={{ background: c }} />{l}</span>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{r.palette.source === 'logo' ? 'Taken from your project logo.' : 'trace\'s neutral studio colours: the project has no logo.'}</p>
              </div>
              <p className="mt-auto text-xs text-muted-foreground">Renders show what the design looks like. They are not evidence that it works.</p>
            </aside>
            <DialogTitle className="sr-only md:hidden">{p.label}</DialogTitle>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
