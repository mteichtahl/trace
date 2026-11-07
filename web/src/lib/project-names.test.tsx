import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

// test-esp32 #82: the project was named "test-esp32"; the sidebar showed "Test esp32 e2e", from its repository
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>()
  return {
    ...real,
    call: vi.fn(async (action: string, args: { repo?: string }) => {
      if (action === 'journey.get' && args.repo === 'mteichtahl/test-esp32-e2e') return { name: 'test-esp32' }
      if (action === 'journey.get') throw new real.ApiError('no journey', 404, 'not_found')
      return {}
    }),
  }
})

const { useProjectNames } = await import('./queries')

describe('useProjectNames', () => {
  it('names a project as the person did, and falls back to the repository for one without a journey', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    const repos = ['mteichtahl/test-esp32-e2e', 'acme/motor-driver']
    const { result } = renderHook(() => useProjectNames(repos), { wrapper })
    expect(result.current('mteichtahl/test-esp32-e2e')).toBe('Test esp32 e2e')
    await waitFor(() => expect(result.current('mteichtahl/test-esp32-e2e')).toBe('test-esp32'))
    expect(result.current('acme/motor-driver')).toBe('Motor driver')
  })

  it('reads nothing while it is not enabled', async () => {
    const { call } = await import('@/lib/api')
    vi.mocked(call).mockClear()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    const { result } = renderHook(() => useProjectNames(['mteichtahl/test-esp32-e2e'], { enabled: false }), { wrapper })
    expect(result.current('mteichtahl/test-esp32-e2e')).toBe('Test esp32 e2e')
    expect(call).not.toHaveBeenCalled()
  })
})
