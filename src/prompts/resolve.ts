/**
 * Which text a prompt id has, and where it came from.
 *
 *   code default  →  installation override (admins)  →  project override (write access on that project)
 *
 * The most specific layer that has a usable override wins, per id. Locked ids always have their default: an
 * override of one is never used, and is reported (`problems`). So is an override of an id the catalog no longer has,
 * and one that no longer validates (a variable its entry no longer declares): it is skipped, the next layer down
 * decides, and the provenance says what was skipped and why.
 *
 * `resolvePrompt` gives one id's rendered text and its provenance (layer, version, the sha256 of the template that
 * was used); a Composer builds a whole prompt from ids and keeps every part's provenance, which the runtime records on
 * the job's span and in its run record (ids, layers and versions, never the text). Pure: the layers are loaded by
 * src/prompts/store.ts.
 */
import { createHash } from 'node:crypto'
import { CATALOG, type PromptEntry, entry } from './catalog.js'
import { MAX_PROMPT_CHARS, TemplateError, type Vars, render, validateTemplate } from './template.js'

export const LAYERS = ['default', 'installation', 'project'] as const
export type Layer = (typeof LAYERS)[number]
export type OverrideLayer = Exclude<Layer, 'default'>

/** One override as stored: text null is a reset (a tombstone, so a reset merges across branches like a change). */
export interface Override { id: string; text: string | null; version: number; updated: number; by: string | null }

/** The overrides in force for one job: the installation's and the project's (either may be absent). */
export interface Layers {
  readonly installation?: ReadonlyMap<string, Override> | undefined
  readonly project?: ReadonlyMap<string, Override> | undefined
  /** Why a layer could not be read (it was left out and the defaults below it decide). */
  readonly unavailable?: readonly { layer: OverrideLayer; reason: string }[] | undefined
}

export const NO_LAYERS: Layers = {}

export interface Provenance {
  id: string
  layer: Layer
  /** The override's version in its layer; null for the code default. */
  version: number | null
  /** sha256 of the template used, 12 hex characters: which text it was, without the text. */
  sha: string
  locked: boolean
  /** Overrides of this id that were not used, and why. */
  skipped?: { layer: OverrideLayer; version: number; reason: string }[]
}

export interface Resolved { text: string; provenance: Provenance }

export const sha12 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12)

/** Why an override of `e` can't be used, or null when it can. */
export function overrideProblem(e: PromptEntry | undefined, text: string): string | null {
  if (!e) return 'no such prompt in the catalog'
  if (e.mode === 'locked') return 'the prompt is locked'
  try {
    validateTemplate(text, e.vars, { id: e.id, maxChars: MAX_PROMPT_CHARS })
    return null
  } catch (err) {
    return err instanceof TemplateError ? err.message : String(err)
  }
}

/** The template an id has in these layers, with its provenance (no rendering). */
export function effective(id: string, layers: Layers = NO_LAYERS): { template: string; provenance: Provenance } {
  const e = entry(id)
  const skipped: NonNullable<Provenance['skipped']> = []
  if (e.mode === 'editable') {
    for (const layer of ['project', 'installation'] as const) {
      const o = layers[layer]?.get(id)
      if (!o || o.text === null) continue
      const problem = overrideProblem(e, o.text)
      if (problem) { skipped.push({ layer, version: o.version, reason: problem }); continue }
      return { template: o.text, provenance: { id, layer, version: o.version, sha: sha12(o.text), locked: false, ...(skipped.length ? { skipped } : {}) } }
    }
  } else {
    for (const layer of ['project', 'installation'] as const) {
      const o = layers[layer]?.get(id)
      if (o && o.text !== null) skipped.push({ layer, version: o.version, reason: 'the prompt is locked' })
    }
  }
  return { template: e.default, provenance: { id, layer: 'default', version: null, sha: sha12(e.default), locked: e.mode === 'locked', ...(skipped.length ? { skipped } : {}) } }
}

/** One id's text, rendered with `vars`, in these layers, and where it came from. Throws TemplateError on a bad value. */
export function resolvePrompt(id: string, vars: Vars = {}, layers: Layers = NO_LAYERS): Resolved {
  const { template, provenance } = effective(id, layers)
  return { text: render(template, entry(id).vars, vars, { id }), provenance }
}

/** Every override in these layers that is not used, and why (an unknown id, a locked one, one that does not validate). */
export function problems(layers: Layers): { id: string; layer: OverrideLayer; version: number; reason: string }[] {
  const out: { id: string; layer: OverrideLayer; version: number; reason: string }[] = []
  for (const layer of ['installation', 'project'] as const) {
    for (const o of layers[layer]?.values() ?? []) {
      if (o.text === null) continue
      const problem = overrideProblem(CATALOG.get(o.id), o.text)
      if (problem) out.push({ id: o.id, layer, version: o.version, reason: problem })
    }
  }
  return out
}

// ------------------------------------------------------------------ a whole prompt

export interface Part extends Provenance { text: string }
export interface Composed { text: string; parts: Part[]; provenance: Provenance[] }

/** Parts are joined by one blank line, and nothing else is added: every character of a prompt comes from a part. */
export const JOIN = '\n\n'

/**
 * Builds one prompt from catalog ids: `add` appends a part, `text` renders an id for use inside another part's
 * variable (an inline fragment). Both record provenance.
 */
export class Composer {
  private readonly parts: Part[] = []
  private readonly inline: Provenance[] = []

  constructor(readonly layers: Layers = NO_LAYERS) {}

  text(id: string, vars: Vars = {}): string {
    const r = resolvePrompt(id, vars, this.layers)
    this.inline.push(r.provenance)
    return r.text
  }

  add(id: string, vars: Vars = {}): this {
    const r = resolvePrompt(id, vars, this.layers)
    this.parts.push({ ...r.provenance, text: r.text })
    return this
  }

  /** The prompt so far. */
  done(): Composed {
    const parts = [...this.parts]
    return { text: parts.map((p) => p.text).join(JOIN), parts, provenance: [...parts.map(({ text: _t, ...p }) => p), ...this.inline] }
  }
}

/** A prompt with each part headed by its id, whether it is locked, and its layer and version: for review. */
export function marked(c: Composed): string {
  return c.parts.map((p) => `${markOf(p)}\n${p.text}`).join(JOIN)
}

export const markOf = (p: Provenance): string =>
  `[${p.locked ? 'locked' : 'editable'} ${p.id} · ${p.layer}${p.version === null ? '' : ` v${p.version}`} · ${p.sha}]`

/** One part as telemetry and the run record see it: `id@layer:version`, never the text. */
export const label = (p: Pick<Provenance, 'id' | 'layer' | 'version' | 'sha'>): string => `${p.id}@${p.layer}:${p.version === null ? `d-${p.sha.slice(0, 8)}` : `v${p.version}`}`

/** Provenance without text or skipped detail: what a job's record keeps. */
export interface PromptRecord { id: string; layer: Layer; version: number | null; sha: string }
export const record = (ps: readonly Provenance[]): PromptRecord[] => {
  const seen = new Set<string>()
  const out: PromptRecord[] = []
  for (const p of ps) {
    const key = `${p.id}|${p.layer}|${p.version}|${p.sha}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ id: p.id, layer: p.layer, version: p.version, sha: p.sha })
  }
  return out
}

/** The provenance of ids whose text needs no variables to know where it comes from (a composition done elsewhere). */
export function provenanceOf(ids: readonly string[], layers: Layers = NO_LAYERS): Provenance[] {
  return ids.map((id) => effective(id, layers).provenance)
}
