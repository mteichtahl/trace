/**
 * Question answer's side panel keeps still while the answer is typed (test-esp32 #36): the "Does it last?" choices
 * were drawn under the answer as it is written, so typing moved them down and a click aimed at "Just this once" missed.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { call } from '@/lib/api'
import { SKILL_BY_ID } from './definitions'
import { QuestionAnswer } from './conversation-skills'

vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { back: vi.fn() } }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock('@/components/chat/embedded-chat', () => ({ EmbeddedChat: () => null }))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), call: vi.fn() }))

describe('Question answer, the side panel', () => {
  it('draws what is written so far after the choices, so typing never moves them', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) =>
      ({ matches: true, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }) as MediaQueryList)
    vi.mocked(call).mockImplementation((async (action: string) => {
      if (action === 'skill.get') return { skill: 'question-answer', question: { id: 'q-stall', text: "What is the motor's stall current?" }, checks: [], draft: { done: [], answer: 'Keep the stall threshold at 1.2 A', value: '', source: '', lasts: '', option: 'other', question: 'q-stall' }, step: 2 }
      if (action === 'journey.get') return { repo: 'acme/motor-driver', name: 'Motor driver', stages: [], gates: [] }
      return {}
    }) as unknown as typeof call)
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><QuestionAnswer repo="acme/motor-driver" def={SKILL_BY_ID['question-answer']!} /></TooltipProvider></QueryClientProvider>)
    const lasts = await screen.findByText('Does it last?')
    const sofar = screen.getByText('Chosen').parentElement!
    expect(sofar).toHaveTextContent('Keep the stall threshold at 1.2 A')
    // the written answer comes after the choices in the panel, never above them
    expect(lasts.compareDocumentPosition(sofar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // and the answer box keeps its height as it is typed (it scrolls), so what is below it stays put too
    expect(document.getElementById('qa-answer')!.className).toMatch(/field-sizing-fixed/)
  })
})

describe('Question answer, the runs it cites', () => {
  it('shows the pictures of at most three cited runs, once each (test-esp32-run2 R49)', async () => {
    const { questionRuns } = await import('./conversation-skills')
    const run = (id: string) => ({ kind: 'run' as const, id, label: `run ${id}`, to: `/p/acme~board/runs/${id}` })
    expect(questionRuns({ sources: [run('r1'), { kind: 'datasheet' as const, id: 'd', label: 'datasheet' }, run('r1'), run('r2')], searched: [run('r3'), run('r4')] }))
      .toEqual([{ repo: 'acme/board', id: 'r1' }, { repo: 'acme/board', id: 'r2' }, { repo: 'acme/board', id: 'r3' }])
    expect(questionRuns({})).toEqual([])
  })
})
