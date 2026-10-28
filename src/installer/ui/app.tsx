/**
 * The installer page: a centred column with the steps across the top, one step at a time, Back and Continue at the
 * foot (docs/ui-design.md "The installer"). Only GitHub and AWS ask for anything; every other step has defaults.
 */
import { type ReactNode, useEffect, useState } from 'react'
import { Check, Loader2, Monitor, Moon, Sun } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { go, next } from './actions.js'
import { STEPS, type StepId, blockers } from './model.js'
import { Note } from './parts.js'
import { useStore } from './store.js'
import { WelcomeStep } from './steps/welcome.js'
import { GithubStep } from './steps/github.js'
import { AwsStep } from './steps/aws.js'
import { ProjectsStep } from './steps/projects.js'
import { PeopleStep } from './steps/people.js'
import { OptionalStep } from './steps/optional.js'
import { ReviewStep } from './steps/review.js'
import { InstallStep } from './steps/install.js'

// ------------------------------------------------------------------ theme: light, dark or the system's

type Theme = 'light' | 'dark' | 'system'
const THEME_KEY = 'trace.installer.theme'
function readTheme(): Theme { try { const t = localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : 'system' } catch { return 'system' } }
export function applyTheme(t: Theme): void {
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}
applyTheme(readTheme())

