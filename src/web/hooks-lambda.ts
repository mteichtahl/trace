/**
 * The hooks function `<prefix>-web-hooks` (src/infra/web.ts): GitHub's webhook deliveries, POST /api/hooks/github, and
 * nothing else (hooksApp). The backend's code and role, behind a function URL of its own without IAM, because origin
 * access control would sign GitHub's POSTs and Lambda refuses a signed POST that does not carry its payload's hash
 * (x-amz-content-sha256), which GitHub never sends. src/web/hooks.ts checks CloudFront's origin header first
 * (TRACE_HOOKS_ORIGIN: the value the stack gives CloudFront to add), then every delivery's signature.
 */
import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { hooksApp } from './app.js'
import { awsDeps } from './aws.js'
import { streamSink, toRequest } from './event.js'

let serve: ReturnType<typeof hooksApp> | null = null

export const handler = awslambda.streamifyResponse<APIGatewayProxyEventV2>(async (event, responseStream) => {
  serve ??= hooksApp(awsDeps(), { origin: process.env.TRACE_HOOKS_ORIGIN ?? '' })
  await serve(toRequest(event), streamSink(responseStream, (w, m) => awslambda.HttpResponseStream.from(w, { ...m })))
})
