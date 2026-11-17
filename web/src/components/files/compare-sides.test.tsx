/**
 * Every kind of file compares in the app (nothing ends in "download to review"): the kinds with no difference view of
 * their own open in their own viewer, Before, After or side by side.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CompareView } from './compare'
import { compareMode, type ViewerKind, viewerKind } from './kinds'

vi.mock('./viewers', () => ({
  ViewerFor: ({ file, commit }: { file: { path: string }; commit?: string }) => <div data-testid="viewer">{file.path} @ {commit ?? 'current'}</div>,
}))

const KINDS: ViewerKind[] = [
  'schematic', 'board', 'gerber', 'gerber-zip', 'model', 'step', 'image', 'video', 'svg', 'pdf', 'table', 'vcd', 'plot', 'wavedrom',
  'code', 'markdown', 'firmware', 'archive', 'database', 'unknown', 'spice', 'touchstone', 'gzip', 'report', 'netlist',
]

describe('comparing any kind of file', () => {
  it('every kind has a way to compare', () => {
    for (const k of KINDS) expect(compareMode(k), k).not.toBeNull()
  })

  it('the kinds with no difference view of their own compare as Before, After and Side by side', () => {
    for (const p of ['fab/top.gtl', 'case/lid.step', 'docs/datasheet.pdf', 'out/fw.elf', 'out/fab.zip', 'x/odd.pcapng']) {
      const k = viewerKind(p)
      expect(['sides', 'text', 'table', 'image', 'kicad', 'database']).toContain(compareMode(k))
    }
    expect(compareMode(viewerKind('case/lid.step'))).toBe('sides')
    expect(compareMode(viewerKind('x/odd.pcapng'))).toBe('sides')
  })

  it('opens After first, then Before, then both, each in the file\'s own viewer at that commit', async () => {
    render(<CompareView file={{ repo: 'acme/x', path: 'case/lid.step' }} before="abc1234" after="def5678" size="sheet" />)
    expect(screen.getByTestId('viewer')).toHaveTextContent('case/lid.step @ def5678')
    await userEvent.click(screen.getByRole('radio', { name: 'Before' }))
    expect(screen.getByTestId('viewer')).toHaveTextContent('case/lid.step @ abc1234')
    await userEvent.click(screen.getByRole('radio', { name: 'Side by side' }))
    const both = screen.getAllByTestId('viewer')
    expect(both).toHaveLength(2)
    expect(both[0]).toHaveTextContent('@ abc1234')
    expect(both[1]).toHaveTextContent('@ def5678')
  })

  it('"current" is the file as it is now, not a commit called current', () => {
    render(<CompareView file={{ repo: 'acme/x', path: 'docs/datasheet.pdf' }} before="abc1234" after="current" size="sheet" />)
    expect(screen.getByTestId('viewer')).toHaveTextContent('docs/datasheet.pdf @ current')
  })
})
