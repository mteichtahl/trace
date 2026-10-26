/** Every area's tools, gathered into the one registry the CLI and the MCP server share. */
import { Registry } from './core/registry.js'
import { tools as memory } from './agent/tools.js'
import { tools as calc } from './calc/tools.js'
import { tools as datasheets } from './datasheets/tools.js'
import { tools as firmware } from './firmware/tools.js'
import { tools as hil } from './hil/tools.js'
import { tools as kicad } from './kicad/tools.js'
import { tools as parts } from './parts/tools.js'
import { tools as pcb } from './pcb/tools.js'
import { tools as render } from './render/tools.js'
import { tools as runs } from './runs/tools.js'
import { tools as sim } from './sim/tools.js'
import { tools as ams } from './tools/ams/tools.js'
import { tools as verify } from './tools/verify/tools.js'

let registry: Registry | null = null

export function allTools(): Registry {
  registry ??= new Registry([...calc, ...kicad, ...sim, ...datasheets, ...parts, ...hil, ...firmware, ...runs, ...render, ...pcb, ...memory, ...ams, ...verify])
  return registry
}
