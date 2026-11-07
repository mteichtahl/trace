/**
 * Requirements review: a person rewords a requirement, and trace's chat does the same in their draft (test log R23).
 *
 * - Every requirement row, undecided or accepted, has Edit: its words, its acceptance criterion, the method that checks
 *   it and its kind. The edit goes into the draft's decisions as `{ requirement, choice: 'edit', text?, criterion?,
 *   method?, class? }` (only the fields changed; `class` is the kind, named apart from the decision's own kind), which
 *   accepts the requirement in those words. Submit records it as the person's decision; the agents' row is not changed
 *   (src/api/actions-design.ts prepare). The quality bar reads it, laid over the record, so "One testable criterion
 *   each" moves once the criterion has a number.
 * - An edit over an earlier edit keeps the earlier one's fields under its own (withRequirementEdit), as the Intent
 *   builder's does (test log R17): editing the criterion keeps the words the person changed before.
 * - trace's chat makes the same decisions with its `decide_requirement` tool (decideRequirements), told the rows and
 *   the draft's decisions on them (reviewDraftContext). Before this, asked to reword a criterion, it offered a
 *   Verification job (branch, change, accept) for what is the person's own decision.
 */
import { useFrontendTool } from '@copilotkit/react-core/v2'
import { Pencil } from 'lucide-react'
import { useRef, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { FOCUS_AGENT_ID } from '@/components/chat/agent'
import { useTraceContext } from '@/components/chat/context'
import type { SkillItem } from '@/lib/types-s1'

/** The kinds a requirement can be (src/tools/verify/db.ts REQ_KINDS). */
export const REQUIREMENT_KINDS = ['functional', 'electrical', 'timing', 'emc'] as const
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number]

/** A person's decision on one requirement, kept in the draft until Submit records it (actions-skills pendingDecisions). */
export interface RequirementDecision {
  requirement: string
  choice: 'accept' | 'edit' | 'strike'
  reason?: string
  text?: string
  criterion?: string
  method?: string
  class?: RequirementKind
}

/** The fields an edit sets. */
export type RequirementFields = Pick<RequirementDecision, 'text' | 'criterion' | 'method' | 'class'>
const FIELD_KEYS = ['text', 'criterion', 'method', 'class'] as const

/** A requirement as the row shows it: the record's wording with the draft's edit laid over it. */
export interface ShownRequirement { id: string; text: string; criterion: string | null; method: string | null; kind: string | null; accepted: boolean }

/** The requirement id of a review item ("requirement:REQ-1" → "REQ-1"), or null for another item. Pure. */
export const requirementOf = (it: Pick<SkillItem, 'id'>): string | null => (it.id.startsWith('requirement:') ? it.id.slice('requirement:'.length) : null)

