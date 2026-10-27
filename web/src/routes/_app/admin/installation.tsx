/**
 * Admin › Installation (docs/ui-design.md, "Admin"): one health list, each line a status or a Wait line, from what
 * the API can answer today (whoami, /api/config, the live connection, projects with status and tools.waits,
 * integrations.list); then Optional keys (Nexar, Mouser, Digi-Key: integrations.list / set / remove), each entered
 * once, never read back; then the dashboards Operations draws from, honestly marked where the API has no read yet.
 */
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ExternalLink, KeyRound, Loader2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Column, Section } from '@/components/shell/app-shell'
import { useCommands } from '@/components/shell/command-menu'
import { SideSheet } from '@/components/side-sheet'
import { Loading, QueryError, SkeletonRows } from '@/components/states'
import { type Status, StatusBadge } from '@/components/status-badge'
import { WaitLine } from '@/components/wait-line'
import { useTraceContext } from '@/components/chat/context'
import { call, projectName } from '@/lib/api'
import type { IntegrationName, IntegrationStatus } from '@/lib/admin-types'
import { loadConfig } from '@/lib/config'
import { ago } from '@/lib/format'
import { useLiveStatus } from '@/lib/live'
import { q, useAction, useProjects } from '@/lib/queries'

export const Route = createFileRoute('/_app/admin/installation')({
  staticData: { crumb: 'Installation' },
  component: Installation,
})

export interface HealthLine {
  id: string
  what: string
  status: Status
  word: string
  detail?: string
  /** the one thing to do when it is not healthy */
  todo?: string
}

/** "Optional: parts search works without it; adds live stock and prices from this distributor". */
export const OPTIONAL_LINE = 'Optional: parts search works without it; adds live stock and prices from this distributor.'

/** The health line for AWS WAF in front of the app (src/infra/edge.ts). */
export function wafLine(waf: { enabled: boolean; own: boolean; apiRequestsPer5Minutes: number; authRequestsPer5Minutes: number } | undefined): HealthLine {
  const what = 'Protection (AWS WAF in front of the app)'
  if (!waf) return { id: 'waf', what, status: 'idle', word: 'Not reported', detail: 'This installation is older than the setting.', todo: 'Run the installer again: AWS WAF is on by default (about US$11 a month).' }
  if (!waf.enabled) return { id: 'waf', what, status: 'idle', word: 'Off', detail: 'Only the app\'s own limits per person apply; sign-in has no limit per address.', todo: 'Turn on "Protect the app with AWS WAF" in the installer\'s Advanced › Web app (about US$11 a month, plus US$0.60 per million requests).' }
  if (waf.own) return { id: 'waf', what, status: 'verified', word: 'On', detail: 'Your own web ACL is in front of the app.' }
  return { id: 'waf', what, status: 'verified', word: 'On', detail: `AWS's managed rules; at most ${waf.apiRequestsPer5Minutes.toLocaleString()} requests to the API and ${waf.authRequestsPer5Minutes.toLocaleString()} sign-in requests per address in 5 minutes; no request body over 5 MB.` }
}

/** The key's last four characters, the only part ever shown again. */
export const lastFour = (value: string): string => value.trim().slice(-4)

