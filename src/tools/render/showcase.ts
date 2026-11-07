/**
 * render.showcase: a revision's photorealistic renders (docs/revision-renders.md). The board, the board from above
 * and below, the closed case, the board in the case and an exploded view, rendered by Blender (Cycles) from the board
 * kicad-cli exports and the case mech.build wrote (mechanical/out/case-base.stl and case-lid.stl, and the screws its
 * records name in case.jsonld), lit and backed with colours taken from the project's logo, or trace's neutral studio
 * look when it has none.
 *
 * Each picture is named <project>_rev-<revision>_<YYYY-MM-DD>_<shot>.png, the project's name taken from its record
 * (./subject.ts: the name given, the journey's, the KiCad project's, the repository's; the folder only as a last
 * resort), and kept as an artifact of one recorded run,
 * whose result (revision, date, palette, shots) the ontology reads as the revision's renders (src/ontology/renders.ts).
 * The run's inputs are the board file, the case files and the logo, so the pictures go out of date when any changes.
 *
 * Parts are drawn as fully as the record allows, and the result says what is not: a footprint without a body in
 * KiCad's 3D library gets its vendor's model (./model.ts, src/tools/kicad/vendor3d.ts); a case part beyond the base and
 * lid (an off-board module mech.build placed at its mount, mechanical/out/case-<part>.stl) is drawn with the part it
 * is mounted to; an off-board part the case does not place, and its cable, are listed as not drawn.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { normalisedHash } from '../../core/normalise.js'
import { logoPath } from '../../docs/logo.js'
import { defineTool, ToolError } from '../../core/registry.js'
import { findRoot, PROJECT_DB, projectPath, scratchDir, Work, type RunInput } from '../../core/store.js'
import { keepOutput } from '../../core/artifact-store.js'
import { backendFor } from '../../gpu/jobs.js'
import { needPcb, resolveProject } from '../kicad/project.js'
import { boardFacts } from '../mech/board.js'
import { CASE_JSON, OUT_DIR, readSettings } from '../mech/settings.js'
import { SHOTS, type Shot, shotExt } from '../../ontology/renders.js'
import { findBlender, pngSize, runBlender } from './blender.js'
import { defaultDevice, DeviceWant, probe, selectDevice } from './device.js'
import { type Bodies, commitOf, exportBoard, inRepo, type BoardFormat } from './model.js'
import { encodeMp4, freeName, RenderResult } from './tools.js'
import { type CasePart, extraCaseParts, offBoardDrawn, type OffBoardPart, recordFacts, showcaseName } from './subject.js'

export const CASE_SHOTS: readonly Shot[] = ['case', 'board-in-case', 'exploded']
export const BOARD_SHOTS: readonly Shot[] = ['board', 'board-top', 'board-bottom']
/** The turntable: the closed case (the board without one) turning once, an MP4 of `frames` frames at FPS. */
export const TURNTABLE_SHOTS: readonly Shot[] = ['turntable']
export const FPS = 24
export const CASE_FILES = { base: `${OUT_DIR}/case-base.stl`, lid: `${OUT_DIR}/case-lid.stl` } as const
/** The case's records (python/tracebridge/mech/records.py), which name its screws and where each goes. */
export const CASE_RECORDS = `${OUT_DIR}/case.jsonld`

/** A screw as the pictures show it: its size and length, and its mounting hole in the case frame (mm, y flipped). */
export interface ShowcaseScrew { ref: string; size: string; length_mm: number; x_mm: number; y_mm: number }

/**
 * The screws a built case holds the board with, from its records: each Fastener (size, length) and the MountingPoint
 * that names it (the hole's KiCad position). A case held by rests and lid posts has none.
 */
export function caseScrews(jsonld: unknown): ShowcaseScrew[] {
  const graph = Array.isArray(jsonld) ? jsonld : (jsonld as { '@graph'?: unknown } | null)?.['@graph']
  if (!Array.isArray(graph)) return []
  const nodes = graph.filter((n): n is Record<string, unknown> => !!n && typeof n === 'object')
  const fasteners = new Map(nodes.filter((n) => n['@type'] === 'Fastener' && typeof n['@id'] === 'string').map((n) => [n['@id'] as string, n]))
  const out: ShowcaseScrew[] = []
  for (const m of nodes.filter((n) => n['@type'] === 'MountingPoint')) {
    const f = fasteners.get(String((m.fastener as { '@id'?: unknown } | undefined)?.['@id'] ?? ''))
    const x = Number(m.positionX)
    const y = Number(m.positionY)
    const length = Number(f?.length)
    if (!f || typeof f.size !== 'string' || !/^M\d+(\.\d+)?$/.test(f.size) || !Number.isFinite(x) || !Number.isFinite(y) || !(length > 0)) continue
    out.push({ ref: String(m.reference ?? f['@id']), size: f.size, length_mm: length, x_mm: x, y_mm: -y })
  }
  return out
}

