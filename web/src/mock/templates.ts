/**
 * The mock's project templates (src/api/actions-templates.ts): templates.list, templates.get, templates.check,
 * templates.save and templates.reset, kept in memory for the session. Seeded from the API's real answers
 * (lib/api-answers.json: the Board template, the catalog and trace's own definition), so the editor shows what the API
 * gives. The check here is only the size rules a person trips over while editing; the API holds every rule.
 */
import answers from '@/lib/api-answers.json'
import type { TemplateCatalogStage, TemplateDoc, TemplateHistoryEntry, TemplateId, TemplateView } from '@/lib/types'
import { ME } from './fixtures'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown) => json({ ok: true, result })
const refuse = (error: string) => json({ ok: false, error })

const real = (answers as unknown as Record<string, { result: unknown }>)
const GOT = real['templates.get']!.result as { template: TemplateView; catalog: TemplateCatalogStage[]; code: TemplateDoc }
const LISTED = (real['templates.list']!.result as { templates: TemplateView[] }).templates
const state = new Map<TemplateId, { view: TemplateView; history: TemplateHistoryEntry[] }>(LISTED.map((t) => [t.id, { view: t, history: [] }]))

function problems(doc: TemplateDoc): string[] {
  const out: string[] = []
  if (doc.name.trim().length < 2) out.push('The template needs a name of at least 2 characters.')
  if (doc.stages[0]?.id !== 'define') out.push('Every template starts at Define.')
  for (const s of doc.stages) for (const g of s.gates) {
    if (!g.criteria.length) out.push(`The gate ${g.id} needs at least one criterion.`)
    for (const c of g.criteria) if (c.text.trim().length < 3) out.push(`${c.id} needs its words.`)
  }
  return out
}

export function templatesAction(name: string, a: Record<string, unknown>): Response | undefined {
  switch (name) {
    case 'templates.list': return ok({ templates: [...state.values()].map((s) => s.view) })
    case 'templates.get': {
      const s = state.get(a.template as TemplateId)
      if (!s) return refuse('No such template.')
      return ok({ template: s.view, history: s.history, catalog: GOT.catalog, code: s.view.id === 'board' ? GOT.code : s.view.doc })
    }
    case 'templates.check': {
      const p = problems(a.doc as TemplateDoc)
      return ok({ ok: !p.length, problems: p })
    }
    case 'templates.save': {
      const doc = a.doc as TemplateDoc
      const p = problems(doc)
      if (p.length) return refuse(p.join(' '))
      const s = state.get(doc.id)!
      const version = s.view.version + 1
      const at = new Date().toISOString()
      s.view = { ...s.view, doc, name: doc.name, version, changed: true, updated: at, by: ME.email }
      s.history = [{ version, action: 'save', by: ME.email, at, reason: String(a.reason ?? '') }, ...s.history]
      return ok({ template: s.view, saved: true, summary: `Saved as version ${version}. Projects started before keep the version they started from.` })
    }
    case 'templates.reset': {
      const s = state.get(a.template as TemplateId)!
      if (!s.view.changed) return ok({ template: s.view, saved: false, summary: 'It was already trace\'s own definition.' })
      const version = s.view.version + 1
      const at = new Date().toISOString()
      const doc = s.view.id === 'board' ? GOT.code : s.view.doc
      s.view = { ...s.view, doc, name: doc.name, version, changed: false, updated: at, by: ME.email }
      s.history = [{ version, action: 'reset', by: ME.email, at, reason: String(a.reason ?? '') }, ...s.history]
      return ok({ template: s.view, saved: true, summary: `Back to trace's own definition, as version ${version}.` })
    }
    default: return undefined
  }
}
