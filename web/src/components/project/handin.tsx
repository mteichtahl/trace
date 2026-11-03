/**
 * Getting and handing in the design's KiCad files (docs/stay-in-trace.md "4. Getting and handing in design files"), on
 * the Design page: a person who finishes trace's draft in KiCad gets the files and hands them back here, without git
 * or GitHub.
 *
 *   Get the design files (.zip)   the KiCad files of the default branch (files.list, the design group and the library
 *                                 tables), each read through files.url, zipped here with fflate and saved
 *   Hand in your edits            a sheet with a drop zone taking KiCad files; each dropped file is compared with the
 *                                 design's own bytes (files.url): "Changed", "New" or "Same as the design", and a file
 *                                 trace will not take says why (not KiCad, too large). "Hand in N files" sends the
 *                                 changed ones (design.handin) and opens the change it made (/p/<id>/changes/<number>)
 *
 * Handing in is for people who can write (a Contributor on the project, or an admin); everyone can get the files. A
 * dropped file is matched to the design by its path inside the zip it came from when that is known (a folder dropped
 * whole), else by its name: the one design file of that name, else beside the design's other KiCad files.
 */
import { useNavigate } from '@tanstack/react-router'
import { strToU8, zipSync } from 'fflate'
import { Download, FileUp, Loader2, Upload, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SideSheet } from '@/components/side-sheet'
import { StatusBadge } from '@/components/status-badge'
import { fetchBytes, type ListedFile } from '@/components/files/data'
import { call, projectId, projectName } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useAction, useProjects } from '@/lib/queries'
import { cn } from '@/lib/utils'

/** What design.handin takes (src/api/actions-handin.ts HANDIN_TYPES and its limits). */
export const HANDIN_TYPES = ['.kicad_sch', '.kicad_pcb', '.kicad_pro', '.kicad_sym', '.kicad_mod', '.kicad_dru', 'fp-lib-table', 'sym-lib-table'] as const
export const MAX_FILES = 20
export const MAX_FILE = 3 * 1024 * 1024
export const MAX_TOTAL = 3.5 * 1024 * 1024

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const folderOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

/** Whether a name or path is a KiCad file trace takes in. Pure. */
export const isKiCad = (path: string): boolean => {
  const n = baseName(path)
  return HANDIN_TYPES.some((t) => (t.startsWith('.') ? n.toLowerCase().endsWith(t) : n === t))
}

/** The design's KiCad files from files.list. Pure. */
export const designFiles = (files: readonly ListedFile[]): ListedFile[] => files.filter((f) => isKiCad(f.path))

/** The zip's name: "<project>-design.zip". Pure. */
export const zipName = (repo: string): string => `${(repo.split('/')[1] ?? 'design').replace(/[^A-Za-z0-9._-]+/g, '-')}-design.zip`

/**
 * Where a dropped file goes in the repository: its relative path when it came in a folder and that path is a design
 * file; else the one design file with its name; else beside the design's KiCad files (the folder most of them are in);
 * else the top folder. Pure.
 */
export function pathFor(name: string, relative: string | undefined, design: readonly string[]): string {
  if (relative) {
    // a folder dropped whole: "soil-sensor/hardware/power.kicad_sch" → match the longest tail that is a design path
    const parts = relative.split('/').filter(Boolean)
    for (let i = 0; i < parts.length; i++) {
      const tail = parts.slice(i).join('/')
      if (design.includes(tail)) return tail
    }
  }
  const same = design.filter((p) => baseName(p) === name)
  if (same.length === 1) return same[0]!
  const counts = new Map<string, number>()
  for (const p of design) counts.set(folderOf(p), (counts.get(folderOf(p)) ?? 0) + 1)
  const folder = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  return folder ? `${folder}/${name}` : name
}

export type Verdict = 'changed' | 'new' | 'same' | 'checking' | 'refused'
export interface Dropped { id: string; name: string; path: string; bytes: Uint8Array; verdict: Verdict; why?: string }

/** The words beside a dropped file. Pure. */
export const VERDICT_WORDS: Record<Verdict, { label: string; status: 'yours' | 'met' | 'idle' | 'waiting' | 'failing' }> = {
  changed: { label: 'Changed', status: 'yours' },
  new: { label: 'New', status: 'yours' },
  same: { label: 'Same as the design', status: 'idle' },
  checking: { label: 'Comparing', status: 'waiting' },
  refused: { label: 'Not taken', status: 'failing' },
}

