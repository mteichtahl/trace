/**
 * The skills where the person edits in KiCad (Schematic finish, Placement adjust; Board setup uses it too): the step's
 * picture with its findings drawn on it and listed under it (tapping either selects both), the quiet line "Edit in
 * KiCad and push. trace re-checks every push.", and the changes from trace's draft, each asking for its one-line
 * reason pre-filled with trace's best guess. When a push lands (skill.get reports a new push, refetched on the live
 * record event), the picture refreshes in place and a toast says what changed.
 */
import { Link } from '@tanstack/react-router'
import { ArrowRight, GitCommitHorizontal, Monitor } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmbeddedChat } from '@/components/chat/embedded-chat'
import { useTraceContext } from '@/components/chat/context'
import { DecisionCard } from '@/components/decision-card'
import { FocusLayout } from '@/components/focus/focus-layout'
import { StatusBadge } from '@/components/status-badge'
import { QueryError } from '@/components/states'
import { useMediaQuery } from '@/hooks/use-media-query'
import { projectId } from '@/lib/api'
import type { DraftChange } from '@/lib/types-s1'
import { cn } from '@/lib/utils'
import { type SkillDef, pictureOf } from './definitions'
import { FindingsList } from './findings'
import { NoChecker, StepHeader, TraceIntro } from './parts'
import { StepPicture } from './step-picture'
import { type SkillDraftBase, qualityChecks, useSkill } from './use-skill'

interface Draft extends SkillDraftBase {
  /** confirmed reasons per change id */
  reasons: Record<string, string>
  choice?: { option: string; reason?: string }
  sheet?: string
}

/** Every change from the draft has a reason: the rule the bar shows as "Every change has a reason". Pure. */
export function changesExplained(changes: DraftChange[], reasons: Record<string, string>): boolean {
  return changes.every((c) => (c.confirmed && !!c.reason) || (reasons[c.id] ?? '').trim().length >= 3)
}

