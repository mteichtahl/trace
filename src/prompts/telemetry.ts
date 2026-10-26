/**
 * What telemetry records of a job's prompts: each part's id, layer and version (a code default as `d-<sha8>` of its
 * template), in step, and how many came from an override. Never the text, nor a variable's value.
 */
import { ATTR, type Attrs } from '../core/telemetry.js'
import type { PromptRecord } from './resolve.js'

export type { PromptRecord } from './resolve.js'

/** At most this many parts go on a span (the attribute guard keeps 64 items of an array). */
const MAX_PARTS = 64

export function promptAttrs(used: readonly PromptRecord[]): Attrs {
  const parts = used.slice(0, MAX_PARTS)
  return {
    [ATTR.promptIds]: parts.map((p) => p.id),
    [ATTR.promptLayers]: parts.map((p) => p.layer),
    [ATTR.promptVersions]: parts.map((p) => (p.version === null ? `d-${p.sha.slice(0, 8)}` : `v${p.version}`)),
    [ATTR.promptOverridden]: used.filter((p) => p.layer !== 'default').length,
  }
}
