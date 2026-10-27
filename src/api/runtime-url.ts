/**
 * The API runtime's data-plane address (InvokeAgentRuntime over plain HTTPS with a bearer token): one place for the
 * CLI (src/login/invoke.ts) and the web backend (src/web/call.ts), with no imports, so the web bundle stays small.
 */
export function invocationUrl(region: string, arn: string, endpoint?: string): string {
  const host = (endpoint ?? `https://bedrock-agentcore.${region}.amazonaws.com`).replace(/\/+$/, '')
  return `${host}/runtimes/${encodeURIComponent(arn)}/invocations?qualifier=DEFAULT`
}
