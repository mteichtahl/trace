/**
 * The render tools: photographic renders of a KiCad board, any model (an enclosure, an assembly, a part) and turntables,
 * made by Blender (Cycles) headless. Renders are slow, so nothing renders unless one of these tools is called: no
 * other tool or build step makes them as a side effect.
 *
 * Each call is a recorded run (`run_id`): the PNGs (and a turntable's MP4) are stored as its artifacts, with the device
 * used, the render time and the commit the model came from. `out_dir` also writes the files there, never replacing a
 * file that exists (a numbered name is used instead). Answers stay compact: names, sizes and pixel statistics, no
 * image data.
 *
 * device: auto (the best GPU backend there is, else the CPU), gpu (fail without one), cpu. Defaults scale with it:
 * 1280×800 at 32 samples on a CPU, 1920×1200 at 128 on a GPU. TRACE_RENDER_DEVICE sets the default device.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { z } from 'zod'
import { defineTool, ToolError, type AnyTool } from '../core/registry.js'
import { scratchDir, Work } from '../core/store.js'
import { findKicadCli, kicadCliVersion, needPcb, resolveProject, runProgram } from '../kicad/project.js'
import { backendFor } from '../gpu/jobs.js'
import { findBlender, findFfmpeg, pngSize, runBlender, scriptsDir, type Script } from './blender.js'
import { DEFAULTS, defaultDevice, DeviceWant, probe, selectDevice, type DeviceWant as Want } from './device.js'
import { commitOf, exportBoard, inRepo, prepareModel, type BoardFormat, type Prepared } from './model.js'

// ------------------------------------------------------------------ inputs

export const VIEWS = ['top', 'bottom', 'iso', 'front', 'back', 'left', 'right'] as const
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour is #rrggbb')

const common = {
  width: z.number().int().min(16).max(7680).optional().describe('image width in px (default 1280 on CPU, 1920 on GPU)'),
  height: z.number().int().min(16).max(4320).optional().describe('image height in px (default 800 on CPU, 1200 on GPU)'),
  samples: z.number().int().min(1).max(4096).optional().describe('Cycles samples (default 32 on CPU, 128 on GPU)'),
  denoise: z.boolean().default(true).describe('denoise when this Blender has a denoiser (OpenImageDenoise/OptiX)'),
  device: DeviceWant.optional().describe('auto: best GPU (OPTIX>CUDA>HIP>ONEAPI>METAL) else CPU; gpu: fail without one; cpu. Default TRACE_RENDER_DEVICE or auto'),
  engine: z.enum(['cycles', 'eevee']).default('cycles').describe('cycles (works headless anywhere); eevee only where it can render headless'),
  background: z.union([z.enum(['light', 'dark', 'transparent']), hex]).default('light').describe('light, dark, transparent or #rrggbb'),
  out_dir: z.string().optional().describe('also write the files here (relative to the repository); existing files are never replaced'),
  timeout_s: z.number().int().min(10).max(4 * 3600).default(1800).describe('stop Blender after this many seconds'),
}
const boardOpts = {
  project: z.string().optional().describe('path to a .kicad_pro/.kicad_pcb (or its folder); omit for the configured/only project'),
  mask_color: hex.default('#1f6b3a').describe('solder mask colour'),
  silk_color: hex.default('#f2f2ec').describe('silkscreen colour'),
  model_format: z.enum(['auto', 'glb', 'vrml']).default('auto').describe('how kicad-cli hands the board to Blender: auto = GLB when this Blender imports glTF, else VRML'),
}
const modelOpts = {
  up_axis: z.enum(['Y', 'Z']).optional().describe('up axis of a VRML/X3D file (VRML standard Y; KiCad writes Z)'),
  units: z.enum(['m', 'mm']).optional().describe('units of an STL/OBJ/PLY (default: guessed; over 5 units across = mm)'),
  materials: z.enum(['auto', 'clay', 'keep']).default('auto').describe("auto: the model's materials, clay where it has none; clay: one clay surface; keep"),
  clay_color: hex.default('#c9ccd1'),
}

// ------------------------------------------------------------------ script results

const ImageStat = z.object({
  view: z.string(), width: z.number(), height: z.number(), mean: z.number(), std: z.number(), coverage: z.number(), seconds: z.number(),
})
export const RenderResult = z.object({
  images: z.array(ImageStat),
  render: z.object({
    width: z.number(), height: z.number(), samples: z.number(), engine: z.string(), denoiser: z.string().nullable(),
    device: z.object({ type: z.string(), gpu: z.boolean(), names: z.array(z.string()) }),
  }),
  notes: z.array(z.string()),
  bbox_mm: z.array(z.number()),
  objects: z.number(),
  blender: z.string(),
  seconds: z.number(),
  surfaces: z.record(z.string(), z.number()).optional(),
  clay_objects: z.number().optional(),
})
export type RenderResult = z.output<typeof RenderResult>

// ------------------------------------------------------------------ the shared path

interface Plan {
  kind: string
  subject: string
  args: unknown
  script: Script
  /** where the commit is read from */
  repoPath: string
  prepare: (dir: string, format: BoardFormat) => Promise<Prepared>
  wantGltf: 'auto' | 'glb' | 'vrml'
  job: Record<string, unknown>
  views: readonly string[]
  frames: number
  fps: number
  keepFrames: boolean
  device: Want | undefined
  engine: 'cycles' | 'eevee'
  timeoutS: number
  outDir: string | undefined
}

