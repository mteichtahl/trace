/**
 * Project templates as an installation keeps them (docs/ontology.md "Where templates live"; plan P5.6): the code's
 * catalog (src/core/journey-catalog.ts) is the default each installation is seeded with, and its admins may change a
 * template within that catalog:
 *
 *   - name it, and choose which of the catalog's stages it has (in the catalog's order; Define always, and the later
 *     stages Certify, Produce and Sustain always, since each project chooses those for itself)
 *   - choose which of a gate's catalog criteria it has (any template's), and reword any criterion
 *   - add criteria a person signs off (owner person, with the evidence they look at): trace has no check behind them,
 *     so a person meets one by confirming it (journey.ts confirmCriterion)
 *   - reword each stage's guide (what it is for, what the person does, what trace does, what they get, how long)
 *
 * What it may not change is what the code depends on: a stage's gates and their ids, a criterion trace checks (its
 * owner, its id), the template ids themselves. templateProblems says what is wrong with a definition, in words for the
 * admin; a journey starts from a definition only when it has none (src/core/journey.ts startJourney), and keeps it.
 *
 *   TemplateDoc            the definition as stored: id, name, its stages with their gates' criteria and guides
 *   catalogTemplate(id)    the code's definition of a template: the seed, and what "reset" goes back to
 *   templateProblems(doc)  everything wrong with a definition, empty when it is sound
 *   docStages(doc, later)  the stages, gates and criteria a project gets from it, as templateStages gives them
 *   docGuide(doc, stage)   a stage's guide words from it
 */
import { z } from 'zod'
import {
  GATES, LATER_STAGES, type LaterStage, STAGE_IDS, STAGE_NAMES, STAGES_OF, type StageId, TEMPLATE_NAMES, TEMPLATES, type Template,
  type TemplateStage,
} from './journey-catalog.js'
import { stageGuideText } from './stage-guides.js'

const GUIDE_FIELDS = ['purpose', 'you_do', 'trace_does', 'you_get', 'typical_time'] as const
const Words = (max: number) => z.string().trim().min(3).max(max)

export const GuideDoc = z.object({
  purpose: Words(400), you_do: Words(600), trace_does: Words(800), you_get: Words(400), typical_time: Words(120),
}).strict()
export const CriterionDoc = z.object({
  /** `<gate>.<key>`: a catalog criterion's id, or a person's criterion the admin added (`custom` true) */
  id: z.string().regex(/^[a-z][a-z.]*\.[a-z][a-z-]{0,39}$/, 'a criterion id such as capture.erc'),
  text: Words(300),
  /** a criterion the admin added: always a person's, with the evidence they look at */
  custom: z.boolean().optional(),
  evidence: Words(120).optional(),
}).strict()
export const GateDoc = z.object({ id: z.string().min(1).max(40), criteria: z.array(CriterionDoc).max(20) }).strict()
export const StageDoc = z.object({ id: z.enum(STAGE_IDS), gates: z.array(GateDoc).max(4), guide: GuideDoc }).strict()
export const TemplateDoc = z.object({
  id: z.enum(TEMPLATES),
  name: z.string().trim().min(2).max(60),
  stages: z.array(StageDoc).min(1).max(STAGE_IDS.length),
}).strict()
export type TemplateDoc = z.output<typeof TemplateDoc>
export type GuideText = z.output<typeof GuideDoc>

const catalogCriterion = (id: string) => {
  const dot = id.lastIndexOf('.')
  const gate = GATES.find((g) => g.id === id.slice(0, dot))
  return gate?.criteria.find((c) => c.key === id.slice(dot + 1)) ? { gate, def: gate.criteria.find((c) => c.key === id.slice(dot + 1))! } : null
}

/** The code's definition of template `id`: its stages (and every later stage), their gates' criteria and guides. */
export function catalogTemplate(id: Template): TemplateDoc {
  const ids = [...STAGES_OF[id], ...LATER_STAGES]
  return {
    id, name: TEMPLATE_NAMES[id],
    stages: ids.map((s) => ({
      id: s,
      gates: GATES.filter((g) => g.stage === s).map((g) => ({
        id: g.id, criteria: g.criteria.filter((c) => (c.in ?? TEMPLATES).includes(id)).map((c) => ({ id: `${g.id}.${c.key}`, text: c.text })),
      })),
      guide: stageGuideText(s, id),
    })),
  }
}

