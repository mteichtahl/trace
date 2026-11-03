/**
 * What the runtime adds to Claude Code's system prompt (the Agent SDK's `systemPrompt.append`): system.append, the
 * design rules every agent works under (design.silkscreen), and
 * system.notes with the default branch's CLAUDE.md, fenced. Both are locked, so this is the same whatever the
 * overrides; the layers are taken only so the provenance is recorded like every other part's.
 */
import { type Composed, Composer, type Layers, NO_LAYERS } from './resolve.js'

export function systemAppend(notes: string | null | undefined, layers: Layers = NO_LAYERS): Composed {
  const p = new Composer(layers).add('system.append').add('design.silkscreen')
  if (notes?.trim()) p.add('system.notes', { notes: notes.replaceAll('</project-notes>', '') })
  return p.done()
}
