/**
 * New project's "Design files" step (docs/fab-import.md): the design's source files (schematics, layouts, net lists) as
 * one zip, and the optional fabrication files, the Gerbers, the bill of materials and the pick and place, each
 * uploaded in parts as it is given (projects.import_upload), and the project overview with the six topics it
 * should cover. trace checks them as soon as they change (projects.import_check, useFabCheck): a summary of the board
 * and its parts first, the problems and warnings below it, and what trace read on request. It ends with where the
 * project starts, with trace's recommendation and the gates that will be signed on the import's evidence.
 */
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, CircleAlert, CircleCheck, FileArchive, FileSpreadsheet, FileText, FolderTree, Info, Lightbulb, Loader2, TriangleAlert, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { toBase64 } from '@/components/project/handin'
import { call } from '@/lib/api'
import { q } from '@/lib/queries'
import type { FabDraft, NewProjectDraft } from '@/lib/types-s1'
import { cn } from '@/lib/utils'
import { blankFab, boardWords, countWords, ENTRY_WORDS, FAB_FILES, type FabCheck, type FabFile, fileRefusal, guessFile, MAX_OVERVIEW, mb, MIN_OVERVIEW, partsOf, partsWords, signedBefore, sourceWords } from './fab-import'

/** The inspection of the draft's files and overview, asked again once typing pauses or a file arrives. */
export function useFabCheck(d: NewProjectDraft, enabled: boolean) {
  const fab = d.fab
  const overview = useSettledValue(fab?.overview ?? '', 700)
  const files = JSON.stringify(fab?.files ?? {})
  return useQuery({
    ...q('projects.import_check', { upload: fab?.upload ?? '', overview, quantity: d.build.quantity, built: fab?.built ?? false }),
    // the files are in the key too: a file given again is checked again
    queryKey: ['projects.import_check', fab?.upload, overview, d.build.quantity, fab?.built, files],
    enabled: enabled && !!fab && (Object.keys(fab.files).length > 0 || overview.trim().length > 0),
    staleTime: 60_000, retry: false, placeholderData: (prev) => prev,
  })
}

function useSettledValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

type Sending = { sent: number; parts: number } | { error: string }

