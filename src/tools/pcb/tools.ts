/** The pcb tools: board-level operations that drive external routers (src/tools/pcb/autoroute.ts). */
import type { AnyTool } from '../../core/registry.js'
import { autoroute } from './autoroute.js'

export const tools: AnyTool[] = [autoroute] as unknown as AnyTool[]
