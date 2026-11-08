/**
 * test-esp32 #88: numbers trace adds to a drafted requirement ("10 of 10 attempts", "1 ms resolution", "5 m line of
 * sight", "within 5 s") read like the person's own. Each must be marked "(inferred: …)" in the acceptance criterion;
 * verify.requirements lists the ones left unmarked, and the drafting request says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EARLIER_REQUESTS, REQUIREMENTS_FROM_INTENT, draftingJobs } from '../../src/api/drafting.js'
import type { JobRow } from '../../src/core/job-index.js'
import { allTools } from '../../src/tools/index.js'
import { unmarkedNote, unmarkedNumbers } from '../../src/tools/verify/inferred.js'

type Dict = Record<string, unknown>
const reg = allTools()
const call = async (name: string, args: Dict): Promise<Dict> => (await reg.call(name, args, { hardware: false, via: 'test' })) as Dict

// the run-2 intent, as the person gave it (test-esp32-e2e project.db)
const INTENT = [
  'Indoor desk, 0 to 40 degC, no condensation.',
  'USB-C 5 V (VBUS) only; at most 500 mA including Wi-Fi bursts; 3.3 V regulator rated at least 600 mA.',
  '(4) Wi-Fi 2.4 GHz 802.11 b/g/n on the module\'s PCB antenna, NTP in, HTTP on port 80.',
  'Screen and clock refresh at least once per second; Wi-Fi connects within 10 s of power-up; the message page responds within 1 s.',
  'Board at most 50 x 35 mm; two-part 3D-printed case at most 60 x 45 x 20 mm.',
]

describe('numbers trace chose, in an acceptance criterion', () => {
  it('the run-2 criteria: trace\'s own numbers are found, the person\'s are not', () => {
    expect(unmarkedNumbers('esptool enters download mode by DTR/RTS in 10 of 10 attempts; the circuit has 2 transistors driving EN and GPIO0.', INTENT)).toEqual(['10 of 10'])
    expect(unmarkedNumbers('Peak VBUS current measured at 5 V during Wi-Fi association is <= 500 mA (current probe, 1 ms resolution or better).', INTENT)).toEqual(['1 ms'])
    expect(unmarkedNumbers('The board associates with a 2.4 GHz 802.11n access point at 5 m line of sight.', INTENT)).toEqual(['5 m'])
    expect(unmarkedNumbers('After Wi-Fi connects, the board receives an NTP response and sets its clock within 5 s.', INTENT)).toEqual(['5 s'])
    // the person's: a range, a size, a time they gave; a bare number, a hex address, a net name are not quantities
    expect(unmarkedNumbers('All functional requirements pass at 0 degC and at 40 degC ambient.', INTENT)).toEqual([])
    expect(unmarkedNumbers('The board outline measures <= 50 mm x <= 35 mm.', INTENT)).toEqual([])
    expect(unmarkedNumbers('Time from VBUS applied to an IP address is <= 10 s; HTTP returns status 200 within 1 s on 0x3C, pin 2 = +3V3.', INTENT)).toEqual([])
  })

  it('a number marked inferred is not listed', () => {
    expect(unmarkedNumbers('sets its clock within 5 s (inferred: a typical NTP exchange).', INTENT)).toEqual([])
    expect(unmarkedNumbers('enters download mode in 10 of 10 attempts (inferred: a repeatable reset); 1 ms resolution.', INTENT)).toEqual(['1 ms'])
    expect(unmarkedNumbers('a current probe (inferred: 1 ms resolution, enough for Wi-Fi bursts).', INTENT)).toEqual([])
  })

  it('without an intent to compare with, nothing is said', () => {
    expect(unmarkedNote([{ id: 'REQ-1', acceptance: 'within 5 s' }], [])).toBeNull()
    expect(unmarkedNote([{ id: 'REQ-1', acceptance: 'within 5 s' }], INTENT)).toMatchObject({ requirements: [{ id: 'REQ-1', numbers: ['5 s'] }] })
  })
})

describe('verify.requirements lists the numbers left unmarked', () => {
  beforeEach(() => {
    for (const k of ['TRACE_PROJECT', 'TRACE_MEMORY_REPOSITORY', 'GITHUB_REPOSITORY', 'TRACE_PROJECT_HOME', 'TRACE_AGENT']) vi.stubEnv(k, '')
  })
  afterEach(() => { vi.unstubAllEnvs() })

  it('on add and on update, against the intent statements in the record', async () => {
    await call('design.intent', { action: 'add', statements: INTENT.map((text, i) => ({ id: `INT-${i}`, topic: 'performance', text })) })
    const added = await call('verify.requirements', { action: 'add', requirements: [
      { id: 'REQ-ntp', text: 'The board sets its clock from NTP.', kind: 'functional', acceptance: 'After Wi-Fi connects, the board sets its clock within 5 s.' },
      { id: 'REQ-boot', text: 'Wi-Fi connects soon after power-up.', kind: 'functional', acceptance: 'Wi-Fi connects within 10 s of power-up.' },
    ] })
    expect(added.unmarked_numbers).toMatchObject({ requirements: [{ id: 'REQ-ntp', numbers: ['5 s'] }], note: expect.stringMatching(/\(inferred: where it comes from\)/) })
    const fixed = await call('verify.requirements', { action: 'update', id: 'REQ-ntp', set: { acceptance: 'After Wi-Fi connects, the board sets its clock within 5 s (inferred: a typical NTP exchange).' } })
    expect(fixed.unmarked_numbers).toBeUndefined()
  })

  it('lists criteria without a number, as Requirements review would refuse them (test-esp32-run3 S3)', async () => {
    const added = await call('verify.requirements', { action: 'add', requirements: [
      { id: 'REQ-rtc', text: 'No clock chip that keeps time without power.', kind: 'functional', acceptance: 'The schematic and BOM contain no real-time clock chip (inspection).' },
      { id: 'REQ-hdr', text: 'A 4-pin display header.', kind: 'functional', acceptance: 'The board has exactly 4 header pins (inspection).' },
    ] })
    expect(added.without_number).toMatchObject({ ids: ['REQ-rtc'], note: expect.stringMatching(/0 real-time clock chips/) })
    const fixed = await call('verify.requirements', { action: 'update', id: 'REQ-rtc', set: { acceptance: 'The schematic and BOM contain 0 real-time clock chips (inspection).' } })
    expect(fixed.without_number).toBeUndefined()
  })
})

describe('the drafting request', () => {
  it('asks for every number trace chose to be marked, and still knows a job started with the earlier words', () => {
    expect(REQUIREMENTS_FROM_INTENT).toMatch(/\(inferred: where it comes from\)/)
    expect(REQUIREMENTS_FROM_INTENT).toMatch(/unmarked_numbers/)
    expect(REQUIREMENTS_FROM_INTENT).toMatch(/without_number/)
    const row = (request: string): JobRow => ({ id: 'j1', handle: null, session: null, kind: 'task', agent: 'verify', title: 't', number: null, requestedBySub: null, requestedBy: null, state: 'running', step: null, queuedAt: 1, startedAt: 1, endedAt: null, beatAt: 1, where: null, branch: null, parentJob: null, handoff: null, resumeOf: null, resumedBy: null, summary: null, error: null, payload: JSON.stringify({ kind: 'task', request }), claudeSession: null, pausedBy: null, pausedAt: null, tail: null, vitals: null, updatedAt: 1 })
    expect(draftingJobs([row(REQUIREMENTS_FROM_INTENT)])).toHaveLength(1)
    expect(EARLIER_REQUESTS[0]).not.toMatch(/inferred: where/)
    expect(draftingJobs([row(EARLIER_REQUESTS[0] as string)])).toHaveLength(1)
    expect(draftingJobs([row('Something else.')])).toHaveLength(0)
  })
})
