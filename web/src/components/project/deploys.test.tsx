/**
 * The Deploys panel (docs/stay-in-trace.md "2. Deploys"): the "Needs you" card for a person who may decide ("Deploy
 * Soil sensor to bench?", the changes since what runs now, trace's recommendation with its reason, Deploy and Skip this
 * one, which asks why first), the read-only form for anyone else, a deploy's progress, the results with Roll back on an
 * earlier deployed entry (confirmed first), no GitHub link for a person who is not an admin, and the mock actions.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { auth } from '@/lib/auth'
import { handle } from '@/mock/handlers'
import type { DeploysView } from '@/lib/types'
import { DeploysCard, rollbackTargets, skipReason } from './deploys'

const S = (c: string) => c.repeat(40)
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const view = (o: Partial<DeploysView> = {}): DeploysView => ({
  enabled: true, environment: 'bench', url: null, auto: false, may_approve: true,
  running: { sha: S('a'), at: ago(3_600_000) },
  request: { sha: S('b'), opened_at: ago(600_000), held: false, held_reasons: [], build_passed: true, commits: [{ sha: S('b'), subject: 'usb: protect the input' }, { sha: S('c'), subject: 'power: a larger regulator' }] },
  in_progress: null,
  recent: [{ sha: S('a'), result: 'deployed', at: ago(3_600_000), by: 'Priya S.' }, { sha: S('9'), result: 'deployed', at: ago(86_400_000), by: 'Marc T.' }, { sha: S('8'), result: 'failed', at: ago(90_000_000), by: 'Marc T.' }],
  recommendation: { verdict: 'deploy', why: 'Its build passed and it is the newest commit that passed. It brings 2 changes since what runs now.' },
  ...o,
})
const LINK = [{ label: 'The deploy workflow on GitHub', href: 'https://github.com/acme/soil-sensor/actions/workflows/trace-deploy.yml' }]
const signIn = (cls: 'admin' | 'user') => auth.set((s) => ({ ...s, status: 'signed-in', user: { sub: 'u', email: 'u@example.com', groups: [], class: cls } as never }))

afterEach(() => { auth.set((s) => ({ ...s, user: null })) })

describe('the deploy request, for a person who may decide', () => {
  it('asks the question, lists the changes, and gives trace\'s recommendation with its reason', () => {
    render(<DeploysCard view={view()} project="Soil sensor" />)
    expect(screen.getByRole('heading', { name: 'Deploy Soil sensor to bench?' })).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Changes since what runs now' })
    expect(within(list).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['bbbbbbbusb: protect the input', 'cccccccpower: a larger regulator'])
    expect(screen.getByText(/trace recommends: Deploy it\./)).toBeInTheDocument()
    expect(screen.getByText(/It brings 2 changes since what runs now\./)).toBeInTheDocument()
  })

  it('Deploy sends the commit that was shown', async () => {
    const onDeploy = vi.fn()
    render(<DeploysCard view={view()} project="Soil sensor" onDeploy={onDeploy} />)
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }))
    expect(onDeploy).toHaveBeenCalledWith(S('b'))
  })

  it('Skip this one asks why, in one line, before it sends', async () => {
    const onSkip = vi.fn(async () => undefined)
    render(<DeploysCard view={view()} project="Soil sensor" onSkip={onSkip} />)
    await userEvent.click(screen.getByRole('button', { name: 'Skip this one' }))
    const send = screen.getByRole('button', { name: 'Skip this one' })
    expect(send).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Why skip it?'), 'The bench is busy until Friday')
    await userEvent.click(send)
    expect(onSkip).toHaveBeenCalledWith('The bench is busy until Friday')
  })

  it('a build that has not passed cannot be deployed; the recommendation says wait', () => {
    render(<DeploysCard view={view({ request: { ...view().request!, build_passed: false }, recommendation: { verdict: 'wait', why: 'Its build has not passed yet. Wait for it to pass.' } })} project="Soil sensor" />)
    expect(screen.getByRole('button', { name: 'Deploy' })).toBeDisabled()
    expect(screen.getByText(/trace recommends: Wait\./)).toBeInTheDocument()
  })
})

describe('anyone else, and what happened', () => {
  it('a person who may not decide reads it, with who decides, and no buttons', () => {
    render(<DeploysCard view={view({ may_approve: false })} project="Soil sensor" />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText(/A trace admin, or someone named in the project's deploy setting, decides this\./)).toBeInTheDocument()
  })

  it('a deploy running shows its step, live, and nothing can be decided meanwhile', () => {
    render(<DeploysCard view={view({ in_progress: { sha: S('b'), started_at: ago(30_000), by: 'Ada L.', step: 'Deploying' } })} project="Soil sensor" />)
    expect(screen.getByRole('status')).toHaveTextContent(/Deploying.*bbbbbbb to bench, approved by Ada L\./)
    expect(screen.queryByRole('button', { name: 'Deploy' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Roll back' })).toBeNull()
  })

  it('Roll back is on earlier deployed entries only, and confirms first', async () => {
    expect([...rollbackTargets(view())]).toEqual([S('9')])
    const onRollback = vi.fn()
    render(<DeploysCard view={view()} project="Soil sensor" onRollback={onRollback} />)
    const rows = within(screen.getByRole('list', { name: 'Recent deploys' })).getAllByRole('listitem')
    expect(within(rows[0]!).queryByRole('button')).toBeNull()        // runs now
    expect(within(rows[2]!).queryByRole('button')).toBeNull()        // failed
    await userEvent.click(within(rows[1]!).getByRole('button', { name: 'Roll back' }))
    expect(screen.getByText('Put 9999999 back in bench?')).toBeInTheDocument()
    await userEvent.click(within(rows[1]!).getByRole('button', { name: 'Roll back' }))
    expect(onRollback).toHaveBeenCalledWith(S('9'))
  })

  it('the GitHub link is in the More menu for admins only', () => {
    signIn('user')
    const { rerender } = render(<DeploysCard view={view()} project="Soil sensor" adminLinks={LINK} />)
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
    expect(screen.queryByRole('link', { name: /GitHub/ })).toBeNull()
    signIn('admin')
    rerender(<DeploysCard view={view()} project="Soil sensor" adminLinks={LINK} />)
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument()
  })

  it('deploys off: says so, and how to turn them on', () => {
    render(<DeploysCard view={view({ enabled: false, request: null, recommendation: { verdict: 'none', why: 'Deploys are off for this project.' } })} project="Soil sensor" />)
    expect(screen.getByText('Deploys are off for this project.')).toBeInTheDocument()
  })

  it('a skip reason is one line of 3 to 300 characters', () => {
    expect(skipReason(' no ')).toBeNull()
    expect(skipReason('Busy\n bench')).toBe('Busy bench')
    expect(skipReason('x'.repeat(301))).toBeNull()
  })
})

describe('the mock deploy actions (dev:mock)', () => {
  const call = async <T,>(action: string, args: Record<string, unknown>) => (await (await handle('/api/call', { method: 'POST', body: JSON.stringify({ action, ...args }) })).json()) as { ok: boolean; result: T; error?: string }

  it('reads a request, refuses a moved commit, deploys with progress, and skips', async () => {
    const v = (await call<DeploysView>('deploys.get', { repo: 'acme/soil-sensor' })).result
    expect(v).toMatchObject({ enabled: true, environment: 'bench', may_approve: true, recommendation: { verdict: 'deploy' } })
    expect((await call('deploy.approve', { repo: 'acme/soil-sensor', sha: S('0') })).error).toMatch(/moved to a newer commit/)
    expect((await call('deploy.approve', { repo: 'acme/soil-sensor', sha: v.request!.sha })).ok).toBe(true)
    expect((await call<DeploysView>('deploys.get', { repo: 'acme/soil-sensor' })).result.in_progress).toMatchObject({ sha: v.request!.sha, step: expect.any(String) })
    expect((await call('deploy.skip', { repo: 'acme/soil-sensor', reason: 'later' })).error).toMatch(/running now/)
    // another project has deploys off
    expect((await call<DeploysView>('deploys.get', { repo: 'acme/motor-driver' })).result).toMatchObject({ enabled: false, may_approve: false })
  })
})