export function KicadSkill({ repo, def }: { repo: string; def: SkillDef }) {
  const s = useSkill<Draft>(repo, def, { done: [], reasons: {} })
  const v = s.view.data
  const [selected, setSelected] = useState<string | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const phone = useMediaQuery('(max-width: 767px)')
  const changes = v?.changes ?? []
  const findings = (v?.findings ?? []).filter((f) => !s.draft.data.sheet || !f.sheet || f.sheet === s.draft.data.sheet)
  const explained = changesExplained(changes, s.draft.data.reasons)
  const changeCheck = def.id === 'placement-adjust' ? 'moves' : 'changes'
  const checks = qualityChecks(def, v, {
    [changeCheck]: changes.length === 0 || explained ? 'met' : 'not_met',
    ...(s.draft.data.choice && s.draft.data.choice.option !== v?.recommendation?.recommended && !s.draft.data.choice.reason ? { reasons: 'not_met' as const } : {}),
  }, s.goTo)
  const sel = findings.find((f) => f.id === selected)
  useTraceContext(sel ? { label: `Finding ${findings.indexOf(sel) + 1}`, description: 'The finding the person selected', value: { text: sel.text, where: sel.where ?? null, severity: sel.severity } } : null, 'finding')

  // a push landed: say what changed
  const lastPush = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!v?.push) return
    if (lastPush.current && lastPush.current !== v.push.sha) toast(`Push ${v.push.sha}: ${v.push.fixed} finding${v.push.fixed === 1 ? '' : 's'} fixed, ${v.push.new} new`)
    lastPush.current = v.push.sha
  }, [v?.push])

  const sheets = v?.sheets ?? []
  const stepsExtra = sheets.length ? (
    <div>
      <p className="px-2 pb-2 text-xs text-muted-foreground">Sheets</p>
      <ul className="space-y-0.5">
        {sheets.map((sh) => (
          <li key={sh.id}>
            <button type="button" onClick={() => s.draft.setData((d) => ({ ...d, sheet: sh.id }))} className={cn('flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm', (s.draft.data.sheet ?? sheets[0]!.id) === sh.id ? 'bg-accent font-medium' : 'hover:bg-accent/60')}>
              {sh.name}
              {sh.open ? <StatusBadge plain status={sh.open > 1 ? 'failing' : 'fix'} label={`${sh.open} open`} /> : <StatusBadge plain status="clean" label="clean" />}
            </button>
          </li>
        ))}
      </ul>
      {(() => { const cur = sheets.find((x) => x.id === (s.draft.data.sheet ?? sheets[0]!.id)); return cur?.serves?.length ? <p className="mt-4 px-2 text-xs text-muted-foreground">{cur.name} serves <span className="font-mono">{cur.serves.join(', ')}</span>.</p> : null })()}
    </div>
  ) : undefined

  return (
    <FocusLayout
      title={def.name}
      context={s.context}
      steps={s.steps}
      onStep={s.onStep}
      stepsExtra={stepsExtra}
      checks={checks}
      onSubmit={() => s.submit()}
      onClose={s.close}
      draftSavedAt={s.draft.savedAt}
      trace={
        <EmbeddedChat
          repo={repo}
          intro={
            <div className="space-y-3">
              {v?.push && <p className="rounded-md bg-muted px-3 py-2 text-sm">Push <span className="font-mono">{v.push.sha}</span> landed: {v.push.fixed} findings fixed, {v.push.new} new.</p>}
              <TraceIntro summary={v?.summary} step={s.step} def={def} />
              {v?.recommendation && (
                <DecisionCard
                  decision={v.recommendation}
                  acceptLabel="Apply in my next push"
                  chosen={s.draft.data.choice ? { option: s.draft.data.choice.option, recommended: s.draft.data.choice.option === v.recommendation.recommended, reason: s.draft.data.choice.reason } : undefined}
                  onChoose={(c) => { s.draft.setData((d) => ({ ...d, choice: { option: c.option, reason: c.reason } })); toast(c.recommended ? 'Noted: trace will check it on your next push.' : 'Your choice and reason are kept with the decision.') }}
                />
              )}
            </div>
          }
        />
      }
    >
      <StepHeader def={def} index={s.stepIndex} />
      {phone ? (
        <p className="mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
          <Monitor className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>Editing needs KiCad on your desktop. Reading, answering and waiving work here. <Link to="/p/$id/do/$skill" params={{ id: projectId(repo), skill: def.id }} className="text-primary hover:underline" onClick={(e) => { e.preventDefault(); void navigator.clipboard?.writeText(location.href).then(() => toast('Link copied: open it on your desktop.')) }}>Copy a link for your desktop</Link></span>
        </p>
      ) : (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><GitCommitHorizontal className="size-4" aria-hidden /> Edit in KiCad and push. trace re-checks every push.</p>
      )}
      {s.view.isError && <div className="mt-4"><QueryError error={s.view.error} what={`${def.name}'s state`} onRetry={() => void s.view.refetch()} /></div>}

      {pictureOf(def, s.step.id) !== 'none' && (
        <div className="mt-4">
          <StepPicture repo={repo} kind={pictureOf(def, s.step.id)} view={v ? { ...v, sheets: sheets.length ? [sheets.find((x) => x.id === (s.draft.data.sheet ?? sheets[0]!.id))!, ...sheets.filter((x) => x.id !== (s.draft.data.sheet ?? sheets[0]!.id))] : v.sheets, findings } : undefined} selected={selected} onSelect={setSelected} />
        </div>
      )}

      <section className="mt-6" aria-labelledby="findings-h">
        <h2 id="findings-h" className="text-base font-semibold">Findings {sheets.length ? 'on this sheet' : 'on the board'} <span className="ml-1 text-sm font-normal text-muted-foreground">{findings.filter((f) => f.severity !== 'waived').length} open{v?.push ? ` · from push ${v.push.sha}` : ''}</span></h2>
        <FindingsList
          className="mt-2"
          findings={findings}
          selected={selected}
          onSelect={setSelected}
          empty="Nothing open here: clean."
          actions={(f) => f.severity !== 'waived' && <Button asChild variant="outline" size="sm"><Link to="/p/$id/do/$skill" params={{ id: projectId(repo), skill: 'waiver' }} search={{ about: f.id } as never}>Waive…</Link></Button>}
        />
      </section>

      <section className="mt-6" aria-labelledby="changes-h">
        <h2 id="changes-h" className="text-base font-semibold">{def.id === 'placement-adjust' ? 'Moves from trace\'s placement' : "Changes from trace's draft"} <span className="ml-1 text-sm font-normal text-muted-foreground">{changes.filter((c) => !(c.confirmed && c.reason) && !s.draft.data.reasons[c.id]).length} need a reason</span></h2>
        {changes.length === 0 ? (
          <p className="mt-2 rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">No changes from the draft yet. Each one you push shows here and asks for its reason.</p>
        ) : (
          <ul className="mt-2 divide-y rounded-xl border">
            {changes.map((c) => {
              const confirmed = (c.confirmed && c.reason) || s.draft.data.reasons[c.id]
              const value = edits[c.id] ?? s.draft.data.reasons[c.id] ?? c.reason ?? c.guess ?? ''
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <span className="min-w-[10rem]">
                    {c.what}{' '}
                    {c.from && <><span className="text-muted-foreground line-through">{c.from}</span> → {c.to}</>}
                  </span>
                  {confirmed ? (
                    <span className="flex min-w-0 flex-1 items-center gap-2"><StatusBadge status="done" label="Reason kept" /><span className="truncate text-muted-foreground">{confirmed}</span>
                      <Button variant="ghost" size="sm" onClick={() => { setEdits((e) => ({ ...e, [c.id]: String(confirmed) })); s.draft.setData((d) => { const r = { ...d.reasons }; delete r[c.id]; return { ...d, reasons: r } }) }}>Change</Button>
                    </span>
                  ) : (
                    <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (value.trim().length >= 3) s.draft.setData((d) => ({ ...d, reasons: { ...d.reasons, [c.id]: value.trim() } })) }}>
                      <label className="sr-only" htmlFor={`reason-${c.id}`}>Reason for {c.what}</label>
                      <span className="text-muted-foreground" aria-hidden>reason:</span>
                      <Input id={`reason-${c.id}`} value={value} onChange={(e) => setEdits((x) => ({ ...x, [c.id]: e.target.value }))} className="min-w-0 flex-1" />
                      <Button type="submit" size="sm" disabled={value.trim().length < 3}>Confirm</Button>
                    </form>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {changes.some((c) => c.guess && !c.confirmed) && <p className="mt-1.5 text-xs text-muted-foreground">Each reason starts as trace's best guess. Confirm it or rewrite it.</p>}
      </section>

      {!v?.checks?.length && !s.view.isLoading && <div className="mt-4"><NoChecker def={def} /></div>}
      {s.stepIndex < def.steps.length - 1 && (
        <div className="mt-6 flex justify-end"><Button onClick={s.next}>Continue to {def.steps[s.stepIndex + 1]!.title.toLowerCase()} <ArrowRight /></Button></div>
      )}
    </FocusLayout>
  )
}
