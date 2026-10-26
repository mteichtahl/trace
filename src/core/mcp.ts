/**
 * The trace MCP server: every tool in the registry, over stdio, for Claude Code (`trace mcp`;
 * `claude mcp add trace -- trace mcp`).
 *
 * MCP tool names may only use letters, digits, `_` and `-`, so `kicad.erc` is offered as `kicad_erc`. A ToolError
 * comes back as a tool result with isError set (the model reads it and adjusts); anything else is reported with its
 * stack, since it is a bug in the tool. Tools that drive hardware are listed only when TRACE_HARDWARE=1, so a session
 * on a machine with nothing attached is never offered them.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { type AnyTool, Registry, ToolError } from './registry.js'

export const VERSION = '0.1.0'
export const mcpName = (name: string): string => name.replaceAll('.', '_')
export const hardwareAllowed = (): boolean => ['1', 'true', 'yes'].includes(process.env.TRACE_HARDWARE ?? '')

const INSTRUCTIONS = 'Electronics tools: KiCad reading and ERC/DRC, BOM and parts, a datasheet library and parts database ' +
  'shared by every project, calculators, SPICE and Verilog simulation, the firmware loop and hardware-in-the-loop. ' +
  'Every run is recorded in the project database (trace_runs, trace_run). Cite datasheet figures with part number, sha256 and page.'

function text(obj: unknown): string {
  return typeof obj === 'string' ? obj : JSON.stringify(obj, (_k, v: unknown) => (typeof v === 'bigint' ? Number(v) : v), 1)
}

/** The tools this session offers, by MCP name. */
export function offered(registry: Registry, hardware = hardwareAllowed()): Map<string, AnyTool> {
  return new Map(registry.list().filter((t) => hardware || !t.hardware).map((t) => [mcpName(t.name), t]))
}

/** One tools/call, as the server answers it (exported for tests). */
export async function callTool(registry: Registry, name: string, args: unknown, hardware = hardwareAllowed()): Promise<CallToolResult> {
  const t = offered(registry, hardware).get(name)
  if (!t) return { content: [{ type: 'text', text: `unknown tool ${JSON.stringify(name)}` }], isError: true }
  // A tool's own console output must never reach the protocol stream (stdout).
  const log = console.log
  console.log = (...a: unknown[]) => { process.stderr.write(`${a.map(String).join(' ')}\n`) }
  try {
    const out = await registry.call(t.name, args, { hardware, via: 'mcp' })
    return { content: [{ type: 'text', text: text(out) }], isError: false }
  } catch (e) {
    if (e instanceof ToolError) return { content: [{ type: 'text', text: e.message }], isError: true }
    const err = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)
    return { content: [{ type: 'text', text: `internal error in ${t.name}:\n${err.slice(0, 4000)}` }], isError: true }
  } finally {
    console.log = log
  }
}

export function server(registry: Registry): Server {
  const s = new Server({ name: 'trace', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS })
  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...offered(registry)].map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: Registry.jsonSchema(t) as { type: 'object'; properties?: Record<string, object> },
    })),
  }))
  s.setRequestHandler(CallToolRequestSchema, async (req) => callTool(registry, req.params.name, req.params.arguments ?? {}))
  return s
}

export async function serve(registry: Registry): Promise<void> {
  await server(registry).connect(new StdioServerTransport())
}
