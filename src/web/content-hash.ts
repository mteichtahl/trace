/**
 * The payload hash every POST, PUT and DELETE with a body must carry: CloudFront reaches the Lambda function URL
 * through origin access control (SigV4), and Lambda accepts no unsigned payloads, so the viewer sends
 * `x-amz-content-sha256: <hex sha256 of the exact body bytes>` and CloudFront signs with it. Without it the function
 * URL refuses the request (403) before this code runs.
 *
 * This file has no imports so the app can copy it as is (web/src/lib/api.ts). In the browser:
 *
 *   const body = JSON.stringify(payload)
 *   fetch('/api/call', { method: 'POST', body, headers: {
 *     'content-type': 'application/json',
 *     'x-amz-content-sha256': await contentSha256(body),
 *     authorization: `Bearer ${accessToken}`,
 *   } })
 *
 * A request with no body (GET, the cookie-only auth calls) may send the hash of the empty string, or nothing.
 */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export async function contentSha256(body: string | Uint8Array): Promise<string> {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
