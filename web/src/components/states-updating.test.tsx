import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryError } from './states'
import { ApiError } from '@/lib/api'

describe('QueryError while trace finishes an update', () => {
  it('says the part will be here in a few minutes when the API does not know the action yet', () => {
    render(<QueryError error={new ApiError('unknown action "changes.list"', 400)} what="the changes" onRetry={() => undefined} />)
    expect(screen.getByRole('alert').textContent).toMatch(/trace is finishing an update, so the changes will be here in a few minutes/)
    expect(screen.getByRole('button', { name: /Try again/ })).toBeTruthy()
  })

  it('keeps the plain wording for other errors', () => {
    render(<QueryError error={new Error('boom')} what="the changes" />)
    expect(screen.getByRole('alert').textContent).toMatch(/Could not load the changes/)
  })
})
