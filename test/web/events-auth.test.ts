import { describe, expect, it } from 'vitest'
import { AuthError } from '../../src/api/jwt.js'
import { authorize } from '../../src/web/events-auth.js'
import { verifier } from '../api/fixtures.js'
import { idToken } from './fakes.js'

const NOW = Date.now()
const ok = async (t: string) => { if (t !== 'good') throw new AuthError('bad'); return { sub: 'abc', exp: Math.floor(NOW / 1000) + 3600 } }

describe('the live events\' authorizer', () => {
  it('connect: a valid id token; subscribe: that token\'s own channel only; never publish', async () => {
    expect(await authorize({ authorizationToken: 'good', requestContext: { operation: 'EVENT_CONNECT' } }, ok, () => NOW)).toEqual({ isAuthorized: true, handlerContext: { sub: 'abc' }, ttlOverride: 60 })
    expect(await authorize({ authorizationToken: 'good', requestContext: { operation: 'EVENT_SUBSCRIBE', channel: '/trace/users/abc' } }, ok, () => NOW)).toMatchObject({ isAuthorized: true })
    for (const channel of ['/trace/users/xyz', '/trace/users/abc/more', '/trace/users/*', '/trace/users/a*', '/other/users/abc']) {
      expect(await authorize({ authorizationToken: 'good', requestContext: { operation: 'EVENT_SUBSCRIBE', channel } }, ok, () => NOW), channel).toEqual({ isAuthorized: false, ttlOverride: 0 })
    }
    expect((await authorize({ authorizationToken: 'good', requestContext: { operation: 'EVENT_PUBLISH', channel: '/trace/users/abc' } }, ok, () => NOW)).isAuthorized).toBe(false)
    expect((await authorize({ authorizationToken: 'bad', requestContext: { operation: 'EVENT_CONNECT' } }, ok, () => NOW)).isAuthorized).toBe(false)
    expect((await authorize({ requestContext: { operation: 'EVENT_CONNECT' } }, ok, () => NOW)).isAuthorized).toBe(false)
  })

  it('checks real id tokens of the web client (and refuses an access token)', async () => {
    const v = verifier()
    const id = idToken('sub-ada', 'ada@example.com', ['trace-users'])
    expect(await authorize({ authorizationToken: id, requestContext: { operation: 'EVENT_SUBSCRIBE', channel: '/trace/users/sub-ada' } }, (t) => v.verifyId(t))).toMatchObject({ isAuthorized: true, handlerContext: { sub: 'sub-ada' } })
    const { accessToken } = await import('../api/fixtures.js')
    expect((await authorize({ authorizationToken: accessToken('sub-ada', []), requestContext: { operation: 'EVENT_CONNECT' } }, (t) => v.verifyId(t))).isAuthorized).toBe(false)
  })
})