/**
 * The project's logo is the documentation module's (docs/scribe.md "Project logo", src/docs/logo.ts): one logo for the
 * documents and the pictures, uploaded in the project's settings and kept in the repository. The renders use the one
 * for light backgrounds. Blender reads a PNG itself; an SVG's colours are read from its fills and strokes here.
 */
export const LOGO_PATHS: readonly string[] = [logoPath('light', 'png'), logoPath('light', 'svg')]

/**
 * The colours an SVG paints with, most used first: fill, stroke and stop-color, as attributes or in style, in #rgb,
 * #rrggbb or rgb(). Each is weighted by how often it is used; none, transparent, currentColor and url() are not colours.
 */
export function svgColours(svg: string): { hex: string; uses: number }[] {
  const counts = new Map<string, number>()
  const add = (hex: string): void => { counts.set(hex, (counts.get(hex) ?? 0) + 1) }
  const re = /(?:fill|stroke|stop-color)\s*(?:=\s*["']|:\s*)\s*(#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\))/g
  for (const m of svg.matchAll(re)) {
    const v = (m[1] as string).toLowerCase()
    if (v.startsWith('rgb')) {
      const n = (v.match(/\d+/g) ?? []).map((x) => Math.min(255, Number(x)))
      add(`#${n.map((x) => x.toString(16).padStart(2, '0')).join('')}`)
    } else {
      add(v.length === 4 ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : v)
    }
  }
  return [...counts].map(([hex, uses]) => ({ hex, uses })).sort((a, b) => b.uses - a.uses || a.hex.localeCompare(b.hex))
}

/** Picture sizes: release quality by default, draft for a quick look. */
export const QUALITY = {
  release: { cpu: { width: 1920, height: 1200, samples: 128 }, gpu: { width: 2560, height: 1600, samples: 256 } },
  draft: { cpu: { width: 960, height: 600, samples: 24 }, gpu: { width: 1280, height: 800, samples: 48 } },
} as const

/**
 * The turntable's frames: smaller and with fewer samples than a picture (denoised, and a frame is seen for a 24th of a
 * second), so a release turntable on the GPU queue takes about as long as the pictures. Four seconds at 24 fps; half
 * that as a draft.
 */
export const TURNTABLE = {
  release: { frames: 96, cpu: { width: 1280, height: 800, samples: 24 }, gpu: { width: 1920, height: 1200, samples: 64 } },
  draft: { frames: 48, cpu: { width: 640, height: 400, samples: 8 }, gpu: { width: 960, height: 600, samples: 16 } },
} as const

const REVISION = /^[A-Z]{1,3}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** A file-name-safe project name: lower case, words joined by hyphens. */
export function projectSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
}

/** The picture's file name: <project>_rev-<revision>_<YYYY-MM-DD>_<shot>.png (the turntable's .mp4) */
export function shotName(project: string, revision: string, date: string, shot: Shot): string {
  return `${projectSlug(project)}_rev-${revision}_${date}_${shot}.${shotExt(shot)}`
}

/** Today's date (YYYY-MM-DD) in a time zone (an IANA name), UTC when none is given or it is not one. */
export function dayIn(at: Date, timeZone?: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
  } catch {
    return at.toISOString().slice(0, 10)
  }
}

/** The case's look in the pictures, from what it is made of (case.json's process). */
export function caseLook(p: { service?: string; process?: string; material?: string } | null | undefined): 'nylon' | 'resin' | 'black' | 'pla' | 'aluminium' {
  const proc = (p?.process ?? 'MJF').toUpperCase()
  const material = p?.material ?? ''
  if (p?.service === 'jlccnc' || proc === 'CNC' || proc === 'SLM') return 'aluminium'
  if (proc === 'SLA') return /black/i.test(material) ? 'black' : 'resin'
  if (proc === 'FDM') return /black/i.test(material) ? 'black' : 'pla'
  return /black|PAC/i.test(material) ? 'black' : 'nylon'
}

