/**
 * Getting and handing in design files (docs/stay-in-trace.md "4."): which files are KiCad's, where a dropped file goes,
 * what can be handed in and why not, and the sheet itself: each dropped file compared with the design ("Changed",
 * "Same as the design", "New", "Not taken"), only the changed ones sent, and the change opened after. Hand in is shown
 * to Contributors and admins only.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call } from '@/lib/api'
import { auth } from '@/lib/auth'
import { DesignFiles, HandInSheet, isKiCad, pathFor, readiness, refusal, toBase64, zipName, type Dropped } from './handin'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', async (orig) => ({ ...(await orig<typeof import('@tanstack/react-router')>()), useNavigate: () => navigate }))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), call: vi.fn() }))
vi.mock('@/components/files/data', async (orig) => ({
  ...(await orig<typeof import('@/components/files/data')>()),
  fetchBytes: vi.fn(async (f: { path: string }) => new TextEncoder().encode(f.path === 'hardware/power.kicad_sch' ? 'POWER v1' : 'BOARD').buffer),
}))
const mockCall = vi.mocked(call)
const enc = (s: string) => new TextEncoder().encode(s)
const drop = (o: Partial<Dropped>): Dropped => ({ id: Math.random().toString(36), name: 'a.kicad_sch', path: 'hw/a.kicad_sch', bytes: enc('x'), verdict: 'changed', ...o })

describe('the rules, pure', () => {
  it('KiCad files only', () => {
    expect(isKiCad('hw/power.kicad_sch')).toBe(true)
    expect(isKiCad('fp-lib-table')).toBe(true)
    expect(isKiCad('notes.md')).toBe(false)
    expect(refusal('notes.md', 10)).toMatch(/Not a KiCad file/)
    expect(refusal('big.kicad_pcb', 4 * 1024 * 1024)).toMatch(/at most 3 MB/)
    expect(refusal('ok.kicad_pcb', 10)).toBeNull()
  })

  it('where a dropped file goes: its folder path, else the one design file of its name, else beside the design', () => {
    const design = ['hardware/power.kicad_sch', 'hardware/board.kicad_pcb', 'jig/power.kicad_sch']
    expect(pathFor('power.kicad_sch', 'soil-sensor/jig/power.kicad_sch', design)).toBe('jig/power.kicad_sch')
    expect(pathFor('board.kicad_pcb', undefined, design)).toBe('hardware/board.kicad_pcb')
    expect(pathFor('usb.kicad_sch', undefined, design)).toBe('hardware/usb.kicad_sch')
    expect(pathFor('usb.kicad_sch', undefined, [])).toBe('usb.kicad_sch')
  })

  it('what can be handed in, and why not', () => {
    expect(readiness([]).blocked).toMatch(/Drop the KiCad files/)
    expect(readiness([drop({ verdict: 'same' })]).blocked).toBe('Nothing differs from the design.')
    expect(readiness([drop({ verdict: 'checking' })]).blocked).toMatch(/Comparing/)
    expect(readiness([drop({}), drop({})]).blocked).toMatch(/there twice/)
    expect(readiness([drop({ bytes: new Uint8Array(2 * 1024 * 1024) }), drop({ path: 'b', bytes: new Uint8Array(2 * 1024 * 1024) })]).blocked).toMatch(/at most 3\.5 MB/)
    const ok = readiness([drop({}), drop({ path: 'x', verdict: 'same' }), drop({ path: 'n', verdict: 'new' })])
    expect(ok).toMatchObject({ blocked: null })
    expect(ok.send.map((f) => f.path)).toEqual(['hw/a.kicad_sch', 'n'])
  })

  it('base64 of large files, and the zip\'s name', () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 256)
    expect(toBase64(big)).toBe(Buffer.from(big).toString('base64'))
    expect(zipName('acme/soil-sensor')).toBe('soil-sensor-design.zip')
  })
})

describe('the sheet', () => {
  let qc: QueryClient
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    mockCall.mockReset()
    navigate.mockReset()
  })
  afterEach(() => { auth.set((s) => ({ ...s, user: null })) })

  it('compares each file with the design, hands in only the changed ones and opens the change', async () => {
    mockCall.mockResolvedValue({ repo: 'acme/soil-sensor', change: 41, changed: ['hardware/power.kicad_sch'], same: [], branch: 'trace/handin-x', commit: 'c' } as never)
    render(<HandInSheet repo="acme/soil-sensor" design={['hardware/power.kicad_sch', 'hardware/board.kicad_pcb']} open onOpenChange={() => undefined} />, { wrapper })
    const input = screen.getByTestId('handin-input') as HTMLInputElement
    fireEvent.change(input, { target: { files: [
      new File(['POWER v2'], 'power.kicad_sch'),
      new File(['BOARD'], 'board.kicad_pcb'),
      new File(['# notes'], 'notes.md'),
    ] } })
    expect(await screen.findByText('Changed')).toBeInTheDocument()
    expect(await screen.findByText('Same as the design')).toBeInTheDocument()
    expect(screen.getByText('Not taken')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Hand in 1 file' }))
    await waitFor(() => expect(mockCall).toHaveBeenCalledWith('design.handin', { repo: 'acme/soil-sensor', files: [{ path: 'hardware/power.kicad_sch', base64: btoa('POWER v2') }] }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/p/acme~soil-sensor/changes/41' }))
  })

  it('nothing differs: Hand in stays off and says why', async () => {
    render(<HandInSheet repo="acme/soil-sensor" design={['hardware/board.kicad_pcb']} open onOpenChange={() => undefined} />, { wrapper })
    fireEvent.change(screen.getByTestId('handin-input'), { target: { files: [new File(['BOARD'], 'board.kicad_pcb')] } })
    expect(await screen.findByText('Nothing differs from the design.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hand in' })).toBeDisabled()
  })

  it('Get the design files for everyone; Hand in your edits for Contributors and admins only', async () => {
    mockCall.mockImplementation((async (action: string) => {
      if (action === 'files.list') return [{ path: 'hardware/board.kicad_pcb', kind: 'design', size: 5 }, { path: 'README.md', kind: 'documents', size: 3 }]
      if (action === 'projects') return [{ repo: 'acme/soil-sensor', role: 'read', part: 'reviewer' }, { repo: 'acme/other', role: 'write', part: 'contributor' }]
      return {}
    }) as never)
    auth.set((s) => ({ ...s, user: { sub: 'u', email: 'u@x', groups: [], class: 'user' } as never }))
    const { unmount } = render(<DesignFiles repo="acme/soil-sensor" />, { wrapper })
    await waitFor(() => expect(screen.getByRole('button', { name: /Get the design files/ })).toBeEnabled())
    expect(screen.queryByRole('button', { name: /Hand in your edits/ })).toBeNull()
    unmount()
    render(<DesignFiles repo="acme/other" />, { wrapper })
    expect(await screen.findByRole('button', { name: /Hand in your edits/ })).toBeInTheDocument()
  })
})
