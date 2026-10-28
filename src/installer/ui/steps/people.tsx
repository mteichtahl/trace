import { Plus, Trash2, UserRound } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { PersonClass } from '../model.js'
import { Choice, Section, TextField, touch, useError } from '../parts.js'
import { update, useStore } from '../store.js'

const CLASSES: { value: PersonClass; label: string; help: string }[] = [
  { value: 'user', label: 'User', help: 'Reads and changes the projects ticked.' },
  { value: 'guest', label: 'Guest', help: 'Reads the projects ticked, changes nothing.' },
  { value: 'admin', label: 'Admin', help: 'Everything, on every project, including people.' },
]

export function PeopleStep() {
  const s = useStore()
  const err = useError()
  const tokenEmail = s.pre?.facts.email ?? null
  const repos = [...s.projects.keys()]
  return (
    <>
      <Section title="First administrator" description="Signs in first and can invite everyone else. Amazon Cognito emails them a temporary password.">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField id="adminEmail" label="Email" type="email" inputMode="email" value={s.adminEmail} error={err('adminEmail')}
            placeholder={tokenEmail ?? 'you@example.com'} onChange={(v) => update((x) => { x.adminEmail = v })}
            hint={tokenEmail ? <>Leave empty to use <span className="font-medium text-foreground">{tokenEmail}</span>, the token's email.</> : 'Required: the token can\'t see its account\'s email.'} />
          <TextField id="agents.escalateTo" label="Who the agents ask for help" optional value={s.agents.escalateTo} placeholder={`@${s.gh?.login ?? 'your-login'}`}
            error={err('escalateTo')} onChange={(v) => update((x) => { x.agents.escalateTo = v.trim() })} hint="A GitHub login or @org/team, mentioned when a project needs a person." />
        </div>
      </Section>

      <Section title="Others" description="Optional. Admins can invite more later from the app or with tracectl users invite."
        action={<Button variant="outline" size="sm" onClick={() => update((x) => { x.people.push({ id: x.nextPersonId++, email: '', class: 'user', projects: new Set(x.projects.keys()) }) })}><Plus />Add a person</Button>}>
        {s.people.length === 0 ? (
          <div className="flex items-center gap-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground"><UserRound className="size-4" />Nobody else yet.</div>
        ) : (
          <div className="grid gap-2">
            {s.people.map((p) => {
              const e = err(`people.${p.id}.email`)
              return (
                <div key={p.id} className="grid gap-2 rounded-lg border p-3">
                  <div className="grid items-start gap-2 sm:grid-cols-[1fr_8rem_auto]">
                    <div className="grid gap-1">
                      <Input type="email" inputMode="email" value={p.email} placeholder="name@example.com" aria-label="Email" aria-invalid={e ? true : undefined}
                        onChange={(ev) => update(() => { p.email = ev.target.value })} onBlur={touch(`people.${p.id}.email`)} />
                      {e ? <p className="text-xs text-destructive" role="alert">{e}</p> : null}
                    </div>
                    <Choice label={<span className="sr-only">Access</span>} value={p.class} options={CLASSES} onChange={(v) => update(() => { p.class = v })} className="gap-0" />
                    <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => update((x) => { x.people = x.people.filter((y) => y !== p) })}><Trash2 /></Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{CLASSES.find((c) => c.value === p.class)?.help}</p>
                  {p.class !== 'admin' ? (
                    repos.length ? (
                      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Projects">
                        {repos.map((r) => {
                          const on = p.projects.has(r)
                          return (
                            <button key={r} type="button" aria-pressed={on} onClick={() => update(() => { if (on) p.projects.delete(r); else p.projects.add(r) })}
                              className={cn('rounded-full border px-2.5 py-0.5 font-mono text-xs transition-colors', on ? 'border-primary bg-primary-soft text-foreground' : 'text-muted-foreground hover:bg-accent')}>
                              {r}
                            </button>
                          )
                        })}
                        {![...p.projects].some((r) => s.projects.has(r)) ? <Badge variant="outline" className="border-warning/50 font-normal text-warning-foreground">no projects: they will see nothing until given one</Badge> : null}
                      </div>
                    ) : <p className="text-xs text-muted-foreground">There are no projects to give them yet: an admin can assign them later.</p>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </Section>
    </>
  )
}
