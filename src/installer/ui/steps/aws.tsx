import { useState } from 'react'
import { ChevronDown, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { Check } from '../../answers.js'
import { runPreflight, submitUseCase } from '../actions.js'
import { REGIONS, account, awsErrors, isRepoCheck, preCurrent } from '../model.js'
import { CheckProgress, Choice, Cmd, Ext, Field, Finding, Help, Note, Steps, TextField, touch } from '../parts.js'
import { update, useStore } from '../store.js'

function UseCaseForm({ c }: { c: Check }) {
  const s = useStore()
  const u = s.useCase
  const set = (k: 'companyName' | 'companyWebsite' | 'industryOption' | 'useCases', v: string): void => update((x) => { x.useCase[k] = v })
  const missing = !u.companyName.trim() || !u.companyWebsite.trim() || !u.useCases.trim()
  const website = u.companyWebsite.trim() && !/^https?:\/\/\S+\.\S+/.test(u.companyWebsite.trim()) ? 'A web address starting https://' : ''
  return (
    <div className="mt-2 grid gap-3 rounded-md border bg-background p-3">
      <p className="text-xs">Anthropic's one-time form for using Claude on Bedrock, sent from here. Once per account (or for the whole organisation from its management account).</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id="usecase.company" label="Company or your name" value={u.companyName} onChange={(v) => set('companyName', v)} />
        <TextField id="usecase.website" label="Website" value={u.companyWebsite} placeholder="https://github.com/you" error={website} onChange={(v) => set('companyWebsite', v)} hint="A GitHub profile or project page is fine." />
        <Choice label="Who uses it" value={u.intendedUsers} onChange={(v) => update((x) => { x.useCase.intendedUsers = v })}
          options={[{ value: '0', label: 'Internal users' }, { value: '1', label: 'External users' }, { value: '2', label: 'Both' }]} />
        <TextField id="usecase.industry" label="Industry" value={u.industryOption} onChange={(v) => set('industryOption', v)} />
      </div>
      <Field label="Use case"><Textarea rows={3} value={u.useCases} onChange={(e) => set('useCases', e.target.value)} /></Field>
      <div><Button size="sm" disabled={missing || Boolean(website) || s.fixBusy !== ''} onClick={() => void submitUseCase(c)}>Submit the form</Button></div>
    </div>
  )
}

export function AwsStep() {
  const s = useStore()
  const a = s.aws
  const env = s.env
  const profiles = env?.profiles.names ?? []
  const profRegion = a.mode === 'profile' ? env?.profiles.regions[a.profile] ?? '' : ''
  const show = (k: string): boolean => s.touched.has(`aws.${k}`) || s.tried.has('aws')
  const e = awsErrors(a, profiles)
  const fresh = preCurrent(s)
  const pre = fresh ? s.pre : null
  const f = pre?.facts
  const checks = (pre?.checks ?? []).filter((c) => !isRepoCheck(c))
  const order = { fail: 0, warn: 1, info: 2, ok: 3 } as const
  const important = checks.filter((c) => c.status === 'fail' || c.status === 'warn').sort((x, y) => order[x.status] - order[y.status])
  const rest = checks.filter((c) => c.status === 'ok' || c.status === 'info')
  const [openRest, setOpenRest] = useState(false)
  const set = (fn: (x: typeof s) => void): void => update(fn)
  const defaultRegion = env?.defaultRegion ?? 'us-east-1'
  return (
    <>
      <Field label="How to sign in to AWS">
        <RadioGroup value={a.mode} onValueChange={(v) => set((x) => { x.aws.mode = v === 'keys' ? 'keys' : 'profile' })} className="grid gap-2 sm:grid-cols-2">
          {([['profile', 'A profile on this computer', 'From ~/.aws: single sign-on or saved keys. Simplest.'], ['keys', 'Access keys', 'Paste an access key ID and secret (and session token if temporary).']] as const).map(([v, t, d]) => (
            <Label key={v} htmlFor={`mode-${v}`} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal', a.mode === v && 'border-primary bg-primary-soft')}>
              <RadioGroupItem id={`mode-${v}`} value={v} className="mt-0.5" />
              <span className="grid gap-0.5"><span className="font-medium">{t}</span><span className="text-xs text-muted-foreground">{d}</span></span>
            </Label>
          ))}
        </RadioGroup>
      </Field>

      {a.mode === 'profile' ? (
        profiles.length ? (
          <div className="grid gap-1.5" onBlur={touch('aws.profile')}>
            <Choice label="Profile" value={a.profile} onChange={(v) => set((x) => { x.aws.profile = v })}
              options={[...profiles.map((p) => ({ value: p, label: env?.profiles.regions[p] ? `${p}  ·  ${env.profiles.regions[p]}` : p })),
                ...(profiles.includes(a.profile) ? [] : [{ value: a.profile, label: `${a.profile || '(none)'} (not on this computer)` }])]}
              error={e.profile} hint="Single sign-on profiles work: sign in first (see below)." />
          </div>
        ) : (
          <TextField id="aws.profile" label="Profile name" value={a.profile} onChange={(v) => set((x) => { x.aws.profile = v })} error={show('profile') ? e.profile : ''}
            hint="No profiles were found in ~/.aws on this computer: set one up (see below), or use access keys." />
        )
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField id="aws.keyId" label="Access key ID" mono value={a.keyId} placeholder="AKIA… or ASIA…" onChange={(v) => set((x) => { x.aws.keyId = v.trim() })} error={show('keyId') ? e.keyId : ''} />
          <TextField id="aws.secret" label="Secret access key" mono secret value={a.secret} onChange={(v) => set((x) => { x.aws.secret = v.trim() })} error={show('secret') ? e.secret : ''} />
          <TextField id="aws.session" label="Session token" mono secret optional className="sm:col-span-2" value={a.session} onChange={(v) => set((x) => { x.aws.session = v.trim() })}
            error={show('session') || a.keyId.startsWith('ASIA') ? e.session : ''} hint="Only for temporary keys (those starting ASIA)." />
        </div>
      )}

      <Choice label="Region" value={a.region} onChange={(v) => set((x) => { x.aws.region = v })}
        hint="trace needs Amazon Bedrock AgentCore there; the checks confirm it. Choose the region closest to you."
        options={[{ value: '', label: profRegion ? `The profile's region (${profRegion})` : `The default (${defaultRegion})` }, ...REGIONS.map((r) => ({ value: r.id, label: `${r.name}  ·  ${r.id}` }))]} />

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
        {Object.keys(e).length
          ? <span>The account is checked as soon as these details are complete.</span>
          : !s.preBusy && (fresh || s.preError)
            ? <Button variant="ghost" size="xs" onClick={() => void runPreflight()}><RefreshCw />Check again</Button>
            : !s.preBusy ? <span className="flex items-center gap-2"><Loader2 className="size-3.5 animate-spin text-primary" />Checking the account…</span> : null}
      </div>
      <CheckProgress />
      {s.preError && !s.preBusy ? <Note tone="fail" title="The checks could not run">{s.preError}</Note> : null}

      {f?.account ? (
        <Note tone={important.some((c) => c.status === 'fail') ? 'warn' : 'ok'} title={<>Installing into account <span className="font-mono">{account(f.account)}</span> in <span className="font-mono">{pre?.region}</span></>}>
          <p>Signed in as <span className="font-mono break-all">{f.arn}</span>.{f.existing ? ' trace is installed here already: installing again updates it.' : ' A new installation.'}</p>
          {important.length === 0 ? <p>Everything trace needs is available. Continue when ready.</p> : <p>{important.filter((c) => c.status === 'fail').length ? 'Fix what is marked below, then check again.' : 'You can install; the notes below say what will not work until it is fixed.'}</p>}
        </Note>
      ) : null}
      {important.map((c) => <Finding key={`${c.id}:${c.title}:${c.detail}`} c={c} extra={c.action?.id === 'bedrock-use-case' && s.useCase.open ? <UseCaseForm c={c} /> : undefined} />)}
      {rest.length ? (
        <Collapsible open={openRest} onOpenChange={setOpenRest}>
          <CollapsibleTrigger className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <ChevronDown className={cn('size-4 transition-transform', openRest && 'rotate-180')} />{rest.length} more check{rest.length === 1 ? '' : 's'} passed or noted
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 grid gap-2">{rest.map((c) => <Finding key={`${c.id}:${c.title}:${c.detail}`} c={c} />)}</CollapsibleContent>
        </Collapsible>
      ) : null}

      <Help title="Setting up AWS credentials" defaultOpen={!profiles.length && a.mode === 'profile'}>
        <p>trace's installer creates IAM roles, so it needs an administrator (the <strong>AdministratorAccess</strong> permission set or policy). The credentials are used only by this installer and its deploy; trace's agents get their own narrow roles.</p>
        <p><strong>Single sign-on (IAM Identity Center)</strong>, once per computer:</p>
        <Steps>
          {[
            <div className="grid gap-1.5">Set the profile up (it asks for your start URL and region): <Cmd>aws configure sso</Cmd></div>,
            <div className="grid gap-1.5">Sign in (again whenever the session expires): <Cmd>{`aws sso login --profile ${a.profile || 'NAME'}`}</Cmd></div>,
            <div className="grid gap-1.5">Confirm it works, then choose it above: <Cmd>{`aws sts get-caller-identity --profile ${a.profile || 'NAME'}`}</Cmd></div>,
          ]}
        </Steps>
        <p><strong>Access keys</strong> come from the IAM console (<Ext href="https://console.aws.amazon.com/iam/home#/security_credentials">Security credentials</Ext>), or temporary ones from your sign-in portal's "Access keys" link. Don't have the AWS CLI? <Ext href="https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html">Install it</Ext>.</p>
      </Help>
    </>
  )
}