export function FabFilesStep({ d, set, check, checking }: { d: NewProjectDraft; set: (p: Partial<NewProjectDraft>) => void; check: FabCheck | undefined; checking: boolean }) {
  const fab = d.fab ?? blankFab()
  // the draft is written as the step is opened, so its upload id is kept
  useEffect(() => { if (!d.fab) set({ fab }) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const setFab = (p: Partial<FabDraft>) => set({ fab: { ...fab, ...p } })
  const [sending, setSending] = useState<Partial<Record<FabFile, Sending>>>({})
  const latest = useRef(fab)
  latest.current = fab

  const give = async (file: FabFile, f: File) => {
    const why = fileRefusal(file, f.name, f.size)
    if (why) return setSending((s) => ({ ...s, [file]: { error: `${f.name}: ${why}` } }))
    const bytes = new Uint8Array(await f.arrayBuffer())
    const parts = partsOf(bytes)
    const at = String(Date.now())
    try {
      for (let i = 0; i < parts.length; i++) {
        setSending((s) => ({ ...s, [file]: { sent: i, parts: parts.length } }))
        await call('projects.import_upload', { upload: latest.current.upload, file, give: at, part: i, parts: parts.length, base64: toBase64(parts[i]!) })
      }
      setSending((s) => { const { [file]: _, ...rest } = s; return rest })
      set({ fab: { ...latest.current, files: { ...latest.current.files, [file]: { name: f.name, bytes: f.size } } } })
    } catch (e) {
      setSending((s) => ({ ...s, [file]: { error: `${f.name} did not upload: ${e instanceof Error ? e.message : String(e)}. Give it again.` } }))
    }
  }
  // several files dropped on any box go where their names say
  const drop = (into: FabFile, list: FileList) => {
    const fs = [...list]
    if (fs.length === 1) return void give(into, fs[0]!)
    for (const f of fs) { const k = guessFile(f.name); if (k) void give(k, f) }
  }
  const loadOverview = async (f: File) => setFab({ overview: (await f.text()).slice(0, MAX_OVERVIEW) })

  const fresh = check && check.upload === fab.upload ? check : undefined
  const hasDesign = !!(fab.files.source || fab.files.gerbers)
  const topics = fresh?.overview.topics

  return (
    <div className="max-w-[820px] space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">The design files</h1>
        <p className="mt-1 text-sm text-muted-foreground">Give trace the project's files (schematics, layouts, net lists) and tell it about the project. The Gerbers, bill of materials and pick and place are optional: trace builds what you leave out. trace checks the files before anything is created, then keeps them in the project's repository.</p>
      </div>

      <section aria-labelledby="fab-files-h" className="space-y-3">
        <h2 id="fab-files-h" className="text-sm font-medium">Files <span className="font-normal text-muted-foreground">· drop several on any box, or choose each</span></h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {FAB_FILES.map((x) => <FileBox key={x.id} file={x} given={fab.files[x.id]} sending={sending[x.id]} findings={fresh?.findings.filter((f) => f.file === x.id && f.severity === 'blocking').length ?? 0} onDrop={(l) => drop(x.id, l)} />)}
        </div>
      </section>

      <section aria-labelledby="fab-overview-h" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="fab-overview-h" className="text-sm font-medium">Project overview</h2>
            <p className="text-xs text-muted-foreground">trace's intent starts from it, and its agents draft the requirements from it. Cover what the board does, where it is used, power, interfaces, size and quantity.</p>
          </div>
          <OverviewLoad onFile={(f) => void loadOverview(f)} />
        </div>
        <div className="grid gap-4 md:grid-cols-[1fr_240px]">
          <div className="space-y-1.5">
            <Label htmlFor="fab-overview" className="sr-only">Project overview</Label>
            <Textarea id="fab-overview" rows={12} value={fab.overview} maxLength={MAX_OVERVIEW} onChange={(e) => setFab({ overview: e.target.value })}
              placeholder="The carrier hosts a Raspberry Pi CM5 and eight plug-in modules for a flight simulator cockpit. It runs from 12 to 24 V through a 30 A fuse…" />
            <p className={cn('text-xs', fab.overview.trim().length >= MIN_OVERVIEW ? 'text-muted-foreground' : 'text-warning-foreground')}>
              {fab.overview.trim().length.toLocaleString('en')} characters{fab.overview.trim().length < MIN_OVERVIEW ? `: at least ${MIN_OVERVIEW}` : ''}
            </p>
          </div>
          <ul className="space-y-2 rounded-xl border p-3 text-sm" aria-label="What the overview covers">
            {(topics ?? TOPIC_TITLES.map((t) => ({ id: t, title: t, found: false, ask: '' }))).map((t) => (
              <li key={t.id} className="flex items-start gap-2">
                {t.found ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-verified" aria-label="Covered" /> : <span className="mt-1 size-3 shrink-0 rounded-full border-2 border-muted-foreground/40" aria-label="Not yet" />}
                <span><span className={cn(t.found ? '' : 'text-muted-foreground')}>{t.title}</span>{!t.found && t.ask && <span className="block text-xs text-muted-foreground">{t.ask}</span>}</span>
              </li>
            ))}
            <li className="border-t pt-2 text-xs text-muted-foreground">{topics ? `${fresh!.overview.found} of 6 covered; 4 needed, all 6 recommended.` : 'trace looks as you type.'}</li>
          </ul>
        </div>
      </section>

      <div className="flex items-center gap-3 rounded-xl border p-4">
        <span className="flex-1"><span className="block text-sm font-medium">The boards are already built</span><span className="text-xs text-muted-foreground">The project then starts at Bring up, and their bench results are its first evidence.</span></span>
        <Switch checked={fab.built} onCheckedChange={(v) => setFab({ built: v })} aria-label="The boards are already built" />
      </div>

      <CheckResult fresh={fresh} checking={checking} hasDesign={hasDesign} built={fab.built} />
    </div>
  )
}

const TOPIC_TITLES = ['What it does', 'Where it is used', 'Power', 'Interfaces', 'Size and mounting', 'Quantity and cost']
const ICONS: Record<FabFile, typeof FileArchive> = { source: FolderTree, gerbers: FileArchive, bom: FileSpreadsheet, cpl: FileSpreadsheet }

function FileBox({ file, given, sending, findings, onDrop }: { file: (typeof FAB_FILES)[number]; given: { name: string; bytes: number } | undefined; sending: Sending | undefined; findings: number; onDrop: (l: FileList) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const Icon = ICONS[file.id]
  const busy = sending && 'sent' in sending
  const error = sending && 'error' in sending ? sending.error : null
  return (
    <div
      role="button" tabIndex={0} aria-label={`${file.title}: ${given ? `${given.name}, choose another` : 'drop or choose a file'}`}
      onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click() } }}
      onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onDrop(e.dataTransfer.files) }}
      className={cn('flex min-h-[148px] cursor-pointer flex-col gap-2 rounded-xl border-2 p-4 text-sm transition-colors',
        over ? 'border-primary bg-primary/5' : given && !findings ? 'border-solid border-verified/40 bg-verified/5' : given ? 'border-solid border-destructive/40' : 'border-dashed hover:bg-accent/40')}
    >
      <span className="flex items-center gap-2 font-medium"><Icon className="size-4 text-muted-foreground" aria-hidden />{file.title}{file.optional && <span className="text-xs font-normal text-muted-foreground">optional</span>}</span>
      {busy ? (
        <span className="mt-auto space-y-1.5"><Progress value={((sending.sent + 0.5) / sending.parts) * 100} aria-label={`Uploading ${file.title}`} /><span className="block text-xs text-muted-foreground">Uploading{sending.parts > 1 ? `, part ${sending.sent + 1} of ${sending.parts}` : ''}…</span></span>
      ) : given ? (
        <span className="mt-auto min-w-0">
          <span className="flex items-center gap-1.5">{findings ? <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden /> : <CircleCheck className="size-4 shrink-0 text-verified" aria-hidden />}<span className="truncate font-mono text-[13px]" title={given.name}>{given.name}</span></span>
          <span className="block text-xs text-muted-foreground">{mb(given.bytes)} · {findings ? `${findings} to fix, below` : 'choose to replace'}</span>
        </span>
      ) : (
        <span className="mt-auto space-y-1"><span className="block text-xs text-muted-foreground">{file.detail}</span><span className="flex items-center gap-1 text-xs text-primary"><Upload className="size-3.5" aria-hidden />Drop or choose {file.accept}</span></span>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
      <input ref={input} type="file" hidden accept={file.accept} multiple data-testid={`fab-${file.id}`} onClick={(e) => e.stopPropagation()} onChange={(e) => { if (e.target.files?.length) onDrop(e.target.files); e.target.value = '' }} />
    </div>
  )
}

function OverviewLoad({ onFile }: { onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => input.current?.click()}><FileText /> Load from a file</Button>
      <input ref={input} type="file" hidden accept=".md,.txt,.markdown" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />
    </>
  )
}

