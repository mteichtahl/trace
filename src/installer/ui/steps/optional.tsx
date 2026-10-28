import { type ReactNode, useState } from 'react'
import { ChevronDown, Loader2, RotateCcw, Settings2, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { INTEGRATIONS, INTEGRATION_NAMES, type IntegrationName } from '../../../core/integrations-catalog.js'
import { RUNNER_AUTH, RUNNER_COMPUTE_TYPES } from '../../answers.js'
import { checkKey } from '../actions.js'
import { type NumberField, NUMBERS, type State, buildTrace, fieldErrors, flatInstall, initialState, region } from '../model.js'
import { Choice, Code, Ext, Note, Section, TextField, Toggle, TriChoice, useError } from '../parts.js'
import { update, useStore } from '../store.js'

// ------------------------------------------------------------------ distributor and other keys

function Integration({ n }: { n: IntegrationName }) {
  const s = useStore()
  const err = useError()
  const i = INTEGRATIONS[n]
  const values = s.integrations[n]
  const c = s.integrationCheck.get(n)
  const complete = i.keys.every((k) => (values[k] ?? '').trim())
  const e = err(`integrations.${n}`)
  return (
    <div className="grid gap-3 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-0.5">
          <p className="text-sm font-semibold">{i.title}</p>
          <p className="text-xs text-muted-foreground">{i.enables}</p>
        </div>
        <span className="shrink-0 whitespace-nowrap"><Ext href={i.url}>Get a key</Ext></span>
      </div>
      <div className={cn('grid gap-3', i.keys.length > 1 && 'sm:grid-cols-2')}>
        {i.keys.map((k) => (
          <TextField key={k} id={`integrations.${n}`} label={<span className="font-mono text-xs">{k}</span>} secret mono value={values[k] ?? ''} placeholder="Not set"
            onChange={(v) => update((x) => { x.integrations[n][k] = v; x.integrationCheck.delete(n) })} />
        ))}
      </div>
      {e ? <p className="text-xs text-destructive" role="alert">{e}</p> : null}
      {complete ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="outline" disabled={c === 'busy'} onClick={() => void checkKey(n)}>{c === 'busy' ? <Loader2 className="animate-spin" /> : <ShieldCheck />}Check with {i.title.split(' ')[0]}</Button>
          {c && c !== 'busy' ? <span className={cn('text-xs', c.ok ? 'text-verified' : 'text-warning-foreground')}>{c.detail}{c.ok ? '' : ' It is stored anyway; installing never waits on it.'}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

// ------------------------------------------------------------------ Advanced, in groups

const NumberInput = ({ k, hint }: { k: NumberField; hint?: ReactNode }) => {
  const s = useStore()
  const err = useError()
  const f = NUMBERS[k]
  return (
    <TextField id={`agents.${k}`} type="number" label={`${f.label} (${f.unit})`} value={s.agents[k]} placeholder={String(f.def)} error={err(`agents.${k}`)}
      hint={hint ?? `${f.min.toLocaleString()} to ${f.max.toLocaleString()}; default ${f.def.toLocaleString()}.`} onChange={(v) => update((x) => { x.agents[k] = v.trim() })} />
  )
}

type Group = 'agents' | 'jobs' | 'builds' | 'web' | 'knowledge' | 'tokens'
const GROUPS: { id: Group; title: string; keys: RegExp }[] = [
  { id: 'agents', title: 'Agents', keys: /^agents\.(prefix|model|maxLifetimeHours|idleMinutes|centralBucketName|retainData|migrateLayout)$/ },
  { id: 'jobs', title: 'Graphics card and CPU jobs', keys: /^agents\.(gpu|cpu|image|publish)/ },
  { id: 'builds', title: 'Builds', keys: /^runners\./ },
  { id: 'web', title: 'Web app', keys: /^agents\.web/ },
  { id: 'knowledge', title: 'Knowledge and monitoring', keys: /^agents\.(knowledgeBase|libraryGateway|externalAccess|observability|transactionSearch|dashboard|samplingPercent)$/ },
  { id: 'tokens', title: 'Tokens and memory', keys: /^(github\.adminToken|projectTokens\.|projects\.)/ },
]

/** Each group back to its defaults (the answers' own, as initialState has them). */
function reset(g: Group): void {
  const d = initialState()
  update((s: State) => {
    const pick = <K extends keyof State['agents']>(...ks: K[]): void => { for (const k of ks) s.agents[k] = d.agents[k] }
    if (g === 'agents') pick('prefix', 'model', 'maxLifetimeHours', 'idleMinutes', 'centralBucketName', 'retainData', 'migrateLayout')
    if (g === 'jobs') pick('gpuEnabled', 'gpuMaxVcpus', 'gpuSpot', 'cpuEnabled', 'cpuMaxVcpus', 'cpuSpot', 'cpuVcpus', 'cpuMemoryMiB', 'imageSource', 'imageRegistry', 'publishImages')
    if (g === 'builds') s.runners = d.runners
    if (g === 'web') pick('webEnabled', 'webDomain', 'webCertificateArn', 'webEmailFrom', 'webWaf')
    if (g === 'knowledge') pick('knowledgeBase', 'libraryGateway', 'externalAccess', 'observability', 'transactionSearch', 'dashboard', 'samplingPercent')
    if (g === 'tokens') { s.github.adminToken = ''; s.projectTokens.clear(); for (const p of s.projects.values()) p.memoryDays = '' }
  })
}

function AgentsGroup() {
  const s = useStore()
  const err = useError()
  const g = s.agents
  const models = s.pre?.facts.models ?? []
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id="agents.prefix" label="Prefix" mono value={g.prefix} error={err('agents.prefix')} onChange={(v) => update((x) => { x.agents.prefix = v.trim().toLowerCase() })}
          hint="On every resource's name. Two installations in one account need two prefixes." />
        {models.length ? (
          <Choice label="Model" value={g.model} onChange={(v) => update((x) => { x.agents.model = v })} hint="Claude on Amazon Bedrock, as offered in this region."
            options={[{ value: '', label: 'The newest Claude Sonnet here (recommended)' }, ...models.map((m) => ({ value: m.id, label: m.name }))]} />
        ) : (
          <TextField id="agents.model" label="Model" mono value={g.model} placeholder="the newest Claude Sonnet here" error={err('agents.model')} onChange={(v) => update((x) => { x.agents.model = v.trim() })}
            hint="A Bedrock inference profile id; the list appears after the AWS check." />
        )}
        <NumberInput k="maxLifetimeHours" hint="How long one task may run: Amazon Bedrock AgentCore allows up to 8 hours." />
        <NumberInput k="idleMinutes" hint="A session with nothing happening ends after this; 1 to 480." />
        <TextField id="agents.centralBucketName" label="Central bucket name" mono optional value={g.centralBucketName} placeholder="named automatically" error={err('agents.centralBucketName')}
          onChange={(v) => update((x) => { x.agents.centralBucketName = v.trim() })} hint="Only if you need a particular S3 name." />
      </div>
      <Toggle label="Keep the data if trace or a project is removed" description="The central bucket, images and memories stay, so a reinstall can pick them up. Recommended." checked={g.retainData} onChange={(v) => update((x) => { x.agents.retainData = v })} />
      {flatInstall(s) ? (
        <Note tone="warn" title="Move to one stack per project">
          <p>This installation keeps every project in one CloudFormation stack (about 20 fit). One nested stack per project fits 60, but moving takes three deploys and deletes every project's memory records.</p>
          <Toggle label="Move it (deletes every project's memory records)" checked={g.migrateLayout} onChange={(v) => update((x) => { x.agents.migrateLayout = v })} />
        </Note>
      ) : null}
    </div>
  )
}

function JobsGroup() {
  const s = useStore()
  const err = useError()
  const g = s.agents
  const f = s.pre?.facts
  const gpuAuto = f?.gpuQuota === undefined || f?.gpuQuota === null ? 'on' : f.gpuQuota >= 4 ? `on: ${f.gpuQuota} vCPUs allowed` : `off: the quota is ${f.gpuQuota}`
  return (
    <div className="grid gap-4">
      <p className="text-xs text-muted-foreground">Blender renders and PCB autorouting run on graphics card instances; CPU-heavy jobs (openEMS, Verilator, formal checks, CFD) on CPU instances. Both are AWS Batch queues that scale to zero when idle, sharing one large image made after trace is ready (its first build takes 30 to 60 minutes).</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <TriChoice label="Graphics card jobs" value={g.gpuEnabled} auto={gpuAuto} onChange={(v) => update((x) => { x.agents.gpuEnabled = v })} />
        <TriChoice label="CPU jobs" value={g.cpuEnabled} auto="on with graphics card jobs, when the quota allows" onChange={(v) => update((x) => { x.agents.cpuEnabled = v })} />
        <NumberInput k="gpuMaxVcpus" hint="4 per job; a multiple of 4. Default 16 (4 jobs at once)." />
        <NumberInput k="cpuMaxVcpus" />
        <NumberInput k="cpuVcpus" />
        <NumberInput k="cpuMemoryMiB" hint="Default 32,768 (32 GB)." />
      </div>
      <Toggle label="Graphics card jobs on Spot instances" description="Cheaper; a job can be interrupted and is retried." checked={g.gpuSpot} onChange={(v) => update((x) => { x.agents.gpuSpot = v })} />
      <Toggle label="CPU jobs on Spot instances" checked={g.cpuSpot} onChange={(v) => update((x) => { x.agents.cpuSpot = v })} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Choice label="Agent and job images" value={g.imageSource} onChange={(v) => update((x) => { x.agents.imageSource = v })}
          options={[{ value: 'prebuilt', label: 'trace\'s published images, else built here' }, { value: 'build', label: 'Always build them here (CodeBuild)' }]} />
        {g.imageSource === 'prebuilt' ? (
          <TextField id="agents.imageRegistry" label="Published images registry" optional mono value={g.imageRegistry} error={err('agents.imageRegistry')} onChange={(v) => update((x) => { x.agents.imageRegistry = v.trim() })}
            placeholder={f?.publishedRegistry ?? 'wherever trace publishes them'} hint="Copied by digest into this account's private registry." />
        ) : null}
      </div>
      <TriChoice label="Publish trace's images from this account" value={g.publishImages} auto={f?.sourceAdmin ? 'on: your token administers trace\'s repository' : 'off: only trace\'s owner publishes'} onChange={(v) => update((x) => { x.agents.publishImages = v })} />
    </div>
  )
}

const COMPUTE: Record<(typeof RUNNER_COMPUTE_TYPES)[number], string> = {
  BUILD_GENERAL1_MEDIUM: 'Medium (4 vCPUs, 7 GB)', BUILD_GENERAL1_LARGE: 'Large (8 vCPUs, 15 GB)',
  BUILD_GENERAL1_XLARGE: 'X-large (36 vCPUs, 72 GB)', BUILD_GENERAL1_2XLARGE: '2X-large (72 vCPUs, 144 GB)',
}
const STATUS: Record<string, string> = { AVAILABLE: 'authorised', PENDING: 'not authorised yet', ERROR: 'in error' }
const OTHER = '__other__'

function BuildsGroup() {
  const s = useStore()
  const err = useError()
  const r = s.runners
  const reg = region(s)
  const name = `${s.agents.prefix || 'trace'}-github`
  const consoleUrl = `https://${reg}.console.aws.amazon.com/codesuite/settings/connections?region=${reg}`
  const found = s.pre?.facts.runnerConnection ?? null
  const list = s.pre?.facts.githubConnections ?? []
  const listed = list.find((c) => c.arn === r.connectionArn) ?? null
  const value = r.connectionOther || (r.connectionArn && !listed) ? OTHER : r.connectionArn
  const own = s.pre?.self ?? null
  const automatic = found ? `reuse ${found}` : r.auth === 'connection' ? `create ${name}, authorised once after the deploy` : 'the GitHub token (none is authorised)'
  return (
    <div className="grid gap-4">
      <p className="text-xs text-muted-foreground">Every GitHub Actions job of your projects runs on AWS CodeBuild in this account, each repository on its own runner, once it exists; until then jobs run on GitHub's runners and move over by themselves.</p>
      {own ? (
        s.projects.has(own.repo) ? <p className="text-xs text-muted-foreground">trace's own repository ({own.repo}) is one of the projects, so it gets its build runner with them.</p>
          : !own.ok ? <p className="text-xs text-muted-foreground">trace's own repository ({own.repo}) stays on GitHub's runners: the token can't set its variables.</p>
            : (
              <div className="grid gap-1">
                <Toggle label={`Build trace's own repository on AWS too (${own.repo})`} description="A build runner for it alone, no agents." checked={buildTrace(s)} onChange={(v) => update((x) => { x.runners.buildTrace = v })} />
                {buildTrace(s) ? <Toggle label="Keep this installation up to date when trace's main branch changes" description={`When ${own.repo}'s default branch changes and its tests pass, its ci workflow deploys this installation again with the settings saved here. Anyone who can merge there can change this installation.`}
                  checked={r.selfUpdate} onChange={(v) => update((x) => { x.runners.selfUpdate = v })} /> : null}
              </div>
            )
      ) : null}
      <Choice label="How CodeBuild reaches GitHub" value={r.auth} hint={<>Change it later with <Code>tracectl upgrade --runner-auth</Code>.</>}
        onChange={(v) => update((x) => { x.runners.auth = (RUNNER_AUTH as readonly string[]).includes(v) ? v : 'auto' })}
        options={[
          { value: 'auto', label: `Automatic: an authorised connection if there is one${found ? ` (${found})` : ''}, else the token` },
          { value: 'token', label: 'The GitHub token (no console step; stored with CodeBuild)' },
          { value: 'connection', label: 'An AWS CodeConnections connection (no token stored; one console step)' },
        ]} />
      {r.auth !== 'token' ? (
        <>
          <Choice label="GitHub connection" value={value} error={value !== OTHER ? err('runners.connectionArn') : ''}
            hint={list.length ? `${list.length} in this account and region.` : s.pre ? 'None in this account and region yet.' : 'The AWS check lists this account\'s connections.'}
            onChange={(v) => update((x) => { x.runners.connectionOther = v === OTHER; if (v !== OTHER) x.runners.connectionArn = v; else if (listed) x.runners.connectionArn = '' })}
            options={[
              { value: '', label: `Automatic: ${automatic}` },
              ...list.map((c) => ({ value: c.arn, label: `${c.name || c.arn} (${STATUS[c.status] ?? c.status.toLowerCase()})` })),
              { value: OTHER, label: 'Another connection (enter its ARN)' },
            ]} />
          {value === OTHER ? <TextField id="runners.connectionArn" label="Connection ARN" mono value={r.connectionArn} error={err('runners.connectionArn')} placeholder="arn:aws:codeconnections:<region>:<account>:connection/<id>" onChange={(v) => update((x) => { x.runners.connectionArn = v.trim() })} /> : null}
          {listed?.status === 'PENDING' ? <Note tone="warn">{listed.name} is not authorised yet: the deploy goes ahead, then authorise it once in <Ext href={consoleUrl}>Connections</Ext> ("Update pending connection") and the installer adds the runners.</Note> : null}
          {listed?.status === 'ERROR' ? <Note tone="fail">{listed.name} is in error: choose another, or delete it in <Ext href={consoleUrl}>Connections</Ext> and choose again.</Note> : null}
          {r.auth === 'connection' ? <Note tone="info" title="One step in the AWS console">After the first deploy the installer shows a link to <Ext href={consoleUrl}>Connections</Ext> and waits: choose {listed?.name ?? name}, then "Update pending connection", which installs the AWS Connector for GitHub app; give it access to every chosen repository.</Note> : null}
        </>
      ) : null}
      {r.auth !== 'connection' ? (
        <Choice label="The token CodeBuild keeps" value={r.token} onChange={(v) => update((x) => { x.runners.token = v })}
          hint="It needs Administration, Webhooks and Commit statuses (read and write) and Contents (read) on each repository."
          options={[{ value: 'agent', label: 'The GitHub token' }, { value: 'admin', label: 'The admin token (under Tokens and memory)' }]} />
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Choice label="Job size" value={r.computeType} onChange={(v) => update((x) => { x.runners.computeType = v })} hint="A job can ask for another with an instance-size label."
          options={[{ value: '', label: 'Default (Large)' }, ...RUNNER_COMPUTE_TYPES.map((t) => ({ value: t, label: COMPUTE[t] }))]} />
        <Choice label="Docker in jobs" value={r.privileged} onChange={(v) => update((x) => { x.runners.privileged = v })}
          options={[{ value: 'default', label: 'Default (off)' }, { value: 'on', label: 'On (for jobs that build containers)' }, { value: 'off', label: 'Off' }]} />
      </div>
    </div>
  )
}

function WebGroup() {
  const s = useStore()
  const err = useError()
  const g = s.agents
  return (
    <div className="grid gap-4">
      <Toggle label="The web app" description="Where people sign in with passkeys or a password: S3 and CloudFront, a small Lambda, live updates. tracectl login works either way." checked={g.webEnabled} onChange={(v) => update((x) => { x.agents.webEnabled = v })} />
      {g.webEnabled ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField id="agents.webDomain" label="Custom domain" optional mono value={g.webDomain} placeholder="CloudFront's own address" error={err('agents.webDomain')}
              onChange={(v) => update((x) => { x.agents.webDomain = v.trim().toLowerCase() })} hint="You point its DNS at CloudFront afterwards." />
            <TextField id="agents.webCertificateArn" label="Its certificate" optional mono value={g.webCertificateArn} placeholder="arn:aws:acm:us-east-1:…" error={err('agents.webCertificateArn')}
              onChange={(v) => update((x) => { x.agents.webCertificateArn = v.trim() })} hint="An ACM certificate in us-east-1 (CloudFront's region)." />
          </div>
          <TextField id="agents.webEmailFrom" label="Email sign-in codes from" type="email" optional value={g.webEmailFrom} placeholder="passkeys and passwords only" error={err('agents.webEmailFrom')}
            onChange={(v) => update((x) => { x.agents.webEmailFrom = v.trim() })} hint="A verified Amazon SES sender: Cognito sends codes only through SES." />
          <Toggle label="Protect it with AWS WAF" description="About US$11 a month plus US$0.60 per million requests. The address is public, so managed rules and a request limit keep bots and password guessing off it. Turn off only for a private trial." checked={g.webWaf} onChange={(v) => update((x) => { x.agents.webWaf = v })} />
          <p className="text-xs text-muted-foreground">Passkeys belong to the app's address: moving to a custom domain later means people add their passkeys again.</p>
        </>
      ) : null}
    </div>
  )
}

function KnowledgeGroup() {
  const s = useStore()
  const err = useError()
  const g = s.agents
  return (
    <div className="grid gap-4">
      <TriChoice label="Knowledge bases" value={g.knowledgeBase} auto={s.pre?.facts.s3vectors === false ? 'off: no Amazon S3 Vectors in this region' : 'on where Amazon S3 Vectors is'} onChange={(v) => update((x) => { x.agents.knowledgeBase = v })} />
      <Toggle label="Serve the datasheets and parts tools through AgentCore Gateway" description="Then only its Lambda can read the distributor keys." checked={g.libraryGateway} onChange={(v) => update((x) => { x.agents.libraryGateway = v })} />
      <Toggle label="External access" description="Let other systems and AI agents connect to trace with their own keys. Off until you turn it on; admins then add each system in the web app." checked={g.externalAccess} onChange={(v) => update((x) => { x.agents.externalAccess = v })} />
      <Toggle label="Traces and metrics to CloudWatch" description="Amazon Bedrock AgentCore observability, for the Operations screen." checked={g.observability} onChange={(v) => update((x) => { x.agents.observability = v })} />
      {g.observability ? (
        <>
          <Toggle label="Turn on CloudWatch Transaction Search if it is off" description="Account-wide; uninstalling leaves it on." checked={g.transactionSearch} onChange={(v) => update((x) => { x.agents.transactionSearch = v })} />
          <Toggle label="A CloudWatch dashboard for the agents" checked={g.dashboard} onChange={(v) => update((x) => { x.agents.dashboard = v })} />
          <TextField id="agents.samplingPercent" type="number" label="X-Ray trace indexing (%)" optional value={g.samplingPercent} placeholder="leave the account's setting" error={err('agents.samplingPercent')}
            onChange={(v) => update((x) => { x.agents.samplingPercent = v.trim() })} hint="Account-wide, 0 to 100." className="sm:max-w-xs" />
        </>
      ) : null}
    </div>
  )
}

function TokensGroup() {
  const s = useStore()
  const err = useError()
  const repos = [...s.projects.keys()]
  return (
    <div className="grid gap-4">
      <TextField id="github.adminToken" label="Admin token" optional secret mono value={s.github.adminToken} error={err('github.adminToken')} placeholder="github_pat_…"
        onChange={(v) => update((x) => { x.github.adminToken = v })} hint="Only when the GitHub token can't set a repository's secrets, variables or settings. Used during this installation, never stored (unless CodeBuild keeps it)." />
      {repos.length ? (
        <>
          <p className="text-xs text-muted-foreground">Each project's agent reaches whatever its token can on GitHub. A fine-grained token limited to that one repository keeps it out of the others. Memory days: how long its agents keep short-term events (3 to 365; default 30).</p>
          {repos.map((r) => {
            const p = s.projects.get(r)
            return p ? (
              <div key={r} className="grid items-start gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_8rem]">
                <TextField id={`projectTokens.${r}`} label={<span className="font-mono text-xs">{r}</span>} secret mono optional value={s.projectTokens.get(r) ?? ''} placeholder="the GitHub token"
                  error={err(`projectTokens.${r}`)} onChange={(v) => update((x) => { x.projectTokens.set(r, v) })} />
                <TextField id={`projects.${r}.memoryDays`} type="number" label="Memory days" value={p.memoryDays} placeholder="30" error={err(`projects.${r}.memoryDays`)}
                  onChange={(v) => update(() => { p.memoryDays = v.trim() })} />
              </div>
            ) : null
          })}
        </>
      ) : <p className="text-xs text-muted-foreground">Per-project tokens and memory appear here once projects are chosen.</p>}
    </div>
  )
}

const BODY: Record<Group, () => ReactNode> = { agents: AgentsGroup, jobs: JobsGroup, builds: BuildsGroup, web: WebGroup, knowledge: KnowledgeGroup, tokens: TokensGroup }

function Advanced() {
  const s = useStore()
  const errors = fieldErrors(s)
  const bad = (g: (typeof GROUPS)[number]): boolean => [...errors.keys()].some((k) => g.keys.test(k))
  const anyBad = GROUPS.some(bad)
  const [open, setOpen] = useState(anyBad)
  const [tab, setTab] = useState<Group>(GROUPS.find(bad)?.id ?? 'agents')
  return (
    <Collapsible open={open || anyBad && s.tried.has('optional')} onOpenChange={setOpen} className="rounded-lg border">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <Settings2 className="size-4 text-muted-foreground" />
        <span className="flex-1 text-sm font-semibold">Advanced settings <span className="font-normal text-muted-foreground">(all have defaults)</span></span>
        {anyBad ? <Badge variant="destructive">needs a fix</Badge> : null}
        <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-4 py-4">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Group)}>
          <TabsList className="!h-auto w-full flex-wrap justify-start gap-1">
            {GROUPS.map((g) => (
              <TabsTrigger key={g.id} value={g.id} className="h-7 flex-none">
                {g.title}{bad(g) ? <span className="size-1.5 rounded-full bg-destructive" aria-label="needs a fix" /> : null}
              </TabsTrigger>
            ))}
          </TabsList>
          {GROUPS.map((g) => {
            const Body = BODY[g.id]
            return (
              <TabsContent key={g.id} value={g.id} className="grid gap-4 pt-3">
                <Body />
                <div className="flex justify-end border-t pt-3"><Button variant="ghost" size="sm" onClick={() => reset(g.id)}><RotateCcw />Reset {g.title.toLowerCase()} to defaults</Button></div>
              </TabsContent>
            )
          })}
        </Tabs>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function OptionalStep() {
  return (
    <>
      <Section title="Distributor keys" description="Live stock, prices and lifecycle in the parts search and BOM checks. Without them parts come from LCSC (no key needed). Each key is stored in AWS Secrets Manager; add or change one any time with tracectl integrations set.">
        <div className="grid gap-3">{INTEGRATION_NAMES.map((n) => <Integration key={n} n={n} />)}</div>
      </Section>
      <Advanced />
    </>
  )
}
