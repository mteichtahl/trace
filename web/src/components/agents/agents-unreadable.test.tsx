import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ApiError } from '@/lib/api'

vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>()
  return { ...real, call: vi.fn(async (action: string) => { if (action === 'projects') throw new real.ApiError('trace has had too many requests from your network', 429, 'rate_limited'); return {} }) }
})

const { useWork } = await import('./use-agents')

describe('Agents when the projects cannot be read', () => {
  it('says so, rather than "nothing is running", and can try again', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    const { result } = renderHook(() => useWork(), { wrapper })
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.projectsError).toBeInstanceOf(ApiError)
    expect((result.current.projectsError as ApiError).status).toBe(429)
    expect(typeof result.current.retry).toBe('function')
  })
})
