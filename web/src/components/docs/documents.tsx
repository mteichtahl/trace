/**
 * The Documents tab's pieces (docs/scribe.md "Publishing"): a card per project document with how current it is and
 * why, its sections written, its newest print and its text; each revision's release copies; and the line saying when
 * trace next checks them. The PDFs open in the file viewer (FileSheet: a printed copy is read by its hash through
 * documents.pdf); the text opens as the repository's markdown.
 */
import { BookOpenText, CalendarClock, Download, FileText, Loader2, Package } from 'lucide-react'
import { toast } from 'sonner'
import { type FileRef, downloadFile } from '@/components/files/data'
import { dayWords } from '@/components/renders/gallery'
import { type Status, StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { ago, eng } from '@/lib/format'
import type { DocState, DocumentsView, Printed, ProjectDocument, ReleaseCopies } from '@/lib/types-docs'
import { cn } from '@/lib/utils'

/** What each source of a section is called in a sentence ("Changed since: the schematic and the board"). */
const RECORD: Readonly<Record<string, string>> = {
  intent: 'the intent', requirements: 'the requirements', decisions: 'the decisions', architecture: 'the architecture',
  parts: 'the parts', schematic: 'the schematic', 'pin-plan': 'the pin plan', board: 'the board', enclosure: 'the case',
  firmware: 'the firmware', 'protocol-specs': 'the protocol specs', 'protocol-runs': 'the protocol runs', power: 'the power budget',
  thermal: 'the thermal results', load: 'the load results', tests: 'the tests', fabrication: 'the fabrication files', journey: 'the journey',
}
const and = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

const STATE: Readonly<Record<DocState, { status: Status; label: string }>> = {
  current: { status: 'verified', label: 'Current' },
  behind: { status: 'warning', label: 'Behind' },
  missing: { status: 'not_met', label: 'Not written' },
  later: { status: 'idle', label: 'Not yet' },
  unknown: { status: 'waiting', label: 'Not compared' },
}

/** A printed copy as a file the viewer opens: named <project>_<document>_<rev or commit>.pdf. */
export function printedFile(repo: string, title: string, p: Printed, o: { revision?: string | null } = {}): FileRef {
  const project = repo.split('/')[1] ?? repo
  const doc = title.toLowerCase().replace(/\s+/g, '-')
  const tag = o.revision ? `rev-${o.revision}` : (p.commit ?? 'draft').slice(0, 7)
  return { repo, path: `${project}_${doc}_${tag}.pdf`, kind: 'pdf', size: p.bytes, printed: { sha256: p.sha256 }, ...(o.revision ? { revision: `Rev ${o.revision}` } : {}), ...(p.commit ? { commit: p.commit } : {}) }
}

/** The stage's name, from the journey's stages; the id as a word when it has none. */
export type StageName = (id: string) => string

/** Why a document is behind, in a sentence; null when it is not. */
export function behindWhy(d: ProjectDocument, stage: StageName): string | null {
  if (d.state !== 'behind') return null
  const parts: string[] = []
  if (d.behind.length) parts.push(`${and(d.behind.map((r) => RECORD[r] ?? r))} changed since it was written`)
  const overdue = d.sections.filter((s) => s.overdue)
  if (overdue.length) {
    const by = [...new Set(overdue.map((s) => stage(s.due)))]
    parts.push(`${overdue.length === 1 ? `${overdue[0]!.title} is` : `${overdue.length} sections are`} still to write for ${and(by)}`)
  }
  const s = parts.join('; ')
  return s ? `${s[0]!.toUpperCase()}${s.slice(1)}.` : null
}

function Progress({ d }: { d: ProjectDocument }) {
  const written = d.sections.filter((s) => s.written).length
  const n = d.sections.length
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span>{written} of {n} sections written</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={written} aria-valuemin={0} aria-valuemax={n} aria-label={`${d.title}: ${written} of ${n} sections written`}>
        <div className={cn('h-full rounded-full', d.state === 'current' ? 'bg-verified' : 'bg-primary')} style={{ width: `${n ? (written / n) * 100 : 0}%` }} />
      </div>
    </div>
  )
}

