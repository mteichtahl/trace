import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { panel } from '@/components/chat/chat-state'
import { contextStore } from '@/components/chat/context'
import type { FileRef } from './data'
import { FileViewer } from './file-viewer'

const calls: { action: string; args: Record<string, unknown> }[] = []
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  call: vi.fn(async (action: string, args: Record<string, unknown>) => {
    calls.push({ action, args })
    if (action === 'files.url') return { url: `blob:mock/${String(args.path)}@${String(args.commit ?? 'current')}` }
    if (action === 'artifact') return { id: args.id, name: args.name, mime: 'text/plain', size: 5, base64: btoa('hello') }
    return {}
  }),
}))

const TEXT: Record<string, string> = {
  'src/main.c@current': 'int main(void)\n{\n    return 0;\n}\n',
  'src/main.c@abc1234': 'int main(void)\n{\n    return 1;\n}\n',
}

beforeEach(() => {
  calls.length = 0
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  globalThis.fetch = vi.fn(async (u: RequestInfo | URL) => {
    const key = String(u).replace('blob:mock/', '')
    return new Response(TEXT[key] ?? 'plain text\n')
  }) as typeof fetch
  ;(URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:mock/artifact'
  contextStore.set({ entries: [], removed: new Set() })
  panel.set((s) => ({ ...s, open: false }))
})

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  )
}

const code: FileRef = {
  repo: 'acme/soil-sensor',
  path: 'src/main.c',
  commit: 'def5678aa',
  revision: 'Rev A',
  versions: [{ commit: 'def5678aa' }, { commit: 'abc1234' }],
}

describe('File viewer', () => {
  it('shows one toolbar: name, kind, revision and commit, Download, Copy link, Versions, Ask about this file', async () => {
    wrap(<FileViewer file={code} size="page" popOut />)
    expect(screen.getByRole('heading', { name: 'main.c' })).toBeInTheDocument()
    expect(screen.getByText('Code')).toBeInTheDocument()
    expect(screen.getByText('Rev A')).toBeInTheDocument()
    expect(screen.getByText(/commit def5678/)).toBeInTheDocument()
    for (const name of [/Download/, /Copy link/, /Versions/, /Ask about this file/, /Pop out/]) expect(screen.getByRole('button', { name })).toBeInTheDocument()
    // the code itself arrives through files.url, a signed link, never stored
    await screen.findByText('return 0;', { exact: false })
    expect(calls.find((c) => c.action === 'files.url')?.args).toMatchObject({ repo: 'acme/soil-sensor', path: 'src/main.c' })
  })

  it('Ask about this file puts the file in trace’s context and opens Ask trace', async () => {
    wrap(<FileViewer file={code} size="page" />)
    await userEvent.click(screen.getByRole('button', { name: /Ask about this file/ }))
    expect(panel.get().open).toBe(true)
    const e = contextStore.get().entries.find((x) => x.id === 'file')
    expect(e?.label).toBe('main.c')
    expect(e?.value).toMatchObject({ repo: 'acme/soil-sensor', path: 'src/main.c', kind: 'Code' })
  })

  it('Versions offers Compare with previous, and the comparison is line by line', async () => {
    wrap(<FileViewer file={code} size="page" />)
    await userEvent.click(screen.getByRole('button', { name: /Versions/ }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Compare with previous' }))
    expect(await screen.findByText(/Comparing/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('return 1;', { exact: false })).toBeInTheDocument())
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(calls.some((c) => c.action === 'files.url' && c.args.commit === 'abc1234')).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Stop comparing' }))
    expect(screen.queryByText(/Comparing/)).not.toBeInTheDocument()
  })

  it('a file with one version says so and offers no Compare', async () => {
    wrap(<FileViewer file={{ ...code, versions: undefined }} size="page" />)
    await userEvent.click(screen.getByRole('button', { name: /Versions/ }))
    expect(await screen.findByText('Only this version is recorded for this file.')).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Compare with previous' })).not.toBeInTheDocument()
  })

  it('the card is compact, with Open and Expand; Expand shows the full toolbar in place', async () => {
    const open = vi.fn()
    wrap(<FileViewer file={code} size="card" onOpenPage={open} />)
    expect(screen.queryByRole('button', { name: /Copy link/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(open).toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /Expand/ }))
    expect(screen.getByRole('button', { name: /Copy link/ })).toBeInTheDocument()
  })

  it('a run’s output is read through the artifact action', async () => {
    wrap(<FileViewer file={{ repo: 'acme/soil-sensor', path: 'runs/run_1/build.log', run: { id: 'run_1', name: 'build.log' } }} size="page" />)
    await waitFor(() => expect(calls.some((c) => c.action === 'artifact')).toBe(true))
    expect(calls.find((c) => c.action === 'artifact')?.args).toMatchObject({ id: 'run_1', name: 'build.log' })
    expect(calls.some((c) => c.action === 'files.url')).toBe(false)
  })

  it('an unknown kind shows its name, size and Download', async () => {
    wrap(<FileViewer file={{ repo: 'acme/soil-sensor', path: 'notes/x.unknownext', size: 2048 }} size="page" />)
    expect(await screen.findByText(/no viewer for this kind of file/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Download/ }).length).toBeGreaterThan(0)
  })
})
