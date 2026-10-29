/** The installer's building blocks, made of the web app's shadcn components so the two look the same. */
import { type ReactNode, useEffect, useId, useState } from 'react'
import { AlertTriangle, Check as CheckIcon, CheckCircle2, ChevronDown, CircleX, Copy, ExternalLink, Eye, EyeOff, Info, Loader2, Wrench } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { Check } from '../answers.js'
import { runFix } from './actions.js'
import { fieldErrors } from './model.js'
import { get, update, useStore } from './store.js'

// ------------------------------------------------------------------ fields and their problems

/** A field's problem, once the person has left it or tried to continue ('' otherwise). */
export function useError(): (key: string) => string {
  const s = useStore()
  const errors = fieldErrors(s)
  return (key: string) => (s.touched.has(key) || s.tried.has(s.step) ? errors.get(key) ?? '' : '')
}
export const touch = (key: string) => (): void => { if (!get().touched.has(key)) update((s) => { s.touched.add(key) }) }

export function Field({ label, hint, error, optional, htmlFor, children, className }: {
  label: ReactNode; hint?: ReactNode; error?: string; optional?: boolean; htmlFor?: string; children: ReactNode; className?: string
}) {
  return (
    <div className={cn('grid min-w-0 gap-1.5', className)}>
      <Label htmlFor={htmlFor} className="gap-1.5">
        {label}
        {optional ? <span className="font-normal text-muted-foreground">(optional)</span> : null}
      </Label>
      {children}
      {error
        ? <p className="flex items-start gap-1.5 text-xs text-destructive" role="alert"><CircleX className="mt-px size-3.5 shrink-0" />{error}</p>
        : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/** A text field bound to the store; its problem shows once the person leaves it. */
export function TextField({ id, label, value, onChange, error, hint, placeholder, type = 'text', optional, secret, mono, inputMode, autoFocus, className }: {
  id: string; label: ReactNode; value: string; onChange: (v: string) => void; error?: string; hint?: ReactNode; placeholder?: string
  type?: 'text' | 'email' | 'number'; optional?: boolean; secret?: boolean; mono?: boolean; inputMode?: 'numeric' | 'decimal' | 'email'; autoFocus?: boolean; className?: string
}) {
  const [shown, setShown] = useState(false)
  const domId = useId()
  return (
    <Field label={label} hint={hint} error={error} optional={optional} htmlFor={domId} className={className}>
      <div className="relative">
        <Input
          id={domId} type={secret && !shown ? 'password' : type === 'number' ? 'text' : type} value={value} placeholder={placeholder}
          inputMode={inputMode ?? (type === 'number' ? 'decimal' : undefined)} autoComplete="off" spellCheck={false} autoFocus={autoFocus}
          aria-invalid={error ? true : undefined} className={cn(mono && 'font-mono', secret && 'pr-10')}
          onChange={(e) => onChange(e.target.value)} onBlur={touch(id)}
        />
        {secret ? (
          <Button type="button" variant="ghost" size="icon-sm" className="absolute top-0.5 right-0.5 text-muted-foreground" onClick={() => setShown((v) => !v)} aria-label={shown ? 'Hide' : 'Show'}>
            {shown ? <EyeOff /> : <Eye />}
          </Button>
        ) : null}
      </div>
    </Field>
  )
}

const DEFAULT = '__default__'
/** A select; '' is a real choice (shown as the default), which Radix's items cannot hold, so it is mapped. */
export function Choice<T extends string>({ label, value, options, onChange, hint, error, className }: {
  label: ReactNode; value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void; hint?: ReactNode; error?: string; className?: string
}) {
  const domId = useId()
  return (
    <Field label={label} hint={hint} error={error} htmlFor={domId} className={className}>
      <Select value={value === '' ? DEFAULT : value} onValueChange={(v) => onChange((v === DEFAULT ? '' : v) as T)}>
        <SelectTrigger id={domId} className="w-full min-w-0" aria-invalid={error ? true : undefined}><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={o.value || DEFAULT} value={o.value || DEFAULT}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  )
}

/** on / off / decided from what the checks found (null) */
export function TriChoice({ label, value, auto, onChange, hint }: { label: string; value: boolean | null; auto: string; onChange: (v: boolean | null) => void; hint?: ReactNode }) {
  return (
    <Choice label={label} hint={hint} value={value === null ? 'auto' : value ? 'on' : 'off'} onChange={(v) => onChange(v === 'auto' ? null : v === 'on')}
      options={[{ value: 'auto', label: `Decide for me (${auto})` }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
  )
}

export function Toggle({ label, description, checked, onChange, disabled }: { label: ReactNode; description?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const domId = useId()
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <div className="grid gap-0.5">
        <Label htmlFor={domId} className="leading-snug">{label}</Label>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <Switch id={domId} checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" />
    </div>
  )
}

// ------------------------------------------------------------------ help, commands, links

/** "How do I get this?": everything needed to answer a field, folded until asked for. */
export function Help({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border bg-muted/40">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium">
        <Info className="size-4 text-primary" />
        <span className="flex-1">{title}</span>
        <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-3 px-3 pb-3 text-sm text-muted-foreground [&_strong]:text-foreground">{children}</CollapsibleContent>
    </Collapsible>
  )
}

export function Steps({ children }: { children: ReactNode[] }) {
  return (
    <ol className="grid gap-2">
      {children.map((c, i) => (
        <li key={i} className="flex gap-2.5">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs font-medium text-primary">{i + 1}</span>
          <div className="min-w-0 flex-1">{c}</div>
        </li>
      ))}
    </ol>
  )
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(false), 1500); return () => clearTimeout(t) }, [done])
  return (
    <Button type="button" variant="outline" size="xs" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setDone(true)) }} aria-label={`${label}: ${text}`}>
      {done ? <CheckIcon /> : <Copy />}{done ? 'Copied' : label}
    </Button>
  )
}