function Installation() {
  const qc = useQueryClient()
  const config = useQuery({ queryKey: ['config'], queryFn: loadConfig, staleTime: Infinity })
  const who = useAction('whoami', {})
  const projects = useProjects()
  const live = useLiveStatus()
  const integrations = useAction('integrations.list', {})
  const repos = (projects.data ?? []).map((p) => p.repo)
  const statuses = useQueries({ queries: repos.map((repo) => ({ ...q('status', { repo }), retry: false })) })
  const waits = useQueries({ queries: repos.map((repo) => q('tools.waits', { repo })) })
  const [editing, setEditing] = useState<IntegrationStatus | null>(null)
  const [removing, setRemoving] = useState<IntegrationStatus | null>(null)

  useTraceContext({ label: 'Installation', description: 'The screen the person is on: Admin, the installation\'s health and optional keys', value: { projects: repos.length, keys: (integrations.data ?? []).filter((i) => i.configured).map((i) => i.name) } }, 'screen')
  useCommands((integrations.data ?? []).map((i) => ({ id: `key-${i.name}`, label: `${i.configured ? 'Replace' : 'Add'} the ${i.title} key`, group: 'Installation', icon: KeyRound, run: () => setEditing(i) })))

  const lines: HealthLine[] = []
  if (config.data) {
    lines.push({ id: 'stack', what: 'The stack', status: 'verified', word: 'Deployed', detail: `Region ${config.data.region}, prefix ${config.data.prefix}.` })
  } else if (config.isError) {
    lines.push({ id: 'stack', what: 'The stack', status: 'failing', word: 'Not answering', todo: 'Check the web backend in the CloudFormation console, or run the installer again.' })
  }
  if (who.data) lines.push({ id: 'api', what: 'The API', status: 'verified', word: 'Answering', detail: `Signed in as ${who.data.email}.` })
  else if (who.isError) lines.push({ id: 'api', what: 'The API', status: 'failing', word: 'Not answering', detail: who.error instanceof Error ? who.error.message : undefined, todo: 'Check the API runtime in the AgentCore console.' })
  lines.push({
    id: 'live', what: 'The live connection',
    status: live.state === 'live' ? 'verified' : live.state === 'offline' ? 'failing' : 'waiting',
    word: live.state === 'live' ? 'Live' : live.state === 'offline' ? 'Offline' : 'Reconnecting',
    detail: config.data && !config.data.events.realtime ? 'No live endpoint is configured; screens refresh when you act.' : live.lastUpdate ? `Last heard from ${ago(live.lastUpdate)}.` : undefined,
    todo: live.state === 'offline' ? 'Check your network; the app keeps what it had and catches up when it is back.' : undefined,
  })
  if (config.data) {
    const f = config.data.features
    lines.push({ id: 'voice', what: 'Voice (reading aloud and dictation)', status: f.voice ? 'verified' : 'idle', word: f.voice ? 'On' : 'Off', todo: f.voice ? undefined : 'Turn it on in the installer\'s Advanced settings.' })
    lines.push({ id: 'email', what: 'Email notifications', status: f.email ? 'verified' : 'idle', word: f.email ? 'On' : 'Off', detail: f.email ? undefined : 'In-app only until a sender is verified.', todo: f.email ? undefined : 'Set up email in the installer\'s optional step.' })
    lines.push({ id: 'ops', what: 'Operations (CloudWatch dashboards)', status: f.ops ? 'verified' : 'idle', word: f.ops ? 'On' : 'Off' })
    lines.push(wafLine(config.data.waf))
  }
  repos.forEach((repo, i) => {
    const s = statuses[i]
    if (!s) return
    if (s.isLoading) return
    if (s.isError) {
      lines.push({ id: `p-${repo}`, what: `${projectName(repo)}: repository and build runner`, status: 'warning', word: 'Could not check', detail: s.error instanceof Error ? s.error.message : undefined, todo: 'Check the GitHub connection is authorised for this repository.' })
      return
    }
    const d = s.data!
    const deploy = d.last_deploy as { conclusion?: string; status?: string } | null
    const failed = deploy?.conclusion === 'failure'
    lines.push({
      id: `p-${repo}`, what: `${projectName(repo)}: repository and build runner`, status: failed ? 'failing' : 'verified', word: failed ? 'Last deploy failed' : 'Connected',
      detail: `Default branch ${d.default_branch}; ${d.pulls.length} open pull request${d.pulls.length === 1 ? '' : 's'}.`,
      todo: failed ? 'Open the failed deploy in GitHub Actions.' : undefined,
    })
  })

  const projectWaits = waits.flatMap((w, i) => (w.data?.waits ?? []).map((x) => ({ ...x, project: projectName(repos[i] ?? '') })))
  const loading = config.isLoading || who.isLoading || projects.isLoading

  return (
    <Column>
      <h1 className="text-2xl font-semibold tracking-tight">Installation</h1>
      <p className="mt-1 text-[15px] text-muted-foreground">How this installation of trace is doing, and the keys it can use.</p>

      <Section label="Health" className="mt-8">
        {loading ? (
          <Loading><SkeletonRows rows={4} /></Loading>
        ) : (
          <ul className="divide-y rounded-xl border bg-card">
            {lines.map((l) => (
              <li key={l.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-5 py-3.5" data-density-item>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{l.what}</p>
                  {l.detail && <p className="mt-0.5 text-xs text-muted-foreground">{l.detail}</p>}
                  {l.todo && <p className="mt-1 text-xs"><span className="font-medium">What to do: </span>{l.todo}</p>}
                </div>
                <StatusBadge status={l.status} label={l.word} />
              </li>
            ))}
            {projectWaits.map((w) => (
              <li key={w.id}><WaitLine wait={w} project={w.project} onCheckNow={(x) => call('tools.check_now', { repo: x.repo ?? '', waitId: x.id })} /></li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Not shown yet, because the API has no read for them: the graphics card image build, each project's knowledge base sync state and its build runner's own health. They will appear here as Wait lines when the API reports them.
        </p>
      </Section>

      <Section label="Optional keys">
        {integrations.isError ? (
          <QueryError error={integrations.error} what="the optional keys" onRetry={() => void integrations.refetch()} />
        ) : integrations.isLoading ? (
          <Loading><SkeletonRows rows={3} /></Loading>
        ) : (
          <ul className="divide-y rounded-xl border bg-card">
            {(integrations.data ?? []).map((i) => (
              <li key={i.name} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start" data-density-item>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {i.title}
                    <StatusBadge status={i.configured ? 'verified' : 'idle'} label={i.configured ? 'Key added' : 'No key'} />
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{OPTIONAL_LINE}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{i.enables}</p>
                  {i.configured && (
                    <p className="mt-1 text-xs">
                      {i.last4 ? <>Ends in <span className="font-mono">…{i.last4}</span>. </> : 'Stored; trace never shows a key again. '}
                      {i.changed && `Changed ${ago(i.changed)}.`}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant={i.configured ? 'outline' : 'default'} onClick={() => setEditing(i)}>{i.configured ? 'Replace' : 'Add key'}</Button>
                  {i.configured && <Button size="sm" variant="ghost" onClick={() => setRemoving(i)} aria-label={`Remove the ${i.title} key`}><Trash2 /> Remove</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section label="Dashboards for Operations">
        <div className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
          <p>
            Operations draws the CloudWatch dashboards the installer created. Listing them here, adding others by name, and choosing who may see each widget (Admins, Project members, or Everyone for health only) needs an API action that does not exist yet; until then the list is set in the installer, and new widgets stay admin-only.
          </p>
          <Button asChild size="sm" variant="outline" className="mt-3">
            <a href="/ops">Open Operations</a>
          </Button>
        </div>
      </Section>

      <KeySheet integration={editing} onClose={() => setEditing(null)} onSaved={() => void qc.invalidateQueries({ queryKey: ['integrations.list'] })} />
      <AlertDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the {removing?.title} key?</AlertDialogTitle>
            <AlertDialogDescription>Parts search keeps working without it, but stops showing live stock and prices from {removing?.title}. Workers notice when they next start.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!removing) return
                try {
                  await call('integrations.remove', { name: removing.name })
                  toast(`The ${removing.title} key is removed.`)
                  await qc.invalidateQueries({ queryKey: ['integrations.list'] })
                } catch (e) {
                  toast.error(`Could not remove it: ${e instanceof Error ? e.message : String(e)}`)
                }
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Column>
  )
}

const KEY_WORDS: Record<string, string> = {
  NEXAR_CLIENT_ID: 'Client ID', NEXAR_CLIENT_SECRET: 'Client secret', MOUSER_API_KEY: 'API key', DIGIKEY_CLIENT_ID: 'Client ID', DIGIKEY_CLIENT_SECRET: 'Client secret',
}

function KeySheet({ integration: i, onClose, onSaved }: { integration: IntegrationStatus | null; onClose: () => void; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const ready = !!i && i.keys.every((k) => (values[k] ?? '').trim())
  const save = async () => {
    if (!i) return
    setSaving(true)
    try {
      const r = await call('integrations.set', { name: i.name as IntegrationName, values: Object.fromEntries(i.keys.map((k) => [k, values[k]!.trim()])) })
      const ends = lastFour(values[i.keys[i.keys.length - 1]!] ?? '')
      if (r.check.ok) toast(`${i.title} key saved, ending in …${ends}. ${r.check.detail}`)
      else toast.warning(`${i.title} key saved, ending in …${ends}, but the check failed: ${r.check.detail}`)
      setValues({})
      onSaved()
      onClose()
    } catch (e) {
      toast.error(`Could not save the key: ${e instanceof Error ? e.message : String(e)}. Nothing was stored.`)
    } finally {
      setSaving(false)
    }
  }
  return (
    <SideSheet
      open={!!i}
      onOpenChange={(o) => { if (!o) { setValues({}); onClose() } }}
      title={i ? `${i.configured ? 'Replace' : 'Add'} the ${i.title} key` : ''}
      description="Entered once and stored in the installation's secrets. trace never shows it again; only its last four characters are named when it is saved."
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!ready || saving} onClick={() => void save()}>{saving && <Loader2 className="animate-spin" />}Check and save</Button></>}
    >
      {i && (
        <div className="space-y-4">
          {i.keys.map((k) => (
            <div key={k} className="space-y-1.5">
              <Label htmlFor={`key-${k}`}>{KEY_WORDS[k] ?? k} <span className="font-mono text-xs font-normal text-muted-foreground">{k}</span></Label>
              <Input id={`key-${k}`} type="password" autoComplete="off" spellCheck={false} value={values[k] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))} />
              {(values[k] ?? '').trim().length >= 4 && <p className="text-xs text-muted-foreground">Ends in <span className="font-mono">…{lastFour(values[k]!)}</span></p>}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">{i.enables}</p>
          <a href={i.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            Get a key from {new URL(i.url).hostname} <ExternalLink className="size-3.5" />
          </a>
          <p className="text-xs text-muted-foreground">Saving checks the key with {i.title} first; a failed check is reported but the key is still kept, so you can fix it on their side.</p>
        </div>
      )}
    </SideSheet>
  )
}
