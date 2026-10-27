import { describe, expect, it } from 'vitest'
import { afterSend, dedupe, down, escape, initialRecall, up } from './recall'

const history = ['third', 'second', 'second', 'first'] // newest first, with a repeat

describe('Up/Down recall', () => {
  it('drops consecutive duplicates and blanks', () => {
    expect(dedupe(['a', 'a', '', 'b', 'a'])).toEqual(['a', 'b', 'a'])
  })

  it('Up from an empty box recalls the newest, then further back, without repeats', () => {
    let r = up(initialRecall, history, '', 0)
    expect(r.value).toBe('third')
    r = up(r.state, history, r.value!, 0)
    expect(r.value).toBe('second')
    r = up(r.state, history, r.value!, 0)
    expect(r.value).toBe('first')
    // the oldest: Up does nothing
    expect(up(r.state, history, r.value!, 0).value).toBeNull()
  })

  it('Up recalls only when the cursor is on the first line', () => {
    const text = 'line one\nline two'
    expect(up(initialRecall, history, text, text.length).value).toBeNull()
    expect(up(initialRecall, history, text, 3).value).toBe('third')
  })

  it('Down recalls only on the last line, and past the newest restores the draft exactly', () => {
    const draft = 'my unsent\ndraft'
    let r = up(initialRecall, history, draft, 0)
    r = up(r.state, history, r.value!, 0)
    expect(r.value).toBe('second')
    const multi = 'second'
    r = down(r.state, history, multi, multi.length)
    expect(r.value).toBe('third')
    r = down(r.state, history, r.value!, r.value!.length)
    expect(r.value).toBe(draft)
    expect(r.state.index).toBe(-1)
    // not recalling: Down does nothing
    expect(down(r.state, history, draft, draft.length).value).toBeNull()
  })

  it('Down does nothing when the cursor is not on the last line', () => {
    const r = up(initialRecall, ['a\nb'], '', 0)
    expect(down(r.state, ['a\nb'], 'a\nb', 0).value).toBeNull()
  })

  it('Escape leaves recall and restores the draft', () => {
    let r = up(initialRecall, history, 'draft', 0)
    r = up(r.state, history, r.value!, 0)
    const e = escape(r.state)
    expect(e.value).toBe('draft')
    expect(e.state.index).toBe(-1)
    expect(escape(e.state).value).toBeNull()
  })

  it('after sending, the sent text leads the history once', () => {
    expect(afterSend(['a', 'b'], 'a')).toEqual(['a', 'b'])
    expect(afterSend(['a', 'b'], 'c')).toEqual(['c', 'a', 'b'])
  })
})
