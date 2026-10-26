/**
 * Every specialist agent, by kind. Jobs start one of these (src/agents/router.ts picks which); the generic worker
 * (src/agents/worker/prompt.ts) runs only when a specialist delegates to it.
 *
 *   verify   src/agents/verify   Verification
 *   impl     src/agents/impl     Implementation
 *   ams      src/agents/ams      Analog & Mixed-Signal
 *   emc      src/agents/emc      EMC & Simulation
 *   render   src/agents/render   Rendering
 *   thermal  src/agents/thermal  Thermal
 */
import { type SpecialistKind } from './kinds.js'
import { ams } from './ams/index.js'
import { emc } from './emc/index.js'
import { impl } from './impl/index.js'
import { render } from './render/index.js'
import type { Specialist } from './specialist.js'
import { thermal } from './thermal/index.js'
import { verify } from './verify/index.js'

export { SPECIALIST_KINDS, SpecialistKindSchema, type Route, type SpecialistKind } from './kinds.js'
export {
  DELEGATE_TOOL, SHARED_TOOLS, SPECIALIST_BUILTINS, type Specialist, allowedToolsOf, mcpToolName, specialistPrompt, toolsOf,
} from './specialist.js'

export const SPECIALISTS: Readonly<Record<SpecialistKind, Specialist>> = { verify, impl, ams, emc, render, thermal }

export function specialist(kind: SpecialistKind): Specialist {
  return SPECIALISTS[kind]
}
