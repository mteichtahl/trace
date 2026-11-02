/**
 * The preflight's per-repository probe (src/installer/github.ts repoAccess): a fine-grained token without "Checks:
 * read" is named, since a change can only be accepted in the web app once trace can read that its checks passed.
 */
import { describe, expect, it } from 'vitest'
import { accessNote, repoAccess } from '../../src/installer/github.js'

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function github(o: { checks: number }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (/\/repos\/marc\/board$/.test(url)) return json(200, { default_branch: 'main', permissions: { admin: true, push: true } })
    if (url.includes('/check-runs')) return o.checks === 200 ? json(200, { total_count: 0, check_runs: [] }) : json(o.checks, { message: o.checks === 403 ? 'Resource not accessible by personal access token' : 'Git Repository is empty.' })
    return json(200, {})
  }) as typeof fetch
}

describe('repoAccess: Checks', () => {
  it('names "Checks: read" when GitHub refuses the check runs, and says what it costs', async () => {
    const a = await repoAccess('github_pat_x', 'marc/board', 'fine-grained', github({ checks: 403 }))
    expect(a.checks).toBe(false)
    expect(a.missing).toEqual(['Checks: read'])
    expect(accessNote(a)).toMatch(/can't read its checks, so its changes can't be accepted in the web app/)
  })

  it('reads them, or finds nothing to read in an empty repository, without counting a permission missing', async () => {
    for (const status of [200, 409]) {
      const a = await repoAccess('github_pat_x', 'marc/board', 'fine-grained', github({ checks: status }))
      expect(a.checks).toBe(true)
      expect(a.missing).toEqual([])
      expect(accessNote(a)).toBeNull()
    }
  })
})
