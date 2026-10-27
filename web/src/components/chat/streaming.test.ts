import { describe, expect, it } from 'vitest'
import { shapeOf } from './renderers'
import { closeStreaming } from './streaming'
import { spokenCommand } from './voice/dictation'
import { audioEvent, decodeMessage, encodeMessage, readTranscript } from './voice/eventstream'
import { domainOf, recordLink } from './markdown-impl'

describe('streaming markdown', () => {
  it('closes an open code fence', () => {
    expect(closeStreaming('Here:\n```c\nint a')).toBe('Here:\n```c\nint a\n```')
  })
  it('holds back an unfinished table row', () => {
    expect(closeStreaming('| a | b |\n| --- | --- |\n| 1 | 2')).toBe('| a | b |\n| --- | --- |')
  })
  it('closes bold', () => {
    expect(closeStreaming('**trace recommends')).toBe('**trace recommends**')
  })
  it('closes display maths', () => {
    expect(closeStreaming('$$\nx^2')).toBe('$$\nx^2\n$$')
  })
})

describe('links in messages', () => {
  it('record links become in-app addresses', () => {
    expect(recordLink('/p/acme~soil/requirements/R-014')).toEqual({ to: '/p/acme~soil/requirements/R-014' })
    expect(recordLink('trace:run/run_8f2c')).toEqual({ to: '/r/run/run_8f2c', label: 'run_8f2c' })
    expect(recordLink('https://x.com')).toBeNull()
    expect(recordLink('//evil.com')).toBeNull()
  })
  it('external links show their domain; others are not links', () => {
    expect(domainOf('https://www.ti.com/lit/ds/tlv755p.pdf')).toBe('ti.com')
    expect(domainOf('javascript:alert(1)')).toBe('')
  })
})

describe('tool call shapes', () => {
  it('draws by the result shape', () => {
    expect(shapeOf('sim.run', {}, { series: [], x: {}, y: {} })?.kind).toBe('plot')
    expect(shapeOf('kicad.erc', {}, { findings: [] })?.kind).toBe('findings')
    expect(shapeOf('parts.search', {}, { mpn: 'X' })?.kind).toBe('part')
    expect(shapeOf('files.read', {}, { path: 'a.pdf', size: 3 })?.kind).toBe('file')
    expect(shapeOf('kb.search', {}, { results: [] })).toBeNull()
  })
})

describe('voice', () => {
  it('event-stream frames round-trip and checksums hold', () => {
    const m = { headers: { ':event-type': 'AudioEvent', ':message-type': 'event' }, payload: new Uint8Array([1, 2, 3]) }
    const back = decodeMessage(encodeMessage(m))
    expect(back.headers).toEqual(m.headers)
    expect([...back.payload]).toEqual([1, 2, 3])
    const bad = encodeMessage(m)
    bad[bad.length - 6] ^= 0xff
    expect(() => decodeMessage(bad)).toThrow(/checksum/)
    expect(decodeMessage(audioEvent(new Uint8Array(4))).headers[':content-type']).toBe('application/octet-stream')
  })
  it('reads a TranscriptEvent', () => {
    const payload = new TextEncoder().encode(JSON.stringify({ Transcript: { Results: [{ Alternatives: [{ Transcript: 'move U4 left' }], IsPartial: true, ResultId: 'r1' }] } }))
    const r = readTranscript(encodeMessage({ headers: { ':event-type': 'TranscriptEvent', ':message-type': 'event' }, payload }))
    expect(r.results).toEqual([{ text: 'move U4 left', partial: true, resultId: 'r1' }])
  })
  it('spots spoken commands at the end', () => {
    expect(spokenCommand('move the antenna. Send.')).toEqual({ command: 'send', rest: 'move the antenna.' })
    expect(spokenCommand('read that again')).toEqual({ command: 'read-again', rest: '' })
    expect(spokenCommand('send the order to JLCPCB')).toBeNull()
  })
})
