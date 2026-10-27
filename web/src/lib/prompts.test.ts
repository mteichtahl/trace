import { describe, expect, it } from 'vitest'
import type { PromptRow, PromptView } from './admin-types'
import { lineDiff, diffCounts } from './diff'
import { MAX_PROMPT_CHARS, canSave, checkTemplate, entryTitle, filterRows, groupCatalog, layerBelow, layerLabel, nextVersion, parseMarked, suggestionFrom } from './prompts'

const row = (id: string, o: Partial<PromptRow> = {}): PromptRow => ({ id, mode: 'editable', prompt: 'specialist', description: `about ${id}`, layer: 'default', version: null, ...o })

describe('agent instruction checks', () => {
  it('accepts declared variables and refuses unknown or malformed ones', () => {
    expect(checkTemplate('for {{repository}} {{ where }}', ['repository', 'where']).ok).toBe(true)
    const c = checkTemplate('read {{log_url}} first', ['repository'])
    expect(c.ok).toBe(false)
    expect(c.unknown).toEqual(['log_url'])
    expect(checkTemplate('{{Name}}', ['name']).malformed).toMatch(/not a variable/)
    expect(checkTemplate('an unmatched {{ brace', []).malformed).toMatch(/unmatched/)
  })

  it('holds the 16,000 character limit', () => {
    expect(checkTemplate('x'.repeat(MAX_PROMPT_CHARS), []).ok).toBe(true)
    const c = checkTemplate('x'.repeat(MAX_PROMPT_CHARS + 1), [])
    expect(c.tooLong).toBe(true)
    expect(c.ok).toBe(false)
  })

  it('wakes Save only when the text changed, the checks pass and a reason is given', () => {
    const ok = checkTemplate('fine', [])
    expect(canSave({ check: ok, changed: true, reason: 'clearer', locked: false })).toBe(true)
    expect(canSave({ check: ok, changed: true, reason: '  ', locked: false })).toBe(false)
    expect(canSave({ check: ok, changed: false, reason: 'clearer', locked: false })).toBe(false)
    expect(canSave({ check: checkTemplate('{{nope}}', []), changed: true, reason: 'x', locked: false })).toBe(false)
    expect(canSave({ check: ok, changed: true, reason: 'x', locked: true })).toBe(false)
  })
})

describe('the catalog', () => {
  it('groups specialists under one heading and names parts plainly', () => {
    const g = groupCatalog([row('specialist.ams.role'), row('specialist.ams.workflow'), row('specialist.verify.done'), row('specialist.guardrails', { mode: 'locked' }), row('router.classify', { prompt: 'router' })])
    expect(g[0]!.title).toBe('Specialists')
    expect(g[0]!.groups!.map((s) => s.title)).toEqual(['Verification', 'Analog and mixed-signal'])
    expect(g.map((x) => x.title)).toContain('Router')
    expect(entryTitle('specialist.ams.escalate')).toBe('Escalation')
  })

  it('filters by editable, changed and words', () => {
    const rows = [row('specialist.ams.role', { layer: 'project', version: 2 }), row('specialist.guardrails', { mode: 'locked' }), row('router.classify', { prompt: 'router' })]
    expect(filterRows(rows, { editableOnly: true, changedOnly: false, text: '' }).map((r) => r.id)).not.toContain('specialist.guardrails')
    expect(filterRows(rows, { editableOnly: false, changedOnly: true, text: '' }).map((r) => r.id)).toEqual(['specialist.ams.role'])
    expect(filterRows(rows, { editableOnly: false, changedOnly: false, text: 'router' }).map((r) => r.id)).toEqual(['router.classify'])
    expect(layerLabel('project', 2)).toBe('Project v2')
  })

  it('finds the layer below and the next version per scope', () => {
    const v = { default: 'D', installation: { text: 'I', version: 1, updated: '', by: null }, project: { text: 'P', version: 2, updated: '', by: null } } as unknown as PromptView
    expect(layerBelow(v, 'project')).toMatchObject({ layer: 'installation', text: 'I' })
    expect(layerBelow(v, 'installation')).toMatchObject({ layer: 'default', text: 'D' })
    expect(nextVersion(v, 'project')).toBe(3)
  })
})

describe('preview and suggestions', () => {
  it('splits the marked prompt into its labelled parts', () => {
    const parts = parseMarked('[editable specialist.ams.role · project v2 · a1b2c3d4e5f6]\nYou are…\n\n[locked specialist.guardrails · default · 0f9e8d7c6b5a]\nNever print tokens.')
    expect(parts).toEqual([
      { id: 'specialist.ams.role', locked: false, layer: 'project', version: 2, text: 'You are…' },
      { id: 'specialist.guardrails', locked: true, layer: 'default', version: null, text: 'Never print tokens.' },
    ])
  })
  it('takes the fenced block of trace\'s reply as the suggestion', () => {
    expect(suggestionFrom('Here:\n```\nnew text\n```\nTightened it.')).toBe('new text')
  })
  it('diffs line by line', () => {
    const d = lineDiff('a\nb\nc', 'a\nc\nd')
    expect(diffCounts(d)).toEqual({ added: 1, removed: 1 })
    expect(d.map((l) => l.kind)).toEqual(['same', 'remove', 'same', 'add'])
  })
})
