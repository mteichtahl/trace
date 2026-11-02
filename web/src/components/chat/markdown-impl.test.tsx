import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import MarkdownImpl from './markdown-impl'

describe('MarkdownImpl maths', () => {
  it('keeps currency as text: two dollar amounts in one paragraph are not a formula', () => {
    const { container } = render(<MarkdownImpl text="costs US$5 per board, US$50 for ten" />)
    expect(container.textContent).toContain('costs US$5 per board, US$50 for ten')
    expect(container.querySelector('.katex, math')).toBeNull()
  })

  it('keeps currency as text while streaming', () => {
    const { container } = render(<MarkdownImpl text="the US$5 includes the stencil at 10 boards, over US$5" streaming />)
    expect(container.textContent).toContain('the US$5 includes the stencil at 10 boards, over US$5')
    expect(container.querySelector('.katex, math')).toBeNull()
  })

  it('still renders $$…$$ as maths, inline and as a block', () => {
    const inline = render(<MarkdownImpl text="area is $$x^2$$ here" />).container
    expect(inline.querySelector('.katex')).not.toBeNull()
    expect(inline.textContent).not.toContain('$$')

    const block = render(<MarkdownImpl text={'$$\nx^2\n$$'} />).container
    expect(block.querySelector('.katex-display')).not.toBeNull()
  })
})
