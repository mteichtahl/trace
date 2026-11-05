/**
 * The Renders gallery's words and names (src/components/renders/gallery.tsx): how a revision's set is counted when it
 * has a turntable, the zip's name, and the day as written.
 */
import { describe, expect, it } from 'vitest'
import type { RenderPicture, RevisionRenders, Shot } from '@/lib/types-renders'
import { countWords, dayWords, zipName } from './gallery'

const pic = (shot: Shot): RenderPicture => ({ name: `soil-sensor_rev-B_2026-11-05_${shot}.${shot === 'turntable' ? 'mp4' : 'png'}`, shot, label: shot, bytes: null, width: null, height: null })
const rev = (shots: Shot[]): RevisionRenders => ({
  revision: 'B', date: '2026-11-05', run: 'r', at: null, commit: null, case: null,
  palette: { source: 'neutral', base: '#000000', accent: '#000000', neutral: '#000000', background: ['#000000', '#000000'], logo: null },
  pictures: shots.map(pic),
})

describe('a revision\'s renders, in words', () => {
  it('counts the pictures and names the turntable apart', () => {
    expect(countWords(rev(['exploded', 'turntable', 'board-in-case', 'case', 'board', 'board-top', 'board-bottom']))).toBe('6 pictures and a turntable')
    expect(countWords(rev(['board', 'board-top', 'board-bottom']))).toBe('3 pictures')
    expect(countWords(rev(['board']))).toBe('1 picture')
    expect(countWords(rev(['turntable']))).toBe('a turntable')
  })

  it('names the zip from the pictures, whichever comes first', () => {
    expect(zipName(rev(['turntable', 'board']))).toBe('soil-sensor_rev-B_2026-11-05_renders.zip')
    expect(dayWords('2026-11-05')).toBe('5 Nov 2026')
  })
})