/** Everything wrong with a definition, in words for the admin who edits it. Empty: it can start a journey. */
export function templateProblems(input: unknown): string[] {
  const parsed = TemplateDoc.safeParse(input)
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join(' › ') || 'the template'}: ${i.message}`)
  const doc = parsed.data
  const out: string[] = []
  const ids = doc.stages.map((s) => s.id)
  if (new Set(ids).size !== ids.length) out.push('A stage is listed twice.')
  const order = ids.map((s) => STAGE_IDS.indexOf(s))
  if (order.some((v, i) => i > 0 && v < order[i - 1]!)) out.push(`The stages are not in order: they run ${STAGE_IDS.map((s) => STAGE_NAMES[s]).join(', ')}.`)
  if (ids[0] !== 'define') out.push('Every template starts at Define.')
  for (const later of LATER_STAGES) if (!ids.includes(later)) out.push(`${STAGE_NAMES[later]} stays in every template: each project chooses whether to use it.`)
  if (!ids.some((s) => !(LATER_STAGES as readonly string[]).includes(s) && s !== 'define')) out.push('A template needs at least one stage after Define.')
  for (const s of doc.stages) {
    const want = GATES.filter((g) => g.stage === s.id).map((g) => g.id)
    const have = s.gates.map((g) => g.id)
    if (want.join() !== have.join()) {
      out.push(`${STAGE_NAMES[s.id]} ends at ${want.length === 1 ? 'its gate' : 'its gates'} ${want.join(' and ')}, in that order.`)
      continue
    }
    for (const g of s.gates) {
      const seen = new Set<string>()
      if (!g.criteria.length) out.push(`The gate ${g.id} needs at least one criterion.`)
      for (const c of g.criteria) {
        if (seen.has(c.id)) out.push(`${c.id} is listed twice.`)
        seen.add(c.id)
        if (!c.id.startsWith(`${g.id}.`) || c.id.slice(g.id.length + 1).includes('.')) { out.push(`${c.id} does not belong to the gate ${g.id}: its id starts ${g.id}.`); continue }
        const known = catalogCriterion(c.id)
        if (c.custom) {
          if (known) out.push(`${c.id} is one of trace's own criteria: choose another name for an added one.`)
          if (!c.evidence) out.push(`${c.id} needs the evidence a person looks at to sign it off.`)
        } else {
          if (!known) out.push(`${c.id} is not one of trace's criteria. To add your own, mark it as added and say what evidence a person looks at.`)
          if (c.evidence) out.push(`${c.id} is one of trace's criteria: its evidence is trace's, and cannot be changed.`)
        }
      }
    }
  }
  return out
}

/** The stages, gates and criteria a project gets from a definition, with the later stages it chose. */
export function docStages(doc: TemplateDoc, later: readonly LaterStage[] = []): TemplateStage[] {
  return doc.stages.filter((s) => !(LATER_STAGES as readonly string[]).includes(s.id) || later.includes(s.id as LaterStage)).map((s) => ({
    id: s.id, name: STAGE_NAMES[s.id], optional: (LATER_STAGES as readonly string[]).includes(s.id),
    gates: s.gates.map((g) => ({
      id: g.id, stage: s.id, name: GATES.find((x) => x.id === g.id)?.name ?? g.id,
      criteria: g.criteria.map((c) => {
        const known = c.custom ? null : catalogCriterion(c.id)
        return { id: c.id, text: c.text, owner: known?.def.owner ?? 'person', evidence: known?.def.evidence ?? c.evidence ?? 'what the person checked' }
      }),
    })),
  }))
}

/** A stage's guide words from a definition; the catalog's when the definition does not have the stage. */
export function docGuide(doc: TemplateDoc | null, stage: StageId, template: Template): GuideText {
  return doc?.stages.find((s) => s.id === stage)?.guide ?? stageGuideText(stage, template)
}

/** The ids of the criteria a person signs off that an admin added to a definition (no skill or check meets them). */
export const addedCriteria = (doc: TemplateDoc | null): Set<string> =>
  new Set((doc?.stages ?? []).flatMap((s) => s.gates.flatMap((g) => g.criteria.filter((c) => c.custom).map((c) => c.id))))

export { GUIDE_FIELDS }
