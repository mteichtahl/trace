import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { checkPlot, parsePlot, PlotError, plotCsv, plotRows } from './chat-plot'
import MarkdownImpl from './markdown-impl'
import { mermaidTitle } from './mermaid'

describe('chat plots', () => {
  it('reads JSON5 with comments and unquoted keys', async () => {
    const p = await parsePlot('{ title: "Rail", series: [{ name: "3V3", points: [[0, 3.3], [1, 3.28]] }], // the rail\n}')
    expect(p.title).toBe('Rail')
    expect(p.series[0]!.points).toHaveLength(2)
  })

  it('says what is wrong in plain words', async () => {
    await expect(parsePlot('{ title: "x" }')).rejects.toThrow(/at least one series/)
    expect(() => checkPlot({ series: [{ name: 'a', points: [[0, 'high']] }] })).toThrow(PlotError)
    expect(() => checkPlot({ kind: 'pie', series: [{ name: 'a', points: [[0, 1]] }] })).toThrow(/kind must be one of/)
    expect(() => checkPlot({ series: [{ name: 'a', points: Array.from({ length: 5001 }, (_, i) => [i, i]) }] })).toThrow(/at most 5000/)
  })

  it('lines series up by x: numbers sorted, words in the order they first appear', () => {
    const nums = checkPlot({ series: [{ name: 'a', points: [[2, 1], [1, 2]] }, { name: 'b', points: [[1, 5]] }] })
    expect(plotRows(nums)).toEqual([{ x: 1, a: 2, b: 5 }, { x: 2, a: 1 }])
    const words = checkPlot({ series: [{ name: 'cost', points: [['PCB', 4], ['Assembly', 9]] }] })
    expect(plotRows(words).map((r) => r.x)).toEqual(['PCB', 'Assembly'])
  })

  it('downloads its numbers as CSV with the axis unit in the header', () => {
    const p = checkPlot({ x: { label: 'Time', unit: 's' }, series: [{ name: 'V, out', points: [[0, 1]] }] })
    expect(plotCsv(p)).toBe('Time (s),"V, out"\n0,1')
  })
})

describe('chat pictures in markdown', () => {
  it('reads a Mermaid title line', () => {
    expect(mermaidTitle('%% title: Power path\nflowchart LR\n A-->B')).toBe('Power path')
    expect(mermaidTitle('flowchart LR\n A-->B')).toBeUndefined()
  })

  it('draws an SVG fence as a cleaned picture, with no script left', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Pinout</title><script>alert(1)</script><rect width="5" height="5" onclick="alert(1)"/></svg>'
    const { container } = render(<MarkdownImpl text={'```svg\n' + svg + '\n```'} />)
    expect(screen.getByRole('figure', { name: 'Pinout' })).toBeTruthy()
    expect(container.querySelector('figure svg rect')).not.toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('[onclick]')).toBeNull()
  })

  it('shows a quiet placeholder while a diagram is still streaming, never half-drawn code', () => {
    render(<MarkdownImpl text={'```plot\n{ series: [{ name: "a", points: [[0,'} streaming />)
    expect(screen.getByRole('status').textContent).toMatch(/Drawing the plot/)
  })

  it('shows the source with a note when a plot cannot be drawn', async () => {
    render(<MarkdownImpl text={'```plot\n{ title: "nothing" }\n```'} />)
    await waitFor(() => expect(screen.getByText(/could not be drawn: it needs at least one series/)).toBeTruthy())
  })

  it('opens an image full screen when tapped', () => {
    render(<MarkdownImpl text="See ![Top of the board](https://example.com/top.png) here" />)
    fireEvent.click(screen.getByRole('button', { name: /Open image "Top of the board" full screen/ }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Top of the board' })).toBeTruthy()
  })

  it('keeps ordinary code blocks as code', () => {
    const { container } = render(<MarkdownImpl text={'```c\nint x = 1;\n```'} />)
    expect(container.querySelector('figure')).toBeNull()
    expect(container.textContent).toContain('int x = 1;')
  })
})
