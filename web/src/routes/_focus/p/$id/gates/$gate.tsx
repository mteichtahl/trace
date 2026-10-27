/**
 * Gate review and signing (/p/:id/gates/:gate): the Gate signing skill in Focus mode. Its one job is to make the
 * signer open the evidence before Sign wakes up (docs/ui-design.md, "Gates and signing"):
 *
 *   recommendation (Decision card, alternative folded) · criteria (Data table: status, evidence, Opened, Open evidence)
 *   · waivers taken in this stage (Acknowledge) · cost and time · notes · Return / Sign
 *
 * Open evidence shows the run or record in a side panel (a drawer on phones) and records journey.criterion.open; only
 * that ticks "Opened". Sign stays disabled until every criterion is met or waived, every piece of evidence is opened
 * and every waiver acknowledged; its tooltip lists what is missing. Sign restates the act in a dialog, and at the
 * release and order gates asks for the passkey (or an email code) again. Return needs a reason. Non-admins see
 * "Waiting for an admin to sign" with the admins' names. A signed or returned gate reads as its record (a receipt).
 */
import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { ArrowRight, CircleAlert, Clock, KeyRound, Loader2, Lock, Receipt, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTraceContext } from '@/components/chat/context'
import { DataTable } from '@/components/data-table'
import { DecisionCard } from '@/components/decision-card'
import { EvidenceChip } from '@/components/evidence-chip'
import { Rich } from '@/components/rich'
import { useCommands } from '@/components/shell/command-menu'
import { LiveDot } from '@/components/shell/live-dot'
import { EvidenceBody, EvidencePanel } from '@/components/skills/evidence-sheet'
import { type Blocker, isOpened, needsReauth, returnReasonOk, signBlockers, signLabel } from '@/components/skills/gate-rules'
import { reauthenticate } from '@/components/skills/reauth'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState, ErrorState, Loading, NotShared, OfflineBanner, QueryError } from '@/components/states'
import { useMediaQuery } from '@/hooks/use-media-query'
import { ApiError, projectId, projectName, repoOf } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ago, money } from '@/lib/format'
import { useLiveStatus } from '@/lib/live'
import { q, useCall, useJourney } from '@/lib/queries'
import type { Criterion, Journey } from '@/lib/types'
import type { GateMore } from '@/lib/types-s1'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_focus/p/$id/gates/$gate')({ component: GatePage })

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const gateTitle = (g: GateMore) => cap(g.name.replace(/^the /, ''))

function GatePage() {
  const { id, gate: gateId } = Route.useParams()
  const repo = repoOf(id)
  const router = useRouter()
  const j = useJourney(repo)
  const close = () => (window.history.length > 1 ? router.history.back() : void router.navigate({ to: '/p/$id', params: { id } }))
  const g = j.data?.gates.find((x) => x.id === gateId) as GateMore | undefined
  const from = j.data?.stages.find((s) => s.id === g?.after)
  const to = j.data && from ? j.data.stages[j.data.stages.indexOf(from) + 1] : undefined
  const name = j.data?.name ?? projectName(repo)

  useTraceContext({ label: g ? gateTitle(g) : 'Gate', description: 'The gate the person is reviewing', value: { repo, gate: gateId, state: g?.state ?? null } }, 'gate')

  return (
    <div className="flex h-dvh flex-col bg-background" role="main" aria-label={g ? gateTitle(g) : 'Gate'}>
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b px-4">
        <Button variant="outline" size="icon" onClick={close} aria-label="Close and return">
          <X />
        </Button>
        <div className="min-w-0 flex-1 truncate">
          <span className="font-semibold">{g ? gateTitle(g) : 'Gate'}</span>
          <span className="ml-3 hidden text-sm text-muted-foreground sm:inline">
            {[name, j.data?.revision, from && to ? `${from.name} → ${to.name}` : from?.name].filter(Boolean).join(' · ')}
          </span>
        </div>
        <LiveDot />
      </header>
      <OfflineBanner />
      {j.isError ? (
        j.error instanceof ApiError && j.error.noAccess ? <NotShared /> : <div className="p-6"><QueryError error={j.error} what="this gate" onRetry={() => void j.refetch()} /></div>
      ) : !j.data ? (
        <Loading loading={j.isLoading}>
          <div className="mx-auto w-full max-w-[880px] space-y-4 px-4 py-8 md:px-8">
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-36 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        </Loading>
      ) : !g ? (
        <div className="mx-auto w-full max-w-[880px] px-4 py-10 md:px-8">
          <EmptyState action={<Button asChild variant="outline"><Link to="/p/$id" params={{ id }}>Back to the project</Link></Button>}>
            {name} has no gate called “{gateId}”. Its template sets which gates it has.
          </EmptyState>
        </div>
      ) : g.state === 'signed' || g.state === 'returned' ? (
        <GateRecord journey={j.data} gate={g} />
      ) : g.state === 'locked' ? (
        <div className="mx-auto w-full max-w-[880px] px-4 py-10 md:px-8">
          <h1 className="text-2xl font-semibold tracking-tight">{gateTitle(g)}</h1>
          <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
            <Lock className="size-4" aria-hidden /> Queued: this gate opens when {from?.name ?? 'its stage'} starts. Stages after the current gate are visible but locked.
          </p>
        </div>
      ) : (
        <GateReview journey={j.data} gate={g} onDone={close} />
      )}
    </div>
  )
}