export interface ArtifactOut {
  name: string
  bytes: number
  width?: number
  height?: number
  mean?: number
  std?: number
}

/** A free file name in dir: name, else name-1, name-2, … (a person's files are never replaced). */
export function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return join(dir, name)
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 1; ; i++) {
    const p = join(dir, `${stem}-${i}${ext}`)
    if (!existsSync(p)) return p
  }
}

async function chooseFormat(want: 'auto' | 'glb' | 'vrml'): Promise<BoardFormat> {
  if (want === 'glb') return 'glb'
  if (want === 'vrml') return 'wrl'
  // GLB only when the Blender that will import it is known to read glTF (a probe; never a remote job just for this)
  const p = await probe({ allowRemote: false }).catch(() => null)
  return p?.gltf_import ? 'glb' : 'wrl'
}

async function encodeMp4(frames: string[], fps: number, dir: string): Promise<Uint8Array | null> {
  const ff = findFfmpeg()
  if (!ff || !frames.length) return null
  frames.forEach((f, i) => writeFileSync(join(dir, `f_${String(i + 1).padStart(4, '0')}.png`), readFileSync(f)))
  const out = join(dir, 'turntable.mp4')
  const r = await runProgram(ff, ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(dir, 'f_%04d.png'),
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', out], { timeoutMs: 600_000 })
  if (r.code !== 0 || !existsSync(out)) throw new ToolError(`ffmpeg could not encode the turntable: ${(r.stderr || r.stdout).trim().slice(-500)}`)
  return readFileSync(out)
}

async function renderRun(p: Plan): Promise<Record<string, unknown>> {
  const want = p.device ?? defaultDevice()
  // fail early, before exporting anything, when the machine that would render cannot do what was asked
  if (backendFor({ gpu: true }) === 'local' && (want === 'gpu' || p.engine === 'eevee')) {
    if (!findBlender()) throw new ToolError('Blender is not installed here (or set TRACE_BLENDER to its path)')
    const pr = await probe()
    if (pr && want === 'gpu') selectDevice(pr.devices, 'gpu')
    if (pr && p.engine === 'eevee' && !pr.eevee?.renders_headless) {
      throw new ToolError(`EEVEE cannot render headless with this Blender (${pr.eevee?.error ?? 'no EEVEE'}); use engine=cycles`)
    }
  }
  const commit = commitOf(p.repoPath)
  const work = new Work()
  const id = work.start(p.kind, { subject: p.subject, args: p.args, ...(commit ? { gitSha: commit } : {}) })
  const tmp = scratchDir('trace-render-')
  try {
    const format = await chooseFormat(p.wantGltf)
    const model = await p.prepare(tmp, format)
    const modelName = `model.${model.format}`
    const viewOuts = p.views.map((v) => `${v}.png`)
    const frameOuts = Array.from({ length: p.frames }, (_, i) => `frame_${String(i + 1).padStart(4, '0')}.png`)
    const outs = [...viewOuts, ...frameOuts]
    const tt = p.frames > 0
    const defaults = tt
      ? { cpu: { width: 800, height: 500, samples: 24 }, gpu: { width: 1280, height: 800, samples: 96 } }
      : DEFAULTS
    const job = {
      ...p.job,
      format: model.format,
      ...(model.zUp ? { up_axis: 'Z' } : {}),
      ...(model.dropKicadBoard ? { drop_kicad_board: true } : {}),
      views: p.views,
      turntable: tt ? { frames: p.frames, elevation: p.job.elevation ?? 25 } : null,
      defaults,
      device: want,
      engine: p.engine,
    }
    const run = await runBlender({
      script: p.script, job, gpu: true, timeoutSeconds: p.timeoutS,
      inputs: { [modelName]: model.path, ...model.extra },
      args: [`{in:${modelName}}`, ...outs.map((o) => `{out:${o}}`)],
      outputs: outs,
      schema: RenderResult,
    })
    const r = run.result
    try {
      const artifacts: ArtifactOut[] = []
      const files: { name: string; data: Uint8Array }[] = []
      const notes = [...r.notes]
      let blank = 0
      const statOf = new Map(r.images.map((im) => [im.view, im]))
      const add = (name: string, data: Uint8Array, mime: string, st?: z.output<typeof ImageStat>): void => {
        work.artifact(id, name, data, mime)
        const size = mime === 'image/png' ? pngSize(data) : null
        artifacts.push({ name, bytes: data.length, ...(size ?? {}), ...(st ? { mean: st.mean, std: st.std } : {}) })
        files.push({ name, data })
      }
      for (const [i, v] of p.views.entries()) {
        const f = run.outputs[viewOuts[i] as string]
        if (!f) throw new ToolError(`Blender did not write ${viewOuts[i]}`)
        const st = statOf.get(v)
        if (st && st.std < 0.002) blank++
        add(`${v}.png`, readFileSync(f), 'image/png', st)
      }
      if (tt) {
        const framePaths = frameOuts.map((n) => run.outputs[n]).filter((x): x is string => typeof x === 'string')
        if (framePaths.length !== p.frames) throw new ToolError(`Blender wrote ${framePaths.length} of ${p.frames} turntable frames`)
        const mp4 = await encodeMp4(framePaths, p.fps, tmp)
        if (mp4) add('turntable.mp4', mp4, 'video/mp4')
        else notes.push('ffmpeg is not installed: the turntable is stored as PNG frames')
        if (!mp4 || p.keepFrames) {
          framePaths.forEach((f, i) => add(frameOuts[i] as string, readFileSync(f), 'image/png', statOf.get(`frame_${String(i + 1).padStart(4, '0')}`)))
        } else {
          add('poster.png', readFileSync(framePaths[0] as string), 'image/png', statOf.get('frame_0001'))
        }
        for (const im of r.images) if (im.view.startsWith('frame_') && im.std < 0.002) blank++
      }
      if (blank) notes.push(`${blank} image(s) look blank (almost no variation): check the model and the views`)
      let written: string[] | undefined
      if (p.outDir) {
        const dir = resolve(inRepo(p.outDir))
        mkdirSync(dir, { recursive: true })
        written = files.map((f) => {
          const target = freeName(dir, f.name)
          writeFileSync(target, f.data, { flag: 'wx' })
          return target
        })
      }
      const dev = r.render.device
      const renderSeconds = Math.round(r.images.reduce((s, im) => s + im.seconds, 0) * 10) / 10
      work.measure(id, 'render_seconds', renderSeconds, 's')
      work.measure(id, 'blender_seconds', Math.round(run.seconds * 10) / 10, 's')
      work.measure(id, 'device_gpu', dev.gpu ? 1 : 0, '', { type: dev.type, names: dev.names })
      work.measure(id, 'samples', r.render.samples, '')
      work.measure(id, 'width', r.render.width, 'px')
      work.measure(id, 'height', r.render.height, 'px')
      const what = tt ? `${p.frames}-frame turntable` : `${p.views.length} view(s)`
      const summary = `${what} ${r.render.width}x${r.render.height}, ${r.render.samples} samples, ${dev.type}${dev.gpu ? ` (${dev.names.join(', ')})` : ''}, ${renderSeconds} s`
      const result = {
        run_id: id,
        artifacts,
        ...(written ? { written } : {}),
        device: { type: dev.type, gpu: dev.gpu, name: dev.names.join(', ') },
        where: run.where,
        ...(run.jobId ? { job_id: run.jobId } : {}),
        render: { width: r.render.width, height: r.render.height, samples: r.render.samples, engine: r.render.engine, denoiser: r.render.denoiser, model_format: model.format },
        render_seconds: renderSeconds,
        total_seconds: Math.round(run.seconds * 10) / 10,
        bbox_mm: r.bbox_mm,
        commit,
        blender: r.blender,
        ...(r.surfaces ? { surfaces: r.surfaces } : {}),
        notes,
      }
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
}

const commonJob = (a: { width?: number | undefined; height?: number | undefined; samples?: number | undefined; denoise: boolean; background: string }): Record<string, unknown> => ({
  ...(a.width ? { width: a.width } : {}),
  ...(a.height ? { height: a.height } : {}),
  ...(a.samples ? { samples: a.samples } : {}),
  denoise: a.denoise,
  background: a.background,
})

async function boardPlan(a: { project?: string | undefined; model_format: 'auto' | 'glb' | 'vrml'; mask_color: string; silk_color: string }) {
  const p = await resolveProject(a.project)
  const pcb = needPcb(p)
  return {
    subject: pcb,
    repoPath: p.dir,
    script: 'render_board.py' as const,
    prepare: (dir: string, f: BoardFormat) => exportBoard(pcb, dir, f),
    wantGltf: a.model_format,
    job: { mask_color: a.mask_color, silk_color: a.silk_color },
  }
}

function modelPlan(a: { path: string; up_axis?: 'Y' | 'Z' | undefined; units?: 'm' | 'mm' | undefined; materials: string; clay_color: string }) {
  const path = inRepo(a.path)
  if (!existsSync(path)) throw new ToolError(`${a.path} does not exist`)
  const isStep = /\.(step|stp)$/i.test(path)
  if (isStep && !findKicadCli()) throw new ToolError('a STEP model is tessellated by kicad-cli (Blender has no STEP importer), which is not installed')
  return {
    subject: path,
    repoPath: path,
    script: 'render_model.py' as const,
    prepare: (dir: string, f: BoardFormat) => prepareModel(path, dir, f),
    wantGltf: 'auto' as const,
    job: {
      ...(a.up_axis ? { up_axis: a.up_axis } : {}),
      ...(a.units ? { units: a.units } : {}),
      materials: a.materials,
      clay_color: a.clay_color,
    },
  }
}

// ------------------------------------------------------------------ tools

const board = defineTool({
  name: 'render.board',
  description: 'Photographic renders of a KiCad board (Blender Cycles): kicad-cli exports its 3D model, Blender renders each view (top, bottom, iso) with a clean solder mask, silkscreen and metallic pads. Slow (tens of seconds per view on a CPU); only when renders are wanted. Stored as run artifacts.',
  input: z.object({
    ...boardOpts,
    views: z.array(z.enum(VIEWS)).min(1).max(7).default(['top', 'bottom', 'iso']).describe('views to render'),
    ...common,
  }),
  run: async (a) => {
    const b = await boardPlan(a)
    return renderRun({
      kind: 'render.board', args: a, ...b, job: { ...b.job, ...commonJob(a) }, views: a.views, frames: 0, fps: 0, keepFrames: false,
      device: a.device, engine: a.engine, timeoutS: a.timeout_s, outDir: a.out_dir,
    })
  },
})

const model = defineTool({
  name: 'render.model',
  description: 'Render a model file (GLB, VRML/X3D, STL, OBJ, PLY, FBX, or STEP via kicad-cli): an enclosure, an assembly, a part. Views iso/front/top/…; its own materials or clay. Slow; only when renders are wanted. Stored as run artifacts.',
  input: z.object({
    path: z.string().describe('the model file, relative to the repository'),
    ...modelOpts,
    views: z.array(z.enum(VIEWS)).min(1).max(7).default(['iso', 'front']).describe('views to render'),
    ...common,
  }),
  run: async (a) => {
    const m = modelPlan(a)
    return renderRun({
      kind: 'render.model', args: a, ...m, job: { ...m.job, ...commonJob(a) }, views: a.views, frames: 0, fps: 0, keepFrames: false,
      device: a.device, engine: a.engine, timeoutS: a.timeout_s, outDir: a.out_dir,
    })
  },
})

const turntable = defineTool({
  name: 'render.turntable',
  description: 'A turntable of a KiCad board (project) or a model file (path): the camera circles it; frames are encoded to an H.264 MP4 when ffmpeg is installed (else stored as PNG frames). Defaults 800×500 on CPU (1280×800 GPU). Very slow on a CPU: keep frames low.',
  input: z.object({
    project: boardOpts.project,
    path: z.string().optional().describe('a model file instead of a board'),
    frames: z.number().int().min(2).max(720).default(24).describe('frames in one revolution'),
    seconds: z.number().min(0.5).max(120).default(4).describe('length of the movie'),
    elevation: z.number().min(-89).max(89).default(25).describe('camera elevation, degrees'),
    keep_frames: z.boolean().default(false).describe('also store every frame as a PNG artifact'),
    mask_color: boardOpts.mask_color,
    silk_color: boardOpts.silk_color,
    model_format: boardOpts.model_format,
    ...modelOpts,
    ...common,
  }),
  run: async (a) => {
    if (a.project && a.path) throw new ToolError('give project (a board) or path (a model), not both')
    const plan = a.path ? modelPlan({ ...a, path: a.path }) : await boardPlan(a)
    return renderRun({
      kind: 'render.turntable', args: a, ...plan, job: { ...plan.job, ...commonJob(a), elevation: a.elevation }, views: [],
      frames: a.frames, fps: Math.max(1, Math.round((a.frames / a.seconds) * 100) / 100), keepFrames: a.keep_frames,
      device: a.device, engine: a.engine, timeoutS: a.timeout_s, outDir: a.out_dir,
    })
  },
})

const status = defineTool({
  name: 'render.status',
  description: 'Can this machine render? Blender (path, version, where renders run), its engines, every Cycles device per backend and the device device=auto would use, EEVEE headless, glTF import, denoisers, ffmpeg and kicad-cli. Probed once an hour.',
  input: z.object({ refresh: z.boolean().default(false).describe('probe again instead of using the cached answer') }),
  run: async (a) => {
    const where = backendFor({ gpu: true })
    const local = findBlender()
    const base = {
      where,
      blender_path: where === 'local' ? local : 'blender (on the GPU queue)',
      scripts: scriptsDir(),
      ffmpeg: findFfmpeg(),
      kicad_cli: findKicadCli(),
      kicad_cli_version: findKicadCli() ? await kicadCliVersion() : null,
      default_device: process.env.TRACE_RENDER_DEVICE ? defaultDevice() : 'auto',
      defaults: DEFAULTS,
    }
    if (where === 'local' && !local) return { ...base, found: false, note: 'Blender is not installed (or set TRACE_BLENDER); with TRACE_GPU_QUEUE set, renders run on the GPU queue' }
    const p = await probe({ refresh: a.refresh })
    if (!p) return { ...base, found: false }
    const auto = selectDevice(p.devices, 'auto')
    return {
      ...base,
      found: true,
      cached: p.cached,
      version: p.blender,
      python: p.python,
      engines: p.engines,
      compute_types: p.compute_types,
      devices: p.devices.map((d) => ({ type: d.type, name: d.name, gpu: d.gpu })),
      gpu_available: p.devices.some((d) => d.gpu),
      auto_device: { type: auto.type, gpu: auto.gpu, name: auto.names.join(', ') },
      eevee: p.eevee ?? null,
      gltf_import: p.gltf_import,
      board_model_format: p.gltf_import ? 'glb' : 'vrml',
      denoisers: p.denoisers,
    }
  },
})

export const tools: AnyTool[] = [board, model, turntable, status]
