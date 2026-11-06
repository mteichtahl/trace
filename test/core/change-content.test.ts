/**
 * What a change carries, from its files (src/core/change-contents.ts changeContent): only the project's record, only
 * the documents, or design. The first two do not hold a gate (test-esp32 #101, #116).
 */
import { describe, expect, it } from 'vitest'
import { changeContent } from '../../src/core/change-contents.js'

describe('changeContent', () => {
  it('a finished job\'s record only', () => {
    expect(changeContent(['.trace/project.db'])).toBe('record')
  })

  it('the documents, with or without the record', () => {
    expect(changeContent(['docs/design/high-level-design.md'])).toBe('docs')
    expect(changeContent(['docs/design/high-level-design.md', 'docs/design/figures/top.png', '.trace/project.db'])).toBe('docs')
  })

  it('anything else is design, and so is a change whose files are not known', () => {
    expect(changeContent(['.trace/project.db', 'hardware/board.kicad_sch'])).toBe('design')
    expect(changeContent(['docs/design/high-level-design.md', 'mechanical/case.py'])).toBe('design')
    expect(changeContent(['.trace/rules.md'])).toBe('design')
    expect(changeContent(['docs/notes.md'])).toBe('design')
    expect(changeContent([])).toBe('design')
  })
})
