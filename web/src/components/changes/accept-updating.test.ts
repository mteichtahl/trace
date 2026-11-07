/**
 * Accepting a change while trace's API is being redeployed (test-esp32 #223: "Could not accept the change · 424 Nothing
 * changed"). The accept is never sent again blindly: trace reads the change first, and sends it again only while it is
 * still open at the head the person was shown. Merged in the meantime is accepted; the words never carry a bare status.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ApiError, call } from '@/lib/api'
import { UPDATING } from '@/lib/http'
import { ACCEPT_UPDATING, acceptWhileUpdating, refusalWords } from './use-change-actions'

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), call: vi.fn() }))
const mockCall = vi.mocked(call)

const REPO = 'acme/board'
const HEAD = 'a'.repeat(40)
const updating = () => new ApiError(UPDATING, 424, 'updating')
const accepted = { merged: true as const, sha: 'm'.repeat(40), stage: 'capture', next: 'trace drafts the layout.' }
const change = (o: Record<string, unknown> = {}) => ({ number: 44, state: 'open', head: { ref: 'claude/x', sha: HEAD }, may_accept: true, blockers: [], ...o })
const now = { again: [1, 1, 1], sleep: async () => {} }

/** Answers each action from its own queue, in order. */
function answers(by: Record<string, unknown[]>) {
  mockCall.mockImplementation((async (action: string) => {
    const next = by[action]?.shift()
    if (next instanceof Error) throw next
    if (next === undefined) throw new Error(`no answer for ${action}`)
    return next
  }) as never)
}
const sent = () => mockCall.mock.calls.map((c) => c[0])

beforeEach(() => { mockCall.mockReset() })

describe('accepting a change while trace is updating', () => {
  it('reads the change, finds it still open at the same head, and accepts it again', async () => {
    answers({ 'change.accept': [updating(), accepted], 'change.get': [change()] })
    await expect(acceptWhileUpdating({ repo: REPO, number: 44, head: HEAD }, now)).resolves.toEqual(accepted)
    expect(sent()).toEqual(['change.accept', 'change.get', 'change.accept'])
    expect(mockCall.mock.calls[2]![1]).toEqual({ repo: REPO, number: 44, head_sha: HEAD })
  })

  it('a change merged by the first try is accepted, and never sent twice', async () => {
    answers({ 'change.accept': [updating()], 'change.get': [updating(), change({ state: 'merged' })] })
    await expect(acceptWhileUpdating({ repo: REPO, number: 44, head: HEAD }, now)).resolves.toMatchObject({ merged: true, sha: HEAD })
    expect(sent()).toEqual(['change.accept', 'change.get', 'change.get'])
  })

  it('a head that moved meanwhile is not accepted', async () => {
    answers({ 'change.accept': [updating()], 'change.get': [change({ head: { ref: 'claude/x', sha: 'b'.repeat(40) } })] })
    await expect(acceptWhileUpdating({ repo: REPO, number: 44, head: HEAD }, now)).rejects.toThrow('It changed since you looked at it')
    expect(sent()).toEqual(['change.accept', 'change.get'])
  })

  it('still updating after about a minute: says so in words, with whether the change is known to be open', async () => {
    answers({ 'change.accept': [updating(), updating(), updating()], 'change.get': [change(), change()] })
    const e = await acceptWhileUpdating({ repo: REPO, number: 44, head: HEAD }, { again: [1, 1], sleep: async () => {} }).catch((x: unknown) => x)
    expect(e).toMatchObject({ message: ACCEPT_UPDATING.open, code: 'updating' })
    expect(refusalWords(e)).toBe(ACCEPT_UPDATING.open)
    expect(refusalWords(e)).not.toMatch(/\d{3}/)

    answers({ 'change.accept': [updating()], 'change.get': [updating(), updating()] })
    const u = await acceptWhileUpdating({ repo: REPO, number: 44, head: HEAD }, { again: [1, 1], sleep: async () => {} }).catch((x: unknown) => x)
    expect(u).toMatchObject({ message: ACCEPT_UPDATING.unknown })
    // not known to be unchanged, so it does not say "Nothing changed"
    expect(refusalWords(u)).not.toMatch(/Nothing changed/)
  })

  it('any other refusal is said at once, as before', async () => {
    answers({ 'change.accept': [new ApiError('It cannot be accepted now. A check failed.', 200)] })
    const e = await acceptWhileUpdating({ repo: REPO, number: 44, head: HEAD }, now).catch((x: unknown) => x)
    expect(refusalWords(e)).toBe('It cannot be accepted now. A check failed. Nothing changed.')
    expect(sent()).toEqual(['change.accept'])
  })
})
