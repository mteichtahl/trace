/**
 * The hooks function `<prefix>-web-hooks` (src/infra/web.ts): GitHub's webhook deliveries, POST /api/hooks/github, and
 * nothing else (hooksApp). The backend's code and role, behind a function URL of its own without IAM, because origin
 * access control would sign GitHub's POSTs and Lambda refuses a signed POST that does not carry its payload's hash
 * (x-amz-content-sha256), which GitHub never sends. src/web/hooks.ts checks CloudFront's origin header first
 * (TRACE_HOOKS_ORIGIN: the value the stack gives CloudFront to add), then every delivery's signature.
 *
 * Its schedule (EventBridge, src/infra/web.ts) invokes it directly, never through its URL, with DRIFT_EVENT: the
 * nightly drift check of every project's documents (hooksSchedule). Nothing from the URL can look like that event: a
 * request through the URL is always an HTTP event.
 */
import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { hooksApp } from './app.js'
import { hooksSchedule, isDriftEvent } from './hooks.js'
import { awsDeps } from './aws.js'
import { streamSink, toRequest } from './event.js'

let serve: ReturnType<typeof hooksApp> | null = null
let drift: ReturnType<typeof hooksSchedule> | null = null

export const handler = awslambda.streamifyResponse<APIGatewayProxyEventV2>(async (event, responseStream) => {
  if (isDriftEvent(event)) {
    drift ??= hooksSchedule(awsDeps())
    const r = await drift()
    responseStream.write(JSON.stringify(r))
    responseStream.end()
    return
  }
  serve ??= hooksApp(awsDeps(), { origin: process.env.TRACE_HOOKS_ORIGIN ?? '' })
  await serve(toRequest(event), streamSink(responseStream, (w, m) => awslambda.HttpResponseStream.from(w, { ...m })))
})
