// The person's token behind CloudFront: origin access control replaces Authorization with its own signature, so the
// /api/* viewer-request function forwards the viewer's token in FORWARDED_AUTH_HEADER, and the backend reads it there.
import { describe, expect, it } from 'vitest'
import { FORWARDED_AUTH_HEADER as INFRA_HEADER } from '../../src/infra/web.js'
import { FORWARDED_AUTH_HEADER, personToken } from '../../src/web/deps.js'

describe('the forwarded bearer token', () => {
  it('uses the same header name as the CloudFront function', () => {
    expect(FORWARDED_AUTH_HEADER).toBe(INFRA_HEADER)
  })

  it('prefers the forwarded token over CloudFront\'s own signature', () => {
    expect(personToken({
      authorization: 'AWS4-HMAC-SHA256 Credential=AKIA/20261027/ap-southeast-2/lambda/aws4_request, Signature=abc',
      [FORWARDED_AUTH_HEADER]: 'Bearer person.token.here',
    })).toBe('person.token.here')
  })

  it('takes a bearer Authorization when nothing was forwarded (local runs), and never a signature', () => {
    expect(personToken({ authorization: 'Bearer local.token' })).toBe('local.token')
    expect(personToken({ authorization: 'AWS4-HMAC-SHA256 Credential=x, Signature=y' })).toBeNull()
    expect(personToken({})).toBeNull()
  })
})