/** A review item's requirement as the record has it (its title is "ID: words" where `words` is not given). Pure. */
export function recordRequirement(it: SkillItem): ShownRequirement | null {
  const id = requirementOf(it)
  if (!id) return null
  const text = it.words ?? it.title.replace(new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*`), '')
  return { id, text, criterion: it.criterion ?? null, method: it.method ?? null, kind: it.kind ?? null, accepted: it.accepted === true }
}

/** The requirement as shown, the draft's edit laid over the record's wording. Pure. */
export function shownRequirement(r: ShownRequirement, d?: Pick<RequirementDecision, 'choice' | keyof RequirementFields>): ShownRequirement {
  if (d?.choice !== 'edit') return r
  return { ...r, text: d.text ?? r.text, criterion: d.criterion ?? r.criterion, method: d.method ?? r.method, kind: d.class ?? r.kind }
}

/** The fields of `typed` that differ from what is shown, trimmed; empty ones are left out (they keep what stands). Pure. */
export function changedRequirementFields(shown: ShownRequirement, typed: RequirementFields): RequirementFields {
  const now: Record<(typeof FIELD_KEYS)[number], string | null> = { text: shown.text, criterion: shown.criterion, method: shown.method, class: shown.kind }
  const out: Record<string, string> = {}
  for (const k of FIELD_KEYS) {
    const v = typed[k]?.trim()
    if (v && v !== (now[k] ?? '').trim()) out[k] = v
  }
  return out as RequirementFields
}

/**
 * The draft with one requirement edited: the edit accepts it in the new words. An edit over an earlier edit keeps the
 * earlier one's fields under the new ones, so a second edit of only the criterion keeps the words set before. Pure.
 */
export function withRequirementEdit<D extends { decisions?: RequirementDecision[] }>(d: D, requirement: string, fields: RequirementFields): D {
  const before = (d.decisions ?? []).find((x) => x.requirement === requirement)
  const rest = (d.decisions ?? []).filter((x) => x.requirement !== requirement)
  const earlier: RequirementFields = before?.choice === 'edit' ? Object.fromEntries(FIELD_KEYS.flatMap((k) => (before[k] ? [[k, before[k]]] : []))) : {}
  const merged = { ...earlier, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => typeof v === 'string' && v.trim())) } as RequirementFields
  return { ...d, decisions: [...rest, { requirement, choice: 'edit' as const, ...merged }] }
}

/** The badge a requirement row shows: its decision in the draft, else accepted in the record, else undecided. Pure. */
export function requirementBadge(d: Pick<RequirementDecision, 'choice'> | undefined, accepted: boolean): { status: 'met' | 'waived' | 'yours'; label: string } {
  if (d?.choice === 'edit') return { status: 'met', label: 'Accepted, edited' }
  if (d?.choice === 'accept') return { status: 'met', label: 'Accepted' }
  if (d?.choice === 'strike') return { status: 'waived', label: 'Struck' }
  return accepted ? { status: 'met', label: 'Accepted' } : { status: 'yours', label: 'Undecided' }
}

/** The words, criterion, method and kind of a requirement row, as shown. */
export function RequirementWording({ r }: { r: ShownRequirement }) {
  return (
    <>
      <span className="block">{r.id}: {r.text}</span>
      <span className="block text-xs">Criterion: {r.criterion ?? <span className="text-warning">none given</span>}</span>
      {(r.method || r.kind) && (
        <span className="block text-xs text-muted-foreground">
          {r.method && <>Method: {r.method}</>}
          {r.method && r.kind && ' · '}
          {r.kind && <>Kind: {r.kind}</>}
        </span>
      )}
    </>
  )
}

/** A requirement row's Edit button: opens its editor (RequirementEditor) under the row. */
export function EditButton({ id, onClick }: { id: string; onClick: () => void }) {
  return <Button size="sm" variant="outline" aria-label={`Edit ${id}`} onClick={onClick}><Pencil /> Edit</Button>
}

/**
 * A requirement's editor: its words and criterion in multi-line boxes (they run long), the method and the kind, each
 * starting from what the row shows. Saving lays only the fields changed over the draft's earlier edit. Not a login
 * form: no password manager offers itself.
 */
export function RequirementEditor({ r, onEdit, onClose }: { r: ShownRequirement; onEdit: (fields: RequirementFields) => void; onClose: () => void }) {
  const [typed, setTyped] = useState({ text: r.text, criterion: r.criterion ?? '', method: r.method ?? '', class: r.kind ?? '' })
  const changed = changedRequirementFields(r, { ...typed, class: (typed.class || undefined) as RequirementKind | undefined })
  const any = Object.keys(changed).length > 0
  const tooShort = typed.text.trim().length < 3
  const ids = (k: string) => `req-${r.id}-${k}`
  const off = { autoComplete: 'off', 'data-1p-ignore': true, 'data-lpignore': 'true', 'data-form-type': 'other' } as const
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3" role="group" aria-label={`Edit ${r.id}`}>
      <div className="space-y-1">
        <Label htmlFor={ids('text')} className="text-xs">Requirement</Label>
        <Textarea id={ids('text')} className="min-h-14 w-full min-w-0 resize-y" {...off} value={typed.text} onChange={(e) => setTyped((x) => ({ ...x, text: e.target.value }))} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={ids('criterion')} className="text-xs">Acceptance criterion</Label>
        <Textarea id={ids('criterion')} className="min-h-14 w-full min-w-0 resize-y" autoFocus placeholder="A number and a unit, the conditions, and how it is measured" {...off} value={typed.criterion} onChange={(e) => setTyped((x) => ({ ...x, criterion: e.target.value }))} />
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_10rem]">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={ids('method')} className="text-xs">Method</Label>
          <Input id={ids('method')} className="h-8" placeholder="Bench test, simulation, inspection…" {...off} value={typed.method} onChange={(e) => setTyped((x) => ({ ...x, method: e.target.value }))} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={ids('kind')} className="text-xs">Kind</Label>
          <select id={ids('kind')} className="h-8 w-full rounded-md border bg-background px-2 text-sm" value={typed.class} onChange={(e) => setTyped((x) => ({ ...x, class: e.target.value }))}>
            {!r.kind && <option value="">Not set</option>}
            {REQUIREMENT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Saving accepts it in these words, in your draft. Submit records it as your decision.</p>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!any || tooShort} onClick={() => { onEdit(changed); onClose() }}>Save</Button>
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ trace's chat: decide_requirement

/** decide_requirement's arguments: what the chat model sends. */
export const DecideRequirement = z.object({
  decisions: z.array(z.object({
    requirement: z.string().describe('the requirement\'s id, as the Requirements review draft context lists it (REQ-…)'),
    choice: z.enum(['accept', 'edit', 'strike', 'undo']).describe('accept as worded; edit: new words, criterion, method and/or kind (it accepts it in them); strike: with a reason; undo: take back the draft\'s decision on it'),
    text: z.string().optional().describe('edit: the requirement in its new words; leave out to keep them'),
    criterion: z.string().optional().describe('edit: the whole acceptance criterion: a number and a unit, the conditions, and how it is measured; leave out to keep it'),
    method: z.string().optional().describe('edit: how the criterion is checked (bench test, simulation, inspection…); leave out to keep it'),
    kind: z.enum(REQUIREMENT_KINDS).optional().describe('edit: the requirement\'s kind (Classify); leave out to keep it'),
    reason: z.string().optional().describe('strike: why, in one line'),
  })).min(1),
})
export type DecideRequirementArgs = z.input<typeof DecideRequirement>

export const DECIDE_REQUIREMENT_DESCRIPTION = 'Change a requirement in the person\'s Requirements review draft the way the person does with a row\'s Accept, Edit and Strike: reword it, rewrite its acceptance criterion (a number and a unit, the conditions, the method), set the method that checks it or its kind, accept it as worded, strike it with a reason, or undo a decision. It works on every requirement the review lists, accepted ones too; an edit accepts it in the new words. It goes in the draft at once, the row shows it, and the quality bar checks it; Submit records it as the person\'s decision. No task, branch or change is needed: never offer start_task or a Verification job to reword a requirement, its criterion or its kind in Requirements review. Only make the changes the person asked for or agreed to; say each one back in plain words.'

/**
 * decide_requirement, run by the app on the person's draft: each decision replaces the draft's decision on that
 * requirement, as a row's Accept, Edit and Strike do. An edit's fields are laid over an earlier edit's
 * (withRequirementEdit), and one that changes nothing shown is refused. A strike needs its reason. A requirement the
 * review does not list is refused. Pure.
 */
export function decideRequirements(decisions: readonly RequirementDecision[], args: unknown, shown: ReadonlyMap<string, ShownRequirement>): { decisions: RequirementDecision[]; decided: ({ requirement: string; choice: string; reason?: string } & RequirementFields)[]; refused: string[] } {
  const a = DecideRequirement.safeParse(args)
  if (!a.success) return { decisions: [...decisions], decided: [], refused: [`The decisions could not be read: ${a.error.issues[0]?.message ?? 'bad arguments'}.`] }
  let draft: { decisions: RequirementDecision[] } = { decisions: [...decisions] }
  const decided: ReturnType<typeof decideRequirements>['decided'] = []
  const refused: string[] = []
  const put = (requirement: string, d: Omit<RequirementDecision, 'requirement'> | null) => { draft = { decisions: [...draft.decisions.filter((x) => x.requirement !== requirement), ...(d ? [{ requirement, ...d }] : [])] } }
  for (const d of a.data.decisions) {
    const r = shown.get(d.requirement)
    if (!r) { refused.push(`${d.requirement} is not listed in Requirements review: use the ids the draft context lists.`); continue }
    const before = draft.decisions.find((x) => x.requirement === d.requirement)
    if (d.choice === 'undo') {
      if (before) { put(d.requirement, null); decided.push({ requirement: d.requirement, choice: 'undo' }) }
      continue
    }
    if (d.choice === 'accept') {
      // an edit already accepts it, in its words: accepting keeps them
      if (before?.choice !== 'edit') put(d.requirement, { choice: 'accept' })
      decided.push({ requirement: d.requirement, choice: 'accept' })
      continue
    }
    if (d.choice === 'strike') {
      const reason = d.reason?.trim() ?? ''
      if (reason.length < 3) { refused.push(`Striking ${d.requirement} needs a reason in a few words.`); continue }
      put(d.requirement, { choice: 'strike', reason })
      decided.push({ requirement: d.requirement, choice: 'strike', reason })
      continue
    }
    const changed = changedRequirementFields(shownRequirement(r, before), { text: d.text, criterion: d.criterion, method: d.method, class: d.kind })
    if (changed.text !== undefined && changed.text.length < 3) { refused.push(`${d.requirement} needs its words.`); continue }
    if (!Object.keys(changed).length) { refused.push(`${d.requirement}: nothing to change; it reads so already.`); continue }
    draft = withRequirementEdit(draft, d.requirement, changed)
    decided.push({ requirement: d.requirement, choice: 'edit', ...changed })
  }
  return { decisions: draft.decisions, decided, refused }
}

/** What decide_requirement answers the chat. Pure. */
export function decidedRequirementsAnswer(r: Pick<ReturnType<typeof decideRequirements>, 'decided' | 'refused'>) {
  return {
    decided: r.decided, ...(r.refused.length ? { refused: r.refused } : {}),
    note: 'In the person\'s Requirements review draft now: the row shows it and the quality bar checks it. Submit records it as the person\'s decision, as a row\'s own Edit. Nothing needs to be started.',
  }
}

/** What trace's chat is told about the review: every row as shown, and the draft's decision on it. Pure. */
export function reviewDraftContext(rows: readonly ShownRequirement[], decisions: readonly RequirementDecision[]) {
  const of = (id: string) => decisions.find((d) => d.requirement === id)
  return {
    submitted: false,
    note: 'The requirements Requirements review lists, as the person sees them, with the decision on each in their draft. Decisions in the draft are recorded when the person presses Submit; change them with decide_requirement, never with a task.',
    requirements: rows.map((r) => {
      const d = of(r.id)
      const s = shownRequirement(r, d)
      return {
        id: r.id, words: s.text, criterion: s.criterion, ...(s.method ? { method: s.method } : {}), ...(s.kind ? { kind: s.kind } : {}),
        state: d ? (d.choice === 'edit' ? 'edited in the draft (accepted)' : d.choice === 'accept' ? 'accepted in the draft' : `struck in the draft: ${d.reason ?? ''}`) : r.accepted ? 'accepted in the record' : 'undecided',
      }
    }),
  }
}

/**
 * trace's chat in Requirements review: told the rows and the draft's decisions, and given decide_requirement, which
 * changes the draft as the rows do. Renders nothing.
 */
export function RequirementsChat({ items, decisions, loaded, setDecisions }: { items: readonly SkillItem[]; decisions: readonly RequirementDecision[]; loaded: boolean; setDecisions: (fn: (d: RequirementDecision[]) => RequirementDecision[]) => void }) {
  const rows = items.flatMap((it) => { const r = recordRequirement(it); return r ? [r] : [] })
  useTraceContext(rows.length ? { label: 'Requirements review draft', description: 'The person\'s Requirements review, not submitted yet', value: reviewDraftContext(rows, decisions) } : null, 'requirements-review-draft')
  const now = useRef({ rows, decisions, loaded, setDecisions })
  now.current = { rows, decisions, loaded, setDecisions }
  useFrontendTool({
    name: 'decide_requirement', agentId: FOCUS_AGENT_ID, description: DECIDE_REQUIREMENT_DESCRIPTION, parameters: DecideRequirement,
    handler: async (args) => {
      const c = now.current
      if (!c.loaded) return { decided: [], refused: ['The draft is still loading: make the change again in a moment.'] }
      const r = decideRequirements(c.decisions, args, new Map(c.rows.map((x) => [x.id, x])))
      if (r.decided.length) {
        c.decisions = r.decisions
        c.setDecisions(() => r.decisions)
      }
      return decidedRequirementsAnswer(r)
    },
  }, [])
  return null
}
