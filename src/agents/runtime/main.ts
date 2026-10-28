/**
 * The container's single entry (node /app/dist/agents/runtime/main.js). One image, every AgentCore runtime:
 *   TRACE_AGENT_MODE=worker (default)  a project's worker runtime (IAM-authenticated; that repository's workflows and
 *                                      the API invoke it; TRACE_PROJECT names the one project it serves)
 *   TRACE_AGENT_MODE=api               the API runtime for people (Cognito JWT), src/api/server.ts
 *   TRACE_AGENT_MODE=external          the same API for connected systems (client-credentials tokens, an allow-list
 *                                      of actions, a per-system rate limit): src/api/server.ts startExternal
 *   TRACE_AGENT_MODE=mcp               the MCP endpoint for connected systems (streamable HTTP on :8000/mcp): it
 *                                      forwards every tool call to the external runtime, src/mcp-remote/server.ts
 * (docs/external-access.md)
 */
import { z } from 'zod'
import { telemetryNote } from './observe.js'

const Mode = z.enum(['worker', 'api', 'external', 'mcp']).default('worker')
const ApiModule = z.object({ start: z.function(), startExternal: z.function() })
const McpModule = z.object({ start: z.function() })

async function main(): Promise<void> {
  process.stdout.write(`${telemetryNote()}\n`)
  const mode = Mode.parse(process.env.TRACE_AGENT_MODE || undefined)
  if (mode === 'api' || mode === 'external') {
    // Built separately (src/api); resolved at run time so the worker image builds without it.
    const spec = '../../api/server.js'
    const mod = ApiModule.parse(await import(spec))
    await ((mode === 'api' ? mod.start : mod.startExternal) as () => Promise<void>)()
    return
  }
  if (mode === 'mcp') {
    const spec = '../../mcp-remote/server.js'
    const mod = McpModule.parse(await import(spec))
    await (mod.start as () => Promise<void>)()
    return
  }
  // the installation's optional integrations (distributor keys), when this worker may read them
  // (TRACE_INTEGRATIONS_PREFIX: set with the library gateway off; src/core/integrations.ts). Never fatal.
  try {
    const { loadIntegrationsFromEnv } = await import('../../core/integrations.js')
    const r = await loadIntegrationsFromEnv()
    if (r) process.stdout.write(`integrations: ${r.loaded.length ? r.loaded.join(', ') : 'none configured'}${r.skipped.length ? ` (skipped: ${r.skipped.join('; ')})` : ''}\n`)
  } catch (e) {
    process.stderr.write(`integrations not loaded: ${e instanceof Error ? e.message : String(e)}\n`)
  }
  const { start } = await import('./server.js')
  await start()
}

main().catch((e: unknown) => {
  process.stderr.write(`tracectl agent failed to start: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
  process.exit(1)
})
