/**
 * A schematic opens on what is drawn, not the page (test-esp32 #50: every part in small clusters in the top half of an
 * A4 sheet, and nothing readable at the viewer's fit zoom).
 */
import { describe, expect, it } from 'vitest'
import { contentBox } from './kicad'

const box = (x: number, y: number, w: number, h: number, valid = true) => ({ x, y, w, h, valid })

describe('the box a schematic opens on', () => {
  it('is around the symbols, wires and labels, without the page frame, grid or overlays', () => {
    const layers = [
      { name: ':DrawingSheet', bbox: box(0, 0, 297, 210) },
      { name: ':Grid', bbox: box(-10, -10, 400, 300) },
      { name: ':Symbol:Foreground', bbox: box(40, 30, 60, 20) },
      { name: ':Wire', bbox: box(35, 28, 80, 30) },
      { name: ':Label', bbox: box(120, 40, 15, 3) },
      { name: ':Notes', bbox: box(0, 0, 0, 0, false) },
      { name: ':Overlay', bbox: box(0, 0, 297, 210) },
    ]
    expect(contentBox(layers)).toEqual({ x: 35, y: 28, w: 100, h: 30 })
  })
  it('is nothing for an empty sheet (it opens on the page)', () => {
    expect(contentBox([{ name: ':DrawingSheet', bbox: box(0, 0, 297, 210) }, { name: ':Wire', bbox: box(Infinity, Infinity, -Infinity, -Infinity, false) }])).toBeNull()
    expect(contentBox([])).toBeNull()
  })
})
