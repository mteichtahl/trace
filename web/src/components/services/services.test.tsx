/** Admin › Connected systems: the list, the create form's rules, the keys shown once, delete's typed name, the off state. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, call } from '@/lib/api'
import { nameProblem, snippets } from '@/lib/services'
import { OFF_ERROR, SERVICES } from '@/mock/services'
import { Route as SystemsRoute } from '@/routes/_app/admin/systems/index'
import { CreateSheet, chosenProjects } from './create-sheet'
import { DeleteDialog } from './delete-dialog'
import { KeysPanel } from './keys-panel'

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), call: vi.fn() }))
const mockCall = vi.mocked(call)

const PROJECTS = [{ repo: 'acme/soil-sensor', role: 'write', part: 'contributor' }, { repo: 'acme/motor-driver', role: 'write', part: 'contributor' }]

function client() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(['me.get', {}], { prefs: {}, views: {} })
  return qc
}
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={client()}>{ui}</QueryClientProvider>)

async function renderList() {
  const root = createRootRoute()
  const list = createRoute({ getParentRoute: () => root, path: '/admin/systems', component: SystemsRoute.options.component, validateSearch: SystemsRoute.options.validateSearch })
  const detail = createRoute({ getParentRoute: () => root, path: '/admin/systems/$name', component: () => <p>detail</p> })
  const router = createRouter({ routeTree: root.addChildren([list, detail]), history: createMemoryHistory({ initialEntries: ['/admin/systems'] }) })
  await act(async () => { render(<QueryClientProvider client={client()}><RouterProvider router={router as never} /></QueryClientProvider>) })
  return router
}

window.scrollTo = (() => {}) as typeof window.scrollTo

let clip: string[] = []
beforeEach(() => {
  mockCall.mockReset()
  clip = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => { clip.push(t) } } })
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
})

describe('Connected systems list', () => {
  it('renders each system with what it can do, its projects, last used and status', async () => {
    mockCall.mockImplementation(async (action: string) => {
      if (action === 'services.list') return { services: SERVICES } as never
      if (action === 'projects') return PROJECTS as never
      return {} as never
    })
    await renderList()
    expect(await screen.findByText('build-dashboard')).toBeInTheDocument()
    expect(screen.getByText(/Other systems and AI agents connect with their own keys/)).toBeInTheDocument()
    expect(screen.getByText('2 systems connected, 1 disabled.')).toBeInTheDocument()
    const row = screen.getByText('release-bot').closest('tr')!
    expect(within(row).getByText('Read and change')).toBeInTheDocument()
    expect(within(row).getByText('Disabled')).toBeInTheDocument()
    const first = screen.getByText('build-dashboard').closest('tr')!
    expect(within(first).getByText('Read only')).toBeInTheDocument()
    expect(within(first).getByText('Active')).toBeInTheDocument()
    expect(within(first).getByText('2')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Connect a system/ }).length).toBeGreaterThan(0)
    expect(screen.getByText(/charges a small amount per system and per sign-in/)).toBeInTheDocument()
  })

  it('shows "External access is off" as a friendly state, not an error', async () => {
    mockCall.mockImplementation(async (action: string) => {
      if (action === 'services.list') throw new ApiError(OFF_ERROR, 200)
      return PROJECTS as never
    })
    await renderList()
    expect(await screen.findByTestId('external-off')).toBeInTheDocument()
    expect(screen.getByText('External access is off for this installation')).toBeInTheDocument()
    expect(screen.getByText(/tracectl install/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(/Could not load/)).not.toBeInTheDocument()
  })

  it('says how to start when there are none', async () => {
    mockCall.mockImplementation(async (action: string) => (action === 'services.list' ? { services: [] } : PROJECTS) as never)
    await renderList()
    expect(await screen.findByText(/No systems are connected yet/)).toBeInTheDocument()
  })
})

describe('Connect a system', () => {
  it('recommends read only, and a read-only system can only be a reviewer', async () => {
    mockCall.mockResolvedValue({ client_id: 'c1', secret: 's', service: SERVICES[0] } as never)
    const onCreated = vi.fn()
    wrap(<CreateSheet open onOpenChange={() => {}} projects={PROJECTS.map((p) => p.repo)} taken={['build-dashboard']} onCreated={onCreated} />)
    expect(screen.getByLabelText(/Read only/)).toBeChecked()
    expect(screen.getByText('Recommended')).toBeInTheDocument()
    expect(screen.getByText('Safest: it can look but not change anything.')).toBeInTheDocument()

    await userEvent.click(screen.getByLabelText(/Soil sensor/))
    expect(screen.getByTestId('part-acme/soil-sensor')).toHaveTextContent('Reviewer')
    expect(screen.queryByRole('combobox', { name: /Part on Soil sensor/ })).not.toBeInTheDocument()

    // read and change offers both parts; going back to read only forces reviewer again
    await userEvent.click(screen.getByLabelText(/Read and change/))
    expect(screen.getByRole('combobox', { name: /Part on Soil sensor/ })).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText(/Read only/))
    expect(screen.getByTestId('part-acme/soil-sensor')).toHaveTextContent('Reviewer')

    await userEvent.type(screen.getByLabelText('Name'), 'build-dashboard')
    expect(screen.getByText(/already a connected system called build-dashboard/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect the system' })).toBeDisabled()
    await userEvent.clear(screen.getByLabelText('Name'))
    await userEvent.type(screen.getByLabelText('Name'), 'wall-screen')
    await userEvent.click(screen.getByRole('button', { name: 'Connect wall-screen' }))
    await waitFor(() => expect(mockCall).toHaveBeenCalledWith('services.create', { name: 'wall-screen', scopes: ['read'], projects: [{ repo: 'acme/soil-sensor', part: 'reviewer' }] }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ name: 'wall-screen', client_id: 'c1', secret: 's', scopes: ['read'] })))
  })

  it('never sends contributor for a read-only system, whatever the form held', () => {
    expect(chosenProjects({ 'a/b': { on: true, part: 'contributor' }, 'a/c': { on: false, part: 'reviewer' } }, 'read')).toEqual([{ repo: 'a/b', part: 'reviewer' }])
    expect(chosenProjects({ 'a/b': { on: true, part: 'contributor' } }, 'write')).toEqual([{ repo: 'a/b', part: 'contributor' }])
  })

  it('checks names in words', () => {
    expect(nameProblem('Build')).toMatch(/lower-case letter/)
    expect(nameProblem('a')).toMatch(/2 and 40/)
    expect(nameProblem('ok-name')).toBeNull()
  })
})

describe('Keys panel', () => {
  const keys = { name: 'wall-screen', client_id: 'client-123', secret: 'very-secret', scopes: ['read' as const], token_url: 'https://t.example/oauth2/token', api_url: 'https://api.example/inv', mcp_url: 'https://mcp.example/inv' }

  it('shows the secret once with copy buttons, the addresses and the snippets, until "I\'ve stored it"', async () => {
    const onDone = vi.fn()
    wrap(<KeysPanel keys={keys} onDone={onDone} />)
    expect(screen.getByText('This secret is shown once. Store it now.')).toBeInTheDocument()
    expect(screen.getByText('very-secret')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Copy the secret' }))
    await userEvent.click(screen.getByRole('button', { name: 'Copy the client id' }))
    await userEvent.click(screen.getByRole('button', { name: 'Copy the sign-in address' }))
    await userEvent.click(screen.getByRole('button', { name: 'Copy the API address' }))
    await userEvent.click(screen.getByRole('button', { name: 'Copy the MCP address' }))
    expect(clip).toEqual(['very-secret', 'client-123', 'https://t.example/oauth2/token', 'https://api.example/inv', 'https://mcp.example/inv'])
    expect(screen.getByRole('tab', { name: 'Get a sign-in token' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Call the API' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Connect an AI agent (MCP)' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Copy the sign-in snippet' }))
    expect(clip.at(-1)).toContain('scope=trace-external/read"')
    expect(clip.at(-1)).not.toContain('very-secret')
    await userEvent.click(screen.getByRole('button', { name: "I've stored it" }))
    expect(onDone).toHaveBeenCalled()
  })

  it('makes the three snippets from the addresses and scopes', () => {
    const s = snippets({ ...keys, scopes: ['read', 'write'] })
    expect(s.token).toContain('-u "client-123:$TRACE_CLIENT_SECRET"')
    expect(s.token).toContain('scope=trace-external/read trace-external/write')
    expect(s.api).toContain(`-d '{"action":"projects"}'`)
    expect(s.api).toContain('Authorization: Bearer $TOKEN')
    expect(JSON.parse(s.mcp)).toEqual({ type: 'http', url: 'https://mcp.example/inv', headers: { Authorization: 'Bearer <token>' } })
  })
})

describe('Delete', () => {
  it('needs the name typed exactly before it deletes', async () => {
    mockCall.mockResolvedValue({ deleted: true } as never)
    const onDeleted = vi.fn()
    wrap(<DeleteDialog name="release-bot" open onOpenChange={() => {}} onDeleted={onDeleted} />)
    const del = screen.getByRole('button', { name: 'Delete release-bot' })
    expect(del).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/to confirm/), 'release-bo')
    expect(del).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/to confirm/), 't')
    expect(del).toBeEnabled()
    await userEvent.click(del)
    await waitFor(() => expect(mockCall).toHaveBeenCalledWith('services.delete', { name: 'release-bot' }))
    expect(onDeleted).toHaveBeenCalled()
  })
})
