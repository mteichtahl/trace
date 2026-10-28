/**
 * Connect a system: a sheet with its name, what it is for, what it may do (Read only, recommended, or Read and
 * change) and the projects it is on with its part on each. A read-only system is always a reviewer: the form will not
 * offer anything else. After services.create the same sheet shows the Keys panel, once.
 */
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { SideSheet } from '@/components/side-sheet'
import { call, projectName } from '@/lib/api'
import { COST_NOTE, type Scope, SCOPE_WORDS, type ShownKeys, nameProblem, partFor, partsFor, scopesFor } from '@/lib/services'
import type { Part } from '@/lib/types'
import { cn } from '@/lib/utils'
import { KeysPanel } from './keys-panel'

export const PART_LINES: Record<Part, { label: string; line: string }> = {
  contributor: { label: 'Contributor', line: 'Can start work and change settings on this project.' },
  reviewer: { label: 'Reviewer', line: 'Reads the project; changes nothing.' },
}

/** What it may do: Read only (recommended, with the reason) or Read and change. */
export function ScopeChoice({ value, onChange, idPrefix = 'scope' }: { value: Scope; onChange: (s: Scope) => void; idPrefix?: string }) {
  return (
    <RadioGroup value={value} onValueChange={(v) => onChange(v as Scope)} className="gap-2" aria-label="What it may do">
      {(['read', 'write'] as const).map((s) => (
        <Label key={s} htmlFor={`${idPrefix}-${s}`} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
          <RadioGroupItem id={`${idPrefix}-${s}`} value={s} className="mt-0.5" />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2 font-medium">
              {SCOPE_WORDS[s].label}
              {s === 'read' && <Badge variant="outline" className="rounded-md border-primary/40 font-normal text-primary">Recommended</Badge>}
            </span>
            <span className="block text-sm text-muted-foreground">{SCOPE_WORDS[s].line}</span>
          </span>
        </Label>
      ))}
    </RadioGroup>
  )
}

export interface ProjectChoice { on: boolean; part: Part }

