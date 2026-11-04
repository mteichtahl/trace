/**
 * replay.video (plan P8.5): the record filmed headless, encoded with ffmpeg, stored as the run's artifact. The exit
 * check: a two-minute MP4 that plays.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadJourney, recordOpen, setCriterion, signGate, startJourney } from '../../../src/core/journey.js'
import { Work, openProject } from '../../../src/core/store.js'
import { concatList, finalGraph, layout, storyboard } from '../../../src/ontology/replay-video.js'
import { journeyEvents } from '../../../src/ontology/replay.js'
import { findFfmpeg } from '../../../src/tools/render/blender.js'
import { video } from '../../../src/tools/journey/video.js'

const dir = mkdtempSync(join(tmpdir(), 'trace-video-'))
const SIGNER = { hash: 'a'.repeat(16), label: 'marc@example.com' }
const env = { ...process.env }

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-01T09:00:00Z'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'marc@example.com', name: 'Soil sensor' })
  for (const c of loadJourney(db)!.criteria.filter((x) => x.gate === 'define')) {
    vi.setSystemTime(Date.now() + 3_600_000)
    setCriterion(db, c.id, 'met', [{ kind: 'run', ref: `run-${c.id}` }], c.owner === 'trace' ? 'trace' : SIGNER.label)
    recordOpen(db, { criterion: c.id }, SIGNER.hash)
  }
  vi.setSystemTime(Date.now() + 3_600_000)
  signGate(db, 'define', SIGNER)
  db.close()
  vi.useRealTimers()
  for (const k of ['TRACE_PROJECT', 'TRACE_MEMORY_REPOSITORY', 'GITHUB_REPOSITORY']) delete process.env[k]
  process.env.TRACE_PROJECT_DB = join(dir, '.trace', 'project.db')
})
afterAll(() => { process.env = env; rmSync(dir, { recursive: true, force: true }) })

describe('the replay film', () => {
  it('lays out the same way every time, inside the frame', () => {
    const db = openProject(dir)
    const events = journeyEvents({ journey: db, project: db }, { installation: 'trace', project: 'acme/soil' })
    db.close()
    const g = finalGraph(events)
    expect(g.nodes).toContain('gate:define')
    const a = layout(g.nodes, g.links), b = layout(g.nodes, g.links)
    expect([...a]).toEqual([...b])
    for (const p of a.values()) { expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(1) }
    const frames = storyboard(events, new Map(), { title: 'Soil sensor', seconds: 120, width: 640, height: 360 })
    expect(frames).toHaveLength(events.length + 2)
    expect(frames.reduce((s, f) => s + f.seconds, 0)).toBeCloseTo(120, 1)
    expect(frames.some((f) => f.svg.includes('The journey started'))).toBe(true)
    expect(frames.at(-1)!.svg).toContain('>define<')
    expect(concatList(frames).split('\n').filter((l) => l.startsWith('file')).length).toBe(frames.length + 1)
  })

  it.skipIf(!findFfmpeg())('films the record as a two-minute MP4 that plays, stored as the run\'s artifact', async () => {
    const r = await video.run({ seconds: 120, width: 640, height: 360, fps: 12 }) as { run_id: string; events: number; size: number }
    expect(r.events).toBeGreaterThan(3)
    const w = new Work(process.env.TRACE_PROJECT_DB)
    const mp4 = w.getArtifact(r.run_id, 'replay.mp4')
    const run = w.run(r.run_id)
    w.close()
    expect(run?.status).toBe('pass')
    expect(mp4?.length).toBe(r.size)
    const f = join(dir, 'replay.mp4')
    writeFileSync(f, mp4!)
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height', '-of', 'json', f]).toString())
    expect(Number(probe.format.duration)).toBeCloseTo(120, 0)
    expect(probe.streams[0]).toMatchObject({ codec_name: 'h264', width: 640, height: 360 })
    // it plays: every frame decodes
    execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-'])
  }, 180_000)
})
