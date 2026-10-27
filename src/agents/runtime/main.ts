/**
 * The container's single entry (node /app/dist/agents/runtime/main.js). One image, every AgentCore runtime:
 *   TRACE_AGENT_MODE=worker (default)  a project's worker runtime (IAM-authenticated; that repository's workflows and
 *                                      the API invoke it; TRACE_PROJECT names the one project it serves)
 *   TRACE_AGENT_MODE=api               the API runtime for people (Cognito JWT), src/api/server.ts
 */
import { z } from 'zod'
import { telemetryNote } from './observe.js'

const Mode = z.enum(['worker', 'api']).default('worker')
const ApiModule = z.object({ start: z.function() })

async function main(): Promise<void> {
  process.stdout.write(`${telemetryNote()}\n`)
  const mode = Mode.parse(process.env.TRACE_AGENT_MODE || undefined)
  if (mode === 'api') {
    // Built separately (src/api); resolved at run time so the worker image builds without it.
    const spec = '../api/server.js'
    const mod = ApiModule.parse(await import(spec))
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
