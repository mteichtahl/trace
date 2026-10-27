/**
 * The agent instructions screen's rules, kept pure so they are tested on their own: the live checks an override must
 * pass before Save wakes up (src/prompts/template.ts: declared variables only, at most 16,000 characters), how the
 * catalog is grouped, the layer below an entry, and the preview's marked parts.
 */
import type { PromptLayer, PromptRow, PromptView } from './admin-types'

export const MAX_PROMPT_CHARS = 16_000
const VAR_NAME = /^[a-z][a-z0-9_]*$/
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g

export interface TemplateCheck {
  /** variables used, in order */
  used: string[]
  /** used but not declared by the entry */
  unknown: string[]
  /** a malformed placeholder ("{{Name}}", an unmatched "{{") */
  malformed: string | null
  length: number
  tooLong: boolean
  ok: boolean
}

/** The same checks the API makes when an override is saved. */
export function checkTemplate(text: string, declared: string[]): TemplateCheck {
  const used: string[] = []
  let malformed: string | null = null
  for (const m of text.matchAll(PLACEHOLDER)) {
    const name = m[1] ?? ''
    if (!VAR_NAME.test(name)) {
      malformed ??= `"{{${name}}}" is not a variable: names are lower case letters, digits and _`
      continue
    }
    if (!used.includes(name)) used.push(name)
  }
  const rest = text.replace(PLACEHOLDER, '')
  if (!malformed && (rest.includes('{{') || rest.includes('}}'))) malformed = 'An unmatched "{{" or "}}": a variable is written {{name}}'
  const unknown = used.filter((u) => !declared.includes(u))
  const tooLong = text.length > MAX_PROMPT_CHARS
  return { used, unknown, malformed, length: text.length, tooLong, ok: !malformed && unknown.length === 0 && !tooLong && text.trim().length > 0 }
}

/** May Save be pressed? Checks pass, the text changed and a reason is given. */
export function canSave(o: { check: TemplateCheck; changed: boolean; reason: string; locked: boolean }): boolean {
  return !o.locked && o.check.ok && o.changed && o.reason.trim().length > 0
}

// ------------------------------------------------------------------ the catalog, grouped as people think of it

export const SPECIALIST_TITLES: Record<string, string> = {
  verify: 'Verification',
  impl: 'Implementation',
  ams: 'Analog and mixed-signal',
  emc: 'EMC',
  render: 'Rendering',
  thermal: 'Thermal',
}

const PART_TITLES: Record<string, string> = { role: 'Role', workflow: 'Workflow', done: 'Done', escalate: 'Escalation' }

export interface CatalogGroup {
  id: string
  title: string
  /** sub-groups (the specialists) */
  groups?: CatalogGroup[]
  rows: (PromptRow & { title: string })[]
  locked: boolean
}

const PROMPT_TITLES: Record<string, string> = {
  specialist: 'Shared by specialists',
  'worker.task': 'Worker',
  'worker.item': 'Worker',
  delegate: 'Delegation',
  'actions.check': 'GitHub Actions check',
  router: 'Router',
  render: 'Renders',
  cloudworker: 'Cloud worker',
  memory: 'Memory block',
  system: 'System prompt',
}

/** "specialist.ams.role" → "Role"; "worker.item.ci-red" → "Item: ci red". */
export function entryTitle(id: string): string {
  const parts = id.split('.')
  if (parts[0] === 'specialist' && SPECIALIST_TITLES[parts[1] ?? ''] && parts[2]) return PART_TITLES[parts[2]] ?? parts.slice(2).join(' ')
  const rest = parts.slice(1).join(' ').replace(/-/g, ' ')
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : id
}

