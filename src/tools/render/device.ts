/**
 * Which device renders: what Blender can see (probe.py, cached for an hour per Blender binary), and the rule for
 * choosing among it. `auto` takes the best GPU backend there is (OPTIX > CUDA > HIP > ONEAPI > METAL) and otherwise
 * the CPU; `gpu` insists on one and fails if there is none; `cpu` is always the CPU. TRACE_RENDER_DEVICE sets the
 * default, so a GPU workstation or a GPU self-hosted runner can force it. The same rule is in python/blender/common.py
 * (select_device), which applies it where the render actually runs.
 *
 * AgentCore runtimes have no GPU: there, renders run on the CPU, or on the GPU queue when TRACE_GPU_QUEUE is set.
 */
import { statSync } from 'node:fs'
import { z } from 'zod'
import { ToolError } from '../../core/registry.js'
import { Cache } from '../../core/store.js'
import { blenderTarget, runBlender } from './blender.js'
import type { Backend } from '../../gpu/jobs.js'

export const GPU_ORDER = ['OPTIX', 'CUDA', 'HIP', 'ONEAPI', 'METAL'] as const
export const DeviceWant = z.enum(['auto', 'gpu', 'cpu'])
export type DeviceWant = z.output<typeof DeviceWant>

export const DeviceSchema = z.object({ type: z.string(), name: z.string(), id: z.string(), gpu: z.boolean() })
export type Device = z.output<typeof DeviceSchema>

export const ProbeSchema = z.object({
  blender: z.string(),
  engines: z.array(z.string()),
  compute_types: z.array(z.string()),
  devices: z.array(DeviceSchema),
  gltf_import: z.boolean(),
  denoisers: z.array(z.string()),
  python: z.string(),
  eevee: z.object({
    engine: z.string().nullable(),
    renders_headless: z.boolean(),
    seconds: z.number().optional(),
    error: z.string().nullable().optional(),
  }).optional(),
  seconds: z.number(),
})
export type Probe = z.output<typeof ProbeSchema>

export interface Selected {
  type: string
  gpu: boolean
  names: string[]
}

/** The device a render would use, from a probe's device list. Pure: the tests feed it canned lists. */
export function selectDevice(devices: readonly Device[], want: DeviceWant): Selected {
  if (want !== 'cpu') {
    for (const t of GPU_ORDER) {
      const g = devices.filter((d) => d.type === t && d.gpu)
      if (g.length) return { type: t, gpu: true, names: g.map((d) => d.name) }
    }
    if (want === 'gpu') {
      throw new ToolError(`device=gpu was asked for, but Blender finds no GPU here (looked for ${GPU_ORDER.join(', ')}); use device=auto or cpu`)
    }
  }
  const cpus = devices.filter((d) => d.type === 'CPU')
  return { type: 'CPU', gpu: false, names: cpus.length ? cpus.map((d) => d.name) : ['CPU'] }
}

/** The default device: TRACE_RENDER_DEVICE (auto|gpu|cpu), else auto. */
export function defaultDevice(): DeviceWant {
  const v = (process.env.TRACE_RENDER_DEVICE ?? '').trim().toLowerCase()
  if (!v) return 'auto'
  const p = DeviceWant.safeParse(v)
  if (!p.success) throw new ToolError(`TRACE_RENDER_DEVICE must be auto, gpu or cpu, not ${JSON.stringify(v)}`)
  return p.data
}

/** Default size and samples when the caller gives none: modest on a CPU (Cycles CPU is slow), more on a GPU. */
export const DEFAULTS = {
  cpu: { width: 1280, height: 800, samples: 32 },
  gpu: { width: 1920, height: 1200, samples: 128 },
} as const

const PROBE_TTL_S = 3600

function cacheKey(where: Backend, bin: string): string {
  if (where === 'batch') return `batch:${process.env.TRACE_GPU_QUEUE ?? ''}`
  if (where === 'function') return `function:${process.env.TRACE_TOOLS_FUNCTION ?? ''}`
  try {
    const st = statSync(bin)
    return `local:${bin}:${st.size}:${Math.round(st.mtimeMs)}` // a new Blender build at the same path is a new key
  } catch {
    return `local:${bin}`
  }
}

export interface ProbeOut extends Probe {
  where: Backend
  bin: string
  cached: boolean
}

/** Probe the Blender a render would use; cached an hour per binary (and Blender version, which it carries). */
export async function probe(opts: { refresh?: boolean; allowRemote?: boolean } = {}): Promise<ProbeOut | null> {
  const { where, bin } = blenderTarget(true)
  if (!bin) return null
  const key = cacheKey(where, bin)
  const cache = new Cache()
  try {
    if (!opts.refresh) {
      const hit = cache.get<unknown>('render.probe', key)
      const p = hit === undefined ? null : ProbeSchema.safeParse(hit)
      if (p?.success) return { ...p.data, where, bin, cached: true }
    }
    if (where !== 'local' && opts.allowRemote === false) return null
    const r = await runBlender({
      script: 'probe.py', job: {}, args: ['eevee', '{out:eevee.png}'], outputs: ['eevee.png'], schema: ProbeSchema, timeoutSeconds: 180,
    })
    r.cleanup()
    cache.put('render.probe', key, r.result, { ttlSeconds: PROBE_TTL_S })
    return { ...r.result, where, bin, cached: false }
  } finally {
    cache.close()
  }
}