/** Each project with a checkbox and, when chosen, the part; a read-only system only ever gets Reviewer. */
export function ProjectPicker({ projects, scope, value, onChange }: { projects: string[]; scope: Scope; value: Record<string, ProjectChoice>; onChange: (v: Record<string, ProjectChoice>) => void }) {
  if (!projects.length) return <p className="text-sm text-muted-foreground">There are no projects yet. Put the system on a project once one exists.</p>
  const parts = partsFor(scope)
  return (
    <div className="space-y-2">
      {projects.map((repo) => {
        const c = value[repo] ?? { on: false, part: parts[0]! }
        const part = partFor(scope, c.part)
        const id = `svc-p-${repo.replace(/\W+/g, '-')}`
        return (
          <div key={repo} className={cn('flex min-h-11 flex-wrap items-center gap-3 rounded-lg border p-3', c.on && 'border-primary/60 bg-primary/5')}>
            <Checkbox id={id} checked={c.on} onCheckedChange={(v) => onChange({ ...value, [repo]: { on: !!v, part } })} />
            <Label htmlFor={id} className="min-w-0 flex-1 font-medium">{projectName(repo)}<span className="sr-only"> ({repo})</span></Label>
            {c.on ? (
              parts.length > 1 ? (
                <Select value={part} onValueChange={(v) => onChange({ ...value, [repo]: { on: true, part: v as Part } })}>
                  <SelectTrigger size="sm" className="w-36" aria-label={`Part on ${projectName(repo)}`}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {parts.map((p) => <SelectItem key={p} value={p}>{PART_LINES[p].label}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : (
                <span className="text-sm" data-testid={`part-${repo}`}>Reviewer</span>
              )
            ) : (
              <span className="text-xs text-muted-foreground">Not on it</span>
            )}
          </div>
        )
      })}
      <p className="text-xs text-muted-foreground">
        {scope === 'read'
          ? 'A read-only system is always a reviewer: it reads the project and changes nothing.'
          : `Contributor: ${PART_LINES.contributor.line.toLowerCase()} Reviewer: ${PART_LINES.reviewer.line.toLowerCase()}`}
      </p>
    </div>
  )
}

/** The projects chosen, each with the part the form allows. */
export function chosenProjects(value: Record<string, ProjectChoice>, scope: Scope): { repo: string; part: Part }[] {
  return Object.entries(value).filter(([, c]) => c.on).map(([repo, c]) => ({ repo, part: partFor(scope, c.part) }))
}

/**
 * Hosts the Keys panel in a sheet. Closing the sheet any way but "I've stored it" asks first, because the secret
 * cannot be shown again.
 */
export function KeysSheet({ keys, onDone }: { keys: ShownKeys | null; onDone: () => void }) {
  const [asking, setAsking] = useState(false)
  return (
    <>
      <SideSheet open={!!keys} onOpenChange={(o) => { if (!o) setAsking(true) }} title={keys?.secret_id ? 'New secret' : 'System connected'} description={keys ? `${keys.name} · copy its keys now` : undefined}>
        {keys && <KeysPanel keys={keys} onDone={onDone} />}
      </SideSheet>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Have you stored the secret?</AlertDialogTitle>
            <AlertDialogDescription>Once this closes, the secret can't be shown again. If it is lost, you can make a new one from the system's page.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it open</AlertDialogCancel>
            <AlertDialogAction onClick={onDone}>I've stored it</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function CreateSheet({ open, onOpenChange, projects, taken, onCreated }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  projects: string[]
  taken: string[]
  /** the keys to show, once */
  onCreated: (k: ShownKeys) => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [scope, setScope] = useState<Scope>('read')
  const [chosen, setChosen] = useState<Record<string, ProjectChoice>>({})
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const problem = nameProblem(name, taken)
  const ready = !!name && !problem && description.length <= 500
  const reset = () => { setName(''); setDescription(''); setScope('read'); setChosen({}); setError(null) }

  const create = async () => {
    setSending(true)
    setError(null)
    const scopes = scopesFor(scope)
    const list = chosenProjects(chosen, scope)
    try {
      const r = await call('services.create', { name, scopes, ...(description.trim() ? { description: description.trim() } : {}), ...(list.length ? { projects: list } : {}) })
      await qc.invalidateQueries({ queryKey: ['services.list'] })
      onCreated({ name, scopes, client_id: r.client_id, secret: r.secret, token_url: r.token_url, api_url: r.api_url, mcp_url: r.mcp_url, resource_server: r.resource_server })
      reset()
      onOpenChange(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      toast.error(`Could not connect ${name}: ${msg}`)
    } finally {
      setSending(false)
    }
  }

  return (
    <SideSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Connect a system"
      description="Gives another system or AI agent its own keys. It sees only the projects you put it on."
      footer={
        <div className="flex w-full flex-col gap-2">
          <div className="flex justify-end gap-2 [&>*]:flex-1 md:[&>*]:flex-none">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button disabled={!ready || sending} onClick={() => void create()}>
              {sending && <Loader2 className="animate-spin" />}
              Connect {name && !problem ? name : 'the system'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground md:text-right">{COST_NOTE}</p>
        </div>
      }
    >
      <div className="space-y-6">
        <div className="space-y-1.5">
          <Label htmlFor="svc-name">Name</Label>
          <Input id="svc-name" autoComplete="off" spellCheck={false} placeholder="build-dashboard" value={name} onChange={(e) => setName(e.target.value.trim())} aria-invalid={!!problem} aria-describedby="svc-name-help" className="font-mono" />
          <p id="svc-name-help" className={cn('text-xs', problem ? 'text-destructive' : 'text-muted-foreground')}>
            {problem ?? 'Lower-case letters, digits and dashes. It shows in logs and history as service:name.'}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="svc-desc">What it's for</Label>
          <Textarea id="svc-desc" rows={2} placeholder="The wall screen in the lab: shows each project's stage." value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          <p className="text-xs text-muted-foreground">So other admins know what it is. Optional.</p>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">What it may do</p>
          <ScopeChoice value={scope} onChange={setScope} />
          <p className="text-xs text-muted-foreground">Whatever you choose, it can never sign gates, answer questions, place orders or manage people: those stay with a person.</p>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Projects and its part</p>
          <ProjectPicker projects={projects} scope={scope} value={chosen} onChange={setChosen} />
        </div>
        {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">Could not connect it: {error}. Nothing was created; your choices are kept.</p>}
      </div>
    </SideSheet>
  )
}
