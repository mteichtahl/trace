/**
 * Deploys on the project's Build tab (docs/stay-in-trace.md "2. Deploys"). A deploy used to wait for someone to comment
 * on GitHub; now the person decides here:
 *
 *   - a request waiting, for a person who may decide (a trace admin, or named in the project's deploy setting): a
 *     "Needs you" card, "Deploy Soil sensor to bench?", the changes since what runs now, trace's recommendation with
 *     its reason, and Deploy / Skip this one. Skipping asks why, in one line, before it sends.
 *   - anyone else sees the same request read-only, with who may decide.
 *   - a deploy running now: its step, live (deploys.get is read again every few seconds while one runs).
 *   - what happened lately: deployed, failed, rolled back, skipped, by whom and when. An earlier deployed entry has
 *     Roll back, which confirms first.
 *
 * GitHub's own pages (the deploy workflow) are only in the admins' More menu (MoreForAdmins). Data: deploys.get,
 * deploy.approve, deploy.skip, deploy.rollback.
 */
import { useQuery } from '@tanstack/react-query'
import { Loader2, Rocket, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { MoreForAdmins } from '@/components/more-for-admins'
import { StatusBadge, type Status } from '@/components/status-badge'
import { EmptyState, QueryError } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { projectName } from '@/lib/api'
import { ago } from '@/lib/format'
import { q, useCall } from '@/lib/queries'
import type { DeployResult, DeploysView } from '@/lib/types'
import { cn } from '@/lib/utils'

/** A commit as people read it: its first seven characters. */
export const shortSha = (sha: string): string => sha.slice(0, 7)

/** Each result's badge. */
export const RESULT: Record<DeployResult, { status: Status; label: string }> = {
  deployed: { status: 'done', label: 'Deployed' },
  failed: { status: 'failing', label: 'Failed' },
  rolled_back: { status: 'warning', label: 'Rolled back' },
  skipped: { status: 'waived', label: 'Skipped' },
}

/** The recommendation's lead words. */
export const VERDICT_WORDS: Record<DeploysView['recommendation']['verdict'], string> = { deploy: 'Deploy it.', wait: 'Wait.', none: '' }

/** A reason in one line, 3 to 300 characters, or null when it is not one yet. */
export function skipReason(s: string): string | null {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length >= 3 && t.length <= 300 ? t : null
}

/** The commits Roll back is offered on: deployed earlier, not what runs now, at most one per commit. */
export function rollbackTargets(v: Pick<DeploysView, 'recent' | 'running'>): Set<string> {
  const out = new Set<string>()
  for (const r of v.recent) if ((r.result === 'deployed' || r.result === 'rolled_back') && r.sha !== v.running?.sha) out.add(r.sha)
  return out
}

export interface DeploysCardProps {
  view: DeploysView
  /** the project's name, for "Deploy Soil sensor to bench?" */
  project: string
  onDeploy?: (sha: string) => void
  onSkip?: (reason: string) => Promise<void> | void
  onRollback?: (sha: string) => void
  busy?: 'deploy' | 'skip' | 'rollback' | null
  /** admins only: GitHub's page for the deploy workflow */
  adminLinks?: { label: string; href: string }[]
}

/** The request as a "Needs you" card (or read-only, for a person who may not decide). */
function RequestCard({ view: v, project, onDeploy, onSkip, busy }: DeploysCardProps) {
  const r = v.request!
  const [skipping, setSkipping] = useState(false)
  const [reason, setReason] = useState('')
  const decide = v.may_approve && !v.in_progress
  const rec = v.recommendation
  const n = r.commits.length
  return (
    <section
      className={cn('rounded-xl border p-5 md:p-6', decide ? 'border-primary/40 bg-primary-soft' : 'bg-card')}
      aria-labelledby="deploy-request-title"
      data-density-item
    >
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        {decide && <span className="size-2 shrink-0 rounded-full bg-primary" aria-hidden />}
        <span className="sr-only">{decide ? 'Your move. ' : ''}</span>
        Deploy · waiting {ago(r.opened_at).replace(/ ago$/, '')}
        {r.held && <StatusBadge plain status="warning" label="Held by the risk check" className="ml-1" />}
      </p>
      <h3 id="deploy-request-title" className="mt-1.5 text-xl font-semibold">Deploy {project} to {v.environment}?</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {v.running ? `${v.environment} runs ${shortSha(v.running.sha)} now. ` : `Nothing is recorded as running in ${v.environment} yet. `}
        {n ? `${n} change${n === 1 ? '' : 's'} since then:` : `This is ${shortSha(r.sha)}.`}
        {!r.build_passed && ' Its build has not passed yet.'}
      </p>
      {n > 0 && (
        <ul className="mt-3 space-y-1 text-sm" aria-label="Changes since what runs now">
          {r.commits.map((c) => (
            <li key={c.sha} className="flex gap-3">
              <span className="font-mono text-xs leading-5 text-muted-foreground">{shortSha(c.sha)}</span>
              <span className="min-w-0 flex-1">{c.subject}</span>
            </li>
          ))}
        </ul>
      )}
      {r.held && r.held_reasons.length > 0 && (
        <div className="mt-3 rounded-lg border bg-background px-4 py-3 text-sm">
          <p className="font-medium">Why the risk check held it</p>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">{r.held_reasons.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      )}
      <div className="mt-4 flex gap-3 rounded-lg border bg-background px-4 py-3 text-sm">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <p>
          <span className="font-semibold text-primary">trace recommends: {VERDICT_WORDS[rec.verdict] || 'Nothing to do yet.'}</span> <span>{rec.why}</span>
        </p>
      </div>
      {decide ? (
        skipping ? (
          <form
            className="mt-4 space-y-2"
            onSubmit={(e) => {
              e.preventDefault()
              const why = skipReason(reason)
              if (why) void Promise.resolve(onSkip?.(why)).then(() => setSkipping(false), () => undefined)
            }}
          >
            <Label htmlFor="deploy-skip-reason">Why skip it?</Label>
            <Textarea id="deploy-skip-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wait for the bench to be free on Friday" />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="outline" disabled={!skipReason(reason) || busy === 'skip'}>{busy === 'skip' && <Loader2 className="animate-spin" />}Skip this one</Button>
              <Button type="button" variant="ghost" onClick={() => setSkipping(false)}>Keep it waiting</Button>
            </div>
          </form>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="lg" onClick={() => onDeploy?.(r.sha)} disabled={!r.build_passed || busy === 'deploy'}>
              {busy === 'deploy' ? <Loader2 className="animate-spin" /> : <Rocket aria-hidden />}Deploy
            </Button>
            <Button size="lg" variant="outline" className="bg-background" onClick={() => setSkipping(true)}>Skip this one</Button>
          </div>
        )
      ) : (
        !v.in_progress && <p className="mt-4 text-sm text-muted-foreground">A trace admin, or someone named in the project's deploy setting, decides this.</p>
      )}
    </section>
  )
}

/** Everything about the project's deploys, from deploys.get, with the decisions as callbacks. */
export function DeploysCard(props: DeploysCardProps) {
  const { view: v, onRollback, busy, adminLinks } = props
  const [confirm, setConfirm] = useState<string | null>(null)
  if (!v.enabled) return <EmptyState>{v.recommendation.why}</EmptyState>
  const targets = rollbackTargets(v)
  const p = v.in_progress
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium">{v.environment}</span>
        <span className="text-muted-foreground">
          {v.running ? <>runs <span className="font-mono text-xs">{shortSha(v.running.sha)}</span>{v.running.at && `, deployed ${ago(v.running.at)}`}</> : 'nothing deployed yet'}
          {v.auto && ' · deploys on its own when the build passes'}
        </span>
        {v.url && <a className="text-primary underline-offset-4 hover:underline" href={v.url} target="_blank" rel="noreferrer">Open {v.environment}</a>}
        <MoreForAdmins links={adminLinks ?? []} className="ml-auto" />
      </div>

      {p && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border p-5 text-sm" role="status" aria-live="polite">
          <StatusBadge status="running" label={p.step ?? 'Deploying'} />
          <span>Deploying <span className="font-mono text-xs">{shortSha(p.sha)}</span> to {v.environment}, approved by {p.by}, started {ago(p.started_at)}.</span>
        </div>
      )}

      {v.request && <RequestCard {...props} />}
      {!v.request && !p && <EmptyState>{v.recommendation.why}</EmptyState>}

      {v.recent.length > 0 && (
        <ul className="divide-y rounded-xl border" aria-label="Recent deploys">
          {v.recent.map((r, i) => (
            <li key={`${r.sha}-${r.at}-${i}`} className="flex flex-wrap items-center gap-3 px-5 py-3.5 text-sm">
              <span className="font-mono text-xs">{shortSha(r.sha)}</span>
              <span className="text-muted-foreground">by {r.by} {ago(r.at)}</span>
              {v.running?.sha === r.sha && (r.result === 'deployed' || r.result === 'rolled_back') && <span className="text-xs text-muted-foreground">runs now</span>}
              <StatusBadge status={RESULT[r.result].status} label={RESULT[r.result].label} className="ml-auto" />
              {v.may_approve && !p && targets.has(r.sha) && (confirm === r.sha ? (
                <span className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
                  <span className="text-xs">Put {shortSha(r.sha)} back in {v.environment}?</span>
                  <Button size="sm" variant="destructive" disabled={busy === 'rollback'} onClick={() => { targets.delete(r.sha); onRollback?.(r.sha); setConfirm(null) }}>
                    {busy === 'rollback' && <Loader2 className="animate-spin" />}Roll back
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Keep what runs</Button>
                </span>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setConfirm(r.sha)}>Roll back</Button>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The Deploys panel of a project: reads deploys.get (again every 4 s while a deploy runs) and sends the decisions. */
export function DeploysPanel({ repo }: { repo: string }) {
  const d = useQuery({ ...q('deploys.get', { repo }), refetchInterval: (query) => (query.state.data?.in_progress ? 4_000 : 60_000) })
  const inval = (a: { repo: string }) => [['deploys.get', a.repo], ['inbox']]
  const approve = useCall('deploy.approve', inval)
  const skip = useCall('deploy.skip', inval)
  const rollback = useCall('deploy.rollback', inval)
  if (d.isError) return <QueryError error={d.error} what="the deploys" onRetry={() => void d.refetch()} />
  if (!d.data) return <div className="h-24 animate-pulse rounded-xl border bg-muted/40" aria-label="Loading the deploys" />
  const busy = approve.isPending ? 'deploy' : skip.isPending ? 'skip' : rollback.isPending ? 'rollback' : null
  return (
    <DeploysCard
      view={d.data}
      project={projectName(repo)}
      busy={busy}
      adminLinks={[{ label: 'The deploy workflow on GitHub', href: `https://github.com/${repo}/actions/workflows/trace-deploy.yml` }]}
      onDeploy={(sha) => approve.mutate({ repo, sha }, {
        onSuccess: (r) => toast('Deploy started.', { description: r.next }),
        onError: (e) => toast.error('It was not deployed.', { description: e instanceof Error ? e.message : String(e) }),
      })}
      onSkip={(reason) => skip.mutateAsync({ repo, reason }).then(
        () => { toast('Skipped. The next commit that passes asks again.') },
        (e: unknown) => { toast.error('It was not skipped. What you typed is kept.', { description: e instanceof Error ? e.message : String(e) }); throw e },
      )}
      onRollback={(to) => rollback.mutate({ repo, to }, {
        onSuccess: () => toast('Rollback started.', { description: `trace is putting ${shortSha(to)} back. Its progress shows here.` }),
        onError: (e) => toast.error('It was not rolled back.', { description: e instanceof Error ? e.message : String(e) }),
      })}
    />
  )
}
