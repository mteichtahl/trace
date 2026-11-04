/**
 * The installation's project templates (src/core/template-store.ts; plan P5.6), for Settings › Templates:
 *
 *   templates.list    signed in   every template as a new project starts from it: name, version, whether an admin
 *                                 changed it, and its definition (projects.create's choice reads the names)
 *   templates.get     admin       one template with its history, the code's definition (what reset goes back to), and
 *                                 the catalog an admin chooses from: every stage, its gates, and every criterion trace
 *                                 knows for each gate, with who decides it and the evidence
 *   templates.check   admin       a definition's problems, without saving it (the editor shows them as the admin works)
 *   templates.save    admin       save a definition as the next version, with a reason. Refused while it has a problem
 *                                 or its shape (ontology/shapes/templates/journey-template.ttl, pySHACL on the Python
 *                                 bridge) finds one. Projects started before keep the version they started from
 *   templates.reset   admin       put a template back to the code's definition, as its next version, with a reason
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { bridge } from '../core/bridge.js'
import { GATES, LATER_STAGES, STAGE_IDS, STAGE_NAMES, TEMPLATES } from '../core/journey-catalog.js'
import { TemplateStore, TemplateStoreError, type ShapeCheck } from '../core/template-store.js'
import { type TemplateDoc, catalogTemplate, templateProblems } from '../core/templates.js'
import { ONTOLOGY_DIR } from '../ontology/vocab.js'
import { templateTurtle } from '../ontology/template-graph.js'
import { ActionError, def, label } from './action-kit.js'

const Template = z.enum(TEMPLATES)

/** Every stage, its gates, and every criterion trace knows for each gate: what an admin chooses from. */
export function templateCatalog() {
  return STAGE_IDS.map((s) => ({
    id: s, name: STAGE_NAMES[s], later: (LATER_STAGES as readonly string[]).includes(s),
    gates: GATES.filter((g) => g.stage === s).map((g) => ({
      id: g.id, name: g.name,
      criteria: g.criteria.map((c) => ({ id: `${g.id}.${c.key}`, text: c.text, owner: c.owner, evidence: c.evidence, templates: [...(c.in ?? TEMPLATES)] })),
    })),
  }))
}

const Finding = z.object({ message: z.string() }).loose()
const ShapeResult = z.object({ conforms: z.boolean(), findings: z.array(Finding) })

/** The template's shape, run by the Python bridge: each finding's message. A bridge that cannot run refuses the save. */
export const shapeCheck: ShapeCheck = async (doc: TemplateDoc) => {
  const shape = readFileSync(join(ONTOLOGY_DIR, 'shapes', 'templates', 'journey-template.ttl'), 'utf8')
  const data = await templateTurtle(doc, { installation: process.env.TRACE_PREFIX ?? 'trace', version: 0 })
  try {
    const r = await bridge().call('shapes.check', { data, shapes: [shape] }, ShapeResult)
    return [...new Set(r.findings.map((f) => f.message))]
  } catch (e) {
    throw new ActionError(`The template's shape could not be checked, so it was not saved: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** The shape check templates.save runs (a test seam). */
export const templateChecks: { shape: ShapeCheck } = { shape: shapeCheck }

const store = (): TemplateStore => new TemplateStore()
const refused = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof TemplateStoreError || e instanceof z.ZodError) throw new ActionError(e instanceof z.ZodError ? e.issues.map((i) => i.message).join(' ') : e.message)
    throw e
  }
}

export const TEMPLATE_ACTIONS = {
  'templates.list': def('signed-in', z.object({}), async () => ({ templates: await store().list() })),

  'templates.get': def('admin', z.object({ template: Template }), async (a) => {
    const s = store()
    const [t, history] = await Promise.all([s.get(a.template), s.history(a.template)])
    return { template: t, history, catalog: templateCatalog(), code: catalogTemplate(a.template) }
  }),

  'templates.check': def('admin', z.object({ doc: z.unknown() }), async (a) => {
    const problems = templateProblems(a.doc)
    return { ok: problems.length === 0, problems }
  }),

  'templates.save': def('admin', z.object({ doc: z.unknown(), reason: z.string().trim().max(300) }), async (a, ctx) =>
    refused(async () => {
      const t = await store().save(a.doc, { by: label(ctx.principal), reason: a.reason, check: templateChecks.shape })
      return { template: t, saved: t.saved, summary: t.saved ? `Saved as version ${t.version}. Projects started before keep the version they started from.` : 'Nothing changed.' }
    })),

  'templates.reset': def('admin', z.object({ template: Template, reason: z.string().trim().max(300) }), async (a, ctx) =>
    refused(async () => {
      const t = await store().reset(a.template, { by: label(ctx.principal), reason: a.reason })
      return { template: t, saved: t.saved, summary: t.saved ? `Back to trace's own definition, as version ${t.version}.` : 'It was already trace\'s own definition.' }
    })),
}
