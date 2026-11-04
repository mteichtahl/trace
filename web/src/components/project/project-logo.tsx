/**
 * The project logo (docs/scribe.md "Project logo"; src/api/actions-logo.ts): the picture on the cover and page header
 * of every document trace keeps for the project. Two variants: for light backgrounds, and optionally for dark ones.
 * A chosen file is checked by trace at once (project.logo_check) and shown on a sample cover before anything is saved;
 * Save writes it beside the documents as one change (project.logo_set), which applies once its checks pass. Without a
 * logo, the documents carry the project's icon. Admins change it; everyone else sees it.
 */
import { useNavigate } from '@tanstack/react-router'
import { AlertCircle, ImageUp, Loader2, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ProjectIconView } from '@/components/project/project-icon'
import { toBase64 } from '@/components/project/handin'
import { type LogoCheck, call, projectId } from '@/lib/api'
import { useAction, useCall } from '@/lib/queries'
import type { ProjectIcon } from '@/lib/types-s1'

type Variant = 'light' | 'dark'
interface Chosen { base64: string; url: string; name: string; check: LogoCheck | null; checking: boolean }

const WORDS: Record<Variant, { title: string; hint: string }> = {
  light: { title: 'On light backgrounds', hint: 'Covers and page headers.' },
  dark: { title: 'On dark backgrounds', hint: 'Optional. Without it, the light logo is used.' },
}
const ACCEPT = 'image/svg+xml,image/png,.svg,.png'
const mime = (format: string | null | undefined): string => (format === 'png' ? 'image/png' : 'image/svg+xml')

export function ProjectLogo({ repo, name, icon, admin }: { repo: string; name: string; icon: ProjectIcon; admin: boolean }) {
  const stored = useAction('project.logo', { repo })
  const set = useCall('project.logo_set', (a) => [['project.logo', a.repo]])
  const navigate = useNavigate()
  const [chosen, setChosen] = useState<Partial<Record<Variant, Chosen | null>>>({})

  const shown = (v: Variant): string | null => {
    const c = chosen[v]
    if (c === null) return null
    // a chosen file shows once trace has passed it: until then (or when refused), what is kept now
    if (c?.check?.ok) return c.url
    const s = stored.data?.[v]
    return s ? `data:${mime(s.format)};base64,${s.base64}` : null
  }

  const choose = async (v: Variant, f: File) => {
    const base64 = toBase64(new Uint8Array(await f.arrayBuffer()))
    const url = URL.createObjectURL(f)
    setChosen((x) => ({ ...x, [v]: { base64, url, name: f.name, check: null, checking: true } }))
    try {
      const check = await call('project.logo_check', { repo, base64 })
      setChosen((x) => (x[v]?.base64 === base64 ? { ...x, [v]: { ...x[v]!, check, checking: false } } : x))
    } catch (e) {
      setChosen((x) => (x[v]?.base64 === base64 ? { ...x, [v]: { ...x[v]!, checking: false, check: { ok: false, format: null, width: null, height: null, problems: [e instanceof Error ? e.message : String(e)] } } } : x))
    }
  }

  const changed = (['light', 'dark'] as const).filter((v) => chosen[v] !== undefined)
  const blocked = changed.some((v) => chosen[v] && (chosen[v]!.checking || !chosen[v]!.check?.ok))
  const save = () => {
    const args: { repo: string; light?: { base64: string } | null; dark?: { base64: string } | null } = { repo }
    for (const v of changed) args[v] = chosen[v] ? { base64: chosen[v]!.base64 } : null
    set.mutate(args, {
      onSuccess: (r) => {
        setChosen({})
        toast('Logo saved as a change', {
          description: 'It applies once its checks pass. The printed documents are then made again with it; their text does not change.',
          ...(r.change ? { action: { label: 'Open the change', onClick: () => void navigate({ to: `/p/${projectId(repo)}/changes/${r.change}` as string }) } } : {}),
        })
      },
      onError: (e) => toast.error('The logo was not saved.', { description: e instanceof Error ? e.message : String(e) }),
    })
  }

  return (
    <div className="grid gap-5 rounded-xl border p-5 lg:grid-cols-[1fr_auto]">
      <div className="space-y-4">
        <div>
          <p className="text-sm font-medium">Project logo</p>
          <p className="text-xs text-muted-foreground">On the cover and in the page header of every document trace keeps for this project. SVG is best: it stays sharp at any size. A PNG needs at least 256 pixels on its shorter side.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {(['light', 'dark'] as const).map((v) => (
            <LogoTile key={v} variant={v} url={shown(v)} chosen={chosen[v]} icon={icon} admin={admin} loading={stored.isLoading}
              hasStored={Boolean(stored.data?.[v])}
              onChoose={(f) => void choose(v, f)}
              onRemove={() => setChosen((x) => ({ ...x, [v]: stored.data?.[v] ? null : undefined }))}
              onUndo={() => setChosen((x) => { const { [v]: _, ...rest } = x; return rest })} />
          ))}
        </div>
        {admin && changed.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={save} disabled={blocked || set.isPending}>{set.isPending && <Loader2 className="size-4 animate-spin" />}Save logo</Button>
            <Button variant="ghost" onClick={() => setChosen({})} disabled={set.isPending}>Cancel</Button>
            <p className="text-xs text-muted-foreground">Saved as a change to the project, which applies once its checks pass.</p>
          </div>
        )}
      </div>
      <SampleCover name={name} logo={shown('light')} icon={icon} />
    </div>
  )
}