/** Why a dropped file is not taken, or null. Pure. */
export function refusal(name: string, size: number): string | null {
  if (!isKiCad(name)) return 'Not a KiCad file: only schematics, boards, projects, libraries, design rules and library tables are handed in.'
  if (size > MAX_FILE) return `It is ${(size / (1024 * 1024)).toFixed(1)} MB; a file handed in is at most 3 MB.`
  return null
}

/** What can be handed in now, and why not when it cannot. Pure. */
export function readiness(files: readonly Dropped[]): { send: Dropped[]; blocked: string | null } {
  const send = files.filter((f) => f.verdict === 'changed' || f.verdict === 'new')
  if (files.some((f) => f.verdict === 'checking')) return { send, blocked: 'Comparing with the design…' }
  if (!send.length) return { send, blocked: files.length ? 'Nothing differs from the design.' : 'Drop the KiCad files you changed.' }
  if (send.length > MAX_FILES) return { send, blocked: `At most ${MAX_FILES} files at once.` }
  const total = send.reduce((n, f) => n + f.bytes.length, 0)
  if (total > MAX_TOTAL) return { send, blocked: `These are ${(total / (1024 * 1024)).toFixed(1)} MB together; at most 3.5 MB at once. Hand them in in two parts.` }
  const paths = new Set<string>()
  for (const f of send) {
    if (paths.has(f.path)) return { send, blocked: `${f.path} is there twice: remove one.` }
    paths.add(f.path)
  }
  return { send, blocked: null }
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/** Bytes as base64, in chunks (a 3 MB file is too many arguments for one String.fromCharCode). */
export function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** Whether this person may hand files in: an admin, or a Contributor on the project. */
export function useMayHandIn(repo: string): boolean {
  const { user } = useAuth()
  const projects = useProjects()
  if (user?.class === 'admin') return true
  const p = projects.data?.find((x) => x.repo === repo)
  return (p?.part ?? (p?.role === 'write' ? 'contributor' : 'reviewer')) === 'contributor'
}

/** Save bytes as a file with this name. */
function save(bytes: Uint8Array, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** The two buttons on the Design page, and the hand-in sheet. */
export function DesignFiles({ repo, className }: { repo: string; className?: string }) {
  const may = useMayHandIn(repo)
  const list = useAction('files.list', { repo })
  const design = designFiles(list.data ?? [])
  const [zipping, setZipping] = useState(false)
  const [open, setOpen] = useState(false)

  const getZip = async () => {
    setZipping(true)
    try {
      const entries: Record<string, Uint8Array> = {}
      for (const f of design) entries[f.path] = new Uint8Array(await fetchBytes({ repo, path: f.path }))
      entries['README.txt'] = strToU8(`The KiCad files of ${projectName(repo)}, from trace.\nEdit them in KiCad, then hand the files you changed back in on the Design page.\n`)
      save(zipSync(entries, { level: 6 }), zipName(repo), 'application/zip')
    } catch (e) {
      toast.error(`Could not get the design files: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setZipping(false)
    }
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Button size="sm" variant="outline" disabled={zipping || !design.length} onClick={() => void getZip()} title={design.length ? undefined : 'The project has no KiCad files yet.'}>
        {zipping ? <Loader2 className="animate-spin" /> : <Download />} Get the design files (.zip)
      </Button>
      {may && (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Upload /> Hand in your edits
        </Button>
      )}
      {may && <HandInSheet repo={repo} design={design.map((f) => f.path)} open={open} onOpenChange={setOpen} />}
    </div>
  )
}

/** The hand-in sheet: drop, compare, hand in. */
export function HandInSheet({ repo, design, open, onOpenChange }: { repo: string; design: string[]; open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate()
  const input = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<Dropped[]>([])
  const [note, setNote] = useState('')
  const [over, setOver] = useState(false)
  const [sending, setSending] = useState(false)
  const ready = readiness(files)

  const update = (id: string, o: Partial<Dropped>) => setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, ...o } : f)))

  const compare = async (d: Dropped) => {
    if (!design.includes(d.path)) return update(d.id, { verdict: 'new' })
    try {
      const now = new Uint8Array(await fetchBytes({ repo, path: d.path }))
      update(d.id, { verdict: same(now, d.bytes) ? 'same' : 'changed' })
    } catch {
      // the design's copy could not be read: hand it in, and the API leaves it out if it is the same
      update(d.id, { verdict: 'changed' })
    }
  }

  const add = async (list: FileList | File[]) => {
    const added: Dropped[] = []
    for (const file of Array.from(list)) {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || undefined
      const why = refusal(file.name, file.size)
      const bytes = why ? new Uint8Array() : new Uint8Array(await file.arrayBuffer())
      added.push({ id: `${file.name}-${Math.random().toString(36).slice(2)}`, name: file.name, path: pathFor(file.name, rel, design), bytes, verdict: why ? 'refused' : 'checking', ...(why ? { why } : {}) })
    }
    setFiles((fs) => [...fs, ...added])
    for (const d of added) if (d.verdict === 'checking') void compare(d)
  }

  const reset = () => { setFiles([]); setNote('') }
  const close = (o: boolean) => { if (!o && !sending) reset(); onOpenChange(o) }

  const send = async () => {
    setSending(true)
    try {
      const r = await call('design.handin', { repo, files: ready.send.map((f) => ({ path: f.path, base64: toBase64(f.bytes) })), ...(note.trim() ? { note: note.trim() } : {}) })
      toast(`Handed in ${r.changed.length} file${r.changed.length === 1 ? '' : 's'}${r.same.length ? `; ${r.same.length} were the same as the design` : ''}. trace checks it and applies it once the checks pass.`)
      reset()
      onOpenChange(false)
      if (r.change) void navigate({ to: `/p/${projectId(repo)}/changes/${r.change}` as string })
    } catch (e) {
      toast.error(`Could not hand them in: ${e instanceof Error ? e.message : String(e)}. Your files are kept here.`)
    } finally {
      setSending(false)
    }
  }

  const n = ready.send.length
  return (
    <SideSheet
      open={open}
      onOpenChange={close}
      title="Hand in your edits"
      description="Drop the KiCad files you changed. Each is compared with the design; only the changed ones are handed in, as one change trace checks and applies once its checks pass."
      footer={(
        <>
          <Button variant="outline" onClick={() => close(false)} disabled={sending}>Cancel</Button>
          <Button disabled={!!ready.blocked || sending} onClick={() => void send()} title={ready.blocked ?? undefined}>
            {sending && <Loader2 className="animate-spin" />} {n ? `Hand in ${n} file${n === 1 ? '' : 's'}` : 'Hand in'}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <div
          role="button"
          tabIndex={0}
          aria-label="Drop KiCad files here, or choose them"
          onClick={() => input.current?.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click() } }}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); void add(e.dataTransfer.files) }}
          className={cn('flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center text-sm transition-colors', over ? 'border-primary bg-primary/5' : 'hover:bg-accent/40')}
        >
          <FileUp className="size-6 text-muted-foreground" aria-hidden />
          <span className="font-medium">Drop KiCad files here, or choose them</span>
          <span className="text-xs text-muted-foreground">.kicad_sch, .kicad_pcb, .kicad_pro, libraries and library tables · at most 20 files, 3 MB each</span>
          <input
            ref={input} type="file" multiple hidden data-testid="handin-input"
            accept={HANDIN_TYPES.filter((t) => t.startsWith('.')).join(',')}
            onChange={(e) => { if (e.target.files) void add(e.target.files); e.target.value = '' }}
          />
        </div>

        {files.length > 0 && (
          <ul className="divide-y rounded-xl border" aria-label="Files to hand in">
            {files.map((f) => {
              const w = VERDICT_WORDS[f.verdict]
              return (
                <li key={f.id} className="flex items-start gap-3 px-3 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-[13px]" title={f.path}>{f.path}</p>
                    {f.why && <p className="mt-0.5 text-xs text-muted-foreground">{f.why}</p>}
                  </div>
                  <StatusBadge status={w.status} label={w.label} plain />
                  <button type="button" onClick={() => setFiles((fs) => fs.filter((x) => x.id !== f.id))} className="text-muted-foreground hover:text-foreground" aria-label={`Remove ${f.name}`}>
                    <X className="size-4" aria-hidden />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {ready.blocked && files.length > 0 && <p className="text-xs text-muted-foreground" aria-live="polite">{ready.blocked}</p>}

        <div className="space-y-1.5">
          <Label htmlFor="handin-note">What you changed (optional)</Label>
          <Textarea id="handin-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} placeholder="For example: moved the regulator closer to the connector" />
        </div>
      </div>
    </SideSheet>
  )
}
