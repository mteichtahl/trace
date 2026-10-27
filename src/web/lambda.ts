/**
 * The web backend's Lambda entry: a function URL in RESPONSE_STREAM mode behind CloudFront (origin access control,
 * AWS_IAM auth, so only CloudFront reaches it). The URL event becomes a WebRequest, and the response stream the Sink
 * (src/web/event.ts): the status, headers and cookies go first through `awslambda.HttpResponseStream.from`, then the
 * body as it is written (JSON once, SSE as it happens).
 *
 * `awslambda` is a global the Node.js runtime provides. Its type (`awslambda.streamifyResponse`,
 * `awslambda.HttpResponseStream`) is declared globally by @types/aws-lambda (handler.d.ts), which the type import
 * below brings in; declaring it again here would clash with that declaration.
 */
import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { app } from './app.js'
import { awsDeps } from './aws.js'
import { streamSink, toRequest } from './event.js'

let serve: ReturnType<typeof app> | null = null

export const handler = awslambda.streamifyResponse<APIGatewayProxyEventV2>(async (event, responseStream) => {
  serve ??= app(awsDeps())
  await serve(toRequest(event), streamSink(responseStream, (w, m) => awslambda.HttpResponseStream.from(w, { ...m })))
})
