/**
 * People's decisions about the design record (docs/user-journey.md: Intent builder, Requirements review,
 * Architecture choice, Pin plan review). The agents propose intent, architectures and the pin plan in the repository's
 * project database (src/tools/design); a person decides here, and the decision is written to the journey record
 * (design_decisions, src/tools/design/decisions.ts), logged in the decisions, and published like every journey write.
 *
 *   design.decide  write  { decision } one of:
 *                    intent          { statement, choice: accept | edit | reject, text? (edit), reason? (reject; on
 *                                    accept: why it holds beside a statement it was flagged as conflicting with),
 *                                    interface? { type, connector, protocol, rate, direction } (an interface statement's
 *                                    fields the person set; on edit, the others are read from the new words) }
 *                    uncovered       { statement, reason }: no requirement will cover it (Requirements review, step 6)
 *                    requirement     { requirement, choice: accept | edit | strike, reason (strike), text?,
 *                                    criterion?, method?, class? (edit: the person's own words, acceptance criterion,
 *                                    method and kind, each left out keeping the one that stands; an edit accepts it) }
 *                    criteria        { criteria: [{ id, name, weight }] }: fixed before any score is read
 *                    architecture    { option, reason, deciding: [criterion ids], scores?: [{ option, criterion,
 *                                    score, reason }], only_one?: why only one option is possible }
 *                    pins            { part }: agree the pin plan of one part as it stands now
 *                  Each answers what was recorded and the journey's version. A choice against trace's recommendation
 *                  needs its reason in words (as every decision in trace does).
 *
 * Why the journey record and not the repository: a person's decision must be live for everyone at once and must not
 * wait for a pull request; it is copied into the repository with the rest of the journey when a release is cut, so the
 * released revision carries the decisions that approved it. Agents read it (design.intent list) and never write it.
 */
import { z } from 'zod'
import { CHANGE_STAGE, type StageId, applyChange, changeReason, changeWords, decide, loadJourney } from '../core/journey.js'
import { type DesignDecision, loadDesignDecisions, recordDesignDecision, standing } from '../tools/design/decisions.js'
import { INTENT_KINDS, INTENT_TOPICS, InterfaceSchema, STAGES, readDesignRows } from '../tools/design/db.js'
import { REQUIREMENT_KINDS, type RequirementWording, type RequirementWords, architectureView, decidedFields, decisionStands, editedOf, intentView, outscoredBy, outscoredWords, pinPlanPrint } from '../tools/design/record.js'
import { ActionError, type Context, Repo, def, hashOf, label, openProjectDb, plainly, withProjectDb, writeJourney } from './action-kit.js'

const Id = z.string().min(1).max(64)
const Reason = z.string().trim().min(3).max(2000)

export const Decision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('intent'), statement: Id, choice: z.enum(['accept', 'edit', 'reject']), text: z.string().trim().min(3).max(2000).optional(), reason: Reason.optional(), interface: InterfaceSchema.optional() }).strict(),
  z.object({ kind: z.literal('uncovered'), statement: Id, reason: Reason }).strict(),
  z.object({
    kind: z.literal('requirement'), requirement: Id, choice: z.enum(['accept', 'edit', 'strike']), reason: Reason.optional(),
    // edit: the person's own wording, each field left out keeping the one that stands; `class` is the requirement's
    // kind (Classify), named apart from the decision's own kind
    text: z.string().trim().min(3).max(2000).optional(), criterion: z.string().trim().min(3).max(2000).optional(),
    method: z.string().trim().min(2).max(500).optional(), class: z.enum(REQUIREMENT_KINDS).optional(),
  }).strict(),
  z.object({ kind: z.literal('criteria'), criteria: z.array(z.object({ id: Id, name: z.string().trim().min(1).max(80), weight: z.number().min(0).max(10), description: z.string().max(500).optional() }).strict()).min(1).max(20) }).strict(),
  z.object({
    kind: z.literal('architecture'), option: Id, reason: Reason, deciding: z.array(Id).max(20).default([]),
    scores: z.array(z.object({ option: Id, criterion: Id, score: z.number().min(1).max(5), reason: z.string().trim().min(3).max(500) }).strict()).max(200).optional(),
    only_one: Reason.optional(),
  }).strict(),
  z.object({ kind: z.literal('pins'), part: z.string().trim().min(1).max(40) }).strict(),
])
export type DecisionInput = z.output<typeof Decision>

