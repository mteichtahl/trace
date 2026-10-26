/**
 * The one list of tools trace offers. The CLI (`trace tool <name> key=value ...`) and the MCP server (`trace mcp`,
 * which Claude Code uses) are both generated from it, so a tool is written once.
 *
 * An area defines its tools in its own `tools.ts`:
 *
 *   export const divider = defineTool({
 *     name: 'calc.divider',
 *     description: 'Resistor divider: output voltage, or the resistor pair for a target, from an E-series.',
 *     input: z.object({ vin: z.number().describe('input voltage (V)'), ... }),
 *     run: async (args) => { ... },   // args is fully typed from `input`
 *   })
 *
 * and lists them in its `tools` export; src/tools.ts gathers every area. Inputs are validated by their zod schema
 * before `run` sees them, and the same schema is published to MCP as JSON Schema. A tool throws ToolError for a
 * problem the caller should read (bad input, a missing program, a failed run); anything else is a bug.
 */
import { z } from 'zod'

export class ToolError extends Error {
  override name = 'ToolError'
}

export interface ToolContext {
  /** Hardware (instruments, buses, targets) may be driven in this call. */
  readonly hardware: boolean
  /** Where the call came from, for the run record. */
  readonly via: 'cli' | 'mcp' | 'test'
}

export interface Tool<I extends z.ZodObject = z.ZodObject, O = unknown> {
  readonly name: string
  readonly description: string
  readonly input: I
  /** Drives real hardware: refused unless the session allows it (TRACE_HARDWARE=1 or --hardware). */
  readonly hardware: boolean
  readonly run: (args: z.output<I>, ctx: ToolContext) => Promise<O> | O
}

export function defineTool<I extends z.ZodObject, O>(def: {
  name: string
  description: string
  input: I
  hardware?: boolean
  run: (args: z.output<I>, ctx: ToolContext) => Promise<O> | O
}): Tool<I, O> {
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(def.name)) throw new Error(`tool name ${def.name} must be area.name`)
  return { hardware: false, ...def }
}

/** A tool with its input type erased, for collections. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<z.ZodObject, unknown>

export class Registry {
  private readonly tools = new Map<string, AnyTool>()

  constructor(tools: readonly AnyTool[] = []) {
    for (const t of tools) this.add(t)
  }

  add(tool: AnyTool): void {
    if (this.tools.has(tool.name)) throw new Error(`tool ${tool.name} registered twice`)
    this.tools.set(tool.name, tool)
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name)
  }

  list(): AnyTool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Validate `args` against the tool's schema, then run it. */
  async call(name: string, args: unknown, ctx: ToolContext): Promise<unknown> {
    const t = this.tools.get(name)
    if (!t) throw new ToolError(`no tool ${JSON.stringify(name)}`)
    if (t.hardware && !ctx.hardware) {
      throw new ToolError(`${name} drives real hardware; it runs only with hardware allowed (TRACE_HARDWARE=1 or --hardware)`)
    }
    const parsed = t.input.strict().safeParse(args ?? {})
    if (!parsed.success) {
      throw new ToolError(`${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`)
    }
    return t.run(parsed.data, ctx)
  }

  /** The tool's input as JSON Schema (for MCP and `trace tools --schema`). */
  static jsonSchema(t: AnyTool): Record<string, unknown> {
    return z.toJSONSchema(t.input.strict(), { io: 'input' }) as Record<string, unknown>
  }
}
