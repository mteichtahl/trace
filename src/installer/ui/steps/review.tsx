import type { ReactNode } from 'react'
import { ArrowRight, Clock, Loader2, Rocket } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { INTEGRATION_NAMES } from '../../../core/integrations-catalog.js'
import { go, loadPlan, startInstall } from '../actions.js'
import { STEPS, account, answers, blockers, planKey, region, sampleRepo } from '../model.js'
import { Note, Section } from '../parts.js'
import { useStore } from '../store.js'

function Row({ label, children, step }: { label: string; children: ReactNode; step?: (typeof STEPS)[number]['id'] }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr_auto] items-baseline gap-3 border-b py-2 last:border-b-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
      {step ? <Button variant="link" size="xs" className="h-auto p-0" onClick={() => go(step)}>Change</Button> : <span />}
    </div>
  )
}

export function ReviewStep() {
  const s = useStore()
  const f = s.pre?.facts
  const reasons = blockers(s, 'review')
  const a = answers(s)
  const keys = INTEGRATION_NAMES.filter((n) => Object.values(s.integrations[n]).some((v) => v.trim()))
  const sample = sampleRepo(s)
  const stale = Boolean(s.plan) && s.planKey !== planKey(s)
  const title = (id: string): string => STEPS.find((x) => x.id === id)?.title ?? id
  return (
    <>
      <dl className="rounded-lg border px-3 text-sm">
        <Row label="AWS account" step="aws">{f?.account ? <><span className="font-mono">{account(f.account)}</span> in <span className="font-mono">{region(s)}</span>{f.existing ? ' (updating trace)' : ''}</> : <span className="text-muted-foreground">not checked yet</span>}</Row>
        <Row label="GitHub" step="github">{a.github?.login ? <span className="font-mono">{a.github.login}</span> : <span className="text-muted-foreground">not checked yet</span>}</Row>
        <Row label="Projects" step="projects">
          {s.projects.size ? <span className="font-mono text-[0.8125rem]">{[...s.projects.keys()].join(', ')}</span> : <span className="text-muted-foreground">none yet</span>}
          {sample ? <span className="block text-xs text-muted-foreground">including the sample{s.sample.tour ? ', with its tour' : ''}</span> : null}
        </Row>
        <Row label="People" step="people">{a.adminEmail || <span className="text-destructive">first administrator missing</span>} (admin){s.people.length ? `, and ${s.people.length} other${s.people.length === 1 ? '' : 's'}` : ''}</Row>
        <Row label="Optional" step="optional">{keys.length ? `${keys.length} distributor key${keys.length === 1 ? '' : 's'}` : 'no distributor keys'}; {s.agents.webEnabled ? `web app${s.agents.webDomain ? ` at ${s.agents.webDomain}` : ''}${s.agents.webWaf ? ' with AWS WAF' : ''}` : 'no web app'}; prefix <span className="font-mono">{s.agents.prefix}</span></Row>
      </dl>

      {reasons.length ? (
        <Note tone="fail" title={`${reasons.length} thing${reasons.length === 1 ? '' : 's'} to fix before installing`}>
          <ul className="grid gap-1.5">
            {reasons.map((r, i) => (
              <li key={i} className="flex items-start justify-between gap-3">
                <span>{r.text}</span>
                <Button variant="outline" size="xs" onClick={() => go(r.step)}>{title(r.step)}<ArrowRight /></Button>
              </li>
            ))}
          </ul>
        </Note>
      ) : null}

      {s.changes.length ? <Note tone="info" title="Changes since the last run"><ul className="list-disc pl-4">{s.changes.map((c) => <li key={c}>{c}</li>)}</ul></Note> : null}

      <Section title="The plan" description="Each step runs in order; the page shows each one as it goes."
        action={s.plan && !s.planBusy ? <Button variant="ghost" size="sm" onClick={() => void loadPlan()}>Refresh</Button> : undefined}>
        {s.planBusy ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{s.preBusy ? 'Checking the account again…' : 'Working out the plan…'}</p> : null}
        {s.planError && !s.planBusy ? <Note tone="fail" title="No plan yet">{s.planError}<div><Button size="sm" variant="outline" onClick={() => void loadPlan()}>Try again</Button></div></Note> : null}
        {stale && !s.planBusy ? <Note tone="warn">Something changed since this plan was made. <Button variant="link" size="xs" className="h-auto p-0" onClick={() => void loadPlan()}>Update the plan</Button></Note> : null}
        {s.timeline.length && s.plan ? (
          <div className="flex gap-3 rounded-lg bg-muted/50 p-3 text-sm">
            <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <ul className="grid gap-0.5">{s.timeline.map((l) => <li key={l}>{l}</li>)}</ul>
          </div>
        ) : null}
        {s.plan ? (
          <ol className="grid">
            {s.plan.map((st, i) => (
              <li key={st.id} className="flex gap-3 border-b py-2.5 last:border-b-0">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] text-muted-foreground">{i + 1}</span>
                <div className="grid gap-0.5"><p className="font-medium">{st.title}</p><p className="text-xs text-muted-foreground">{st.detail}</p></div>
              </li>
            ))}
          </ol>
        ) : null}
      </Section>

      <div className="flex flex-col items-stretch gap-3 border-t pt-5 sm:flex-row sm:items-center">
        <Button variant="ghost" onClick={() => go('optional')}>Back</Button>
        <p className="flex-1 text-xs text-muted-foreground sm:text-right">
          {reasons.length ? 'Fix what is listed above first.' : s.plan ? 'Keep this page open until it says trace is ready.' : ''}
        </p>
        <Button size="lg" disabled={!s.plan || stale || reasons.length > 0 || s.planBusy} onClick={() => void startInstall()}>
          <Rocket />{f?.existing ? 'Update' : 'Install into'} {f?.account ? account(f.account) : 'the account'}
        </Button>
      </div>
    </>
  )
}