/**
 * A statement the person stated in the Intent builder (its chat notes each one in their draft): Submit intent records
 * it in their words (choice stated, record.ts statedRows). `draft`: laid over the bar's throwaway copy of the record
 * while it is still in the draft (choice drafted, a proposal). Never taken from design.decide: only from the draft.
 */
export const Stated = z.object({
  kind: z.literal('stated'), statement: z.string().regex(/^INT-[0-9a-f]{6,12}$/), topic: z.enum(INTENT_TOPICS), statement_kind: z.enum(INTENT_KINDS).default('statement'),
  text: z.string().trim().min(3).max(2000), interface: InterfaceSchema.optional(), owner: z.string().trim().max(200).optional(), decide_by: z.enum(STAGES).optional(),
  draft: z.boolean().default(false),
})
export type StatedInput = z.output<typeof Stated>
/** What a skill's draft records: a decision, or a statement of the person's own. */
export type PendingDecision = DecisionInput | StatedInput

/** The agents' design rows as the default branch has them (the repository's project database). */
async function repoRows(ctx: Context, repo: string) {
  return withProjectDb(ctx, repo, (path) => {
    const db = openProjectDb(path)
    try {
      const reqs = db.prepare('SELECT id, text, acceptance FROM requirements').all() as { id: string; text: string; acceptance: string | null }[]
      return { rows: readDesignRows(db), requirements: new Map<string, RequirementWords>(reqs.map((r) => [String(r.id), { text: String(r.text), acceptance: r.acceptance === null ? null : String(r.acceptance) }])) }
    } finally {
      db.close()
    }
  })
}

/**
 * Check one decision against what the agents proposed, and say in words what it records. Throws the person's error
 * when the decision names something that is not there, or chooses against the recommendation without a reason.
 */
