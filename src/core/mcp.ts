/**
 * The trace MCP server: every tool in the registry, over stdio, for Claude Code (`trace mcp`;
 * `claude mcp add trace -- trace mcp`).
 *
 * MCP tool names may only use letters, digits, `_` and `-`, so `kicad.erc` is offered as `kicad_erc`. A ToolError
 * comes back as a tool result with isError set (the model reads it and adjusts); anything else is reported with its
 * stack, since it is a bug in the tool. Tools that drive hardware are listed only when TRACE_HARDWARE=1, so a session
 * on a machine with nothing attached is never offered them.
 *
 * With TRACE_GATEWAY_URL set (a worker on an installation with the library gateway), the shared library's calls that
 * need nothing on this machine are forwarded to AgentCore Gateway, signed with this runtime's credentials
 * (src/core/gateway.ts). A read the gateway can't take runs here instead; a write reports the error, so every write
 * to the shared library goes through the gateway while it is on.
 *
 * Under a job on the trace runtime (TRACE_WAITS_URL and TRACE_WAITS_TOKEN set, src/agents/runtime/job.ts), the waits
 * this process's tools open (gpu.*, kb.sync, …) are relayed to the runtime as they change, attributed to that job, and
 * a check now asked for there wakes the timer here (src/core/wait-report.ts). The relay stops when stdin ends.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { load } from './config.js'
import { type GatewayCaller, type GatewayOutcome, gatewayFromEnv, goesRemote, isLibraryTool, withProjectParts, writesLibrary } from './gateway.js'
import { type AnyTool, Registry, ToolError } from './registry.js'
import { continueFromEnv, flush, observeTool } from './telemetry.js'
import { startWaitReporter } from './wait-report.js'

export const VERSION = '0.1.0'
export const mcpName = (name: string): string => name.replaceAll('.', '_')
export const hardwareAllowed = (): boolean => ['1', 'true', 'yes'].includes(process.env.TRACE_HARDWARE ?? '')

const INSTRUCTIONS = 'Electronics tools: KiCad reading and ERC/DRC, BOM and parts, a datasheet library and parts database ' +
  'shared by every project, calculators, SPICE and Verilog simulation, the firmware loop and hardware-in-the-loop. ' +
  'Every run is recorded in the project database (trace_runs, trace_run). Cite datasheet figures with part number, sha256 and page. ' +
  'When the agents\' memory is configured, memory_recall and memory_remember reach this project\'s and agent\'s memory only.'

function text(obj: unknown): string {
  return typeof obj === 'string' ? obj : JSON.stringify(obj, (_k, v: unknown) => (typeof v === 'bigint' ? Number(v) : v), 1)
}

/** TRACE_MCP_TOOLS: the only tools (registry names, comma-separated) this server offers, when set. A specialist's
 * job sets it to the specialist's allowlist, so its session is never offered another area's tools. */
export function allowlist(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  const v = env.TRACE_MCP_TOOLS?.trim()
  return v ? new Set(v.split(',').map((s) => s.trim()).filter(Boolean)) : null
}

/** The tools this session offers, by MCP name. */
export function offered(registry: Registry, hardware = hardwareAllowed(), only: Set<string> | null = allowlist()): Map<string, AnyTool> {
  return new Map(registry.list().filter((t) => (hardware || !t.hardware) && Registry.available(t) && (!only || only.has(t.name))).map((t) => [mcpName(t.name), t]))
}

/** The project's parts settings (providers, currency), for a parts call forwarded to the gateway. */
function projectParts(): { providers: string[]; currency: string } | null {
  try {
    const p = load(undefined, { strict: false }).parts
    return { providers: [...p.providers], currency: p.currency }
  } catch {
    return null
  }
}

/** A library call through the gateway: its answer, or null when it should run here instead (a read the gateway
 * can't take). */
async function viaGateway(gateway: GatewayCaller, t: AnyTool, args: unknown): Promise<CallToolResult | null> {
  if (!isLibraryTool(t.name)) return null
  const name = t.name
  const sent = withProjectParts(name, { ...(args as Record<string, unknown>) }, projectParts())
  // a call the gateway never took is recorded as an error on its span; the run here, if any, gets its own span
  class Unreachable extends Error { override name = 'GatewayUnreachable' }
  let out: GatewayOutcome
  try {
    out = await observeTool(name, sent, { via: 'gateway', hardware: false }, false, async () => {
      const o = await gateway.call(name, sent)
      if (o.kind === 'unreachable') throw new Unreachable(o.reason)
      return o
    })
  } catch (e) {
    if (!(e instanceof Unreachable)) throw e
    out = { kind: 'unreachable', reason: e.message }
  }
  if (out.kind === 'result') return out.result
  if (writesLibrary(name)) {
    return { content: [{ type: 'text', text: `${name} writes the shared library, which goes only through the library gateway, and the gateway can't be reached: ${out.reason}` }], isError: true }
  }
  process.stderr.write(`trace mcp: the library gateway can't be reached (${out.reason.slice(0, 300)}); running ${name} here\n`)
  return null
}

/** One tools/call, as the server answers it (exported for tests). */
export async function callTool(registry: Registry, name: string, args: unknown, hardware = hardwareAllowed(), gateway: GatewayCaller | null = gatewayFromEnv()): Promise<CallToolResult> {
  const t = offered(registry, hardware).get(name)
  if (!t) return { content: [{ type: 'text', text: `unknown tool ${JSON.stringify(name)}` }], isError: true }
  if (gateway && typeof args === 'object' && args !== null && goesRemote(t.name, args)) {
    const r = await viaGateway(gateway, t, args)
    if (r) return r
  }
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
  // Under Claude on AgentCore the job passes its trace context (TRACEPARENT): the tool spans join the job's trace,
  // and what is buffered is pushed when Claude closes the pipe (src/core/telemetry.ts; no-op without an SDK).
  continueFromEnv()
  // this job's waits, relayed to the runtime that runs it (nothing without TRACE_WAITS_URL / TRACE_WAITS_TOKEN)
  const relay = startWaitReporter()
  // the job is over (or cancelled): stop what its tools left running on AWS Batch, then push the telemetry
  process.stdin.once('end', () => {
    relay?.stop()
    void import('../gpu/inflight.js').then((m) => m.terminateInFlight('the job that started it ended', (l) => process.stderr.write(`${l}\n`))).finally(() => { void flush() })
  })
  await server(registry).connect(new StdioServerTransport())
}