/** A command to run in a terminal, with a copy button. */
export function Cmd({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap text-foreground">{children}</code>
      <CopyButton text={children} />
    </div>
  )
}

export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline">
      {children}<ExternalLink className="size-3" />
    </a>
  )
}

export const Code = ({ children }: { children: ReactNode }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.8125rem] text-foreground">{children}</code>

// ------------------------------------------------------------------ notes and findings

type Tone = 'ok' | 'info' | 'warn' | 'fail'
const TONE: Record<Tone, { icon: ReactNode; cls: string }> = {
  ok: { icon: <CheckCircle2 className="text-verified" />, cls: '' },
  info: { icon: <Info className="text-primary" />, cls: '' },
  warn: { icon: <AlertTriangle className="text-warning" />, cls: 'border-warning/50' },
  fail: { icon: <CircleX className="text-destructive" />, cls: 'border-destructive/50 bg-destructive/5' },
}

export function Note({ tone, title, children, className }: { tone: Tone; title?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <Alert className={cn(TONE[tone].cls, className)}>
      {TONE[tone].icon}
      {title ? <AlertTitle className="line-clamp-none">{title}</AlertTitle> : null}
      {children ? <AlertDescription className="[&_a]:text-primary">{children}</AlertDescription> : null}
    </Alert>
  )
}

const DESTRUCTIVE = new Set(['delete-failed-stack', 'clear-leftovers', 'delete-cognito-domain', 'delete-tools-repository'])

/** One finding of the checks: what it is, what to do, and the installer's own fix when it has one. */
export function Finding({ c, extra }: { c: Check; extra?: ReactNode }) {
  const s = useStore()
  const [confirm, setConfirm] = useState(false)
  const busy = s.fixBusy === `${c.id}:${c.action?.id ?? ''}`
  const done = s.fixNote.get(c.id)
  const act = (): void => { if (c.action && DESTRUCTIVE.has(c.action.id)) setConfirm(true); else void runFix(c) }
  return (
    <Note tone={c.status} title={c.title}>
      <p className="text-foreground/90">{c.detail}</p>
      {c.fix ? <p><span className="font-medium text-foreground">What to do: </span>{c.fix}</p> : null}
      {c.link || c.action ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {c.action ? (
            <Button size="sm" variant={c.status === 'fail' ? 'default' : 'outline'} disabled={busy || s.fixBusy !== ''} onClick={act}>
              {busy ? <Loader2 className="animate-spin" /> : <Wrench />}{c.action.label}
            </Button>
          ) : null}
          {c.link ? <Ext href={c.link}>Open in the AWS console</Ext> : null}
        </div>
      ) : null}
      {extra}
      {done ? <p className="text-foreground">{done}</p> : null}
      {c.action ? (
        <AlertDialog open={confirm} onOpenChange={setConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{c.action.label}?</AlertDialogTitle>
              <AlertDialogDescription>{c.detail} This deletes it from the AWS account and cannot be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => void runFix(c)}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </Note>
  )
}

/** What the checks are doing while they run: a count, the ones running now, and every one on request. */
export function CheckProgress() {
  const s = useStore()
  if (!s.preBusy) return null
  const list = s.preProgress
  const doneN = list.filter((p) => p.state !== 'running').length
  return (
    <div className="grid gap-2 rounded-lg border bg-muted/40 p-3" aria-live="polite">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Loader2 className="size-4 animate-spin text-primary" />
        {list.length ? `Checking… ${doneN} of ${list.length} done` : 'Starting the checks…'}
        <span className="ml-auto text-xs font-normal text-muted-foreground">usually under a minute</span>
      </div>
      <ul className="grid gap-1 text-xs">
        {list.map((p) => (
          <li key={p.id} className="flex items-center gap-2">
            {p.state === 'running' ? <Loader2 className="size-3 animate-spin text-primary" /> : p.state === 'done' ? <CheckIcon className="size-3 text-verified" /> : <CircleX className="size-3 text-destructive" />}
            <span className={p.state === 'running' ? 'text-foreground' : 'text-muted-foreground'}>{p.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A heading inside a step. */
export function Section({ title, description, children, action }: { title: string; description?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="grid gap-3">
      <div className="flex items-end justify-between gap-3">
        <div className="grid gap-0.5">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
