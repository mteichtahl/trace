/** The message box: the microphone button follows the Dictation preference. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ChatInput } from './chat-input'

function renderWith(voice: Record<string, unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(['me.get', {}], { prefs: { voice }, views: {} })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ChatInput onSend={vi.fn()} running={false} history={[]} />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

describe('ChatInput dictation', () => {
  it('shows the microphone by default', () => {
    renderWith({})
    expect(screen.getByRole('button', { name: /dictate/i })).toBeInTheDocument()
  })
  it('hides the microphone when Dictation is off', () => {
    renderWith({ dictation: false })
    expect(screen.queryByRole('button', { name: /dictate/i })).not.toBeInTheDocument()
  })
})
