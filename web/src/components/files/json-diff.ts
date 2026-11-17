/**
 * Structured data compared by key: which keys of a JSON document were added, removed or changed, as dotted paths
 * ("settings.fab.layers"). Pure, so it is tested. A path in an array uses its index ("items[2].name").
 */

export type KeyChange = 'added' | 'removed' | 'changed'
export interface KeyDiff { path: string; change: KeyChange; before?: unknown; after?: unknown }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The text parsed as JSON, or undefined when it is not (a viewer then shows the text). */
export function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Every leaf-level difference between two JSON values. Objects and arrays are walked; anything else is compared whole. */
export function diffJson(before: unknown, after: unknown, path = '', out: KeyDiff[] = []): KeyDiff[] {
  const join = (k: string | number) => (typeof k === 'number' ? `${path}[${k}]` : path ? `${path}.${k}` : k)
  if (isObj(before) && isObj(after)) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!(k in before)) out.push({ path: join(k), change: 'added', after: after[k] })
      else if (!(k in after)) out.push({ path: join(k), change: 'removed', before: before[k] })
      else diffJson(before[k], after[k], join(k), out)
    }
  } else if (Array.isArray(before) && Array.isArray(after)) {
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      if (i >= before.length) out.push({ path: join(i), change: 'added', after: after[i] })
      else if (i >= after.length) out.push({ path: join(i), change: 'removed', before: before[i] })
      else diffJson(before[i], after[i], join(i), out)
    }
  } else if (JSON.stringify(before) !== JSON.stringify(after)) {
    out.push({ path: path || '(whole file)', change: 'changed', before, after })
  }
  return out
}

/** A value in one short line, for the changed-keys list. */
export function brief(v: unknown, max = 60): string {
  const s = typeof v === 'string' ? JSON.stringify(v) : (JSON.stringify(v) ?? 'none')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Whether a file is JSON the tree view can draw (by its name; the content is parsed when it opens). */
export const isJsonFile = (path: string): boolean => /\.(json|jsonc|jsonld|kicad_pro|kicad_prl)$/i.test(path)
