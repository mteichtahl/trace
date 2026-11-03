/**
 * GitHub's own pages are for admins only, in the More menu (docs/stay-in-trace.md, decision C): a Needs you item whose
 * way forward is a GitHub page keeps its words for everyone and its link for admins; a link elsewhere still works. On
 * the prompts screen a pending project change links to its change in the app, and CLAUDE.md is changed in an editor
 * that saves through files.edit.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { call } from '@/lib/api'
import { auth } from '@/lib/auth'
import type { InboxItem } from '@/lib/types'
import { NeedsYouCard, isGitHubHref } from './needs-you-card'
import { changeHref } from './prompts/prompts-screen'

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), call: vi.fn() }))
vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => <a href={to} {...rest}>{children}</a>,
}))
const mockCall = vi.mocked(call)
const as = (cls: 'admin' | 'user') => auth.set((s) => ({ ...s, user: { sub: cls, email: `${cls}@x`, groups: [], class: cls } as never }))
afterEach(() => { auth.set((s) => ({ ...s, user: null })); mockCall.mockReset() })

const item = (href: string, label = 'Review on GitHub'): InboxItem => ({
  id: 'x', kind: 'gate', repo: 'acme/board', project: 'Board', summary: 'Something waits', createdAt: new Date().toISOString(), action: { label, href },
})

describe('a Needs you item with a link to GitHub', () => {
  it('which links are GitHub\'s', () => {
    expect(isGitHubHref('https://github.com/acme/x/pull/1')).toBe(true)
    expect(isGitHubHref('https://raw.githubusercontent.com/acme/x/main/a')).toBe(true)
    expect(isGitHubHref('https://example.com/github.com')).toBe(false)
    expect(isGitHubHref(undefined)).toBe(false)
  })

  it('someone who is not an admin sees the words, never the link', () => {
    as('user')
    render(<NeedsYouCard item={item('https://github.com/acme/board/pull/3')} />)
    expect(screen.getByText('Review')).toBeInTheDocument()
    expect(document.querySelector('a[href*="github.com"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
  })

  it('an admin has it in the More menu', async () => {
    as('admin')
    render(<NeedsYouCard item={item('https://github.com/acme/board/pull/3')} />)
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(await screen.findByRole('menuitem', { name: /Review on GitHub/ })).toHaveAttribute('href', 'https://github.com/acme/board/pull/3')
  })

  it('a link that is not GitHub\'s stays a button', () => {
    as('user')
    render(<NeedsYouCard item={item('https://jlcpcb.com/order/1', 'Open the order')} />)
    expect(screen.getByRole('link', { name: 'Open the order' })).toHaveAttribute('href', 'https://jlcpcb.com/order/1')
  })
})

describe('the prompts screen', () => {
  it('a pending change opens in the app', () => {
    expect(changeHref('acme/board', 12)).toBe('/p/acme~board/changes/12')
  })

  it('CLAUDE.md: Change it opens the editor, which saves through files.edit and links to the change', async () => {
    const { PromptsScreen } = await import('./prompts/prompts-screen')
    as('user')
    const notes = { id: 'system.notes', mode: 'locked', prompt: 'system', description: 'The project\'s notes.', layer: 'default', version: null }
    mockCall.mockImplementation((async (action: string) => {
      if (action === 'projects') return [{ repo: 'acme/board', role: 'write', part: 'contributor' }]
      if (action === 'prompts.list') return { prompts: [notes], problems: [] }
      if (action === 'prompts.get') return { ...notes, vars: {}, default: 'x', installation: null, project: null, effective: { layer: 'default', version: null, sha: 's', text: 'x' }, followed_by_locked: [], composed: 'x' }
      if (action === 'files.url') return { url: 'data:text/plain;base64,IyBOb3Rlcwo=' }
      if (action === 'files.edit') return { repo: 'acme/board', path: 'CLAUDE.md', change: 33, branch: 'trace/edit-claude-md-1', commit: 'c' }
      if (action === 'prompts.preview') return { repo: 'acme/board', prompt: 'system', text: '', marked: '', parts: [] }
      return {}
    }) as never)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('# Notes\n'))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><PromptsScreen repo="acme/board" /></QueryClientProvider>)
    // the notes entry is locked, so it is picked in the catalog (on a narrow screen, behind "Choose an instruction")
    await userEvent.click(await screen.findByRole('button', { name: /Choose an instruction/ }))
    const group = screen.queryAllByRole('button', { expanded: false }).find((b) => /system/i.test(b.textContent ?? ''))
    if (group) await userEvent.click(group)
    await userEvent.click((await screen.findAllByTitle('system.notes'))[0]!)
    await userEvent.click(await screen.findByRole('button', { name: 'Change it' }))
    const area = await screen.findByLabelText('Text of CLAUDE.md')
    await waitFor(() => expect(area).toHaveValue('# Notes\n'))
    await userEvent.type(area, 'Ceramic only.')
    await userEvent.click(screen.getByRole('button', { name: /Save as a change/ }))
    await waitFor(() => expect(mockCall).toHaveBeenCalledWith('files.edit', { repo: 'acme/board', path: 'CLAUDE.md', text: '# Notes\nCeramic only.', note: '' }))
    expect(await screen.findByRole('link', { name: 'Open the change' })).toHaveAttribute('href', '/p/acme~board/changes/33')
    expect(document.querySelector('a[href*="github.com"]')).toBeNull()
    fetchSpy.mockRestore()
  })
})
