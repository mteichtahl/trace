/**
 * render.showcase: a revision's photorealistic renders (docs/revision-renders.md). The board, the board from above
 * and below, the closed case, the board in the case and an exploded view, rendered by Blender (Cycles) from the board
 * kicad-cli exports and the case mech.build wrote (mechanical/out/case-base.stl and case-lid.stl), lit and backed with
 * colours taken from the project's logo, or trace's neutral studio look when it has none.
 *
 * Each picture is named <project>_rev-<revision>_<YYYY-MM-DD>_<shot>.png and kept as an artifact of one recorded run,
 * whose result (revision, date, palette, shots) the ontology reads as the revision's renders (src/ontology/renders.ts).
 * The run's inputs are the board file, the case files and the logo, so the pictures go out of date when any changes.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { normalisedHash } from '../../core/normalise.js'
import { defineTool, ToolError } from '../../core/registry.js'
import { findRoot, scratchDir, Work, type RunInput } from '../../core/store.js'
import { backendFor } from '../../gpu/jobs.js'
import { needPcb, resolveProject } from '../kicad/project.js'
import { boardFacts } from '../mech/board.js'
import { CASE_JSON, OUT_DIR, readSettings } from '../mech/settings.js'
import { SHOTS, type Shot } from '../../ontology/renders.js'
import { findBlender, pngSize, runBlender } from './blender.js'
import { defaultDevice, DeviceWant, probe, selectDevice } from './device.js'
import { commitOf, exportBoard, inRepo, type BoardFormat } from './model.js'
import { freeName, RenderResult } from './tools.js'

export const CASE_SHOTS: readonly Shot[] = ['case', 'board-in-case', 'exploded']
export const BOARD_SHOTS: readonly Shot[] = ['board', 'board-top', 'board-bottom']
export const CASE_FILES = { base: `${OUT_DIR}/case-base.stl`, lid: `${OUT_DIR}/case-lid.stl` } as const

/**
 * Where the project's logo is looked for, first found wins. The documentation module's logo (docs/scribe.md "Project
 * logo") is the one logo of a project; its upload saves it here. Blender reads PNG, JPEG and WebP; an SVG logo needs
 * a PNG copy beside it for its colours to be read.
 */
export const LOGO_PATHS = ['.trace/brand/logo.png', '.trace/brand/logo.webp', '.trace/brand/logo.jpg', '.trace/brand/logo.jpeg'] as const
const SVG_LOGO = '.trace/brand/logo.svg'

/** Picture sizes: release quality by default, draft for a quick look. */
export const QUALITY = {
  release: { cpu: { width: 1920, height: 1200, samples: 128 }, gpu: { width: 2560, height: 1600, samples: 256 } },
  draft: { cpu: { width: 960, height: 600, samples: 24 }, gpu: { width: 1280, height: 800, samples: 48 } },
} as const

const REVISION = /^[A-Z]{1,3}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** A file-name-safe project name: the repository's folder, lower case, words joined by hyphens. */
export function projectSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
}

