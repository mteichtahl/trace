/**
 * Requirement detail (/p/:id/requirements/:rid): a side sheet over the Requirements tab (a drawer on phones), so the
 * traceability view stays in place. What it says, its criterion, its status, its tests with their last runs, and the
 * actions that change it (Raise a change, Waive) for people who may.
 */
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useTraceContext } from '@/components/chat/context'
import { EvidenceChip } from '@/components/evidence-chip'
import { VERDICT, useCoverage } from '@/components/project/shared'
import { StatusBadge } from '@/components/status-badge'
import { useMediaQuery } from '@/hooks/use-media-query'
import { repoOf } from '@/lib/api'
import { useProjects } from '@/lib/queries'

export const Route = createFileRoute('/_app/p/$id/requirements/$rid')({
  staticData: { crumb: 'Requirement' },
  component: RequirementSheet,
})

function RequirementSheet() {
  const { id, rid } = Route.useParams()
  const repo = repoOf(id)
  const navigate = useNavigate()
  const cov = useCoverage(repo)
  const projects = useProjects()
  const reviewer = projects.data?.find((p) => p.repo === repo)?.part === 'reviewer'
  const phone = useMediaQuery('(max-width: 767px)')
  const r = cov.data?.requirements.find((x) => x.id === rid)
  const close = () => void navigate({ to: '/p/$id/requirements', params: { id } })
  useTraceContext(r ? { label: r.id, description: 'The requirement the person has open', value: { id: r.id, text: r.text, verdict: r.verdict }, mono: true } : null, 'requirement')

  const body = !cov.data ? (
    <p className="text-sm text-muted-foreground">{cov.isError ? 'Could not load the requirement.' : 'Loading…'}</p>
  ) : !r ? (
    <p className="text-sm text-muted-foreground">There is no requirement {rid} in this project. It may have been renumbered or struck.</p>
  ) : (
    <div className="space-y-5 text-sm">
      <StatusBadge status={VERDICT[r.verdict].status} label={VERDICT[r.verdict].label} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <dt className="text-muted-foreground">Criterion</dt><dd>{r.acceptance ?? <span className="text-muted-foreground">None yet: Requirements review makes it testable.</span>}</dd>
        <dt className="text-muted-foreground">Kind</dt><dd className="capitalize">{r.kind}</dd>
        {r.priority && <><dt className="text-muted-foreground">Priority</dt><dd className="capitalize">{r.priority}</dd></>}
        {r.source && <><dt className="text-muted-foreground">Source</dt><dd>{r.source}</dd></>}
      </dl>
      <div>
        <h3 className="mb-2 font-medium">Tests</h3>
        {r.tests.length === 0 ? (
          <p className="text-muted-foreground">No test is planned for it yet. trace plans tests in Prove.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {r.tests.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="font-mono text-xs">{t.id}</span>
                <span className="text-xs uppercase text-muted-foreground">{t.method}</span>
                <StatusBadge status={t.status === 'pass' ? 'passed' : t.status === 'fail' || t.status === 'error' ? 'failing' : t.status === 'waived' ? 'waived' : 'untested'} label={t.status === 'planned' ? 'Planned' : undefined} className="ml-auto" />
                {t.last_run && <EvidenceChip evidence={{ kind: 'run', label: t.last_run, id: t.last_run, to: `/p/${id}/runs/${t.last_run}` }} />}
              </li>
            ))}
          </ul>
        )}
      </div>
      {!reviewer && (
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline"><Link to="/p/$id/do/$skill" params={{ id, skill: 'change-request' }} search={{ about: r.id } as never}>Raise a change</Link></Button>
          {r.verdict !== 'waived' && <Button asChild variant="outline"><Link to="/p/$id/do/$skill" params={{ id, skill: 'waiver' }} search={{ about: r.id } as never}>Waive…</Link></Button>}
        </div>
      )}
    </div>
  )

  if (phone)
    return (
      <Drawer open onOpenChange={(o) => !o && close()}>
        <DrawerContent className="max-h-[88dvh]">
          <DrawerHeader><DrawerTitle className="font-mono">{rid}</DrawerTitle><p className="text-sm">{r?.text}</p></DrawerHeader>
          <div className="overflow-y-auto px-4 pb-6">{body}</div>
        </DrawerContent>
      </Drawer>
    )
  return (
    <Sheet open onOpenChange={(o) => !o && close()}>
      <SheetContent className="w-full sm:max-w-[480px] xl:max-w-[560px]">
        <SheetHeader>
          <SheetTitle className="font-mono">{rid}</SheetTitle>
          <SheetDescription className="text-foreground">{r?.text}</SheetDescription>
        </SheetHeader>
        <div className="overflow-y-auto px-4 pb-6">{body}</div>
      </SheetContent>
    </Sheet>
  )
}