function LogoTile({ variant, url, chosen, icon, admin, loading, hasStored, onChoose, onRemove, onUndo }: {
  variant: Variant; url: string | null; chosen: Chosen | null | undefined; icon: ProjectIcon; admin: boolean; loading: boolean; hasStored: boolean
  onChoose: (f: File) => void; onRemove: () => void; onUndo: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const dark = variant === 'dark'
  const w = WORDS[variant]
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm">{w.title}</span>
        {chosen !== undefined && <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={onUndo}>Undo</button>}
      </div>
      <div className={`flex h-28 items-center justify-center rounded-lg border ${dark ? 'border-neutral-700 bg-neutral-900' : 'bg-white'}`}>
        {loading ? <Loader2 className="size-5 animate-spin text-muted-foreground" />
          : url ? <img src={url} alt={`Project logo ${w.title.toLowerCase()}`} className="max-h-20 max-w-[85%] object-contain" />
          : dark ? <span className="px-4 text-center text-xs text-neutral-400">{chosen === null ? 'Removed: the light logo will be used' : 'None: the light logo is used'}</span>
          : <span className="flex flex-col items-center gap-1.5 text-xs text-muted-foreground"><ProjectIconView icon={icon} size={36} />{chosen === null ? 'Removed: the project icon will be used' : 'No logo yet: the project icon is used'}</span>}
      </div>
      <p className="text-xs text-muted-foreground">{w.hint}</p>
      {chosen && <CheckLine chosen={chosen} />}
      {admin && (
        <div className="flex gap-2">
          <input ref={input} type="file" accept={ACCEPT} className="hidden" aria-label={`Choose the logo ${w.title.toLowerCase()}`}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onChoose(f); e.target.value = '' }} />
          <Button size="sm" variant="outline" onClick={() => input.current?.click()}><ImageUp className="size-4" />{url ? 'Replace' : 'Choose file'}</Button>
          {(url || (hasStored && chosen !== null)) && <Button size="sm" variant="ghost" onClick={onRemove} aria-label={`Remove the logo ${w.title.toLowerCase()}`}><Trash2 className="size-4" />Remove</Button>}
        </div>
      )}
    </div>
  )
}

function CheckLine({ chosen }: { chosen: Chosen }) {
  if (chosen.checking) return <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />Checking {chosen.name}</p>
  const c = chosen.check
  if (!c) return null
  if (c.ok) return <p className="text-xs text-muted-foreground">{chosen.name}: {c.format?.toUpperCase()}{c.format === 'png' ? `, ${c.width} × ${c.height} pixels` : ''}. Ready to save.</p>
  return (
    <div role="alert" className="flex gap-1.5 text-xs text-destructive">
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
      <div>{c.problems.map((p) => <p key={p}>{p}</p>)}</div>
    </div>
  )
}

/** A first page as the documents will print it: the logo, the project, the document and its revision. */
function SampleCover({ name, logo, icon }: { name: string; logo: string | null; icon: ProjectIcon }) {
  const today = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
  return (
    <figure className="space-y-2">
      <div className="flex aspect-[210/297] w-48 flex-col rounded-md border bg-white p-4 text-neutral-900 shadow-sm" aria-label="Sample cover page">
        <div className="h-9">{logo ? <img src={logo} alt="" className="max-h-9 max-w-[70%] object-contain" /> : <ProjectIconView icon={icon} size={28} />}</div>
        <div className="mt-auto space-y-1">
          <p className="text-[9px] uppercase tracking-wide text-neutral-500">High level design</p>
          <p className="text-sm font-semibold leading-tight">{name}</p>
          <p className="text-[9px] text-neutral-500">Revision A · {today}</p>
        </div>
        <div className="mt-3 border-t pt-1.5 text-[7px] text-neutral-400">Made by trace from the project's records</div>
      </div>
      <figcaption className="text-xs text-muted-foreground">Sample cover</figcaption>
    </figure>
  )
}
