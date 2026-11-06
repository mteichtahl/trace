/** An agent's words as a person reads them on a card (test-esp32 #25, #35): plain sentences, cut at a word, never mid-word. */
import { describe, expect, it } from 'vitest'
import { DRAFTING_HEADLINE, headlineOf } from '../../src/api/actions-jobs.js'
import { REQUIREMENTS_FROM_INTENT } from '../../src/api/drafting.js'
import { plainSummary, plainTitle } from '../../src/core/plain-words.js'

describe('plain words', () => {
  it('keeps the sentences that name none of the agent\'s internals, and drops stack frames', () => {
    const why = 'The board file does not load. kicad.load threw ENOENT at /work/board.kicad_pcb:\n    at Object.run (/app/dist/index.cjs:120:7)\nOpen it in KiCad 9 and save it once.'
    expect(plainSummary(why)).toEqual({ summary: 'The board file does not load. Open it in KiCad 9 and save it once.', same: false })
    // plain already: the same words, nothing behind them
    expect(plainSummary('The simulator is not installed here.')).toEqual({ summary: 'The simulator is not installed here.', same: true })
    // "e.g." and "3.3 V" are not the ends of sentences
    expect(plainSummary('Use a regulator, e.g. the AP2112K at 3.3 V. It fits.').summary).toBe('Use a regulator, e.g. the AP2112K at 3.3 V. It fits.')
  })

  it('takes the internals out of the first sentence when every sentence names one, and cuts at a word', () => {
    const out = plainSummary('docs_publish failed (job-mw2lhy11-952f6819) because `mmdc` exited.').summary
    expect(out).not.toMatch(/job-mw2|`/)
    const long = plainSummary(`${'word '.repeat(60)}end.`, { max: 50 }).summary
    expect(long.length).toBeLessThanOrEqual(50)
    expect(long).toMatch(/word…$/)
  })

  it('a job\'s card line is its first plain sentence, never a prompt cut off mid-word', () => {
    expect(plainTitle('Re-render the board. Use render.board { side: "top" } and attach the PNGs.')).toBe('Re-render the board')
    const cut = plainTitle(`Check ${'the flash rate and '.repeat(10)}report.`)
    expect(cut.length).toBeLessThanOrEqual(100)
    expect(cut).toMatch(/(?:the|flash|rate|and)…$/)
  })

  // test-esp32 #25: "Read the intent statements with the people's decisions (design.intent list): use the a"
  it('the drafting job reads as what it is for; a short title is left as it is', () => {
    const title = REQUIREMENTS_FROM_INTENT.replace(/\s+/g, ' ').trim().slice(0, 200)
    expect(title).toMatch(/use the a$/)
    expect(headlineOf({ kind: 'task', title, parentJob: null, payload: JSON.stringify({ kind: 'task', request: REQUIREMENTS_FROM_INTENT }) })).toEqual({ headline: DRAFTING_HEADLINE })
    expect(headlineOf({ kind: 'task', title, parentJob: null, payload: null })).toEqual({ headline: DRAFTING_HEADLINE })
    expect(headlineOf({ kind: 'task', title: 'Re-render the board', parentJob: null, payload: null })).toEqual({})
    expect(headlineOf({ kind: 'task', title: 'Re-render the board. Use render.board { side: "top" }.', parentJob: null, payload: null })).toEqual({ headline: 'Re-render the board' })
  })
})