export function prepare(d: PendingDecision, rows: Awaited<ReturnType<typeof repoRows>>['rows'], requirements: ReadonlyMap<string, RequirementWords>, prior: readonly DesignDecision[]): { kind: DesignDecision['kind']; target: string; choice: string; detail: Record<string, unknown>; summary: string } {
  switch (d.kind) {
    case 'intent': {
      const s = intentView(rows, prior).find((x) => x.id === d.statement)
      if (!s) throw new ActionError(`There is no intent statement ${d.statement} in this project.`)
      if (d.choice === 'edit' && !d.text) throw new ActionError('Give the statement in your own words.')
      if (d.choice === 'reject' && !d.reason) throw new ActionError('Say in a line why this statement is rejected.')
      const choice = d.choice === 'accept' ? 'accepted' : d.choice === 'edit' ? 'edited' : 'rejected'
      // an interface's five fields follow the person's words: reworded, they are read from the new words (the fields
      // the person set beside them first), so "Interfaces fully specified" reads the statement as it now stands and a
      // flag is fixed without a job (test-esp32 #20)
      const fields = s.topic === 'interfaces' && s.kind === 'statement' && d.choice !== 'reject' && (d.choice === 'edit' || d.interface)
        ? decidedFields(s.interface, d.choice === 'edit' ? d.text ?? null : null, d.interface) : null
      return {
        // the words seen are kept: an agent's later change of them reopens the decision
        kind: 'intent', target: s.id, choice, detail: { text: s.text, ...(d.text ? { edited: d.text } : {}), ...(d.reason ? { reason: d.reason } : {}), ...(fields ? { interface: fields } : {}) },
        summary: d.choice === 'accept' ? `Intent ${s.id} was accepted as worded: ${s.text}` : d.choice === 'edit' ? `Intent ${s.id} was reworded: ${d.text}` : `Intent ${s.id} was rejected: ${d.reason}`,
      }
    }
    case 'stated': {
      if (rows.intent.some((x) => x.id === d.statement)) throw new ActionError(`The intent statement ${d.statement} is already in the record.`)
      const words = d.statement_kind === 'dont_care' ? `Don't care: ${d.text}` : d.text
      return {
        kind: 'intent', target: d.statement, choice: d.draft ? 'drafted' : 'stated',
        detail: { text: d.text, topic: d.topic, kind: d.statement_kind, ...(d.interface ? { interface: d.interface } : {}), ...(d.owner ? { owner: d.owner } : {}), ...(d.decide_by ? { decide_by: d.decide_by } : {}) },
        summary: `Intent ${d.statement} was stated (${d.topic}): ${words}`,
      }
    }
    case 'uncovered': {
      if (!intentView(rows, prior).some((x) => x.id === d.statement)) throw new ActionError(`There is no intent statement ${d.statement} in this project.`)
      return { kind: 'intent.uncovered', target: d.statement, choice: 'left_out', detail: { reason: d.reason }, summary: `Intent ${d.statement} is left without a requirement: ${d.reason}` }
    }
    case 'requirement': {
      const now = requirements.get(d.requirement)
      if (!now) throw new ActionError(`There is no requirement ${d.requirement} in this project.`)
      if (d.choice === 'strike' && !d.reason) throw new ActionError('Say in a line why the requirement is struck, so a later review can see why.')
      const given: RequirementWording = { ...(d.text ? { text: d.text } : {}), ...(d.criterion ? { acceptance: d.criterion } : {}), ...(d.method ? { method: d.method } : {}), ...(d.class ? { kind: d.class } : {}) }
      if (d.choice === 'edit' && !Object.keys(given).length) throw new ActionError(`Give ${d.requirement}'s new words, criterion, method or kind.`)
      if (d.choice !== 'edit' && Object.keys(given).length) throw new ActionError(`Only an edit of ${d.requirement} changes its wording.`)
      // the person's earlier edit, while it stands: accepting again keeps it (the row is accepted as shown), and a new
      // edit lays its fields over it, so editing the criterion keeps the words they set before
      const was = standing(prior, 'requirement').get(d.requirement)
      const earlier = was && was.choice === 'accepted' && decisionStands(was, { ...now, status: 'accepted', updated: null }) ? editedOf(was) : null
      const edited: RequirementWording = d.choice === 'strike' ? {} : { ...(earlier ?? {}), ...given }
      // a field the person set back to the agent's own words is no edit
      if (edited.text === now.text) delete edited.text
      if (edited.acceptance === now.acceptance) delete edited.acceptance
      const words = Object.keys(edited).length ? edited : null
      const shown = (k: 'text' | 'acceptance' | 'method' | 'kind', label: string): string => (given[k] ? `${label} ${given[k]}` : '')
      return {
        // the words and acceptance decided on are kept: an agent's later change of either reopens it (record.ts
        // decisionStands); the person's own wording beside them, laid over the row wherever it is read
        kind: 'requirement', target: d.requirement, choice: d.choice === 'strike' ? 'struck' : 'accepted', detail: { ...now, ...(words ? { edited: words } : {}), ...(d.reason ? { reason: d.reason } : {}) },
        summary: d.choice === 'strike' ? `Requirement ${d.requirement} was struck: ${d.reason}`
          : d.choice === 'edit' ? `Requirement ${d.requirement} was accepted in the person's wording: ${[shown('text', 'words'), shown('acceptance', 'criterion'), shown('method', 'method'), shown('kind', 'kind')].filter(Boolean).join('; ')}.`
          : `Requirement ${d.requirement} was accepted.`,
      }
    }
    case 'criteria': {
      const ids = new Set<string>()
      for (const c of d.criteria) { if (ids.has(c.id)) throw new ActionError(`The criterion ${c.id} is given twice.`); ids.add(c.id) }
      if (d.criteria.every((c) => c.weight === 0)) throw new ActionError('At least one criterion needs a weight above zero.')
      return { kind: 'architecture.criteria', target: 'architecture', choice: 'fixed', detail: { criteria: d.criteria }, summary: `The architecture criteria were fixed: ${d.criteria.map((c) => `${c.name} (weight ${c.weight})`).join(', ')}.` }
    }
    case 'architecture': {
      const a = architectureView(rows, prior)
      const o = a.options.find((x) => x.id === d.option)
      if (!o) throw new ActionError(`There is no architecture option ${d.option} in this project.`)
      if (a.recommended && d.option !== a.recommended && d.reason.length < 10) throw new ActionError(`Option ${a.recommended} is trace's recommendation: say in a line why you chose ${d.option} instead.`)
      // an option another outscores needs a reason too, even trace's recommendation (test-esp32 #96)
      const higher = outscoredBy(a, d.option, d.scores ?? [])
      if (higher && d.reason.trim().length < 10) throw new ActionError(`${outscoredWords(higher)}: say in a line why you chose ${d.option}.`)
      const known = new Set(a.criteria.map((c) => c.id))
      const unknown = [...d.deciding, ...(d.scores ?? []).map((s) => s.criterion)].filter((c) => !known.has(c))
      if (unknown.length) throw new ActionError(`Not one of the criteria: ${[...new Set(unknown)].join(', ')}.`)
      return {
        kind: 'architecture.choice', target: 'architecture', choice: 'chosen',
        detail: { option: d.option, reason: d.reason, deciding: d.deciding, ...(d.scores ? { scores: d.scores } : {}), ...(d.only_one ? { only_one: d.only_one } : {}), recommended: a.recommended },
        summary: `Architecture ${o.id} (${o.name}) was chosen${a.recommended && a.recommended !== o.id ? `, against trace's recommendation of ${a.recommended}` : ''}: ${d.reason}`,
      }
    }
    case 'pins': {
      const pins = rows.pins.filter((p) => p.part === d.part && p.status !== 'withdrawn')
      if (!pins.length) throw new ActionError(`The pin plan has no pins of ${d.part}.`)
      return { kind: 'pins.agreed', target: d.part, choice: 'agreed', detail: { print: pinPlanPrint(rows.pins, d.part), pins: pins.length }, summary: `The pin plan of ${d.part} (${pins.length} pins) was agreed.` }
    }
  }
}

