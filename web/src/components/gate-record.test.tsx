/**
 * The signed gate's record (test-esp32 #195): a criterion beside a long evidence chip ("kicad_drc: 0 errors, 0
 * unconnected, 0 parity, 2 warnings") wrapped one word a line, because the chip took the row's width. The criterion
 * keeps a readable width, and the chip wraps under it and shrinks to the row.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { JOURNEYS } from '@/mock/fixtures'
import { SOIL_GATES } from '@/mock/fixtures-s1'
import type { GateMore } from '@/lib/types-s1'
import { GateRecord } from '@/routes/_focus/p/$id/gates/$gate'

describe('the gate record\'s criteria (#195)', () => {
  it('a long chip wraps under its criterion, which keeps a readable width', async () => {
    const j = JOURNEYS['acme/soil-sensor']!
    const g = { ...j.gates.find((x) => x.id === 'architecture')!, ...SOIL_GATES.architecture } as GateMore
    const root = createRootRoute()
    const page = createRoute({ getParentRoute: () => root, path: '/', component: () => <GateRecord journey={j} gate={g} /> })
    const router = createRouter({ routeTree: root.addChildren([page]), history: createMemoryHistory({ initialEntries: ['/'] }) })
    await act(async () => { render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router as never} /></QueryClientProvider>) })
    const text = await screen.findByText('The design rule check is clean, or each finding is waived')
    const chip = screen.getByRole('button', { name: /kicad_drc: 0 errors, 0 unconnected, 0 parity, 2 warnings/ })
    // the text and the chip share a wrapping row of their own, beside the status
    const row = text.parentElement!
    expect(row).toContainElement(chip)
    expect(row.className).toMatch(/\bflex-wrap\b/)
    // the text never shrinks below a readable width; the chip may shrink (its label truncates) rather than push it
    expect(text.className).toMatch(/min-w-\[min\(14rem,100%\)\]/)
    expect(text.className).not.toMatch(/\bmin-w-0\b/)
    expect(chip.className).toMatch(/\bmin-w-0\b/)
    expect(chip.className).toMatch(/\bmax-w-full\b/)
  })
})
