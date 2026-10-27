/**
 * The tools catalogue (docs/ui-design.md, "Agents and tools"): tools.list's answer grouped by family as people think
 * of them, each with a plain name beside its tool name, where it runs, and a form built from its JSON schema for
 * Try it. Pure, so it is tested on its own.
 */

export interface ToolInfo {
  name: string
  description: string
  needs: 'read' | 'write'
  input: unknown
}

export interface Family {
  id: string
  label: string
  /** tool-name prefixes in this family */
  prefixes: string[]
}

/** The families, in the design's order. */
export const FAMILIES: Family[] = [
  { id: 'kicad', label: 'Design files (KiCad)', prefixes: ['kicad', 'board'] },
  { id: 'calc', label: 'Calculators', prefixes: ['calc'] },
  { id: 'sim', label: 'Simulation', prefixes: ['sim', 'ams', 'transient'] },
  { id: 'protocol', label: 'Protocols and timing', prefixes: ['protocol'] },
  { id: 'parts', label: 'Datasheets and parts', prefixes: ['datasheets', 'parts'] },
  { id: 'verify', label: 'Verification', prefixes: ['verify'] },
  { id: 'fpga', label: 'FPGA', prefixes: ['fpga'] },
  { id: 'firmware', label: 'Firmware', prefixes: ['firmware', 'idf'] },
  { id: 'layout', label: 'Layout and routing', prefixes: ['pcb', 'layout'] },
  { id: 'render', label: 'Rendering', prefixes: ['render', 'colourbar'] },
  { id: 'emc', label: 'EMC', prefixes: ['emc'] },
  { id: 'thermal', label: 'Thermal', prefixes: ['thermal', 'temperature'] },
  { id: 'hil', label: 'Bench instruments (hardware in the loop)', prefixes: ['hil'] },
  { id: 'knowledge', label: 'Knowledge and memory', prefixes: ['kb', 'memory', 'trace', 'agent', 'runs'] },
]

const OTHER: Family = { id: 'other', label: 'Other tools', prefixes: [] }

export const familyOf = (name: string): Family => {
  const prefix = name.split('.')[0] ?? name
  return FAMILIES.find((f) => f.prefixes.includes(prefix)) ?? OTHER
}

export function groupTools<T extends { name: string }>(tools: T[]): { family: Family; tools: T[] }[] {
  const groups = new Map<string, { family: Family; tools: T[] }>()
  for (const t of tools) {
    const f = familyOf(t.name)
    const g = groups.get(f.id) ?? { family: f, tools: [] }
    g.tools.push(t)
    groups.set(f.id, g)
  }
  const order = [...FAMILIES, OTHER].map((f) => f.id)
  return [...groups.values()].sort((a, b) => order.indexOf(a.family.id) - order.indexOf(b.family.id)).map((g) => ({ ...g, tools: g.tools.sort((a, b) => a.name.localeCompare(b.name)) }))
}

/** Plain names for the tools people meet most; the rest are made from the description's first clause. */
const PLAIN: Record<string, string> = {
  'pcb.autoroute': 'Route the board',
  'pcb.placement_check': 'Check placement',
  'pcb.floorplan': 'Plan the floor',
  'pcb.length_match': 'Match trace lengths',
  'parts.search': 'Search parts',
  'parts.lookup': 'Look up a part',
  'parts.bom_check': 'Check parts against the build quantity',
  'parts.alternatives': 'Find alternative parts',
  'parts.fetch_datasheet': 'Fetch a part\'s datasheet',
  'datasheets.list': 'List the datasheet library',
  'datasheets.get': 'Get a datasheet',
  'datasheets.find': 'Find text in a datasheet',
  'datasheets.text': 'Read datasheet pages',
  'datasheets.tables': 'Read a datasheet page\'s tables',
  'datasheets.params': 'Look up electrical characteristics',
  'datasheets.page_image': 'Picture of a datasheet page',
  'datasheets.history': 'Datasheet versions',
  'datasheets.add': 'Add a datasheet',
  'datasheets.acknowledge': 'Acknowledge a changed datasheet',
  'kicad.erc': 'Check the schematic (ERC)',
  'kicad.drc': 'Check the board layout (DRC)',
  'kicad.netlist': 'Read the netlist',
  'kicad.components': 'List the components',
  'kicad.projects': 'Find the KiCad projects',
  'kicad.net': 'Follow one net',
  'render.board': 'Render the board',
  'render.model': 'Render a 3D model',
  'render.turntable': 'Render a turntable',
  'render.status': 'Rendering status',
  'sim.spice': 'Run a SPICE simulation',
  'sim.sweep': 'Sweep a simulation',
  'sim.montecarlo': 'Monte Carlo simulation',
  'sim.measure': 'Measure a simulation',
  'kb.search': 'Search the knowledge base',
  'kb.status': 'Knowledge base status',
  'kb.sync': 'Sync the knowledge base',
  'memory.recall': 'Recall memories',
  'memory.remember': 'Remember something',
  'calc.divider': 'Voltage divider',
  'calc.regulator_feedback': 'Regulator feedback resistors',
  'calc.rc_filter': 'RC filter',
  'calc.lc_filter': 'LC filter',
  'calc.trace_width': 'Trace width for a current',
  'calc.led_resistor': 'LED resistor',
  'calc.ldo_thermal': 'LDO heat',
  'calc.impedance': 'Trace impedance',
  'calc.via': 'Via current and resistance',
}

