/**
 * The prompt templates' one feature: `{{name}}` is replaced by the value of the variable `name`. Nothing else.
 *
 *   - No code runs: there are no expressions, filters, loops or conditionals. A name is [a-z][a-z0-9_]* and nothing
 *     more; `{{ name }}` (spaces inside) is the same variable.
 *   - A template may use only the variables its catalog entry declares. An unknown variable is refused, by name, both
 *     when an override is saved and when it is rendered; so is a malformed placeholder (`{{`, `}}` or `{{Name}}`
 *     without a valid name inside).
 *   - Values are substituted in one pass and never scanned again, so a value (a request, a rules file, an issue's
 *     title) that contains `{{…}}` stays literal text: data can't reach the template language.
 *   - A variable a template leaves out is simply not used. What must reach the model whatever an override says (the
 *     request, the rules, the guardrails) lives in locked entries (catalog.ts), which an override can't replace.
 *
 * Every variable is typed: `text` (any string), `number`, or `list` (strings, rendered one per line). Values are
 * checked against the declared type before rendering.
 */
import { z } from 'zod'

export const VAR_NAME = /^[a-z][a-z0-9_]*$/
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g

/** Most characters an override (one prompt id's text) may have. Defaults are code and not capped. */
export const MAX_PROMPT_CHARS = 16_000

export type VarType = 'text' | 'number' | 'list'
export interface VarSpec { readonly type: VarType; readonly description: string }
export type VarSpecs = Readonly<Record<string, VarSpec>>
export type VarValue = string | number | readonly string[]
export type Vars = Readonly<Record<string, VarValue>>

export class TemplateError extends Error {
  override name = 'TemplateError'
  /** The variable (or placeholder text) that was refused, when there is one. */
  constructor(message: string, readonly variable?: string) { super(message) }
}

/** The variable names a template uses, in order of first use. Throws TemplateError on a malformed placeholder. */
export function variablesOf(template: string): string[] {
  const names: string[] = []
  for (const m of template.matchAll(PLACEHOLDER)) {
    const name = m[1] ?? ''
    if (!VAR_NAME.test(name)) throw new TemplateError(`"{{${name}}}" is not a variable: names are lower case letters, digits and _`, name)
    if (!names.includes(name)) names.push(name)
  }
  const rest = template.replace(PLACEHOLDER, '')
  if (rest.includes('{{') || rest.includes('}}')) throw new TemplateError('an unmatched "{{" or "}}": a variable is written {{name}}')
  return names
}

/**
 * Check a template against the variables it may use (and the size cap, for an override). Returns the variables it
 * uses. Throws TemplateError naming the first bad variable.
 */
export function validateTemplate(template: string, allowed: VarSpecs, o: { id?: string; maxChars?: number } = {}): string[] {
  const where = o.id ? `${o.id}: ` : ''
  if (o.maxChars !== undefined && template.length > o.maxChars) throw new TemplateError(`${where}${template.length} characters; at most ${o.maxChars}`)
  let used: string[]
  try {
    used = variablesOf(template)
  } catch (e) {
    if (e instanceof TemplateError) throw new TemplateError(`${where}${e.message}`, e.variable)
    throw e
  }
  for (const name of used) {
    if (!Object.hasOwn(allowed, name)) {
      const known = Object.keys(allowed)
      throw new TemplateError(`${where}unknown variable {{${name}}}${known.length ? ` (it may use ${known.map((k) => `{{${k}}}`).join(', ')})` : ' (it takes no variables)'}`, name)
    }
  }
  return used
}

const ValueSchemas: Record<VarType, z.ZodType> = {
  text: z.string(),
  number: z.number().finite(),
  list: z.array(z.string()),
}

const show = (t: VarType, v: VarValue): string => (t === 'list' ? (v as readonly string[]).join('\n') : String(v))

/**
 * Render a template: each `{{name}}` becomes its value (a list: one item per line). The template is validated
 * first; a value that does not match its declared type, or a used variable with no value, is refused.
 */
export function render(template: string, specs: VarSpecs, vars: Vars, o: { id?: string } = {}): string {
  const used = validateTemplate(template, specs, o)
  const where = o.id ? `${o.id}: ` : ''
  for (const name of used) {
    const spec = specs[name] as VarSpec
    if (!Object.hasOwn(vars, name)) throw new TemplateError(`${where}no value for {{${name}}}`, name)
    if (!ValueSchemas[spec.type].safeParse(vars[name]).success) throw new TemplateError(`${where}{{${name}}} must be ${spec.type}`, name)
  }
  return template.replace(PLACEHOLDER, (_m, raw: string) => show((specs[raw.trim()] as VarSpec).type, vars[raw.trim()] as VarValue))
}
