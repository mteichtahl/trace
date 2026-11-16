/**
 * The block diagram's first view (test-esp32-run2 R31): Architecture choice's "Read each option" opened it fitted
 * whole, at 65 %, its blocks unreadable. It opens at a readable zoom from its top left corner instead, the layout held
 * still between options (fixed bounds); Fit still shows it whole.
 */
import { describe, expect, it } from 'vitest'
import { readableViewport } from '@/components/canvas/flow'
import { FIT, layout, overlapping, separate } from './block-diagram'

describe('the block diagram\'s first view', () => {
  const box = FIT.bounds

  it('opens readable in Architecture choice\'s frame, its top left corner in view', () => {
    const frame = { width: 780, height: 320 }
    // fitted whole it would be about 64 %
    expect(Math.min(frame.width / box.width, frame.height / box.height)).toBeLessThan(0.7)
    const v = readableViewport(box, frame, 0, FIT.readable)
    expect(v?.zoom).toBe(0.8)
    expect(v!.x + box.x * v!.zoom).toBe(8)
    expect(v!.y + box.y * v!.zoom).toBe(8)
  })

  it('a frame it fits readably in shows it whole', () => {
    expect(readableViewport(box, { width: 1400, height: 620 }, 0, FIT.readable)).toBeNull()
  })
})

describe('no two blocks overlap', () => {
  const block = (id: string, x: number, y: number) => ({ id, x, y })

  it('spreads blocks the record draws on top of each other', () => {
    const at = layout([block('a', 0.4, 0.4), block('b', 0.4, 0.4), block('c', 0.42, 0.45), block('d', 0, 0)])
    expect(overlapping(at)).toBe(false)
  })

  it('leaves blocks that are already apart where they are', () => {
    const blocks = [block('a', 0, 0), block('b', 1, 1)]
    const before = new Map(blocks.map((b) => [b.id, { x: b.x * (FIT.bounds.width - 32 - 200), y: b.y * (FIT.bounds.height - 32 - 92) }]))
    expect(separate(before)).toEqual(before)
  })

  it('a dragged block stays where it is put; the block in its way steps aside', () => {
    const moved = new Map([['a', { x: 300, y: 100 }]])
    const at = layout([block('a', 0, 0), block('b', 300 / 980, 110 / 378)], moved, 'a')
    expect(at.get('a')).toEqual({ x: 300, y: 100 })
    expect(overlapping(at)).toBe(false)
  })

  it('keeps every block inside the frame, even crowded into a corner', () => {
    const blocks = Array.from({ length: 12 }, (_, i) => block(`b${i}`, 1, 1))
    const at = layout(blocks)
    expect(overlapping(at)).toBe(false)
    for (const p of at.values()) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(980)
      expect(p.y).toBeLessThanOrEqual(378)
    }
  })
})