/** One document: its state and why, its revision and when it was written, its sections, and its print and text. */
export function DocumentCard({ repo, d, stage, writing, onOpen }: { repo: string; d: ProjectDocument; stage: StageName; writing: boolean; onOpen: (f: FileRef) => void }) {
  const st = STATE[d.state]
  const why = behindWhy(d, stage)
  const text: FileRef = { repo, path: d.file, kind: 'md', ...(d.commit ? { commit: d.commit } : {}) }
  return (
    <article className={cn('flex flex-col rounded-xl border p-4 shadow-xs', !d.exists && 'border-dashed shadow-none')} data-doc={d.kind}>
      <div className="flex items-start gap-3">
        <span className={cn('mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg', d.exists ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground')} aria-hidden>
          <FileText className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[15px] font-semibold">{d.title}</h3>
            <StatusBadge status={writing && d.state !== 'current' && d.due ? 'working' : st.status} label={writing && d.state !== 'current' && d.due ? 'Updating' : d.state === 'later' ? `From ${stage(d.from)}` : st.label} />
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {d.exists
              ? <>Rev {d.revision ?? '–'}{d.updated ? ` · written ${dayWords(d.updated)}` : ''}{d.commit ? <> · <span className="font-mono text-xs">{d.commit.slice(0, 7)}</span></> : null}</>
              : d.kind === 'protocol' && !d.due ? 'Once the design has an interface to describe (I2C, SPI, UART, CAN or a message format).'
              : d.due ? 'The stage needs it: trace starts it at the next change or the nightly check.' : `trace starts it at ${stage(d.from)}.`}
          </p>
        </div>
      </div>
      {why && <p className="mt-3 rounded-md bg-warning/10 px-3 py-2 text-sm">{why}{writing ? ' The Documentation agent is bringing it up to date.' : ''}</p>}
      {d.state === 'unknown' && <p className="mt-3 text-sm text-muted-foreground">trace could not compare the commit it was written at with the default branch. Tonight's check writes it again if anything changed.</p>}
      {d.exists && <Progress d={d} />}
      {d.exists && (
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
          {d.printed ? (
            <Button size="sm" onClick={() => onOpen(printedFile(repo, d.title, d.printed!))}><BookOpenText /> Open the PDF</Button>
          ) : (
            <Button size="sm" disabled title="Not printed yet"><BookOpenText /> Not printed yet</Button>
          )}
          <Button size="sm" variant="outline" onClick={() => onOpen(text)}><FileText /> Read the text</Button>
          {d.printed && (
            <span className="text-xs text-muted-foreground max-sm:w-full">
              {d.printed.current ? `Printed ${ago(d.printed.at)}` : `Printed ${ago(d.printed.at)}, from an earlier text`} · {eng(d.printed.bytes, 'B')}
            </span>
          )}
        </div>
      )}
    </article>
  )
}

/** The Documentation agent at work on the project. */
export function WritingCard({ w, onLog }: { w: NonNullable<DocumentsView['writing']>; onLog: () => void }) {
  const queued = w.state === 'queued'
  return (
    <article className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-blue-950 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
      <div className="flex items-center gap-2">
        <Loader2 className={cn('size-4 text-blue-700 dark:text-blue-300', !queued && 'animate-spin')} aria-hidden />
        <h3 className="text-sm font-semibold">{queued ? 'The documents are waiting to be updated' : 'Updating the documents'}</h3>
      </div>
      <p className="mt-1.5 text-sm">
        {queued ? 'The Documentation agent starts when the queue has room.' : 'The Documentation agent is writing the sections that changed, then checks and prints them.'}
        {w.since ? ` Started ${ago(w.since)}.` : ''} Its change comes to Changes for review.
      </p>
      <button type="button" onClick={onLog} className="mt-1.5 py-1.5 text-sm font-medium text-blue-800 underline-offset-4 hover:underline dark:text-blue-200">Show the log</button>
    </article>
  )
}

/** When trace next checks the documents, in the viewer's own time. */
export function NextCheck({ at, now = Date.now() }: { at: string; now?: number }) {
  const t = new Date(at)
  const today = new Date(now).toDateString() === t.toDateString()
  const day = today ? 'today' : 'tomorrow'
  const clock = t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <CalendarClock className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        trace updates the documents after every change to what they're written from, and checks them every night. Next check{' '}
        <time dateTime={at} className="font-medium text-foreground">{day} at {clock}</time>.
      </span>
    </p>
  )
}

/** A revision's release copies: one per document, kept for good, with the record copied in for the revision. */
export function ReleaseRow({ repo, r, onOpen }: { repo: string; r: ReleaseCopies; onOpen: (f: FileRef) => void }) {
  const save = (p: Printed & { title: string }) =>
    void downloadFile(printedFile(repo, p.title, p, { revision: r.revision })).catch((e: unknown) => toast.error('The PDF could not be downloaded.', { description: e instanceof Error ? e.message : String(e) }))
  return (
    <article className="rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Package className="size-4 text-muted-foreground" aria-hidden />
        <h3 className="text-[15px] font-semibold">Rev {r.revision}</h3>
        {r.cut && <span className="text-sm text-muted-foreground">Cut {ago(r.cut.at)}</span>}
        {r.cut?.commit && <span className="font-mono text-xs text-muted-foreground">record {r.cut.commit.slice(0, 7)}</span>}
      </div>
      <ul className="mt-3 divide-y rounded-lg border">
        {r.documents.map((p) => (
          <li key={p.kind} className="flex items-center gap-2 px-3 py-2">
            <button type="button" className="min-w-0 flex-1 truncate text-left text-sm font-medium underline-offset-4 hover:underline" onClick={() => onOpen(printedFile(repo, p.title, p, { revision: r.revision }))}>
              {p.title}
            </button>
            <span className="text-xs text-muted-foreground max-sm:hidden">{eng(p.bytes, 'B')}</span>
            <Button variant="ghost" size="icon" className="size-8" aria-label={`Download the ${p.title.toLowerCase()} of Rev ${r.revision}`} onClick={() => save(p)}><Download /></Button>
          </li>
        ))}
      </ul>
    </article>
  )
}
