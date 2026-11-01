/**
 * The web backend's routes, in one place: what src/web/lambda.ts serves and what the tests call. Every route under
 * /api; CloudFront sends nothing else here.
 *
 *   GET  /api/config      what the app needs to start (src/web/config.ts publicConfig): no secrets
 *   /api/auth/*           sign-in (src/web/auth.ts)
 *   POST /api/call        the API runtime as the person (src/web/call.ts)
 *   POST /api/agui        the "trace" chat agent over AG-UI (src/web/agui.ts)
 *   /api/voice/*          speech and dictation (src/web/voice.ts)
 *   GET  /api/ops         Operations (src/web/ops.ts)
 *   POST /api/hooks/github GitHub's webhook: a change moved (src/web/hooks.ts). CloudFront sends /api/hooks/* to the
 *                         hooks function (src/web/hooks-lambda.ts, hooksApp: this route alone); it is here too so one
 *                         list names every route
 */
import { type AguiOptions, aguiRoutes } from './agui.js'
import { authRoutes } from './auth.js'
import { callRoutes } from './call.js'
import { publicConfig } from './config.js'
import type { WebDeps } from './deps.js'
import type { Publisher } from './events.js'
import { type Sink, type WebRequest, WebError, route, router } from './http.js'
import { type HooksOptions, hooksRoutes } from './hooks.js'
import { opsRoutes } from './ops.js'
import { voiceRoutes } from './voice.js'

export interface AppOptions { publisher?: () => Publisher; agui?: AguiOptions; hooks?: HooksOptions }

export function app(deps: WebDeps, o: AppOptions = {}): (req: WebRequest, sink: Sink) => Promise<void> {
  const voice = voiceRoutes(deps).map((r) => ({
    ...r,
    handler: async (...a: Parameters<typeof r.handler>) => {
      if (!(await deps.config()).features.voice) throw new WebError(404, 'voice is turned off', 'disabled')
      return r.handler(...a)
    },
  }))
  return router([
    route('GET', '/api/config', async () => ({ body: publicConfig(await deps.config()) })),
    ...authRoutes(deps),
    ...callRoutes(deps, o.publisher),
    ...aguiRoutes(deps, { ...o.agui, ...(o.publisher ? { publisher: o.publisher } : {}) }),
    ...voice,
    ...opsRoutes(deps),
    ...hooksRoutes(deps, { ...o.hooks, ...(o.publisher ? { publisher: o.publisher } : {}) }),
  ], { log: deps.log, now: deps.now })
}

/** The hooks function's routes: GitHub's webhook and nothing else (src/web/hooks-lambda.ts). */
export function hooksApp(deps: WebDeps, o: HooksOptions = {}): (req: WebRequest, sink: Sink) => Promise<void> {
  return router(hooksRoutes(deps, o), { log: deps.log, now: deps.now })
}
