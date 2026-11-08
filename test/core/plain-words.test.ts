/** An agent's words as a person reads them on a card (test-esp32 #25, #35): plain sentences, cut at a word, never mid-word. */
import { describe, expect, it } from 'vitest'
import { DRAFTING_HEADLINE, headlineOf } from '../../src/api/actions-jobs.js'
import { REQUIREMENTS_FROM_INTENT } from '../../src/api/drafting.js'
import { stillWorking } from '../../src/api/pending-changes.js'
import { titleOf as queuedTitleOf } from '../../src/api/agent-queue.js'
import { reopenHeadline, scopedRequest } from '../../src/api/reopen-scope.js'
import { titleOf } from '../../src/agents/runtime/job-index.js'
import type { JobRow } from '../../src/core/job-index.js'
import { jobHeadline, plainLine, plainSummary, plainTitle, shownJobTitle } from '../../src/core/plain-words.js'

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
    // a brief that opens with where the project stands (test-esp32-run2 R48)
    expect(plainTitle('The schematic is proven (design proven gate signed). Lay out the 2-layer board for the wifi desk clock.')).toBe('Lay out the 2-layer board for the wifi desk clock')
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

  // test-esp32 #196 (after #164, #189): the scoped reopen's job showed its prompt, "… only par", on the Sign-off gate
  // page and the Overview's job card: it gave no title, and the index took the request's first 200 characters
  describe('a job\'s title is its headline, wherever it was started', () => {
    const scope = { stage: 'signoff' as const, kept: false, why: 'Prove is done again', reach: [] }
    const request = scopedRequest('Write the release report.', scope, ['REQ-4ce9e8', 'REQ-f3f79d'], { edits: { 'REQ-4ce9e8': ['words'], 'REQ-f3f79d': ['words'] } })
    const raw = request.replace(/\s+/g, ' ').trim().slice(0, 200)

    it('the scoped reopen names its job by what it does', () => {
      expect(raw).toMatch(/only par$/)
      expect(reopenHeadline('signoff', false)).toBe('Sign-off: redo what the requirement change reaches')
      expect(reopenHeadline('capture', true)).toBe('Capture: finish what is left after the requirement change')
      expect(titleOf({ kind: 'task', repository: 'acme/x', request, headline: reopenHeadline('signoff', false), requestedBy: 'a@example.com' })).toBe('Sign-off: redo what the requirement change reaches')
      expect(queuedTitleOf(request, reopenHeadline('signoff', false))).toBe('Sign-off: redo what the requirement change reaches')
    })

    it('a start that gives none is titled by its first plain sentence, cut at a word, never mid-word', () => {
      for (const t of [titleOf({ kind: 'task', repository: 'acme/x', request, requestedBy: 'a@example.com' }), queuedTitleOf(request), jobHeadline({ request })]) {
        expect(t).not.toMatch(/only par/)
        expect(t.length).toBeLessThanOrEqual(100)
        expect(t).toMatch(/^Sign-off is open again because requirements changed after the baseline/)
        expect(t).toMatch(/(?:…|[a-z)])$/)
      }
    })

    it('a row written with the prompt as its title is shown by its headline, or its first plain sentence', () => {
      const row = (payload: object | null): JobRow => ({ id: 'j1', handle: null, session: null, kind: 'task', agent: 'impl', title: raw, number: null, requestedBySub: null, requestedBy: null, state: 'running', step: null, queuedAt: 1, startedAt: Date.now() / 1000, endedAt: null, beatAt: Date.now() / 1000, where: null, branch: null, parentJob: null, handoff: null, resumeOf: null, resumedBy: null, summary: null, error: null, payload: payload ? JSON.stringify(payload) : null, claudeSession: null, pausedBy: null, pausedAt: null, tail: null, vitals: null, updatedAt: 1 })
      expect(shownJobTitle(row({ kind: 'task', request, headline: 'Sign-off: redo what the requirement change reaches' }))).toBe('Sign-off: redo what the requirement change reaches')
      expect(shownJobTitle(row(null))).not.toMatch(/only par/)
      // what the gate page's "What is pending" and the Overview's locked step name it by
      expect(stillWorking([row({ kind: 'task', request, headline: 'Sign-off: redo what the requirement change reaches' })]).map((w) => w.title)).toEqual(['Sign-off: redo what the requirement change reaches'])
      expect(stillWorking([row(null)])[0]!.title).not.toMatch(/only par/)
      expect(headlineOf({ kind: 'task', title: raw, parentJob: null, payload: JSON.stringify({ kind: 'task', request, headline: 'Sign-off: redo what the requirement change reaches' }) }))
        .toEqual({ headline: 'Sign-off: redo what the requirement change reaches' })
      // a title that is a headline already is left as it is
      expect(shownJobTitle({ title: 'Re-render the board', payload: null })).toBe('Re-render the board')
    })
  })
})

// test-esp32 #170: the Overview read "the Implementation specialist is stuck: Also: the module datasheet…": every
// sentence before the aside cited a check's id, so the aside was the only plain one and the main point was dropped
describe('a stuck report leads with its point', () => {
  const why = 'architect.stock is not met (shape_check 52b9eb5d36ae4a0d) on one key part only: the off-board OLED module SSD1306-0.96-OLED-128x64-I2C-module. The newer architect.mapped shape needs it in the oled block as an off-board key part with its size (now met, shape_check 91b38f54a251488d), and every key part is then stock-checked. No configured supplier lists a 0.96 in SSD1306 module (parts_search on LCSC: only C9900302173, 0 in stock, no pinout; bom_check d908622df9f947c7: not found). Every board part is in stock for 10 boards (bom_check 1b4a0c446d474f70, 45.16 USD). Also: the module datasheet the case is sized from (sha256 ea9a571f, p2) lists pin 1 VCC and pin 2 GND, the reverse of J2\'s GND-first order (project rule), so the module bought must be GND first, or its 4-wire cable must swap pins 1 and 2.'

  it('drops the brackets that cite internals and keeps the sentence', () => {
    const { summary } = plainSummary(why)
    expect(summary).toMatch(/^No configured supplier lists a 0\.96 in SSD1306 module\. Every board part is in stock for 10 boards\./)
    expect(summary).not.toMatch(/^Also/)
    expect(summary).not.toMatch(/bom_check|parts_search|shape_check|architect\./)
  })

  it('an aside never leads, and plain brackets stay', () => {
    expect(plainSummary('Also: the cable is short. The module is not stocked anywhere.').summary).toBe('The module is not stocked anywhere. Also: the cable is short.')
    expect(plainSummary('Use the header (GND first). It fits.').summary).toBe('Use the header (GND first). It fits.')
    expect(plainSummary('Also: the cable is short.').summary).toBe('Also: the cable is short.')
  })
})

// test-esp32 #24: a change's "What trace did" line by line
describe('plainLine', () => {
  it('keeps what a person reads, without the agent\'s internals', () => {
    expect(plainLine('Drew the power sheet (kicad_erc run 3f2a9c1d4e5f6071).')).toBe('Drew the power sheet.')
    expect(plainLine('New figure `docs/design/figures/timing-i2c.svg`, from the protocol model.')).toBe('New figure `docs/design/figures/timing-i2c.svg`, from the protocol model.')
    expect(plainLine('changed_since: false, flags: []')).toBeNull()
    expect(plainLine('The worker job had nothing to commit. Wrote the guide.')).toBe('Wrote the guide.')
    expect(plainLine('Bold marks the values I added.')).toBeNull()
  })
})
