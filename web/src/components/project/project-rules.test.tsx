/**
 * The project's rules in Settings (test-esp32 log #109; src/api/rule-answers.ts): each answer made a rule for the
 * project, with who decided it and which question, and where it stands (in the rules, waiting in its change, not in
 * the rules yet); one not in the rules yet is added through a change; an empty rules file says agents have none.
 * The question-answer toast says where a rule went (answeredWords).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { call } from '@/lib/api'
import { answeredWords } from '@/components/skills/conversation-skills'
import { ProjectRules } from './project-rules'

vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => <a href={to} className={className}>{children}</a>,
}))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), call: vi.fn() }))
const mockCall = vi.mocked(call)
const REPO = 'acme/soil-sensor'

const wrap = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)
const ANSWERS = [
  { question: 'aq-thermal', asked: 'Can the modem transmit continuously?', asked_by: 'the Thermal specialist', rule: 'Design to modem sleep: no continuous transmit', reason: 'The case has no airflow.', by: 'priya@acme.example', at: '2026-11-05T09:00:00Z', state: 'waiting', change: 41 },
  { question: 'aq-pins', asked: 'Which pin order does J2 need?', asked_by: 'the Implementation specialist', rule: 'J2 is GND, VCC, SCL, SDA', reason: null, by: 'priya@acme.example', at: '2026-11-04T09:00:00Z', state: 'in_rules', change: null },
  { question: 'aq-log', asked: 'May the firmware log in production?', asked_by: 'the Firmware specialist', rule: 'No logging in production builds', reason: null, by: 'alex@acme.example', at: '2026-11-03T09:00:00Z', state: 'missing', change: null },
]
let text: string | null = '# Rules\n\n## Rules from answers\n\n- J2 is GND, VCC, SCL, SDA.\n'
let answers = ANSWERS

beforeEach(() => {
  mockCall.mockReset()
  text = '# Rules\n\n## Rules from answers\n\n- J2 is GND, VCC, SCL, SDA.\n'
  answers = ANSWERS
  mockCall.mockImplementation((async (action: string, args: Record<string, unknown>) => {
    if (action === 'project.rules') return { repo: REPO, branch: 'main', path: '.trace/rules.md', text, answers }
    if (action === 'project.rule_from_answer') return { repo: REPO, question: args.question, state: 'proposed', change: 44, summary: 'The rule goes into the project\'s rules (.trace/rules.md) in change #44.' }
    throw new Error(`unexpected ${action}`)
  }) as never)
})

describe('the project rules in Settings', () => {
  it('shows each answer made a rule, who decided it, the question, and where it stands', async () => {
    wrap(<ProjectRules repo={REPO} canWrite />)
    const list = await screen.findByRole('list', { name: 'Rules from answers' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows[0]!.textContent).toMatch(/Design to modem sleep: no continuous transmit[\s\S]*Why: The case has no airflow\.[\s\S]*Decided by priya@acme\.example on .*answering the Thermal specialist: "Can the modem transmit continuously\?"[\s\S]*Waiting in change #41/)
    expect(within(rows[0]!).getByRole('link', { name: 'Open the change' }).getAttribute('href')).toBe('/p/acme~soil-sensor/changes/41')
    expect(rows[1]!.textContent).toMatch(/In the rules/)
    expect(rows[2]!.textContent).toMatch(/Not in the rules yet/)
    expect(screen.getByText('Read the whole rules file')).toBeTruthy()
  })

  it('adds an answer that is not in the rules yet through a change', async () => {
    wrap(<ProjectRules repo={REPO} canWrite />)
    await userEvent.click(await screen.findByRole('button', { name: 'Add it to the rules' }))
    await waitFor(() => expect(mockCall).toHaveBeenCalledWith('project.rule_from_answer', { repo: REPO, question: 'aq-log' }))
  })

  it('a reviewer sees where each rule stands but cannot add one', async () => {
    wrap(<ProjectRules repo={REPO} canWrite={false} />)
    await screen.findByText('Not in the rules yet')
    expect(screen.queryByRole('button', { name: 'Add it to the rules' })).toBeNull()
  })

  it('an empty rules file says agents have no project rules yet', async () => {
    text = null
    answers = []
    wrap(<ProjectRules repo={REPO} canWrite />)
    expect(await screen.findByText('No answer has been made a rule yet.')).toBeTruthy()
    expect(screen.getByText(/The rules file on main is empty, so agents have no project rules yet/)).toBeTruthy()
  })
})

describe('what an answer says', () => {
  it('a rule says which change adds it to the project\'s rules, or where to add it when it could not be', () => {
    expect(answeredWords({ summary: 'Answered. The agent carries on.' })).toBe('Answered. The agent carries on.')
    expect(answeredWords({ summary: 'Answered.', rule: { state: 'proposed', change: 41, words: 'The rule goes into the project\'s rules in change #41.' } })).toBe('Answered. The rule goes into the project\'s rules in change #41.')
    expect(answeredWords({ summary: 'Answered.', rule_error: 'GitHub did not answer' })).toMatch(/could not be added to the project's rules yet: add it from Settings, under Project rules/)
    expect(answeredWords(undefined)).toBe('Answered. The agent continues.')
  })
})
