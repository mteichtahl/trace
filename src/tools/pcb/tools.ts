/** The pcb tools: board-level operations that drive external routers (src/tools/pcb/autoroute.ts), and JLCPCB's board capabilities (./capabilities-tools.ts). */
import type { AnyTool } from '../../core/registry.js'
import { autoroute } from './autoroute.js'
import { boardCapabilitiesCheckTool, boardCapabilitiesTool } from './capabilities-tools.js'

export const tools: AnyTool[] = [autoroute, boardCapabilitiesTool, boardCapabilitiesCheckTool] as unknown as AnyTool[]
