/**
 * One project template, edited within trace's catalog (src/core/templates.ts; plan P5.6). What an admin may change:
 * the name; which stages it has (Define and the later stages stay); which criteria each gate has, from any template's
 * for that gate, and their words; criteria they add, which a person signs off in the gate; and each stage's guide.
 * What stays is the catalog's: a stage's gates, and who decides a criterion trace checks. The API says what is wrong
 * (templates.check) as the admin works, and refuses a save that would not start a journey. Saving makes the next
 * version; projects started before keep the version they started from.
 */
import { ChevronRight, Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ago } from '@/lib/format'
import { useCall } from '@/lib/queries'
import type { TemplateCatalogStage, TemplateCriterionDoc, TemplateDoc, TemplateGuide, TemplateHistoryEntry, TemplateStageDoc, TemplateView } from '@/lib/types'
import { cn } from '@/lib/utils'

const GUIDE: [keyof TemplateGuide, string][] = [
  ['purpose', 'What it is for'], ['you_do', 'What the person does'], ['trace_does', 'What trace does'], ['you_get', 'What they get'], ['typical_time', 'How long it usually takes'],
]
const TEMPLATE_NAMES: Record<string, string> = { board: 'Board', fpga: 'FPGA', firmware: 'Firmware', mixed: 'Mixed' }

/** A key for a criterion an admin adds, from its words: lower-case letters and hyphens, unique in its gate. */
export function addedKey(text: string, taken: ReadonlySet<string>): string {
  const base = text.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-+|-+$/g, '').split('-').filter(Boolean).slice(0, 4).join('-') || 'check'
  const key = base.slice(0, 36)
  if (!taken.has(key)) return key
  for (const c of 'bcdefghijklmnopqrstuvwxyz') if (!taken.has(`${key.slice(0, 34)}-${c}`)) return `${key.slice(0, 34)}-${c}`
  return `${key.slice(0, 30)}-more`
}

/** The stage `id` as the catalog would give it to this template: its gates with the template's own criteria. */
function stageFromCatalog(cat: TemplateCatalogStage, template: TemplateDoc['id'], guide: TemplateGuide): TemplateStageDoc {
  return {
    id: cat.id, guide,
    gates: cat.gates.map((g) => ({ id: g.id, criteria: g.criteria.filter((c) => c.templates.includes(template)).map((c) => ({ id: c.id, text: c.text })) })),
  }
}

