/**
 * replay.video (docs/ontology-plan.md P8.5): the project's record as a film. The events (src/ontology/replay.ts) are
 * drawn one SVG frame each, headless (src/ontology/replay-video.ts), and ffmpeg encodes them to an H.264 MP4: here
 * when ffmpeg is installed, else as a CPU job on the tools function or the job queue (agent/Dockerfile.tools has
 * ffmpeg with librsvg). The film is a recorded run: replay.mp4 is its artifact, with its last frame as poster.svg.
 *
 * The record is read where the agents read it: the journey, the agents' facts and the job index from the project's
 * stores when a project is in scope (TRACE_PROJECT_HOME …), else the journey copy in the checkout's project database;
 * runs, requirements and results from the checkout's project database.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { AgentFactsStore, projectsBackend, projectsFromEnv } from '../../core/agent-facts.js'
import { JobIndexStore } from '../../core/job-index.js'
import { STAGE_NAMES, type StageId } from '../../core/journey-catalog.js'
import { loadJourney } from '../../core/journey.js'
import { JourneyStore } from '../../core/journey-store.js'
import { ToolError, defineTool } from '../../core/registry.js'
import { Work, projectPath, scratchDir } from '../../core/store.js'
import { backendFor, runJob } from '../../gpu/jobs.js'
import { journeyEvents } from '../../ontology/replay.js'
import { concatList, filmArgs, storyboard } from '../../ontology/replay-video.js'
import { runProgram } from '../kicad/project.js'
import { findFfmpeg } from '../render/blender.js'

/** A store's bytes opened read-only in `dir`, or null. */
function open(dir: string, name: string, bytes: Uint8Array | null): DatabaseSync | null {
  if (!bytes) return null
  writeFileSync(join(dir, name), bytes)
  return new DatabaseSync(join(dir, name), { readOnly: true })
}

/** Labels for the nodes the film names: the gates' stages, the criteria's own words; the rest by their ids. */
function labels(db: DatabaseSync | null): Map<string, string> {
  const out = new Map<string, string>()
  const r = db ? loadJourney(db) : null
  if (!r) return out
  for (const g of r.gates) out.set(`gate:${g.id}`, `${STAGE_NAMES[g.stage as StageId] ?? g.stage} gate`)
  for (const c of r.criteria) out.set(`criterion:${c.id}`, c.text)
  return out
}

/** The frames as an MP4: ffmpeg here, else a CPU job where ffmpeg is. */
async function encode(dir: string, names: string[], fps: number): Promise<Uint8Array> {
  const ff = findFfmpeg()
  if (ff) {
    const out = join(dir, 'replay.mp4')
    const r = await runProgram(ff, filmArgs(join(dir, 'list.txt'), fps, out), { timeoutMs: 1_800_000, cwd: dir })
    if (r.code !== 0 || !existsSync(out)) throw new ToolError(`ffmpeg could not encode the replay: ${(r.stderr || r.stdout).trim().slice(-500)}`)
    return readFileSync(out)
  }
  if (backendFor({ kind: 'ffmpeg' }) === 'local') throw new ToolError('replay.video: ffmpeg is not installed here, and there is no tools function or job queue to encode on')
  const r = await runJob({
    kind: 'ffmpeg', timeoutSeconds: 1800, outputs: ['replay.mp4'],
    inputs: Object.fromEntries(['list.txt', ...names].map((n) => [n, join(dir, n)])),
    argv: ['ffmpeg', ...filmArgs('{dir}/in/list.txt', fps, '{out:replay.mp4}')],
  })
  const got = r.outputs['replay.mp4']
  if (r.exitCode !== 0 || !got) throw new ToolError(`ffmpeg could not encode the replay: ${(r.stderr || r.stdout).trim().slice(-500)}`)
  try { return readFileSync(got) } finally { rmSync(got, { force: true }) }
}

export const video = defineTool({
  name: 'replay.video',
  description: 'The project\'s record as a film: from its intent to now, the graph growing one record a frame, each with who did what and from which record. Encoded to an H.264 MP4 (ffmpeg, a CPU job where it is not installed here) and stored as the run\'s artifact replay.mp4. Two minutes at 1280×720 by default.',
  input: z.object({
    seconds: z.number().min(10).max(600).default(120).describe('how long the film lasts'),
    width: z.number().int().min(640).max(1920).default(1280),
    height: z.number().int().min(360).max(1080).default(720),
    fps: z.number().int().min(12).max(60).default(30),
  }),
  run: async (a) => {
    const where = projectsFromEnv()
    const repository = where?.repository ?? process.env.GITHUB_REPOSITORY ?? 'local/project'
    const dbPath = projectPath()
    if (!existsSync(dbPath)) throw new ToolError('replay.video: there is no project record here (.trace/project.db)')
    const tmp = mkdtempSync(join(scratchDir('trace-replay-'), 'db-'))
    const work = new Work(dbPath)
    let id: string | null = null
    const frames = scratchDir('trace-replay-frames-')
    const dbs: (DatabaseSync | null)[] = []
    try {
      let journey: DatabaseSync | null = null, facts: DatabaseSync | null = null, jobs: DatabaseSync | null = null
      if (where) {
        const store = projectsBackend(where.projects)
        journey = open(tmp, 'journey.db', await new JourneyStore(store, where.repository).bytes())
        facts = open(tmp, 'facts.db', await new AgentFactsStore(store, where.repository).bytes())
        jobs = open(tmp, 'jobs.db', await new JobIndexStore(store, where.repository).bytes())
      }
      const project = new DatabaseSync(dbPath, { readOnly: true })
      dbs.push(journey, facts, jobs, project)
      const events = journeyEvents({ journey: journey ?? project, facts, jobs, project }, { installation: process.env.TRACE_PREFIX ?? 'trace', project: repository })
      if (!events.length) throw new ToolError('replay.video: nothing to replay yet: the project\'s journey has not started')
      const title = loadJourney(journey ?? project)?.journey.name || repository
      const board = storyboard(events, labels(journey ?? project), { title, seconds: a.seconds, width: a.width, height: a.height })
      for (const f of board) writeFileSync(join(frames, f.name), f.svg)
      writeFileSync(join(frames, 'list.txt'), concatList(board))

      id = work.start('replay.video', { subject: repository, args: a })
      const t0 = performance.now()
      const mp4 = await encode(frames, board.map((f) => f.name), a.fps)
      const seconds = Math.round((performance.now() - t0) / 100) / 10
      work.artifact(id, 'replay.mp4', mp4, 'video/mp4')
      work.artifact(id, 'poster.svg', board.at(-1)!.svg, 'image/svg+xml')
      work.measure(id, 'events', events.length, '')
      work.measure(id, 'length', a.seconds, 's')
      work.measure(id, 'encode_seconds', seconds, 's')
      work.measure(id, 'bytes', mp4.length, 'B')
      const summary = `${events.length} records in ${a.seconds} s, ${a.width}×${a.height} at ${a.fps} fps (${(mp4.length / 1e6).toFixed(1)} MB)`
      work.finish(id, 'pass', summary, { events: events.length, from: events[0]!.at, to: events.at(-1)!.at })
      return { run_id: id, artifact: 'replay.mp4', poster: 'poster.svg', events: events.length, seconds: a.seconds, size: mp4.length, summary }
    } catch (e) {
      if (id) work.finish(id, 'error', (e instanceof Error ? e.message : String(e)).slice(0, 300))
      throw e
    } finally {
      for (const d of dbs) d?.close()
      work.close()
      rmSync(tmp, { recursive: true, force: true })
      rmSync(frames, { recursive: true, force: true })
    }
  },
})
