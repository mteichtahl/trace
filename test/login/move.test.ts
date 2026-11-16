/** `tracectl remote move …` (src/login/move.ts): what it asks the API, and what it prints while a move goes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls: { action: string; args: unknown }[] = []
let statuses: unknown[] = []
vi.mock('../../src/login/invoke.js', () => ({
  ApiError: class ApiError extends Error {},
  invokeApi: async (action: string, args: unknown) => {
    calls.push({ action, args })
    if (action === 'project.move') return { summary: "Moving to trace's GitLab. The project is paused meanwhile." }
    if (action === 'project.move_cancel') return { summary: 'The move was cancelled: the project stays on GitHub. It is resumed.' }
    return statuses.length > 1 ? statuses.shift() : statuses[0]
  },
}))

const { cmdRemote } = await import('../../src/login/commands.js')
const { remoteMove } = await import('../../src/login/move.js')

const base = { from: 'github', to: 'gitlab', requested_by: 'marc', when: 'now', changes: {}, issues: {}, todo: [] }
let printed: string[] = []
beforeEach(() => {
  calls.length = 0; printed = []; statuses = []
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { printed.push(String(s)); return true }) as never)
  vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { printed.push(String(s)); return true }) as never)
})
afterEach(() => { vi.restoreAllMocks() })

describe('tracectl remote move', () => {
  it('asks for the move, once idle unless --now', async () => {
    expect(await cmdRemote(['move', 'Acme/Board', '--to', 'gitlab'])).toBe(0)
    expect(calls[0]).toEqual({ action: 'project.move', args: { repo: 'Acme/Board', to: 'gitlab', when: 'idle' } })
    expect(printed.join('')).toContain('tracectl remote move status Acme/Board --watch')
    await cmdRemote(['move', 'Acme/Board', '--to', 'gitlab', '--now'])
    expect(calls[1]?.args).toMatchObject({ when: 'now' })
    expect(await cmdRemote(['move', 'Acme/Board'])).toBe(2)
  })

  it('--watch prints each step once and ends with the renumbered changes', async () => {
    statuses = [
      { forge: 'github', gitlab: true, move: { ...base, status: 'moving', step: 'copy' } },
      { forge: 'github', gitlab: true, move: { ...base, status: 'moving', step: 'copy' } },
      { forge: 'github', gitlab: true, move: { ...base, status: 'moving', step: 'changes' } },
      { forge: 'gitlab', gitlab: true, move: { ...base, status: 'moved', step: null, changes: { 12: 3 }, todo: ['run the installer'] } },
    ]
    expect(await remoteMove(['status', 'acme/board', '--watch'], { every: 1 })).toBe(0)
    expect(printed.join('')).toBe([
      "Moving to trace's GitLab: Copying every branch and tag.",
      "Moving to trace's GitLab: Recreating open changes.",
      "Moved to trace's GitLab. Open changes renumbered: #12 → #3. The old home on GitHub is archived.",
      '- run the installer', '',
    ].join('\n'))
  })

  it('a stopped move exits 1 with its reason; cancel sets it aside', async () => {
    statuses = [{ forge: 'github', gitlab: true, move: { ...base, status: 'failed', step: 'changes', error: 'GitLab: 500' } }]
    expect(await remoteMove(['status', 'acme/board', '--watch'], { every: 1 })).toBe(1)
    expect(printed.join('')).toContain('stopped at "Recreating open changes": GitLab: 500. It is still on GitHub.')
    expect(await cmdRemote(['move', 'cancel', 'acme/board'])).toBe(0)
    expect(calls.at(-1)).toEqual({ action: 'project.move_cancel', args: { repo: 'acme/board' } })
  })
})