export function plainName(t: { name: string; description: string }): string {
  if (PLAIN[t.name]) return PLAIN[t.name]!
  const first = (t.description.split(/[.:;(]|\s—\s/)[0] ?? t.name).trim()
  return first.length > 60 || first.length < 3 ? t.name.split('.').slice(1).join(' ').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : first
}

export type RunsOn = 'agent' | 'gpu' | 'cpu' | 'bench'

/** Where a tool runs: the API's list leaves out bench tools, so these are known from the tool itself. */
export function runsOn(name: string): RunsOn {
  if (name.startsWith('hil.')) return 'bench'
  if (name === 'pcb.autoroute' || name.startsWith('render.') && name !== 'render.status') return 'gpu'
  if (name === 'thermal.solve' || name === 'thermal.check' || name.startsWith('emc.') && name.includes('sim')) return 'cpu'
  return 'agent'
}

export const RUNS_ON_WORD: Record<RunsOn, string> = {
  agent: "project's agent",
  gpu: 'graphics card',
  cpu: 'a CPU job',
  bench: 'the bench machine only',
}

/** Read-only tools may be tried from the page: `needs: 'read'` in tools.list. */
export const canTry = (t: Pick<ToolInfo, 'needs'>, o: { reviewer: boolean }): boolean => t.needs === 'read' && !o.reviewer

// ------------------------------------------------------------------ a form from a JSON schema

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'string[]' | 'json'

export interface Field {
  name: string
  type: FieldType
  label: string
  description?: string
  required: boolean
  default?: unknown
  options?: string[]
  min?: number
  max?: number
}

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; enum?: unknown[]; items?: Schema; description?: string; default?: unknown; minimum?: number; maximum?: number; anyOf?: Schema[]; oneOf?: Schema[]; const?: unknown }

const label = (name: string) => name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

/** The fields of an object schema, one per property; anything not a simple value becomes a JSON field. */
export function schemaFields(input: unknown): Field[] {
  const s = (input && typeof input === 'object' ? input : {}) as Schema
  const props = s.properties ?? {}
  const required = new Set(s.required ?? [])
  return Object.entries(props).map(([name, raw]) => {
    let p = raw
    // zod's optional() as anyOf [T, null] or nullable: take the first non-null
    const alt = p.anyOf ?? p.oneOf
    if (alt) p = alt.find((x) => x.type !== 'null') ?? p
    const t = Array.isArray(p.type) ? p.type.find((x) => x !== 'null') : p.type
    const base = { name, label: label(name), required: required.has(name) && p.default === undefined, ...(raw.description ?? p.description ? { description: raw.description ?? p.description } : {}), ...(p.default !== undefined ? { default: p.default } : raw.default !== undefined ? { default: raw.default } : {}) }
    if (p.enum && p.enum.every((x) => typeof x === 'string')) return { ...base, type: 'enum' as const, options: p.enum as string[] }
    if (t === 'string') return { ...base, type: 'string' as const }
    if (t === 'number' || t === 'integer') return { ...base, type: t, ...(p.minimum !== undefined ? { min: p.minimum } : {}), ...(p.maximum !== undefined ? { max: p.maximum } : {}) }
    if (t === 'boolean') return { ...base, type: 'boolean' as const }
    if (t === 'array' && p.items?.type === 'string' && !p.items.enum) return { ...base, type: 'string[]' as const }
    return { ...base, type: 'json' as const }
  })
}

/** The form's text values → the tool's arguments; errors per field when a value does not fit. */
export function argsFromForm(fields: Field[], values: Record<string, string | boolean | undefined>): { args: Record<string, unknown>; errors: Record<string, string> } {
  const args: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  for (const f of fields) {
    const v = values[f.name]
    if (f.type === 'boolean') {
      if (v !== undefined) args[f.name] = !!v
      continue
    }
    const text = typeof v === 'string' ? v.trim() : ''
    if (!text) {
      if (f.required) errors[f.name] = 'Needed'
      continue
    }
    switch (f.type) {
      case 'number':
      case 'integer': {
        const n = Number(text)
        if (!Number.isFinite(n) || (f.type === 'integer' && !Number.isInteger(n))) errors[f.name] = f.type === 'integer' ? 'A whole number' : 'A number'
        else if (f.min !== undefined && n < f.min) errors[f.name] = `At least ${f.min}`
        else if (f.max !== undefined && n > f.max) errors[f.name] = `At most ${f.max}`
        else args[f.name] = n
        break
      }
      case 'string[]':
        args[f.name] = text.split(',').map((x) => x.trim()).filter(Boolean)
        break
      case 'json':
        try {
          args[f.name] = JSON.parse(text)
        } catch {
          errors[f.name] = 'Not valid JSON'
        }
        break
      default:
        args[f.name] = text
    }
  }
  return { args, errors }
}
