import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { act, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { StageGuidePanel } from './stage-guide'
import type { Journey } from '@/lib/types'

async function inRouter(ui: ReactNode): Promise<void> {
  const root = createRootRoute()
  const page = createRoute({ getParentRoute: () => root, path: '/', component: () => ui })
  const skill = createRoute({ getParentRoute: () => root, path: '/p/$id/do/$skill', component: () => <p>skill page</p> })
  const router = createRouter({ routeTree: root.addChildren([page, skill]), history: createMemoryHistory({ initialEntries: ['/'] }) })
  await act(async () => { render(<RouterProvider router={router as never} />) })
}

const finding = 'layout.fit@urn:trace:acme:acme%2Fboard:case-finding:Q1'
const journey = (held = false) => ({
  repo: 'acme/board', name: 'Board', revision: 'Rev A', template: 'board', current: 'layout',
  stages: [{ id: 'layout', name: 'Layout', state: 'current' }],
  gates: [{
    id: 'layout', name: 'the layout gate', after: 'layout', state: 'open', pending: ['2 open record changes'],
    criteria: [
      { id: 'layout.drc', text: 'The board passes the design rule check.', status: 'met' },
      { id: 'layout.fit', text: 'The board fits its case.', status: 'not_met', findings: [{ id: finding, text: 'Nothing covers Q1 from above.' }] },
    ],
  }],
  next: { kind: 'working', summary: '', button: 'Watch', yours: false }, questions: [], waivers: [], jobs: [], held,
}) as unknown as Journey

// test-esp32 #142: the gate page was closed for review while work was pending, so the finding could be waived nowhere
describe('the stage guide\'s gate panel', () => {
  it('lists what a criterion\'s shape found, each with "Waive this one…" to the Waiver skill about that finding', async () => {
    await inRouter(<StageGuidePanel j={journey()} onWhat={() => undefined} />)
    expect(screen.getByText('Nothing covers Q1 from above.')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'Waive this one…' })
    const href = new URL(link.getAttribute('href')!, 'http://x')
    expect(href.pathname).toBe('/p/acme~board/do/waiver')
    expect(href.searchParams.get('about')).toBe(`finding:${finding}`)
  })

  it('offers nothing to waive while the project is paused', async () => {
    await inRouter(<StageGuidePanel j={journey()} held onWhat={() => undefined} />)
    expect(screen.queryByRole('link', { name: 'Waive this one…' })).toBeNull()
  })
})
