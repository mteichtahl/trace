/**
 * A schematic opens on what is drawn, not the page (test-esp32 #50: every part in small clusters in the top half of an
 * A4 sheet, and nothing readable at the viewer's fit zoom).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
  it('leaves out a heading note in the top corner (test-esp32 #242, the bridge sheet as KiCanvas boxes it)', () => {
    const layers = [
      { name: ':DrawingSheet', bbox: box(-0.1, -0.1, 297.3, 210.3) },
      { name: ':Symbol:Field', bbox: box(53.5, 65.1, 121.6, 77.8) },
      { name: ':Label', bbox: box(55.7, 69.7, 107, 80.3) },
      { name: ':Wire', bbox: box(55.7, 69.7, 107, 80.3) },
      { name: ':Symbol:Foreground', bbox: box(53.3, 67.2, 111, 79.5) },
      { name: ':Notes', bbox: box(20.5, 18.6, 73.5, 2.1) },
    ]
    const b = contentBox(layers)!
    expect(b.x).toBeCloseTo(53.3)
    expect(b.y).toBeCloseTo(65.1)
    expect(b.x + b.w).toBeCloseTo(175.1)
    expect(b.y + b.h).toBeCloseTo(150)
  })
  it("has no local label reaching back to the sheet's origin (the vendored KiCanvas draws no empty label shape)", () => {
    // upstream drew a local label's empty shape as a line, whose box is the origin: every local label's box then ran
    // from the page's top-left corner to the label, and the fit took in most of the page (test-esp32 #242)
    const src = readFileSync(resolve(__dirname, '../../../vendor/kicanvas/kicanvas.js'), 'utf8')
    expect(src).toContain('let o=this.create_shape(r,i);o?.length&&this.gfx.line(o,')
    expect(src).not.toContain('let o=this.create_shape(r,i);o&&this.gfx.line(o,')
  })
  it('is nothing for an empty sheet (it opens on the page)', () => {
    expect(contentBox([{ name: ':DrawingSheet', bbox: box(0, 0, 297, 210) }, { name: ':Wire', bbox: box(Infinity, Infinity, -Infinity, -Infinity, false) }])).toBeNull()
    expect(contentBox([])).toBeNull()
  })
})