/**
 * The stage a decision changes, when it changes one (CHANGE_STAGE): a requirement or intent decided again the same way,
 * with the same words, changes nothing and returns null, so re-accepting what stands never sends a project back.
 */
export function changesStage(p: { kind: string; target: string; choice: string; detail: Record<string, unknown> }, prior: readonly DesignDecision[]): StageId | null {
  const stage = CHANGE_STAGE[p.kind]
  if (!stage) return null
  const was = [...prior].reverse().find((d) => d.kind === p.kind && d.target === p.target && d.supersededAt === null)
  const same = was && was.choice === p.choice && JSON.stringify(was.detail) === JSON.stringify(p.detail)
  return same ? null : stage
}

export const DESIGN_ACTIONS = {
  'design.decide': def('write', Repo.extend({ decision: Decision }), async (a, ctx) => {
    const { rows, requirements } = await repoRows(ctx, a.repo)
    const by = { label: label(ctx.principal), hash: hashOf(ctx.principal) }
    const out = await plainly(() => writeJourney(ctx, a.repo, (db) => {
      const r = loadJourney(db)
      if (!r) throw new ActionError('This project has no journey yet, so there is nowhere to record the decision.')
      const prior = loadDesignDecisions(db)
      const p = prepare(a.decision, rows, requirements, prior)
      const rec = recordDesignDecision(db, p, by)
      decide(db, { kind: `design.${p.kind}`, stage: r.journey.currentStage, ref: p.target, by: by.label, summary: p.summary, detail: { decision: rec.id } })
      // a requirement, the intent behind it or the architecture changed after its stage was passed
      const stage = changesStage(p, prior)
      // before release the project goes back to that stage; after it, the next revision starts there (applyChange)
      const back = stage ? applyChange(db, stage, changeReason(stage, p.summary), by.label) : null
      return { result: { decision: { id: rec.id, kind: rec.kind, target: rec.target, choice: rec.choice, by: rec.by, at: new Date(rec.at * 1000).toISOString() }, summary: back ? `${p.summary} ${changeWords(back)}, to agree it.` : p.summary, ...(back ? { back_to: back.stage, ...(back.revision ? { revision: back.revision } : {}) } : {}) } }
    }))
    return { ok: true, repo: a.repo, ...out }
  }),
}
