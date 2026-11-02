/** Real renders with the Blender installed here (skipped without one). Tiny sizes and few samples keep them quick. */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { Work } from '../../../src/core/store.js'
import { findKicadCli } from '../../../src/tools/kicad/project.js'
import { findBlender, findFfmpeg, pngSize } from '../../../src/tools/render/blender.js'
import { tools } from '../../../src/tools/render/tools.js'

delete process.env.TRACE_GPU_QUEUE
const blender = findBlender()
let works = false
if (blender) {
  try {
    execFileSync(blender, ['-b', '--factory-startup', '--version'], { timeout: 60_000, stdio: 'pipe' })
    works = true
  } catch {
    works = false
  }
}
const hasKicad = !!findKicadCli()
const tool = (n: string) => {
  const t = tools.find((x) => x.name === n)
  if (!t) throw new Error(n)
  return (a: Record<string, unknown>) => t.run(t.input.parse(a) as never, { hardware: false, via: 'test' }) as Promise<Record<string, unknown>>
}

interface Art { name: string; bytes: number; width?: number; height?: number; mean?: number; std?: number }

/** Decode an 8-bit RGB/RGBA PNG (no interlace) and return the luminance standard deviation, independently of Blender. */
function pngLumaStd(buf: Uint8Array): number {
  const b = Buffer.from(buf)
  const w = b.readUInt32BE(16)
  const h = b.readUInt32BE(20)
  const ch = b[25] === 6 ? 4 : 3
  const idat: Buffer[] = []
  for (let o = 8; o < b.length;) {
    const len = b.readUInt32BE(o)
    const type = b.toString('ascii', o + 4, o + 8)
    if (type === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len))
    o += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x] as number
      const a = x >= ch ? (out[y * stride + x - ch] as number) : 0
      const up = y ? (out[(y - 1) * stride + x] as number) : 0
      const c = y && x >= ch ? (out[(y - 1) * stride + x - ch] as number) : 0
      let p = 0
      if (f === 1) p = a
      else if (f === 2) p = up
      else if (f === 3) p = (a + up) >> 1
      else if (f === 4) {
        const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c)
        p = pa <= pb && pa <= pc ? a : pb <= pc ? up : c
      }
      out[y * stride + x] = (v + p) & 0xff
    }
  }
  let s = 0, s2 = 0
  const n = w * h
  for (let i = 0; i < n; i++) {
    const l = 0.2126 * (out[i * ch] as number) + 0.7152 * (out[i * ch + 1] as number) + 0.0722 * (out[i * ch + 2] as number)
    s += l
    s2 += l * l
  }
  const m = s / n
  return Math.sqrt(Math.max(0, s2 / n - m * m))
}

function cube(dir: string): string {
  const p = join(dir, 'cube.obj')
  const v = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]
  const f = [[1, 4, 3, 2], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]]
  writeFileSync(p, `# a 20 mm cube\n${v.map((q) => `v ${q.map((x) => x * 10).join(' ')}`).join('\n')}\n${f.map((q) => `f ${q.join(' ')}`).join('\n')}\n`)
  return p
}