const SEVERITY = {
  blocking: { icon: CircleAlert, tone: 'text-destructive', title: 'To fix before the project can start' },
  warning: { icon: TriangleAlert, tone: 'text-warning-foreground', title: 'Warnings, carried into the project' },
  note: { icon: Info, tone: 'text-muted-foreground', title: 'Notes' },
} as const

function CheckResult({ fresh, checking, hasDesign, built }: { fresh: FabCheck | undefined; checking: boolean; hasDesign: boolean; built: boolean }) {
  if (!hasDesign && !fresh) return <p className="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">trace checks the files as soon as the design files (or the Gerbers) are given.</p>
  if (!fresh) return <p className="flex items-center gap-2 rounded-xl border px-4 py-3 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Checking the files…</p>
  const s = fresh.summary
  const entry = built ? 'bringup' : fresh.recommended.entry
  return (
    <section aria-labelledby="fab-check-h" className="space-y-4">
      <div className="rounded-xl border">
        <div className="flex flex-wrap items-start gap-3 p-4">
          <div className="min-w-0 flex-1">
            <h2 id="fab-check-h" className="flex items-center gap-2 font-medium">
              What trace found {checking && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Checking again" />}
            </h2>
            {s.source.files > 0 && <p className="mt-1 text-sm">{sourceWords(s)}, in {s.source.files} design files.</p>}
            {s.board.layers > 0 && <p className="mt-1 text-sm">{boardWords(s)}.</p>}
            {s.bom.lines > 0 && <p className="text-sm">{partsWords(s)}.</p>}
            {(s.tool || s.project.name) && <p className="mt-1 text-xs text-muted-foreground">{[s.tool ? `Made in ${s.tool}` : null, s.project.name ? `project ${s.project.name}${s.project.revision ? `, revision ${s.project.revision}` : ''}` : null].filter(Boolean).join(' · ')}</p>}
          </div>
          <span className={cn('rounded-md px-2 py-1 text-xs font-medium', !fresh.ok ? 'bg-destructive/10 text-destructive' : fresh.findings.some((f) => f.severity === 'warning') ? 'bg-warning/15 text-warning-foreground' : 'bg-verified/10 text-verified')}>{countWords(fresh)}</span>
        </div>
        {fresh.findings.length > 0 && (
          <div className="space-y-4 border-t p-4">
            {(['blocking', 'warning', 'note'] as const).map((sev) => {
              const list = fresh.findings.filter((f) => f.severity === sev)
              if (!list.length) return null
              const S = SEVERITY[sev]
              return (
                <div key={sev}>
                  <p className={cn('text-xs font-medium uppercase tracking-wide', S.tone)}>{S.title}</p>
                  <ul className="mt-2 space-y-2.5">
                    {list.map((f) => (
                      <li key={f.id} className="flex items-start gap-2 text-sm">
                        <S.icon className={cn('mt-0.5 size-4 shrink-0', S.tone)} aria-hidden />
                        <span><span className="block">{f.text}</span><span className="block text-xs text-muted-foreground">{f.fix}</span></span>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        )}
        {(fresh.layers.length > 0 || fresh.source_files.length > 0) && (
          <Collapsible className="border-t">
            <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium"><ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" /> What trace read <span className="font-normal text-muted-foreground">· {fresh.source_files.length + fresh.layers.length} files{fresh.order_options.length ? ', the order options' : ''}</span></CollapsibleTrigger>
            <CollapsibleContent className="grid gap-4 border-t px-4 py-4 text-sm md:grid-cols-2">
              {fresh.source_files.length > 0 && (
                <table className="w-full text-left text-xs">
                  <caption className="mb-1 text-left text-xs font-medium text-muted-foreground">In the design files zip</caption>
                  <tbody>{fresh.source_files.map((f) => <tr key={f.path} className="border-b last:border-0"><td className="py-1 pr-2 font-mono">{f.path}</td><td className="py-1 text-muted-foreground">{SOURCE_KIND[f.kind] ?? f.kind}</td></tr>)}</tbody>
                </table>
              )}
              {fresh.layers.length > 0 && (
                <table className="w-full text-left text-xs">
                  <caption className="mb-1 text-left text-xs font-medium text-muted-foreground">In the Gerber zip</caption>
                  <tbody>{fresh.layers.map((l) => <tr key={l.name} className="border-b last:border-0"><td className="py-1 pr-2 font-mono">{l.name}</td><td className="py-1 text-muted-foreground">{layerWords(l)}</td></tr>)}</tbody>
                </table>
              )}
              {fresh.order_options.length > 0 && (
                <table className="w-full text-left text-xs">
                  <caption className="mb-1 text-left text-xs font-medium text-muted-foreground">For JLCPCB's order page</caption>
                  <tbody>{fresh.order_options.map((o) => <tr key={o.option} className="border-b last:border-0"><td className="py-1 pr-2">{o.option}</td><td className="py-1">{o.value}{!o.decided && <span className="block text-muted-foreground">JLCPCB's default</span>}</td></tr>)}</tbody>
                </table>
              )}
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>

      <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm">
        <p className="flex items-center gap-2 font-medium"><Lightbulb className="size-4" aria-hidden /> The project starts at {ENTRY_WORDS[entry].title}</p>
        <p className="mt-1">{built ? ENTRY_WORDS.bringup.detail : fresh.recommended.why}</p>
        <p className="mt-2 text-xs text-muted-foreground">The design was made outside trace, so these stages' gates are signed on these files and the overview, once, by you, when you press Create: {signedBefore(entry).join(', ')}. The decisions log says so.</p>
      </div>
    </section>
  )
}

const SOURCE_KIND: Record<string, string> = { schematic: 'schematic', layout: 'board layout', netlist: 'net list', project: 'project file', library: 'library', other: 'kept, not read' }

function layerWords(l: FabCheck['layers'][number]): string {
  const side = l.side === 'top' ? 'top ' : l.side === 'bottom' ? 'bottom ' : l.side === 'inner' ? 'inner ' : ''
  const kind = { copper: 'copper', mask: 'solder mask', silkscreen: 'silkscreen', paste: 'paste', outline: 'outline', drill: 'drill file', 'drill-map': 'drill map', job: 'job file', other: 'not a layer' }[l.kind] ?? l.kind
  return `${side}${kind}${l.kind === 'copper' && l.layer ? `, layer ${l.layer}` : ''}`
}