export function groupCatalog(rows: PromptRow[]): CatalogGroup[] {
  const titled = rows.map((r) => ({ ...r, title: entryTitle(r.id) }))
  const kinds = Object.keys(SPECIALIST_TITLES)
  const kindOf = (id: string) => kinds.find((k) => id.startsWith(`specialist.${k}.`))
  const specialists: CatalogGroup[] = kinds
    .map((k) => {
      const rs = titled.filter((r) => kindOf(r.id) === k)
      return { id: `specialist.${k}`, title: SPECIALIST_TITLES[k]!, rows: rs, locked: rs.every((r) => r.mode === 'locked') }
    })
    .filter((g) => g.rows.length)
  const out: CatalogGroup[] = []
  if (specialists.length) out.push({ id: 'specialists', title: 'Specialists', groups: specialists, rows: [], locked: false })
  const order = ['specialist', 'worker.task', 'delegate', 'actions.check', 'router', 'render', 'cloudworker', 'memory', 'system']
  for (const p of order) {
    const rs = titled.filter((r) => !kindOf(r.id) && (r.prompt === p || (p === 'worker.task' && r.prompt === 'worker.item')))
    if (!rs.length) continue
    out.push({ id: p, title: PROMPT_TITLES[p] ?? p, rows: rs, locked: rs.every((r) => r.mode === 'locked') })
  }
  return out
}

export interface CatalogFilter {
  editableOnly: boolean
  changedOnly: boolean
  text: string
}

export function filterRows<T extends PromptRow>(rows: T[], f: CatalogFilter): T[] {
  const t = f.text.trim().toLowerCase()
  return rows.filter((r) =>
    (!f.editableOnly || r.mode === 'editable') &&
    (!f.changedOnly || r.layer !== 'default') &&
    (!t || r.id.toLowerCase().includes(t) || r.description.toLowerCase().includes(t) || entryTitle(r.id).toLowerCase().includes(t)))
}

/** "Default", "Installation v1", "Project v2". */
export function layerLabel(layer: PromptLayer, version: number | null): string {
  if (layer === 'default') return 'Default'
  return `${layer === 'installation' ? 'Installation' : 'Project'}${version ? ` v${version}` : ''}`
}

/** The text one layer below the scope being edited: what Reset returns to and Compare starts from. */
export function layerBelow(v: PromptView, scope: 'installation' | 'project'): { layer: PromptLayer; text: string; version: number | null } {
  if (scope === 'project' && v.installation?.text) return { layer: 'installation', text: v.installation.text, version: v.installation.version }
  return { layer: 'default', text: v.default, version: null }
}

/** The text this scope holds now (its own override), else what is in force beneath it. */
export function scopeText(v: PromptView, scope: 'installation' | 'project'): string {
  const own = scope === 'installation' ? v.installation : v.project
  return own?.text ?? layerBelow(v, scope).text
}

/** The scope's own override's version, for "Save as Project v3". */
export function nextVersion(v: PromptView, scope: 'installation' | 'project'): number {
  const own = scope === 'installation' ? v.installation : v.project
  return (own?.version ?? 0) + 1
}

// ------------------------------------------------------------------ the preview's parts

export interface PreviewPart {
  id: string
  locked: boolean
  layer: string
  version: number | null
  text: string
}

const MARK = /^\[(locked|editable) (\S+) · (\S+?)(?: v(\d+))? · [0-9a-f]+\]$/

/** Split prompts.preview's `marked` text into its parts. */
export function parseMarked(marked: string): PreviewPart[] {
  const out: PreviewPart[] = []
  for (const line of marked.split('\n')) {
    const m = MARK.exec(line)
    if (m) {
      out.push({ id: m[2]!, locked: m[1] === 'locked', layer: m[3]!, version: m[4] ? Number(m[4]) : null, text: '' })
    } else if (out.length) {
      const p = out[out.length - 1]!
      p.text = p.text ? `${p.text}\n${line}` : line
    }
  }
  for (const p of out) p.text = p.text.replace(/\n+$/, '')
  return out
}

/** The suggested text in trace's reply: the first fenced block, else the whole reply. */
export function suggestionFrom(reply: string): string | null {
  const m = /```[a-z]*\n([\s\S]*?)```/.exec(reply)
  const t = (m ? m[1]! : reply).replace(/\n+$/, '')
  return t.trim() ? t : null
}

/** A person's fingerprint as trace records it (src/core/telemetry.ts personHash): sha256 of the lower-cased email, 16 hex. */
export async function personHash(who: string): Promise<string> {
  const bytes = new TextEncoder().encode(who.trim().toLowerCase())
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}
