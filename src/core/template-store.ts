/**
 * The installation's project templates (src/core/templates.ts; plan P5.6): kept in the ACCESS store beside the
 * installation's policy, so only the API runtime's role and the installing admin can write them. A template nobody
 * changed is the code's catalog (version 0); each save makes the next version, and every save and reset is kept.
 *
 *   templates          one row per template an admin changed: its definition (JSON; NULL after a reset to the
 *                      catalog), version, when and by whom
 *   template_history   every save and reset, append only: the version it made, the definition, by, when and why
 *
 * A save is refused while the definition has a problem (templateProblems) or its shape finds one
 * (ontology/shapes/journey.template.ttl, through `check`): a template that is saved can always start a journey. A
 * journey keeps the definition it started from (src/core/journey.ts journey_template), so a later save never changes it.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { accessStore } from './access.js'
import { type Central, ensureSchema } from './central.js'
import { TEMPLATE_NAMES, TEMPLATES, type Template } from './journey-catalog.js'
import { TemplateDoc, catalogTemplate, templateProblems } from './templates.js'

ensureSchema(`
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,            -- board | fpga | firmware | mixed
  doc TEXT,                       -- the definition as JSON; NULL: back to the catalog
  version INTEGER NOT NULL,
  updated REAL NOT NULL,
  by TEXT
);
CREATE TABLE IF NOT EXISTS template_history (
  uid TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('save', 'reset')),
  doc TEXT,
  by TEXT,
  at REAL NOT NULL,
  reason TEXT
);`)

export const TemplateReason = z.string().trim().min(3, 'say why, in a few words').max(300)

export class TemplateStoreError extends Error {
  override name = 'TemplateStoreError'
}

export interface TemplateView {
  id: Template
  name: string
  /** 0: the code's catalog, never changed here */
  version: number
  /** the definition a new project starts from */
  doc: TemplateDoc
  /** an admin changed it from the catalog */
  changed: boolean
  updated: string | null
  by: string | null
}
export interface TemplateHistoryEntry { version: number; action: 'save' | 'reset'; by: string | null; at: string; reason: string | null }

/** Where the shape check runs (the Python bridge); returns its findings' messages, empty when the definition keeps to it. */
export type ShapeCheck = (doc: TemplateDoc) => Promise<string[]>

const iso = (t: number): string => new Date(t * 1000).toISOString()

export class TemplateStore {
  constructor(private readonly store: Central = accessStore()) {}

  /** Every template as a new project would start from it. */
  async list(): Promise<TemplateView[]> {
    return this.store.query((db) => {
      const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='templates'").get()
      const rows = new Map((has ? db.prepare('SELECT * FROM templates').all() as Record<string, unknown>[] : []).map((r) => [String(r.id), r]))
      return TEMPLATES.map((id) => viewOf(id, rows.get(id)))
    })
  }

  async get(id: Template): Promise<TemplateView> {
    return (await this.list()).find((t) => t.id === id) as TemplateView
  }

  async history(id: Template): Promise<TemplateHistoryEntry[]> {
    return this.store.query((db) => {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='template_history'").get()) return []
      return (db.prepare('SELECT version, action, by, at, reason FROM template_history WHERE id=? ORDER BY at DESC').all(id) as Record<string, unknown>[]).map((r) => ({
        version: Number(r.version), action: r.action === 'reset' ? 'reset' : 'save', by: r.by === null ? null : String(r.by), at: iso(Number(r.at)), reason: r.reason === null ? null : String(r.reason),
      }))
    })
  }

  /** The definition and version a new project of template `id` starts from (projects.create). */
  async definition(id: Template): Promise<{ version: number; doc: TemplateDoc }> {
    const t = await this.get(id)
    return { version: t.version, doc: t.doc }
  }

  /**
   * Save a template's definition as its next version. Refused, with every problem in words, when it cannot start a
   * journey (templateProblems) or its shape finds something (`check`); unchanged from the current one, nothing is written.
   */
  async save(input: unknown, o: { by: string; reason: string; check?: ShapeCheck | undefined }): Promise<TemplateView & { saved: boolean }> {
    const problems = templateProblems(input)
    if (problems.length) throw new TemplateStoreError(problems.join(' '))
    const doc = TemplateDoc.parse(input)
    const found = o.check ? await o.check(doc) : []
    if (found.length) throw new TemplateStoreError(found.join(' '))
    const reason = TemplateReason.parse(o.reason)
    return this.write(doc.id, doc, 'save', o.by, reason)
  }

  /** Put a template back to the code's catalog, as its next version. */
  async reset(id: Template, o: { by: string; reason: string }): Promise<TemplateView & { saved: boolean }> {
    return this.write(id, null, 'reset', o.by, TemplateReason.parse(o.reason))
  }

  private async write(id: Template, doc: TemplateDoc | null, action: 'save' | 'reset', by: string, reason: string): Promise<TemplateView & { saved: boolean }> {
    return this.store.update((db) => {
      const r = db.prepare('SELECT * FROM templates WHERE id=?').get(id) as Record<string, unknown> | undefined
      const now = viewOf(id, r)
      const same = doc === null ? !now.changed : JSON.stringify(doc) === JSON.stringify(now.doc)
      if (same) return { ...now, saved: false }
      const version = now.version + 1
      const t = Math.max(Date.now() / 1000, Number(r?.updated ?? 0) + 1e-6)
      const text = doc === null ? null : JSON.stringify(doc)
      db.prepare(`INSERT INTO templates (id, doc, version, updated, by) VALUES (?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET doc=excluded.doc, version=excluded.version, updated=excluded.updated, by=excluded.by`).run(id, text, version, t, by)
      db.prepare('INSERT INTO template_history (uid, id, version, action, doc, by, at, reason) VALUES (?,?,?,?,?,?,?,?)')
        .run(randomUUID().replaceAll('-', '').slice(0, 16), id, version, action, text, by, t, reason)
      return { ...viewOf(id, { doc: text, version, updated: t, by }), saved: true }
    })
  }
}

function viewOf(id: Template, r: Record<string, unknown> | undefined): TemplateView {
  const parsed = r?.doc ? TemplateDoc.safeParse(safeJson(String(r.doc))) : null
  const doc = parsed?.success ? parsed.data : catalogTemplate(id)
  return {
    id, name: doc.name || TEMPLATE_NAMES[id], version: r ? Number(r.version) : 0, doc, changed: Boolean(parsed?.success),
    updated: r ? iso(Number(r.updated)) : null, by: r && r.by !== null && r.by !== undefined ? String(r.by) : null,
  }
}

const safeJson = (s: string): unknown => {
  try { return JSON.parse(s) } catch { return null }
}
