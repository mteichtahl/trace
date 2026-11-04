/**
 * The project logo in Settings (docs/scribe.md "Project logo"): a chosen file is checked by trace before anything is
 * saved and shown only once it passes; a refused file says why and cannot be saved; Save sends the chosen variants as
 * one change (project.logo_set). Only admins see the controls.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { call } from '@/lib/api'
import { ProjectLogo } from './project-logo'

vi.mock('@tanstack/react-router', async (orig) => ({ ...(await orig<typeof import('@tanstack/react-router')>()), useNavigate: () => vi.fn() }))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), call: vi.fn() }))
const mockCall = vi.mocked(call)
const REPO = 'acme/soil-sensor'
const ICON = { glyph: 'board', colour: 'blue' } as const
const SVG = '<svg viewBox="0 0 200 80"><rect width="10" height="10"/></svg>'

const wrap = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)

beforeEach(() => {
  mockCall.mockReset()
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:logo')
  mockCall.mockImplementation((async (action: string, args: Record<string, unknown>) => {
    if (action === 'project.logo') return { repo: REPO, light: null, dark: null }
    if (action === 'project.logo_check') {
      const ok = atob(String(args.base64)).startsWith('<svg')
      return { repo: REPO, ok, format: ok ? 'svg' : null, width: ok ? 200 : null, height: ok ? 80 : null, problems: ok ? [] : ['It is not an SVG or PNG image.'] }
    }
    if (action === 'project.logo_set') return { repo: REPO, change: 12, branch: 'trace/logo-x', commit: 'c', written: ['docs/design/logo.svg'], removed: [] }
    throw new Error(`unexpected ${action}`)
  }) as never)
})

describe('the project logo', () => {
  it('without a logo, says the project icon is used', async () => {
    wrap(<ProjectLogo repo={REPO} name="Soil sensor" icon={ICON} admin />)
    expect(await screen.findByText('No logo yet: the project icon is used')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Save logo/ })).toBeNull()
  })

  it('checks a chosen file, shows it once it passes, and saves it as one change', async () => {
    wrap(<ProjectLogo repo={REPO} name="Soil sensor" icon={ICON} admin />)
    await screen.findByText('No logo yet: the project icon is used')
    await userEvent.upload(screen.getByLabelText('Choose the logo on light backgrounds'), new File([SVG], 'logo.svg', { type: 'image/svg+xml' }))
    expect(await screen.findByText('logo.svg: SVG. Ready to save.')).toBeTruthy()
    expect(screen.getByAltText('Project logo on light backgrounds')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Save logo/ }))
    await waitFor(() => expect(mockCall).toHaveBeenCalledWith('project.logo_set', { repo: REPO, light: { base64: btoa(SVG) } }))
  })

  it('a refused file says why, is not shown and cannot be saved', async () => {
    wrap(<ProjectLogo repo={REPO} name="Soil sensor" icon={ICON} admin />)
    await screen.findByText('No logo yet: the project icon is used')
    await userEvent.upload(screen.getByLabelText('Choose the logo on light backgrounds'), new File(['GIF89a'], 'logo.gif', { type: 'image/svg+xml' }), { applyAccept: false })
    expect((await screen.findByRole('alert')).textContent).toMatch(/not an SVG or PNG/)
    expect(screen.queryByAltText('Project logo on light backgrounds')).toBeNull()
    expect((screen.getByRole('button', { name: /Save logo/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('people who are not admins see the logo but not the controls', async () => {
    wrap(<ProjectLogo repo={REPO} name="Soil sensor" icon={ICON} admin={false} />)
    await screen.findByText('No logo yet: the project icon is used')
    expect(screen.queryByLabelText('Choose the logo on light backgrounds')).toBeNull()
  })
})