describe.skipIf(!works)('blender (real)', () => {
  it('render.status finds Blender and the CPU', async () => {
    const s = await tool('render.status')({ refresh: true })
    expect(s.found).toBe(true)
    expect(String(s.version)).toMatch(/^\d+\.\d+/)
    expect(s.engines).toContain('CYCLES')
    expect((s.devices as { type: string }[]).some((d) => d.type === 'CPU')).toBe(true)
    if (!(s.gpu_available as boolean)) expect(s.auto_device).toMatchObject({ type: 'CPU', gpu: false })
    expect(s).toHaveProperty('eevee')
  }, 120_000)

  it('render.model renders a cube: PNGs of the asked size, not blank, device recorded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'render-model-'))
    const out = join(dir, 'out')
    const r = await tool('render.model')({ path: cube(dir), views: ['iso', 'front'], width: 160, height: 100, samples: 8, device: 'cpu', out_dir: out })
    const arts = r.artifacts as Art[]
    expect(arts.map((a) => a.name)).toEqual(['iso.png', 'front.png'])
    for (const a of arts) {
      expect(a).toMatchObject({ width: 160, height: 100 })
      expect(a.std ?? 0).toBeGreaterThan(0.01)
    }
    expect(r.device).toMatchObject({ type: 'CPU', gpu: false })
    expect(r.render_seconds).toBeGreaterThan(0)
    expect((r.bbox_mm as number[])[0]).toBeCloseTo(20, 0) // 20 units across (> 5) is read as millimetres
    const written = r.written as string[]
    expect(written).toHaveLength(2)
    const png = readFileSync(written[0] as string)
    expect(pngSize(png)).toEqual({ width: 160, height: 100 })
    expect(pngLumaStd(png)).toBeGreaterThan(2)
    // the run record holds the images, the device and the time
    const w = new Work()
    const rec = w.run(String(r.run_id))
    w.close()
    expect(rec?.status).toBe('pass')
    expect(rec?.artifacts.map((a) => a.name).sort()).toEqual(['front.png', 'iso.png'])
    expect(rec?.measurements.map((m) => m.name)).toEqual(expect.arrayContaining(['device_gpu', 'render_seconds', 'samples']))
    // a second render to the same folder never replaces the first
    const again = await tool('render.model')({ path: join(dir, 'cube.obj'), views: ['iso'], width: 32, height: 20, samples: 1, device: 'cpu', out_dir: out })
    expect((again.written as string[])[0]).toMatch(/iso-1\.png$/)
    expect(readdirSync(out).sort()).toEqual(['front.png', 'iso-1.png', 'iso.png'])
  }, 180_000)

  it('device=auto resolves to the CPU here and device=gpu fails clearly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'render-dev-'))
    const st = await tool('render.status')({})
    if (st.gpu_available) return // a machine with a GPU: nothing to assert about the fallback
    const r = await tool('render.model')({ path: cube(dir), views: ['top'], width: 32, height: 20, samples: 1, device: 'auto', units: 'mm' })
    expect(r.device).toMatchObject({ type: 'CPU', gpu: false })
    expect((r.bbox_mm as number[])[0]).toBeCloseTo(20, 1)
    await expect(tool('render.model')({ path: join(dir, 'cube.obj'), views: ['top'], width: 32, height: 20, samples: 1, device: 'gpu' }))
      .rejects.toThrow(/no GPU/)
  }, 180_000)

  it('the script itself refuses device=gpu without a GPU (no fallback)', () => {
    const st = execFileSync(blender as string, ['-b', '--factory-startup', '--python-exit-code', '1', '-P',
      join(dirname(fileURLToPath(import.meta.url)), '../../../python/blender/probe.py')], { timeout: 120_000, stdio: 'pipe' }).toString()
    if (/"gpu":true/.test(st)) return
    const dir = mkdtempSync(join(tmpdir(), 'render-script-'))
    writeFileSync(join(dir, 'job.json'), JSON.stringify({ views: ['top'], width: 16, height: 16, samples: 1, device: 'gpu', defaults: { cpu: { width: 16, height: 16, samples: 1 }, gpu: { width: 16, height: 16, samples: 1 } } }))
    let out = ''
    try {
      execFileSync(blender as string, ['-b', '--factory-startup', '--python-exit-code', '1', '-P',
        join(dirname(fileURLToPath(import.meta.url)), '../../../python/blender/render_model.py'), '--', join(dir, 'job.json'), join(dir, 'result.json'), cube(dir), join(dir, 'top.png')], { timeout: 120_000, stdio: 'pipe' })
    } catch (e) {
      out = String((e as { stdout?: Buffer }).stdout ?? '')
    }
    expect(out).toMatch(/TRACE_RESULT \{"ok":false,"error":"JobError: device=gpu was asked for, but Blender finds no GPU/)
    expect(existsSync(join(dir, 'top.png'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'))).toMatchObject({ ok: false })
  }, 180_000)

  it('render.board shows the tracks under the solder mask (a translucent mask, not an opaque one)', () => {
    // testyyyu: the board's 54 tracks were exported but hidden under an opaque mask. A track under the mask now reads
    // lighter than bare mask in the top view (fixtures/mask_over_copper.py, dressed by render_board.py's own code)
    const here = dirname(fileURLToPath(import.meta.url))
    const dir = mkdtempSync(join(tmpdir(), 'render-mask-'))
    const out = execFileSync(blender as string, ['-b', '--factory-startup', '--python-exit-code', '1', '-P', join(here, 'fixtures/mask_over_copper.py'),
      '--', join(here, '../../../python/blender'), join(dir, 'top.png')], { timeout: 180_000, stdio: 'pipe' }).toString()
    expect(out).toMatch(/COUNTS \{'fr4': 1, 'pad': 2, 'mask': 2\}/)
    expect(out).toMatch(/TRACK_VISIBLE True/)
  }, 240_000)

  it.skipIf(!hasKicad)('render.board renders the demo board: top and iso', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'render-board-')), 'demo')
    cpSync(join(dirname(fileURLToPath(import.meta.url)), '../kicad/fixtures/demo'), dir, { recursive: true })
    const r = await tool('render.board')({ project: join(dir, 'demo.kicad_pro'), views: ['top', 'iso'], width: 200, height: 125, samples: 4, device: 'cpu', mask_color: '#202060' })
    const arts = r.artifacts as Art[]
    expect(arts.map((a) => a.name)).toEqual(['top.png', 'iso.png'])
    for (const a of arts) {
      expect(a).toMatchObject({ width: 200, height: 125 })
      expect(a.std ?? 0).toBeGreaterThan(0.01)
    }
    expect(['wrl', 'glb']).toContain((r.render as { model_format: string }).model_format)
    expect(r.bbox_mm as number[]).toEqual([expect.closeTo(50, 0), expect.closeTo(30, 0), expect.any(Number)])
    expect((r.surfaces as Record<string, number>).mask).toBeGreaterThan(0)
  }, 240_000)

  it('render.turntable makes a movie (or frames without ffmpeg)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'render-tt-'))
    const r = await tool('render.turntable')({ path: cube(dir), frames: 4, seconds: 1, width: 64, height: 40, samples: 1, device: 'cpu' })
    const names = (r.artifacts as Art[]).map((a) => a.name)
    if (findFfmpeg()) expect(names).toEqual(['turntable.mp4', 'poster.png'])
    else expect(names).toEqual(['frame_0001.png', 'frame_0002.png', 'frame_0003.png', 'frame_0004.png'])
  }, 240_000)
})
