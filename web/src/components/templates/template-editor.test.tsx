/**
 * The project template editor (Admin › Project templates) against the API's real answer (lib/api-answers.json
 * templates.get): it shows the catalog's stages with the template's own, lets an admin drop a stage and a criterion and
 * add one a person signs off, shows what the API says is wrong, and saves the definition with the reason.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import answers from '@/lib/api-answers.json'
import type { TemplateCatalogStage, TemplateDoc, TemplateView } from '@/lib/types'

const calls: { action: string; args: Record<string, unknown> }[] = []
let problems: string[] = []
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>()
  return {
    ...real,
    call: vi.fn(async (action: string, args: Record<string, unknown>) => {
      calls.push({ action, args })
      if (action === 'templates.check') return { ok: problems.length === 0, problems }
      if (action === 'templates.save') return { template: { ...(args.doc as object) }, saved: true, summary: 'Saved as version 1.' }
      return {}
    }),
  }
})

const { TemplateEditor, addedKey } = await import('./template-editor')
const got = (answers as unknown as Record<string, { result: { template: TemplateView; catalog: TemplateCatalogStage[]; code: TemplateDoc } }>)['templates.get']!.result

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><TemplateEditor view={got.template} catalog={got.catalog} code={got.code} history={[]} /></QueryClientProvider>)
}

describe('an added criterion\'s key', () => {
  it('comes from its words, letters and hyphens only, and is unique in its gate', () => {
    expect(addedKey('Legal has read the requirements.', new Set())).toBe('legal-has-read-the')
    expect(addedKey('Legal has read the requirements.', new Set(['legal-has-read-the']))).toBe('legal-has-read-the-b')
    expect(addedKey('42!', new Set())).toBe('check')
  })
})

describe('the template editor', () => {
  it('lists every catalog stage, Define and the later stages fixed, and the Board template\'s own ticked', () => {
    show()
    expect(screen.getByRole('checkbox', { name: 'Define in this template' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Sustain in this template' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Prove in this template' })).toBeChecked()
    expect(screen.getByRole('button', { name: /Save version 1/ })).toBeDisabled()
  })

  it('drops a stage, adds a criterion a person signs off, shows what is wrong, and saves with the reason', async () => {
    calls.length = 0
    show()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Prove in this template' }))
    const define = screen.getByRole('checkbox', { name: 'Define in this template' }).closest('li')!
    fireEvent.click(within(define).getByRole('button', { name: 'Edit Define' }))
    fireEvent.click(within(define).getByRole('button', { name: /Add a criterion a person signs off/ }))
    fireEvent.change(within(define).getByLabelText('What must be true'), { target: { value: 'Legal has read the requirements.' } })
    fireEvent.change(within(define).getByLabelText('What a person looks at to sign it off'), { target: { value: 'the legal review' } })
    fireEvent.click(within(define).getByRole('button', { name: 'Add' }))
    expect(within(define).getByDisplayValue('Legal has read the requirements.')).toBeInTheDocument()

    // the API's word on what is wrong blocks the save until it is fixed
    problems = ['The gate define needs at least one criterion.']
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sensor board' } })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The gate define needs at least one criterion.'))
    problems = []
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sensor board, house rules' } })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())

    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'Our sensor boards skip Prove.' } })
    fireEvent.click(screen.getByRole('button', { name: /Save version 1/ }))
    await waitFor(() => expect(calls.some((c) => c.action === 'templates.save')).toBe(true))
    const saved = calls.find((c) => c.action === 'templates.save')!.args as { doc: TemplateDoc; reason: string }
    expect(saved.reason).toBe('Our sensor boards skip Prove.')
    expect(saved.doc.name).toBe('Sensor board, house rules')
    expect(saved.doc.stages.map((s) => s.id)).not.toContain('prove')
    expect(saved.doc.stages[0]!.gates[0]!.criteria.at(-1)).toEqual({ id: 'define.legal-has-read-the', text: 'Legal has read the requirements.', custom: true, evidence: 'the legal review' })
  })
})