export function TemplateEditor({ view, catalog, code, history }: { view: TemplateView; catalog: TemplateCatalogStage[]; code: TemplateDoc; history: TemplateHistoryEntry[] }) {
  const [doc, setDoc] = useState<TemplateDoc>(view.doc)
  const [reason, setReason] = useState('')
  const [problems, setProblems] = useState<string[]>([])
  useEffect(() => { setDoc(view.doc); setReason('') }, [view.doc, view.version])
  const dirty = JSON.stringify(doc) !== JSON.stringify(view.doc)
  const check = useCall('templates.check')
  const save = useCall('templates.save', () => [['templates.get'], ['templates.list']])
  const reset = useCall('templates.reset', () => [['templates.get'], ['templates.list']])

  // what is wrong, as the admin works: the API's own rules (templateProblems)
  useEffect(() => {
    if (!dirty) { setProblems([]); return }
    const t = setTimeout(() => check.mutate({ doc }, { onSuccess: (r) => setProblems(r.problems), onError: () => setProblems([]) }), 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, dirty])

  const has = useMemo(() => new Set(doc.stages.map((s) => s.id)), [doc])
  const guideOf = (id: string): TemplateGuide => doc.stages.find((s) => s.id === id)?.guide ?? code.stages.find((s) => s.id === id)?.guide ?? view.doc.stages.find((s) => s.id === id)?.guide ?? { purpose: '', you_do: '', trace_does: '', you_get: '', typical_time: '' }
  const setStage = (id: string, on: boolean) => setDoc((d) => {
    if (!on) return { ...d, stages: d.stages.filter((s) => s.id !== id) }
    const cat = catalog.find((c) => c.id === id)!
    const stages = [...d.stages, stageFromCatalog(cat, d.id, guideOf(id))]
    return { ...d, stages: stages.sort((a, b) => catalog.findIndex((c) => c.id === a.id) - catalog.findIndex((c) => c.id === b.id)) }
  })
  const editStage = (id: string, f: (s: TemplateStageDoc) => TemplateStageDoc) => setDoc((d) => ({ ...d, stages: d.stages.map((s) => (s.id === id ? f(s) : s)) }))
  const editGate = (stage: string, gate: string, f: (c: TemplateCriterionDoc[]) => TemplateCriterionDoc[]) =>
    editStage(stage, (s) => ({ ...s, gates: s.gates.map((g) => (g.id === gate ? { ...g, criteria: f(g.criteria) } : g)) }))

  const onSave = () => save.mutate({ doc, reason: reason.trim() }, {
    onSuccess: (r) => { toast(r.summary); setReason('') },
    onError: (e) => toast.error(e.message),
  })
  const onReset = () => reset.mutate({ template: view.id, reason: reason.trim() }, {
    onSuccess: (r) => { toast(r.summary); setReason('') },
    onError: (e) => toast.error(e.message),
  })

  return (
    <div className="space-y-8">
      <div className="grid gap-2 sm:max-w-sm">
        <Label htmlFor="tpl-name">Name</Label>
        <Input id="tpl-name" value={doc.name} maxLength={60} onChange={(e) => setDoc((d) => ({ ...d, name: e.target.value }))} />
        <p className="text-xs text-muted-foreground">People choose it by this name when they start a project. It stays the {TEMPLATE_NAMES[view.id]} template.</p>
      </div>

      <section aria-labelledby="tpl-stages">
        <h2 id="tpl-stages" className="text-lg font-semibold">Stages</h2>
        <p className="mt-1 text-sm text-muted-foreground">Each stage ends at its gates. Define always comes first; Certify, Produce and Sustain stay, because each project chooses them for itself.</p>
        <ul className="mt-4 space-y-2">
          {catalog.map((cat) => {
            const on = has.has(cat.id)
            const fixed = cat.id === 'define' || cat.later
            const stage = doc.stages.find((s) => s.id === cat.id)
            return (
              <li key={cat.id} className={cn('rounded-lg border', !on && 'bg-muted/40')}>
                <Collapsible>
                  <div className="flex items-center gap-3 px-3 py-2.5">
                    <Checkbox id={`stage-${cat.id}`} checked={on} disabled={fixed} onCheckedChange={(v) => setStage(cat.id, v === true)} aria-label={`${cat.name} in this template`} />
                    <Label htmlFor={`stage-${cat.id}`} className={cn('flex-1 font-medium', !on && 'text-muted-foreground')}>
                      {cat.name}
                      {cat.later && <span className="ml-2 text-xs font-normal text-muted-foreground">each project chooses</span>}
                    </Label>
                    {on && stage && (
                      <span className="text-xs text-muted-foreground">{stage.gates.reduce((n, g) => n + g.criteria.length, 0)} criteria</span>
                    )}
                    {on && (
                      <CollapsibleTrigger asChild>
                        <Button variant="ghost" size="sm" className="group" aria-label={`Edit ${cat.name}`}>
                          Edit <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
                        </Button>
                      </CollapsibleTrigger>
                    )}
                  </div>
                  {on && stage && (
                    <CollapsibleContent className="space-y-6 border-t px-3 py-4">
                      {cat.gates.map((cg) => (
                        <GateEditor key={cg.id} template={doc.id} gate={cg} criteria={stage.gates.find((g) => g.id === cg.id)?.criteria ?? []}
                          onChange={(f) => editGate(cat.id, cg.id, f)} />
                      ))}
                      <div className="space-y-3">
                        <h4 className="text-sm font-medium">The stage guide</h4>
                        {GUIDE.map(([k, l]) => (
                          <div key={k} className="grid gap-1.5">
                            <Label htmlFor={`guide-${cat.id}-${k}`} className="text-xs text-muted-foreground">{l}</Label>
                            <Textarea id={`guide-${cat.id}-${k}`} rows={k === 'typical_time' ? 1 : 2} value={stage.guide[k]}
                              onChange={(e) => editStage(cat.id, (s) => ({ ...s, guide: { ...s.guide, [k]: e.target.value } }))} />
                          </div>
                        ))}
                      </div>
                    </CollapsibleContent>
                  )}
                </Collapsible>
              </li>
            )
          })}
        </ul>
      </section>

      <section aria-labelledby="tpl-save" className="space-y-3 rounded-lg border p-4">
        <h2 id="tpl-save" className="text-lg font-semibold">Save</h2>
        {problems.length > 0 && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p className="font-medium">It cannot be saved yet:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="tpl-reason">Why</Label>
          <Input id="tpl-reason" value={reason} maxLength={300} placeholder="Kept with the version, for whoever reads the history" onChange={(e) => setReason(e.target.value)} />
        </div>
        <p className="text-xs text-muted-foreground">
          Saving makes version {view.version + 1}. New projects start from it; projects started before keep the version they started from.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={!dirty || problems.length > 0 || reason.trim().length < 3 || save.isPending} onClick={onSave}>
            {save.isPending && <Loader2 className="animate-spin" />}Save version {view.version + 1}
          </Button>
          <Button variant="outline" disabled={!dirty} onClick={() => setDoc(view.doc)}>Discard changes</Button>
          <Button variant="ghost" disabled={!view.changed || reason.trim().length < 3 || reset.isPending} onClick={onReset}>
            <RotateCcw />Back to trace's own
          </Button>
        </div>
      </section>

      {history.length > 0 && (
        <section aria-labelledby="tpl-history">
          <h2 id="tpl-history" className="text-lg font-semibold">History</h2>
          <ul className="mt-3 divide-y rounded-lg border text-sm">
            {history.map((h) => (
              <li key={`${h.version}-${h.at}`} className="flex flex-wrap items-baseline gap-x-3 px-3 py-2">
                <span className="font-medium">Version {h.version}</span>
                <span className="text-muted-foreground">{h.action === 'reset' ? 'back to trace\'s own' : 'saved'} by {h.by ?? 'someone'}, {ago(Date.parse(h.at))}</span>
                {h.reason && <span className="basis-full text-muted-foreground">{h.reason}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function GateEditor({ template, gate, criteria, onChange }: {
  template: TemplateDoc['id']
  gate: TemplateCatalogStage['gates'][number]
  criteria: TemplateCriterionDoc[]
  onChange: (f: (c: TemplateCriterionDoc[]) => TemplateCriterionDoc[]) => void
}) {
  const [adding, setAdding] = useState<{ text: string; evidence: string } | null>(null)
  const chosen = new Map(criteria.map((c) => [c.id, c]))
  const added = criteria.filter((c) => c.custom)
  const toggle = (id: string, text: string, on: boolean) => onChange((cs) => {
    if (!on) return cs.filter((c) => c.id !== id)
    // in the catalog's order, added ones after
    const order = gate.criteria.map((c) => c.id)
    return [...cs, { id, text }].sort((a, b) => (a.custom ? 99 : order.indexOf(a.id)) - (b.custom ? 99 : order.indexOf(b.id)))
  })
  const reword = (id: string, text: string) => onChange((cs) => cs.map((c) => (c.id === id ? { ...c, text } : c)))
  const add = () => {
    if (!adding) return
    const taken = new Set([...gate.criteria.map((c) => c.id.slice(gate.id.length + 1)), ...criteria.map((c) => c.id.slice(gate.id.length + 1))])
    const id = `${gate.id}.${addedKey(adding.text, taken)}`
    onChange((cs) => [...cs, { id, text: adding.text.trim(), custom: true, evidence: adding.evidence.trim() }])
    setAdding(null)
  }
  return (
    <div>
      <h3 className="text-sm font-medium">The {gate.name} gate</h3>
      <ul className="mt-2 space-y-2">
        {gate.criteria.map((c) => {
          const mine = chosen.get(c.id)
          const elsewhere = !c.templates.includes(template)
          return (
            <li key={c.id} className="flex items-start gap-3">
              <Checkbox className="mt-2" checked={Boolean(mine)} onCheckedChange={(v) => toggle(c.id, c.text, v === true)} aria-label={`${c.text} in this gate`} />
              <div className="min-w-0 flex-1 space-y-1">
                <Input value={mine?.text ?? c.text} disabled={!mine} maxLength={300} aria-label={`Words of ${c.id}`} onChange={(e) => reword(c.id, e.target.value)} />
                <p className="text-xs text-muted-foreground">
                  <Badge variant="outline" className="mr-1.5 align-middle">{c.owner === 'trace' ? 'trace checks it' : 'a person decides'}</Badge>
                  Evidence: {c.evidence}{elsewhere && ' · from another template'}
                  {mine && mine.text !== c.text && (
                    <button type="button" className="ml-2 underline-offset-2 hover:underline" onClick={() => reword(c.id, c.text)}>trace's words</button>
                  )}
                </p>
              </div>
            </li>
          )
        })}
        {added.map((c) => (
          <li key={c.id} className="flex items-start gap-3">
            <span className="mt-2 size-4 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1 space-y-1">
              <Input value={c.text} maxLength={300} aria-label={`Words of ${c.id}`} onChange={(e) => reword(c.id, e.target.value)} />
              <p className="text-xs text-muted-foreground">
                <Badge variant="secondary" className="mr-1.5 align-middle">added: a person signs it off</Badge>Evidence: {c.evidence}
              </p>
            </div>
            <Button variant="ghost" size="icon" aria-label={`Remove ${c.text}`} onClick={() => onChange((cs) => cs.filter((x) => x.id !== c.id))}><Trash2 /></Button>
          </li>
        ))}
      </ul>
      {adding ? (
        <div className="mt-3 grid gap-2 rounded-md border p-3">
          <Label htmlFor={`add-${gate.id}`}>What must be true</Label>
          <Input id={`add-${gate.id}`} value={adding.text} maxLength={300} placeholder="Legal has read the requirements." onChange={(e) => setAdding({ ...adding, text: e.target.value })} />
          <Label htmlFor={`add-ev-${gate.id}`}>What a person looks at to sign it off</Label>
          <Input id={`add-ev-${gate.id}`} value={adding.evidence} maxLength={120} placeholder="the legal review" onChange={(e) => setAdding({ ...adding, evidence: e.target.value })} />
          <div className="flex gap-2">
            <Button size="sm" disabled={adding.text.trim().length < 3 || adding.evidence.trim().length < 3} onClick={add}>Add</Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(null)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setAdding({ text: '', evidence: '' })}><Plus />Add a criterion a person signs off</Button>
      )}
    </div>
  )
}
