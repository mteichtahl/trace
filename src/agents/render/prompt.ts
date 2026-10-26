/**
 * The rendering agent: the task prompt a Claude agent works from when the job is "produce renders". It drives the
 * render.* tools (MCP: render_board, render_model, render_turntable, render_status); the tools do the work. Its text is
 * the prompt catalog's (render.instructions, editable; render.request, locked: src/prompts/catalog.ts).
 */
import type { TraceConfig } from '../../core/config.js'
import { type Composed, Composer, type Layers, NO_LAYERS } from '../../prompts/resolve.js'

export function composeRendering(request: string, cfg: Pick<TraceConfig, 'electronics'>, layers: Layers = NO_LAYERS): Composed {
  const p = new Composer(layers)
  const projects = cfg.electronics.projects.length ? cfg.electronics.projects.join(', ') : p.text('render.projects.all')
  return p.add('render.instructions', { projects }).add('render.request', { request: request.trim() }).done()
}

export function renderingAgentPrompt(request: string, cfg: Pick<TraceConfig, 'electronics'>, layers: Layers = NO_LAYERS): string {
  return composeRendering(request, cfg, layers).text
}