/** The case frame's board outline bounds [minX, minY, maxX, maxY] in mm (docs/enclosure-build.md: y flipped from KiCad). */
export function outlineBounds(outline: readonly (readonly [number, number])[] | readonly number[][]): [number, number, number, number] {
  const xs = outline.map((p) => Number(p[0]))
  const ys = outline.map((p) => -Number(p[1]))
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/** The project's name in its journey, when this checkout runs with the project in scope (the agents do). */
async function journeyName(): Promise<string | null> {
  try {
    const { journeyScope } = await import('../journey/tools.js')
    const { loadJourney } = await import('../../core/journey.js')
    const s = journeyScope()
    return (await s.journey.read((db) => loadJourney(db))).result?.journey.name?.trim() || null
  } catch {
    return null
  }
}

const ShowcaseResult = RenderResult.extend({
  turntable: z.object({ width: z.number(), height: z.number(), samples: z.number() }).nullable().optional(),
  palette: z.object({
    source: z.enum(['logo', 'neutral']), base: z.string(), accent: z.string(), neutral: z.string(), background: z.tuple([z.string(), z.string()]),
  }),
})

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour is #rrggbb')

export const showcase = defineTool({
  name: 'render.showcase',
  description: 'A revision\'s photorealistic renders (Blender Cycles): the board, the board from above and below, the closed case, the board in the case (screws seated) and an exploded view (screws lifted out), and a turntable video of the closed case (the board without a case) turning once, coloured from the project logo (neutral studio look without one), each named <project>_rev-<revision>_<date>_<shot>.png (the turntable .mp4). Case shots need mech.build\'s case files. Slow: minutes per shot on a CPU at release quality, the turntable longest. Stored as one run.',
  input: z.object({
    revision: z.string().regex(REVISION, 'a revision letter such as A or B').describe('the revision the pictures are of'),
    date: z.string().regex(DATE, 'YYYY-MM-DD').optional().describe('the day the revision was cut (default today, in time_zone)'),
    time_zone: z.string().max(64).optional().describe('IANA time zone for the default date (default UTC)'),
    project: z.string().optional().describe('path to a .kicad_pro/.kicad_pcb (or its folder); omit for the configured/only project'),
    project_name: z.string().min(1).max(120).optional().describe('the name the files carry (default: the project\'s name in its journey record, else the KiCad project\'s)'),
    shots: z.array(z.enum(SHOTS)).min(1).max(SHOTS.length).optional().describe('default: every board shot, the case shots when the project has a built case, and the turntable'),
    turntable_frames: z.number().int().min(8).max(360).optional().describe('the turntable\'s frames, one turn (default 96 at release, 48 as a draft; 24 a second)'),
    quality: z.enum(['release', 'draft']).default('release').describe('release: 2560×1600 at 256 samples on a GPU (1920×1200 at 128 on a CPU); draft: a quick look'),
    width: z.number().int().min(16).max(7680).optional().describe('every picture\'s and turntable frame\'s width (default by quality and device)'),
    height: z.number().int().min(16).max(4320).optional(),
    samples: z.number().int().min(1).max(4096).optional(),
    device: DeviceWant.optional().describe('auto (default): a GPU when there is one, else the CPU; gpu; cpu'),
    mask_color: hex.default('#1f6b3a').describe('solder mask colour'),
    silk_color: hex.default('#f2f2ec').describe('silkscreen colour'),
    board_model: z.string().optional().describe('a board model already exported (GLB), relative to the repository, instead of exporting it with kicad-cli'),
    out_dir: z.string().optional().describe('also write the pictures here (relative to the repository); existing files are never replaced'),
    timeout_s: z.number().int().min(10).max(6 * 3600).default(3 * 3600),
  }),
  run: async (a) => {
    const p = await resolveProject(a.project)
    const pcb = needPcb(p)
    const root = findRoot(p.dir) ?? p.dir
    // the project's record: the database the run is kept in, and the repository's own
    const facts0 = [projectPath(), join(root, PROJECT_DB)].map(recordFacts)
    const named = showcaseName({
      given: a.project_name, journey: (await journeyName()) ?? facts0.find((f) => f.journey)?.journey, kicad: p.name,
      repository: process.env.TRACE_PROJECT ?? process.env.GITHUB_REPOSITORY, folder: basename(resolve(root)),
    })
    const project = named.name
    const offBoard: OffBoardPart[] = facts0.find((f) => f.offBoard.length)?.offBoard ?? []
    const date = a.date ?? dayIn(new Date(), a.time_zone)
    const notes: string[] = []

    // the case, when mech.build has written one
    const base = join(root, CASE_FILES.base)
    const lid = join(root, CASE_FILES.lid)
    const hasCase = existsSync(base) && existsSync(lid)
    const shots = a.shots ?? [...BOARD_SHOTS, ...(hasCase ? CASE_SHOTS : []), ...TURNTABLE_SHOTS]
    const stills = shots.filter((s) => !TURNTABLE_SHOTS.includes(s))
    const spin = shots.includes('turntable')
    const frames = spin ? a.turntable_frames ?? TURNTABLE[a.quality].frames : 0
    if (!hasCase && shots.some((s) => CASE_SHOTS.includes(s))) {
      throw new ToolError(`the case shots need the case's files (${CASE_FILES.base} and ${CASE_FILES.lid}): build the case with mech.build first`)
    }
    let look: ReturnType<typeof caseLook> = 'nylon'
    if (hasCase) {
      try { look = caseLook(readSettings(root)?.process) } catch (e) { notes.push(`${CASE_JSON} could not be read (${e instanceof Error ? e.message : String(e)}): the case is shown in grey nylon`) }
    }
    if (!hasCase && !a.shots) notes.push('the project has no built case (mech.build): board shots only')
    // the screws, when the board is screwed down: seated in the open case, lifted out of their holes in the exploded view
    const recordsPath = join(root, CASE_RECORDS)
    let screws: ShowcaseScrew[] = []
    let extras: (CasePart & { drawn: boolean; file: string })[] = []
    if (hasCase && existsSync(recordsPath)) {
      try {
        const jsonld = JSON.parse(readFileSync(recordsPath, 'utf8'))
        screws = caseScrews(jsonld)
        // the case's other parts (an off-board module at its mount), drawn when mech.build wrote their files
        extras = extraCaseParts(jsonld).map((c) => {
          const file = join(root, OUT_DIR, `case-${c.kind}.stl`)
          return { ...c, file, drawn: existsSync(file) }
        })
      } catch (e) { notes.push(`${CASE_RECORDS} could not be read (${e instanceof Error ? e.message : String(e)}): no screws shown`) }
    } else if (hasCase) {
      notes.push(`${CASE_RECORDS} is not there (build the case again with mech.build): no screws shown`)
    }
    const drawnExtras = extras.filter((c) => c.drawn)
    const offBoardSeen = offBoardDrawn(offBoard, hasCase ? extras : [])
    for (const c of extras.filter((x) => !x.drawn && !offBoardSeen.not_drawn.some((n) => n.why.includes(`case-${x.kind}.stl`)))) {
      offBoardSeen.not_drawn.push({ part: `case part ${c.kind}`, why: `${OUT_DIR}/case-${c.kind}.stl is not there (build the case again with mech.build)` })
    }
    if (offBoardSeen.not_drawn.length) notes.push(`not drawn: ${offBoardSeen.not_drawn.map((n) => `${n.part} (${n.why})`).join('; ')}`)

    // the project's logo (the documentation module's): a PNG Blender reads, or an SVG whose colours are read here
    const logoRel = LOGO_PATHS.find((l) => existsSync(join(root, l))) ?? null
    const svg = logoRel?.endsWith('.svg') ? svgColours(readFileSync(join(root, logoRel), 'utf8')) : null
    if (svg && !svg.length) notes.push(`${logoRel} names no colours trace can read (fills and strokes): neutral colours used`)

    // where the board sits in the case: its outline's bounds, from the board file alone
    const facts = boardFacts(pcb, root)
    const bounds = outlineBounds(facts.outline as number[][])

    // fail early, before exporting anything, when the machine that would render cannot do what was asked
    const want = a.device ?? defaultDevice()
    const where = backendFor({ kind: 'blender', gpu: true })
    if (where === 'function' && want === 'gpu') throw new ToolError('this installation has no GPU queue, so renders run on the tools function, which has no graphics card: use device=cpu or auto')
    if (where === 'local' && want === 'gpu') {
      if (!findBlender()) throw new ToolError('Blender is not installed here (or set TRACE_BLENDER to its path)')
      const pr = await probe()
      if (pr) selectDevice(pr.devices, 'gpu')
    }

    const commit = commitOf(root)
    const work = new Work()
    const names = Object.fromEntries(shots.map((s) => [s, shotName(project, a.revision, date, s)])) as Record<Shot, string>
    const id = work.start('render.showcase', { subject: pcb, args: a, ...(commit ? { gitSha: commit } : {}) })
    const tmp = scratchDir('trace-showcase-')
    try {
      // what the pictures are made from, for freshness (src/ontology/lineage.ts)
      const rel = (abs: string): string => abs.startsWith(resolve(root)) ? resolve(abs).slice(resolve(root).length + 1) : abs
      const fileInput = (abs: string): RunInput => ({ kind: 'file', ref: rel(abs), sha256: normalisedHash(rel(abs), readFileSync(abs)) })
      work.inputs(id, [fileInput(pcb), ...(hasCase ? [fileInput(base), fileInput(lid)] : []), ...drawnExtras.map((c) => fileInput(c.file)), ...(screws.length || drawnExtras.length ? [fileInput(recordsPath)] : []), ...(logoRel ? [fileInput(join(root, logoRel))] : [])])

      // the board's model: exported by kicad-cli (GLB), or one handed in
      let model: { path: string; format: string; note?: string; bodies?: Bodies }
      if (a.board_model) {
        const m = inRepo(a.board_model)
        if (!existsSync(m) || !/\.glb$/i.test(m)) throw new ToolError(`${a.board_model}: board_model must be an existing .glb`)
        model = { path: m, format: 'glb' }
      } else {
        model = await exportBoard(pcb, tmp, 'glb' as BoardFormat)
        if (model.note) notes.push(model.note)
      }
      const inputs: Record<string, string> = { 'board.glb': model.path }
      const args = ['{in:board.glb}']
      if (hasCase) { inputs['base.stl'] = base; inputs['lid.stl'] = lid; args.push('{in:base.stl}', '{in:lid.stl}') }
      // the case's other parts come after the lid, the logo last (python/blender/render_showcase.py)
      for (const c of hasCase ? drawnExtras : []) { inputs[`part-${c.kind}.stl`] = c.file; args.push(`{in:part-${c.kind}.stl}`) }
      if (logoRel && !svg) { inputs['logo.png'] = join(root, logoRel); args.push('{in:logo.png}') }
      const outs = stills.map((s) => names[s])
      const frameOuts = Array.from({ length: frames }, (_, i) => `turntable_${String(i + 1).padStart(4, '0')}.png`)
      const q = QUALITY[a.quality]
      const job = {
        // the turntable's frames come after every picture (python/blender/render_showcase.py)
        shots: [...stills, ...(spin ? ['turntable'] : [])], board_xy_mm: bounds, format: model.format, up_axis: 'Z',
        ...(hasCase ? { case: { look } } : {}), ...(drawnExtras.length ? { extra_parts: drawnExtras.map((c) => c.kind) } : {}), ...(screws.length ? { fasteners: screws } : {}), ...(logoRel && !svg ? { logo: true } : {}), ...(svg?.length ? { logo_colours: svg.slice(0, 32).map((c) => [c.hex, c.uses]) } : {}),
        mask_color: a.mask_color, silk_color: a.silk_color,
        ...(a.width ? { width: a.width } : {}), ...(a.height ? { height: a.height } : {}), ...(a.samples ? { samples: a.samples } : {}),
        defaults: q, denoise: true, device: want, engine: 'cycles',
        ...(spin ? { turntable: { frames, defaults: { cpu: TURNTABLE[a.quality].cpu, gpu: TURNTABLE[a.quality].gpu } } } : {}),
      }
      const run = await runBlender({
        script: 'render_showcase.py', job, gpu: true, timeoutSeconds: a.timeout_s, inputs,
        args: [...args, ...[...outs, ...frameOuts].map((o) => `{out:${o}}`)], outputs: [...outs, ...frameOuts], schema: ShowcaseResult,
      })
      try {
        const r = run.result
        notes.push(...r.notes)
        const statOf = new Map(r.images.map((im) => [im.view, im]))
        const artifacts: { name: string; shot: Shot; bytes: number; width?: number; height?: number; frames?: number; fps?: number }[] = []
        const bytesOf = new Map<string, Uint8Array>()
        let blank = 0
        for (const s of stills) {
          const f = run.outputs[names[s]]
          if (!f) throw new ToolError(`Blender did not write ${names[s]}`)
          const data = readFileSync(f)
          if ((statOf.get(s)?.std ?? 1) < 0.002) blank++
          // release-quality pictures are large: the installation's storage, not the run record in git (src/core/artifact-store.ts)
          await keepOutput(work, id, names[s], data, 'image/png')
          artifacts.push({ name: names[s], shot: s, bytes: data.length, ...(pngSize(data) ?? {}) })
          bytesOf.set(names[s], data)
        }
        if (spin) {
          const paths = frameOuts.map((n) => run.outputs[n]).filter((x): x is string => typeof x === 'string')
          if (paths.length !== frames) throw new ToolError(`Blender wrote ${paths.length} of ${frames} turntable frames`)
          // a turntable that is blank in its first frame is blank throughout: the subject is the same, turned
          if ((statOf.get('turntable_0001')?.std ?? 1) < 0.002) blank++
          const mp4 = await encodeMp4(paths, FPS, tmp)
          if (!mp4) {
            notes.push('ffmpeg is not installed where the frames were rendered or here: no turntable video')
          } else {
            await keepOutput(work, id, names.turntable, mp4, 'video/mp4')
            const t = r.turntable
            artifacts.push({ name: names.turntable, shot: 'turntable', bytes: mp4.length, ...(t ? { width: t.width, height: t.height } : {}), frames, fps: FPS })
            bytesOf.set(names.turntable, mp4)
          }
        }
        if (blank) notes.push(`${blank} picture(s) look blank (almost no variation): check the board and case models`)
        let written: string[] | undefined
        if (a.out_dir) {
          const dir = resolve(inRepo(a.out_dir))
          mkdirSync(dir, { recursive: true })
          written = artifacts.map((x) => {
            const target = freeName(dir, x.name)
            writeFileSync(target, bytesOf.get(x.name) as Uint8Array, { flag: 'wx' })
            return target
          })
        }
        const video = artifacts.some((x) => x.shot === 'turntable')
        const dev = r.render.device
        const renderSeconds = Math.round(r.images.reduce((s, im) => s + im.seconds, 0) * 10) / 10
        work.measure(id, 'render_seconds', renderSeconds, 's')
        work.measure(id, 'device_gpu', dev.gpu ? 1 : 0, '', { type: dev.type, names: dev.names })
        work.measure(id, 'samples', r.render.samples, '')
        work.measure(id, 'width', r.render.width, 'px')
        work.measure(id, 'height', r.render.height, 'px')
        const palette = { ...r.palette, ...(logoRel && r.palette.source === 'logo' ? { logo: { path: logoRel, sha256: normalisedHash(logoRel, readFileSync(join(root, logoRel))) } } : {}) }
        const result = {
          run_id: id,
          revision: a.revision,
          date,
          name: named,
          palette,
          shots: Object.fromEntries(artifacts.map((x) => [x.name, x.shot])),
          artifacts,
          ...(written ? { written } : {}),
          device: { type: dev.type, gpu: dev.gpu, name: dev.names.join(', ') },
          where: run.where,
          ...(run.jobId ? { job_id: run.jobId } : {}),
          render: { width: r.render.width, height: r.render.height, samples: r.render.samples, denoiser: r.render.denoiser },
          ...(video && r.turntable ? { turntable: { ...r.turntable, frames, fps: FPS, seconds: Math.round((frames / FPS) * 10) / 10 } } : {}),
          render_seconds: renderSeconds,
          case: hasCase ? { look, screws: screws.map((x) => `${x.size}x${x.length_mm}`), parts: drawnExtras.map((c) => c.kind) } : null,
          // the parts drawn without a body, those drawn with their vendor's model, and what is off the board
          bodies: model.bodies ?? { vendor: [], missing: [] },
          off_board: offBoardSeen,
          commit,
          blender: r.blender,
          notes,
        }
        const summary = `revision ${a.revision} (${date}): ${stills.length} picture(s) ${r.render.width}x${r.render.height}, ${r.render.samples} samples${video ? `, a ${frames}-frame turntable` : ''}, ${dev.type}, ${renderSeconds} s, ${palette.source === 'logo' ? 'colours from the logo' : 'neutral colours'}`
        work.finish(id, blank ? 'fail' : 'pass', summary, result)
        return result
      } finally {
        run.cleanup()
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      work.finish(id, 'error', msg.slice(0, 300))
      if (e instanceof ToolError) throw new ToolError(`${msg} (run ${id})`)
      throw e
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      work.close()
    }
  },
})