// ------------------------------------------------------------------ review and sign

function GateReview({ journey: j, gate: g, onDone }: { journey: Journey; gate: GateMore; onDone: () => void }) {
  const repo = j.repo
  const id = projectId(repo)
  const { user } = useAuth()
  const live = useLiveStatus()
  const admin = user?.class === 'admin'
  const wide = useMediaQuery('(min-width: 1280px)')
  const members = useQuery(q('project.members', { repo }))
  const admins = (members.data ?? []).filter((m) => m.admin || m.class === 'admin')
  const [opened, setOpened] = useState<Set<string>>(new Set())
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set())
  const [showing, setShowing] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [returning, setReturning] = useState(false)
  const from = j.stages.find((s) => s.id === g.after)
  const to = from ? j.stages[j.stages.indexOf(from) + 1] : undefined
  const label = signLabel(g.name)
  const openCriterion = useCall('journey.criterion.open')

  const state = { opened, acknowledged, admin, online: live.state !== 'offline' }
  const blockers = signBlockers(g, state)
  const ready = blockers.length === 0
  const openedCount = g.criteria.filter((c) => isOpened(c, state)).length
  const metCount = g.criteria.filter((c) => c.status !== 'not_met').length
  const waivedCount = g.criteria.filter((c) => c.status === 'waived').length

  const open = (c: Criterion) => {
    setShowing(c.id)
    if (isOpened(c, state)) return
    setOpened((s) => new Set([...s, c.id]))
    openCriterion.mutate({ repo, gate: g.id, criterion: c.id }, {
      onError: () => {
        setOpened((s) => { const n = new Set(s); n.delete(c.id); return n })
        toast.error('Could not record that you opened this evidence. Open it again when back online.')
      },
    })
  }
  const shown = g.criteria.find((c) => c.id === showing)

  useCommands([
    { id: 'gate-sign', label, run: () => (ready ? setConfirm(true) : toast(blockers[0]?.text ?? '')) },
    { id: 'gate-return', label: `Return ${from?.name ?? 'the stage'}`, run: () => setReturning(true) },
    ...g.criteria.map((c) => ({ id: `gate-ev-${c.id}`, label: `Open evidence: ${c.text}`, run: () => open(c) })),
  ])
  useTraceContext(shown ? { label: shown.evidence?.label ?? shown.text, description: 'The evidence the signer has open', value: { criterion: shown.text, evidence: shown.evidence ?? null }, mono: shown.evidence?.kind === 'run' } : null, 'gate-evidence')

  const columns = useMemo<ColumnDef<Criterion, any>[]>(() => [
    { accessorKey: 'text', header: 'Criterion', size: 260, meta: { label: 'Criterion', kind: 'text' } },
    {
      accessorKey: 'status', header: 'Status', size: 130, meta: { label: 'Status', kind: 'enum' },
      cell: ({ row }) => <StatusBadge status={row.original.status === 'not_met' ? 'not_met' : 'met'} label={row.original.status === 'waived' ? 'Met (waived)' : row.original.status === 'met' ? (g.waivers.length && row.index === 0 ? `Met (${g.waivers.length} waived)` : 'Met') : 'Not met'} />,
    },
    { id: 'evidence', accessorFn: (c) => c.evidence?.label ?? '', header: 'Evidence', size: 160, meta: { label: 'Evidence', kind: 'text', mono: true } },
    {
      id: 'opened', accessorFn: (c) => (isOpened(c, state) ? 'Opened' : 'Not yet'), header: 'Opened', size: 100, meta: { label: 'Opened', kind: 'enum' },
      cell: ({ row }) => (isOpened(row.original, state) ? <StatusBadge status="opened" /> : <span className="text-xs text-muted-foreground">Not yet</span>),
    },
    {
      id: 'open', header: '', size: 140, enableSorting: false, meta: { label: 'Open evidence' },
      cell: ({ row }) => (
        <Button variant="outline" size="sm" className={cn(!isOpened(row.original, state) && 'border-primary text-primary')} onClick={(e) => { e.stopPropagation(); open(row.original) }} disabled={!row.original.evidence}>
          Open evidence
        </Button>
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [opened, g])

  const rec = g.recommendation
  const signers = admins.map((m) => m.name ?? m.email)

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-4 pb-40 pt-6 md:px-8 md:pb-16 md:pt-8">
          <h1 className="text-2xl font-semibold tracking-tight">{label}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Signing moves {j.name} {j.revision} from {from?.name ?? 'this stage'} to {to?.name ?? 'the next stage'}. Open the evidence for each criterion before you sign.
          </p>

          {rec && (
            <DecisionCard
              className="mt-6"
              actions={false}
              decision={{
                recommended: 'rec',
                options: [
                  { id: 'rec', ...splitRecommendation(rec.summary) },
                  { id: 'alt', label: rec.sign ? `Return to ${from?.name ?? 'the stage'}` : 'Sign' },
                ],
                evidence: rec.evidence,
                givesUp: rec.givesUp,
              }}
              onChoose={() => undefined}
            />
          )}

          <section className="mt-8" aria-labelledby="criteria">
            <h2 id="criteria" className="text-lg font-semibold">
              Criteria <span className="ml-1 text-sm font-normal text-muted-foreground">{metCount} met{waivedCount ? ` (${waivedCount} waived)` : ''} · evidence opened for {openedCount} of {g.criteria.length}</span>
            </h2>
            <div className="mt-3">
              {g.criteria.length === 0 ? (
                <EmptyState>The checker has not reported this gate's criteria yet. They appear here when it does.</EmptyState>
              ) : (
                <DataTable id="gate-criteria" data={g.criteria} columns={columns} getRowId={(c) => c.id} noun="rows" persist={false} onRowClick={(c) => open(c)} />
              )}
            </div>
          </section>

          <section className="mt-8 rounded-xl border p-5 md:p-6" aria-labelledby="waivers">
            <h2 id="waivers" className="text-lg font-semibold">Waivers taken in {from?.name ?? 'this stage'} ({g.waivers.length})</h2>
            {g.waivers.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No waivers were taken in this stage.</p>
            ) : (
              <ul className="mt-3 divide-y">
                {g.waivers.map((w) => {
                  const ack = !!w.acknowledged || acknowledged.has(w.id)
                  return (
                    <li key={w.id} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex gap-3">
                        <span className="h-fit rounded border bg-muted px-1.5 font-mono text-xs text-muted-foreground">{w.id}</span>
                        <div className="min-w-0 flex-1 space-y-1 text-sm">
                          <p className="font-medium">{w.title}</p>
                          <p><span className="text-muted-foreground">Reason: </span>{w.reason}</p>
                          <p className="flex items-center gap-1.5"><span className="text-muted-foreground">Risk: </span><StatusBadge status={w.risk === 'major' ? 'failing' : 'warning'} label={cap(w.risk)} /></p>
                          <p><span className="text-muted-foreground">Caught: </span>{w.caught}</p>
                        </div>
                      </div>
                      <Label className="mt-3 flex cursor-pointer items-center gap-2 border-t pt-3 font-normal">
                        <Checkbox checked={ack} disabled={!!w.acknowledged} onCheckedChange={(v) => {
                          setAcknowledged((s) => { const n = new Set(s); if (v) n.add(w.id); else n.delete(w.id); return n })
                          // the record needs the signer to have opened each waiver of the stage, as for the evidence
                          if (v) openCriterion.mutate({ repo, waiver: w.id }, { onError: () => toast.error('Could not record that you read this waiver. Tick it again when back online.') })
                        }} />
                        Acknowledge: I've read this waiver and where it is caught.
                      </Label>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {(g.forecast || g.spend) && (
            <div className="mt-6 space-y-1 text-sm">
              {g.forecast && <p className="flex items-start gap-2"><Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden /><span><Rich text={g.forecast} /></span></p>}
              {g.spend && (
                <p className="flex items-start gap-2">
                  <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span><strong>This gate commits {money(g.spend.total, g.spend.currency)}.</strong> {g.spend.changed}</span>
                </p>
              )}
            </div>
          )}

          <div className="mt-6 space-y-1.5">
            <Label htmlFor="gate-notes">Notes <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Textarea id="gate-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything you're uneasy about but won't block on. Saved with the gate record." />
          </div>

          {/* Sign or return (desktop); on phones the footer below holds them */}
          <div className="mt-6 hidden flex-wrap items-center gap-3 border-t pt-5 md:flex">
            <Button variant="outline" onClick={() => setReturning(true)} disabled={live.state === 'offline'}>Return</Button>
            <div className="ml-auto flex items-center gap-3">
              {admin ? (
                <>
                  {!ready && <span className="text-sm text-muted-foreground">{blockers[0]?.text} to sign</span>}
                  <SignButton label={label} blockers={blockers} onSign={() => setConfirm(true)} />
                </>
              ) : (
                <WaitingForAdmin names={signers} />
              )}
            </div>
          </div>
        </div>
      </div>

      {wide && shown && <EvidencePanel repo={repo} criterion={shown} opened={isOpened(shown, state)} onClose={() => setShowing(null)} />}
      {!wide && (
        <Drawer open={!!shown} onOpenChange={(o) => !o && setShowing(null)}>
          <DrawerContent className="max-h-[88dvh]">
            <DrawerHeader>
              <DrawerTitle>{shown?.evidence?.kind === 'run' ? 'Run' : 'Record'} · <span className="font-mono">{shown?.evidence?.label}</span></DrawerTitle>
              <p className="text-xs text-muted-foreground">Criterion: {shown?.text}</p>
            </DrawerHeader>
            <div className="overflow-y-auto px-4 pb-6">{shown && <EvidenceBody repo={repo} criterion={shown} opened={isOpened(shown, state)} />}</div>
          </DrawerContent>
        </Drawer>
      )}

      {/* phone footer */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 backdrop-blur md:hidden">
        {admin ? (
          <>
            {!ready && <p className="mb-2 flex items-center gap-2 text-sm text-muted-foreground"><CircleAlert className="size-4" aria-hidden />{blockers[0]?.text} to sign</p>}
            <Button className="h-12 w-full text-base" disabled={!ready} onClick={() => setConfirm(true)}>{label}</Button>
          </>
        ) : (
          <WaitingForAdmin names={signers} />
        )}
        <Button variant="ghost" className="mt-1 w-full" onClick={() => setReturning(true)}>Return…</Button>
      </div>

      <SignDialog open={confirm} onOpenChange={setConfirm} journey={j} gate={g} to={to?.name} notes={notes} acknowledged={[...acknowledged]} onSigned={onDone} />
      <ReturnDialog open={returning} onOpenChange={setReturning} repo={repo} gate={g} stage={from?.name} id={id} onReturned={onDone} />
    </div>
  )
}

/** "**trace recommends signing.** All 6 criteria…" → the bold part as the option, the rest as its detail. */
export function splitRecommendation(summary: string): { label: string; detail?: string } {
  const m = /^\*\*(.+?)\*\*\s*(.*)$/s.exec(summary.trim())
  return m ? { label: m[1]!, detail: m[2] || undefined } : { label: summary }
}

function SignButton({ label, blockers, onSign }: { label: string; blockers: Blocker[]; onSign: () => void }) {
  const button = <Button size="lg" disabled={blockers.length > 0} onClick={onSign}>{label}</Button>
  if (!blockers.length) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild><span tabIndex={0}>{button}</span></TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p className="mb-1 font-medium">Still missing:</p>
        <ul className="list-disc pl-4">{blockers.map((b) => <li key={b.id}>{b.text}</li>)}</ul>
      </TooltipContent>
    </Tooltip>
  )
}

function WaitingForAdmin({ names }: { names: string[] }) {
  return (
    <p className="text-sm text-muted-foreground" role="status">
      <StatusBadge status="waiting" label="Waiting for an admin to sign" className="mr-2" />
      {names.length ? names.join(', ') : 'An admin'} can sign this gate. You can open the evidence and leave notes.
    </p>
  )
}

// ------------------------------------------------------------------ the confirmation, with the re-check for spend gates

function SignDialog({ open, onOpenChange, journey: j, gate: g, to, notes, acknowledged, onSigned }: {
  open: boolean; onOpenChange: (o: boolean) => void; journey: Journey; gate: GateMore; to?: string; notes: string; acknowledged: string[]; onSigned: () => void
}) {
  const { user } = useAuth()
  const sign = useCall('gate.sign', (a) => [['journey.get', a.repo], ['inbox']])
  const reauth = needsReauth(g.id)
  const [checking, setChecking] = useState<'idle' | 'busy' | 'code'>('idle')
  const [code, setCode] = useState('')
  const [complete, setComplete] = useState<((c: string) => Promise<boolean>) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const label = signLabel(g.name)

  const doSign = () =>
    sign.mutate({ repo: j.repo, gate: g.id, notes: notes || undefined, acknowledge: acknowledged }, {
      onSuccess: (r) => {
        onOpenChange(false)
        toast(`${cap(g.name.replace(/^the /, ''))} signed.`, { description: r.started?.length ? `Started: ${r.started.join('; ')}` : `${to ?? 'The next stage'} starts now.` })
        onSigned()
      },
      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
    })

  const go = async () => {
    setError(null)
    if (!reauth) return doSign()
    setChecking('busy')
    try {
      const r = await reauthenticate(user?.email ?? '')
      if (r.done) { setChecking('idle'); return doSign() }
      setComplete(() => r.complete)
      setChecking('code')
    } catch (e) {
      setChecking('idle')
      setError(e instanceof DOMException && e.name === 'NotAllowedError' ? 'The passkey was not used. Try again.' : e instanceof Error ? e.message : String(e))
    }
  }
  const finishCode = async () => {
    if (!complete) return
    setChecking('busy')
    try {
      if (await complete(code)) { setChecking('idle'); doSign() } else { setChecking('code'); setError('That code did not work. Check the newest email and try again.') }
    } catch (e) {
      setChecking('code')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { setChecking('idle'); setError(null); setCode('') } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{label}?</DialogTitle>
          <DialogDescription>
            You are signing {g.name} for {j.name} {j.revision}. {to ? `${to} work starts as soon as you sign.` : 'The next stage starts as soon as you sign.'}
            {acknowledged.length > 0 && ` You acknowledged ${acknowledged.join(', ')}.`}
          </DialogDescription>
        </DialogHeader>
        {reauth && (
          <p className="flex items-start gap-2 rounded-md bg-muted p-3 text-sm">
            <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
            This gate commits money, so trace asks for your passkey again before it signs{g.spend ? `: ${money(g.spend.total, g.spend.currency)}` : ''}.
          </p>
        )}
        {checking === 'code' && (
          <div className="space-y-2">
            <Label>The code we just emailed you</Label>
            <InputOTP maxLength={6} value={code} onChange={setCode}>
              <InputOTPGroup>{[0, 1, 2, 3, 4, 5].map((i) => <InputOTPSlot key={i} index={i} />)}</InputOTPGroup>
            </InputOTP>
          </div>
        )}
        {error && <ErrorState title="The gate was not signed." kept="Your notes and acknowledgements are kept." detail={error} />}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          {checking === 'code' ? (
            <Button disabled={code.length < 6} onClick={() => void finishCode()}>Confirm and sign</Button>
          ) : (
            <Button disabled={sign.isPending || checking === 'busy'} onClick={() => void go()}>
              {(sign.isPending || checking === 'busy') && <Loader2 className="animate-spin" />}
              {reauth ? 'Confirm with passkey and sign' : 'Sign'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReturnDialog({ open, onOpenChange, repo, gate: g, stage, onReturned }: { open: boolean; onOpenChange: (o: boolean) => void; repo: string; gate: GateMore; stage?: string; id: string; onReturned: () => void }) {
  const [reason, setReason] = useState('')
  const ret = useCall('gate.return', (a) => [['journey.get', a.repo]])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Return {stage ?? 'the stage'}?</DialogTitle>
          <DialogDescription>{stage ?? 'The stage'} goes back for changes. Say what has to change; it is kept with the gate record and shown to whoever picks it up.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="return-reason">What has to change</Label>
          <Textarea id="return-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-required placeholder="For example: C2 must be rated for 10 V, not 6.3 V." />
          {!returnReasonOk(reason) && reason.length > 0 && <p className="text-xs text-muted-foreground">Say what must change, in a sentence.</p>}
        </div>
        {ret.isError && <ErrorState title="The stage was not returned." kept="Your reason is kept." detail={String(ret.error)} />}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!returnReasonOk(reason) || ret.isPending} onClick={() => ret.mutate({ repo, gate: g.id, reason: reason.trim() }, { onSuccess: () => { onOpenChange(false); toast(`${stage ?? 'The stage'} returned.`, { description: reason.trim() }); onReturned() } })}>
            {ret.isPending && <Loader2 className="animate-spin" />}
            Return {stage ?? 'the stage'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ------------------------------------------------------------------ the gate record (a receipt)

export function GateRecord({ journey: j, gate: g }: { journey: Journey; gate: GateMore }) {
  const from = j.stages.find((s) => s.id === g.after)
  const returned = g.state === 'returned' ? g.record?.returned : undefined
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] px-4 py-8 md:px-8">
        <div className="rounded-xl border bg-card p-6">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Receipt className="size-4" aria-hidden /> Gate record</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{gateTitle(g)}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{j.name} {j.revision} · closes {from?.name ?? 'its stage'}</p>
          <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            {returned ? (
              <>
                <dt className="text-muted-foreground">Returned by</dt><dd>{returned.by}</dd>
                <dt className="text-muted-foreground">When</dt><dd>{new Date(returned.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</dd>
                <dt className="text-muted-foreground">What must change</dt><dd>{returned.reason}</dd>
              </>
            ) : (
              <>
                <dt className="text-muted-foreground">Signed by</dt><dd>{g.signature?.by ?? 'An admin'}</dd>
                <dt className="text-muted-foreground">When</dt><dd>{g.signature ? `${new Date(g.signature.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} (${ago(g.signature.at)})` : '—'}</dd>
              </>
            )}
          </dl>
          <h2 className="mt-6 text-sm font-semibold">Criteria</h2>
          {g.criteria.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">This record was kept before criteria were stored with gates.</p>
          ) : (
            <ul className="mt-2 divide-y rounded-lg border">
              {g.criteria.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                  <StatusBadge status={c.status === 'not_met' ? 'not_met' : c.status === 'waived' ? 'waived' : 'met'} />
                  <span className="min-w-0 flex-1">{c.text}</span>
                  {c.evidence && <EvidenceChip evidence={{ ...c.evidence, to: c.evidence.kind === 'run' && c.evidence.id ? `/p/${projectId(j.repo)}/runs/${c.evidence.id}` : c.evidence.to }} />}
                </li>
              ))}
            </ul>
          )}
          <h2 className="mt-6 text-sm font-semibold">Waivers acknowledged</h2>
          <p className="mt-1 text-sm text-muted-foreground">{g.record?.acknowledged?.length ? g.record.acknowledged.join(', ') : g.waivers.length ? g.waivers.map((w) => w.id).join(', ') : 'None were taken in this stage.'}</p>
          <h2 className="mt-6 text-sm font-semibold">Notes</h2>
          <p className="mt-1 text-sm text-muted-foreground">{g.record?.notes || 'No notes.'}</p>
        </div>
        <Button asChild variant="outline" className="mt-4">
          <Link to="/p/$id/decisions" params={{ id: projectId(j.repo) }}>All decisions <ArrowRight /></Link>
        </Button>
      </div>
    </div>
  )
}
