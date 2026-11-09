import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { act, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { EvidenceBody } from './evidence-sheet'

async function inRouter(ui: ReactNode): Promise<void> {
  const root = createRootRoute()
  const page = createRoute({ getParentRoute: () => root, path: '/', component: () => ui })
  const skill = createRoute({ getParentRoute: () => root, path: '/p/$id/do/$skill', component: () => <p>skill page</p> })
  const router = createRouter({ routeTree: root.addChildren([page, skill]), history: createMemoryHistory({ initialEntries: ['/'] }) })
  await act(async () => { render(<RouterProvider router={router as never} />) })
}

describe('evidence panel of a criterion a person meets', () => {
  it('names where a not-met criterion is done (test-esp32-run3 S10)', async () => {
    await inRouter(<EvidenceBody repo="acme/desk-gadget" opened criterion={{ id: 'capture.pins', text: 'The pin plan matches the schematic.', status: 'not_met', evidence: { kind: 'record', label: 'the pin plan' } as never }} />)
    expect(screen.getByRole('link', { name: /Pin plan review/ }).getAttribute('href')).toBe('/p/acme~desk-gadget/do/pin-plan-review')
  })

  it("adds nothing once it is met, or for trace's own checks", async () => {
    await inRouter(
      <>
        <EvidenceBody repo="acme/desk-gadget" opened criterion={{ id: 'capture.pins', text: 'x', status: 'met' }} />
        <EvidenceBody repo="acme/desk-gadget" opened criterion={{ id: 'capture.erc', text: 'y', status: 'not_met' }} />
      </>,
    )
    expect(screen.queryByText(/You meet this in/)).toBeNull()
  })
})
