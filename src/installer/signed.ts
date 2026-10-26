/**
 * A SigV4-signed JSON call to an AWS API that has no SDK client in this package (Service Quotas, ECR, S3 Vectors),
 * so the installer checks them without adding dependencies. Two shapes:
 *
 *   json-1.1   POST / with `X-Amz-Target: <prefix>.<Operation>` (Service Quotas, ECR)
 *   rest-json  POST /<Operation> (S3 Vectors)
 *
 * Signed with @smithy/signature-v4 and @aws-crypto/sha256-js, as src/core/gateway.ts signs its MCP calls.
 */
import type { AwsCredentialIdentity } from '@smithy/types'

export class AwsCallError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); this.name = 'AwsCallError' }
}

export interface SignedCall {
  service: string
  host: string
  /** json-1.1: the target prefix (ServiceQuotasV20190624); rest-json: omitted */
  targetPrefix?: string
  operation: string
  body: Record<string, unknown>
}

export type Caller = (c: SignedCall) => Promise<Record<string, unknown>>

/** The signed caller for these credentials and region. `fetchImpl` for tests. */
export function signedCaller(creds: AwsCredentialIdentity, region: string, fetchImpl: typeof fetch = fetch): Caller {
  return async (c) => {
    const [{ SignatureV4 }, { Sha256 }, { HttpRequest }] = await Promise.all([
      import('@smithy/signature-v4'), import('@aws-crypto/sha256-js'), import('@smithy/protocol-http'),
    ])
    const signer = new SignatureV4({ service: c.service, region, credentials: creds, sha256: Sha256 })
    const json11 = Boolean(c.targetPrefix)
    const body = JSON.stringify(c.body)
    const path = json11 ? '/' : `/${c.operation}`
    const headers: Record<string, string> = {
      host: c.host,
      'content-type': json11 ? 'application/x-amz-json-1.1' : 'application/json',
      ...(json11 ? { 'x-amz-target': `${c.targetPrefix}.${c.operation}` } : {}),
    }
    const signed = await signer.sign(new HttpRequest({ method: 'POST', protocol: 'https:', hostname: c.host, path, headers, body }))
    const r = await fetchImpl(`https://${c.host}${path}`, { method: 'POST', headers: signed.headers as Record<string, string>, body })
    const text = await r.text()
    let data: Record<string, unknown> = {}
    try { data = text ? (JSON.parse(text) as Record<string, unknown>) : {} } catch { /* not JSON */ }
    if (!r.ok) {
      const code = String(data.__type ?? data.code ?? r.headers.get('x-amzn-errortype') ?? r.status).split('#').at(-1)?.split(':')[0] ?? String(r.status)
      throw new AwsCallError(`${c.service} ${c.operation}: ${String(data.message ?? data.Message ?? text.slice(0, 200))}`, r.status, code)
    }
    return data
  }
}

/** An EC2 query-protocol call (form-encoded POST, XML answer): the answer's raw text. */
export async function ec2Query(creds: AwsCredentialIdentity, region: string, action: string, params: Record<string, string> = {}, fetchImpl: typeof fetch = fetch): Promise<string> {
  const [{ SignatureV4 }, { Sha256 }, { HttpRequest }] = await Promise.all([
    import('@smithy/signature-v4'), import('@aws-crypto/sha256-js'), import('@smithy/protocol-http'),
  ])
  const host = `ec2.${region}.amazonaws.com`
  const body = new URLSearchParams({ Action: action, Version: '2016-11-15', ...params }).toString()
  const signer = new SignatureV4({ service: 'ec2', region, credentials: creds, sha256: Sha256 })
  const signed = await signer.sign(new HttpRequest({ method: 'POST', protocol: 'https:', hostname: host, path: '/', headers: { host, 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body }))
  const r = await fetchImpl(`https://${host}/`, { method: 'POST', headers: signed.headers as Record<string, string>, body })
  const text = await r.text()
  if (!r.ok) throw new AwsCallError(`ec2 ${action}: ${/<Message>([^<]*)<\/Message>/.exec(text)?.[1] ?? text.slice(0, 200)}`, r.status, /<Code>([^<]*)<\/Code>/.exec(text)?.[1] ?? String(r.status))
  return text
}

/** Service Quotas (json-1.1). */
export const serviceQuotas = (region: string, operation: string, body: Record<string, unknown>): SignedCall => ({
  service: 'servicequotas', host: `servicequotas.${region}.amazonaws.com`, targetPrefix: 'ServiceQuotasV20190624', operation, body,
})

/** Amazon ECR (json-1.1). */
export const ecr = (region: string, operation: string, body: Record<string, unknown>): SignedCall => ({
  service: 'ecr', host: `api.ecr.${region}.amazonaws.com`, targetPrefix: 'AmazonEC2ContainerRegistry_V20150921', operation, body,
})

/** Amazon S3 Vectors (rest-json). */
export const s3vectors = (region: string, operation: string, body: Record<string, unknown>): SignedCall => ({
  service: 's3vectors', host: `s3vectors.${region}.api.aws`, operation, body,
})