/** The picture's file name: <project>_rev-<revision>_<YYYY-MM-DD>_<shot>.png */
export function shotName(project: string, revision: string, date: string, shot: Shot): string {
  return `${projectSlug(project)}_rev-${revision}_${date}_${shot}.png`
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

const ShowcaseResult = RenderResult.extend({
  palette: z.object({
    source: z.enum(['logo', 'neutral']), base: z.string(), accent: z.string(), neutral: z.string(), background: z.tuple([z.string(), z.string()]),
  }),
})

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour is #rrggbb')

export const showcase = defineTool({
  name: 'render.showcase',
  description: 'A revision\'s photorealistic renders (Blender Cycles): the board, the board from above and below, the closed case, the board in the case and an exploded view, coloured from the project logo (neutral studio look without one), each named <project>_rev-<revision>_<date>_<shot>.png. Case shots need mech.build\'s case files. Slow: minutes per shot on a CPU at release quality. Stored as one run.',
  input: z.object({
    revision: z.string().regex(REVISION, 'a revision letter such as A or B').describe('the revision the pictures are of'),
    date: z.string().regex(DATE, 'YYYY-MM-DD').optional().describe('the day the revision was cut (default today, in time_zone)'),
    time_zone: z.string().max(64).optional().describe('IANA time zone for the default date (default UTC)'),
    project: z.string().optional().describe('path to a .kicad_pro/.kicad_pcb (or its folder); omit for the configured/only project'),
    shots: z.array(z.enum(SHOTS)).min(1).max(6).optional().describe('default: every board shot, and the case shots when the project has a built case'),
    quality: z.enum(['release', 'draft']).default('release').describe('release: 2560×1600 at 256 samples on a GPU (1920×1200 at 128 on a CPU); draft: a quick look'),
    width: z.number().int().min(16).max(7680).optional(),
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
    const project = basename(resolve(root))
    const date = a.date ?? dayIn(new Date(), a.time_zone)
    const notes: string[] = []

    // the case, when mech.build has written one
    const base = join(root, CASE_FILES.base)
    const lid = join(root, CASE_FILES.lid)
    const hasCase = existsSync(base) && existsSync(lid)
    const shots = a.shots ?? [...BOARD_SHOTS, ...(hasCase ? CASE_SHOTS : [])]
    if (!hasCase && shots.some((s) => CASE_SHOTS.includes(s))) {
      throw new ToolError(`the case shots need the case's files (${CASE_FILES.base} and ${CASE_FILES.lid}): build the case with mech.build first`)
    }
    let look: ReturnType<typeof caseLook> = 'nylon'
    if (hasCase) {
      try { look = caseLook(readSettings(root)?.process) } catch (e) { notes.push(`${CASE_JSON} could not be read (${e instanceof Error ? e.message : String(e)}): the case is shown in grey nylon`) }
    }
    if (!hasCase && !a.shots) notes.push('the project has no built case (mech.build): board shots only')

    // the logo, when there is one Blender can read
    const logoRel = LOGO_PATHS.find((l) => existsSync(join(root, l))) ?? null
    if (!logoRel && existsSync(join(root, SVG_LOGO))) notes.push(`${SVG_LOGO} is an SVG, whose colours Blender cannot read: add a PNG copy as .trace/brand/logo.png; neutral colours used`)

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
      work.inputs(id, [fileInput(pcb), ...(hasCase ? [fileInput(base), fileInput(lid)] : []), ...(logoRel ? [fileInput(join(root, logoRel))] : [])])

      // the board's model: exported by kicad-cli (GLB), or one handed in
      let model: { path: string; format: string; note?: string }
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
      if (logoRel) { const ext = logoRel.slice(logoRel.lastIndexOf('.')); inputs[`logo${ext}`] = join(root, logoRel); args.push(`{in:logo${ext}}`) }
      const outs = shots.map((s) => names[s])
      const q = QUALITY[a.quality]
      const job = {
        shots, board_xy_mm: bounds, format: model.format, up_axis: 'Z',
        ...(hasCase ? { case: { look } } : {}), ...(logoRel ? { logo: true } : {}),
        mask_color: a.mask_color, silk_color: a.silk_color,
        ...(a.width ? { width: a.width } : {}), ...(a.height ? { height: a.height } : {}), ...(a.samples ? { samples: a.samples } : {}),
        defaults: q, denoise: true, device: want, engine: 'cycles',
      }
      const run = await runBlender({
        script: 'render_showcase.py', job, gpu: true, timeoutSeconds: a.timeout_s, inputs,
        args: [...args, ...outs.map((o) => `{out:${o}}`)], outputs: outs, schema: ShowcaseResult,
      })
      try {
        const r = run.result
        notes.push(...r.notes)
        const statOf = new Map(r.images.map((im) => [im.view, im]))
        const artifacts: { name: string; shot: Shot; bytes: number; width?: number; height?: number }[] = []
        let blank = 0
        for (const s of shots) {
          const f = run.outputs[names[s]]
          if (!f) throw new ToolError(`Blender did not write ${names[s]}`)
          const data = readFileSync(f)
          if ((statOf.get(s)?.std ?? 1) < 0.002) blank++
          work.artifact(id, names[s], data, 'image/png')
          artifacts.push({ name: names[s], shot: s, bytes: data.length, ...(pngSize(data) ?? {}) })
        }
        if (blank) notes.push(`${blank} picture(s) look blank (almost no variation): check the board and case models`)
        let written: string[] | undefined
        if (a.out_dir) {
          const dir = resolve(inRepo(a.out_dir))
          mkdirSync(dir, { recursive: true })
          written = artifacts.map((x) => {
            const target = freeName(dir, x.name)
            writeFileSync(target, readFileSync(run.outputs[x.name] as string), { flag: 'wx' })
            return target
          })
        }
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
          palette,
          shots: Object.fromEntries(artifacts.map((x) => [x.name, x.shot])),
          artifacts,
          ...(written ? { written } : {}),
          device: { type: dev.type, gpu: dev.gpu, name: dev.names.join(', ') },
          where: run.where,
          ...(run.jobId ? { job_id: run.jobId } : {}),
          render: { width: r.render.width, height: r.render.height, samples: r.render.samples, denoiser: r.render.denoiser },
          render_seconds: renderSeconds,
          case: hasCase ? { look } : null,
          commit,
          blender: r.blender,
          notes,
        }
        const summary = `revision ${a.revision} (${date}): ${shots.length} picture(s) ${r.render.width}x${r.render.height}, ${r.render.samples} samples, ${dev.type}, ${renderSeconds} s, ${palette.source === 'logo' ? 'colours from the logo' : 'neutral colours'}`
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
