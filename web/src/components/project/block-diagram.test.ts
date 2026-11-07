/**
 * The block diagram's first view (test-esp32-run2 R31): Architecture choice's "Read each option" opened it fitted
 * whole, at 65 %, its blocks unreadable. It opens at a readable zoom from its top left corner instead, the layout held
 * still between options (fixed bounds); Fit still shows it whole.
 */
import { describe, expect, it } from 'vitest'
import { readableViewport } from '@/components/canvas/flow'
import { FIT } from './block-diagram'

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