function ThemeSwitch() {
  const [t, setT] = useState<Theme>(readTheme)
  useEffect(() => {
    applyTheme(t)
    try { localStorage.setItem(THEME_KEY, t) } catch { /* private window: this visit only */ }
    if (t !== 'system') return
    const m = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (): void => applyTheme('system')
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [t])
  const opts: { v: Theme; icon: ReactNode; label: string }[] = [{ v: 'light', icon: <Sun />, label: 'Light' }, { v: 'system', icon: <Monitor />, label: 'System' }, { v: 'dark', icon: <Moon />, label: 'Dark' }]
  return (
    <div className="flex rounded-md border p-0.5" role="radiogroup" aria-label="Theme">
      {opts.map((o) => (
        <Button key={o.v} variant="ghost" size="icon-xs" role="radio" aria-checked={t === o.v} aria-label={o.label} title={o.label}
          className={cn(t === o.v && 'bg-accent text-accent-foreground')} onClick={() => setT(o.v)}>{o.icon}</Button>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ the steps across the top

function Stepper() {
  const s = useStore()
  const at = STEPS.findIndex((x) => x.id === s.step)
  const installing = s.step === 'install'
  return (
    <nav aria-label="Installation steps" className="overflow-x-auto">
      <ol className="flex min-w-max items-start px-1 sm:min-w-0">
        {STEPS.map((x, i) => {
          const current = x.id === s.step
          const done = installing || i < at
          const reachable = !installing && (s.visited.has(x.id) || i <= at)
          return (
            <li key={x.id} className="relative flex flex-1 flex-col items-center gap-1.5">
              {i > 0 ? <span aria-hidden className={cn('absolute top-2.5 right-1/2 left-[-50%] h-px', done || current ? 'bg-foreground/60' : 'bg-border')} /> : null}
              <button type="button" disabled={!reachable} onClick={() => go(x.id)} aria-current={current ? 'step' : undefined}
                className={cn('relative z-10 flex size-5 items-center justify-center rounded-full border text-[10px] font-medium transition-colors',
                  done ? 'border-foreground bg-foreground text-background' : current ? 'border-primary bg-primary text-primary-foreground ring-4 ring-primary/15' : 'border-border bg-background text-muted-foreground',
                  reachable && !current && 'cursor-pointer hover:border-foreground/60', !reachable && 'cursor-default')}>
                {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
              </button>
              <span className={cn('px-1 text-xs', current ? 'font-medium text-foreground' : 'text-muted-foreground')}>{x.title}</span>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

// ------------------------------------------------------------------ one step's frame

interface StepView { title: string; description: ReactNode; body: ReactNode; next?: { to: StepId; label: string } }

function view(step: StepId): StepView {
  switch (step) {
    case 'welcome': return { title: 'Install trace', description: 'Two things are needed: a GitHub token and AWS credentials. Everything else is worked out from them or has a default you can change.', body: <WelcomeStep />, next: { to: 'github', label: 'Get started' } }
    case 'github': return { title: 'Connect GitHub', description: 'One token lets trace read and change the repositories it looks after. It is checked with GitHub now and never saved on this computer.', body: <GithubStep />, next: { to: 'aws', label: 'Continue' } }
    case 'aws': return { title: 'Connect AWS', description: 'Where trace runs: the AWS account and region it installs into. The checks read the account and change nothing.', body: <AwsStep />, next: { to: 'projects', label: 'Continue' } }
    case 'projects': return { title: 'Choose projects', description: 'The repositories trace looks after. Each gets its own agent, roles, memory and build runner, and an onboarding pull request you merge. None is fine: add them later by running the installer again.', body: <ProjectsStep />, next: { to: 'people', label: 'Continue' } }
    case 'people': return { title: 'People', description: 'Who signs in to trace. The first administrator is required; everyone else can be invited later from the app.', body: <PeopleStep />, next: { to: 'optional', label: 'Continue' } }
    case 'optional': return { title: 'Optional', description: 'Distributor keys for live stock and prices, and every other setting. All of it has a default: skip this step if you are not sure.', body: <OptionalStep />, next: { to: 'review', label: 'Review the plan' } }
    case 'review': return { title: 'Review and install', description: 'What installing will do, in order. Every step can be run again safely: if one fails, fix the cause and run the installer again.', body: <ReviewStep /> }
    case 'install': return { title: '', description: '', body: <InstallStep /> }
  }
}

function Footer({ step, to, label }: { step: StepId; to: StepId; label: string }) {
  const s = useStore()
  const reasons = blockers(s, step)
  const busy = s.ghBusy || s.preBusy
  const at = STEPS.findIndex((x) => x.id === step)
  const prev = at > 0 ? STEPS[at - 1] : undefined
  // the first reason, said beside the button; a check that has not been run is not an error, so it is quiet until tried
  const reason = reasons[0]?.text ?? ''
  const tried = s.tried.has(step)
  return (
    <CardFooter className="flex-col-reverse items-stretch gap-3 border-t sm:flex-row sm:items-center">
      {prev ? <Button variant="ghost" onClick={() => go(prev.id)}>Back</Button> : null}
      <p className={cn('flex-1 text-xs sm:text-right', tried && reasons.length ? 'text-destructive' : 'text-muted-foreground')} aria-live="polite">
        {reason}{reasons.length > 1 ? ` (and ${reasons.length - 1} more)` : ''}
      </p>
      <Button onClick={() => void next(step, to)} disabled={busy} aria-disabled={reasons.length > 0 && !busy ? true : undefined}>
        {busy ? <Loader2 className="animate-spin" /> : null}{label}
      </Button>
    </CardFooter>
  )
}

export function App() {
  const s = useStore()
  const v = view(s.step)
  return (
    <TooltipProvider>
      <div className="mx-auto flex min-h-svh w-full max-w-2xl flex-col gap-6 px-4 py-6 sm:py-8">
        <header className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-md bg-foreground font-semibold text-background">t</span>
          <span className="text-base font-semibold tracking-tight">trace</span>
          <Badge variant="outline" className="text-muted-foreground">Installer</Badge>
          <span className="ml-auto hidden font-mono text-xs text-muted-foreground sm:inline">localhost · tracectl install</span>
          <ThemeSwitch />
        </header>
        {s.bootError ? (
          <Note tone="fail" title="The installer can't be reached">{s.bootError} Start it again with <code className="font-mono">tracectl install</code> and open the address it prints.</Note>
        ) : !s.env ? (
          <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</p>
        ) : (
          <>
            {s.step !== 'install' ? <Stepper /> : null}
            {s.step === 'install' ? v.body : (
              <Card className="gap-5">
                <CardHeader>
                  <CardTitle className="text-xl tracking-tight">{v.title}</CardTitle>
                  <CardDescription>{v.description}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-6">{v.body}</CardContent>
                {v.next ? <Footer step={s.step} to={v.next.to} label={v.next.label} /> : null}
              </Card>
            )}
          </>
        )}
        <footer className="mt-auto text-center text-xs text-muted-foreground">
          Tokens and keys stay in this installer's memory until they are written to AWS Secrets Manager and GitHub. Nothing is saved to disk but your non-secret choices.
        </footer>
      </div>
    </TooltipProvider>
  )
}
