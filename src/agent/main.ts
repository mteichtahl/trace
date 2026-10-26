/**
 * The container's single entry (node /app/dist/agent/main.js). One image, two AgentCore runtimes:
 *   TRACE_AGENT_MODE=worker (default)  the worker runtime (IAM-authenticated; the repositories' workflows invoke it)
 *   TRACE_AGENT_MODE=api               the API runtime for people (Cognito JWT), src/api/server.ts
 */
import { z } from 'zod'

const Mode = z.enum(['worker', 'api']).default('worker')
const ApiModule = z.object({ start: z.function() })

async function main(): Promise<void> {
  const mode = Mode.parse(process.env.TRACE_AGENT_MODE || undefined)
  if (mode === 'api') {
    // Built separately (src/api); resolved at run time so the worker image builds without it.
    const spec = '../api/server.js'
    const mod = ApiModule.parse(await import(spec))
    await (mod.start as () => Promise<void>)()
    return
  }
  const { start } = await import('./server.js')
  await start()
}

main().catch((e: unknown) => {
  process.stderr.write(`trace agent failed to start: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
  process.exit(1)
})
