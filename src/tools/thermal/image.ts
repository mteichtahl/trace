/**
 * Temperature maps as PNG: a minimal encoder (RGB, 8 bit, no interlace; zlib from node:zlib, CRC-32 per chunk, as
 * the PNG specification, ISO/IEC 15948, requires), a perceptual colour map, and a colour-scale bar with its
 * numbers drawn in a 5x7 pixel font, so a map can be read without a plotting library.
 */
import { crc32, deflateSync } from 'node:zlib'

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** Encode width x height RGB pixels (row-major, top row first). */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  if (rgb.length !== width * height * 3) throw new Error('encodePng: pixel buffer size mismatch')
  const raw = new Uint8Array((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1)
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, width)
  v.setUint32(4, height)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** Viridis, sampled at 9 stops (matplotlib's _viridis_data), interpolated linearly. */
const STOPS: readonly (readonly [number, number, number])[] = [
  [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37],
]

export function colour(f: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, Number.isFinite(f) ? f : 0)) * (STOPS.length - 1)
  const i = Math.min(STOPS.length - 2, Math.floor(x))
  const t = x - i
  const a = STOPS[i]!
  const b = STOPS[i + 1]!
  return [Math.round(a[0] + t * (b[0] - a[0])), Math.round(a[1] + t * (b[1] - a[1])), Math.round(a[2] + t * (b[2] - a[2]))]
}

/** A map image: values per cell (nx x ny, row j = board y), scaled `scale` pixels per cell; NaN cells are grey. */
export function mapImage(values: Float64Array, nx: number, ny: number, lo: number, hi: number, scale = 1): { width: number; height: number; rgb: Uint8Array } {
  const W = nx * scale
  const H = ny * scale
  const rgb = new Uint8Array(W * H * 3)
  const span = hi - lo || 1
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = values[j * nx + i]!
    const c = Number.isNaN(v) ? [200, 200, 200] as const : colour((v - lo) / span)
    for (let q = 0; q < scale; q++) for (let p = 0; p < scale; p++) {
      const o = ((j * scale + q) * W + i * scale + p) * 3
      rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]
    }
  }
  return { width: W, height: H, rgb }
}

// 5x7 glyphs, one row per string, '#' = ink
const FONT: Record<string, readonly string[]> = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  'C': ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
}

function text(rgb: Uint8Array, W: number, x: number, y: number, s: string, px = 2): void {
  let cx = x
  for (const ch of s) {
    const g = FONT[ch] ?? FONT[' ']!
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r]![c] === '#') {
      for (let q = 0; q < px; q++) for (let p = 0; p < px; p++) {
        const o = ((y + r * px + q) * W + cx + c * px + p) * 3
        if (o >= 0 && o + 2 < rgb.length) { rgb[o] = 20; rgb[o + 1] = 20; rgb[o + 2] = 20 }
      }
    }
    cx += 6 * px
  }
}

/** A vertical colour-scale bar from lo (bottom) to hi (top), with `ticks` labelled values in deg C. */
export function colourBar(lo: number, hi: number, o: { height?: number; ticks?: number } = {}): Uint8Array {
  const H = o.height ?? 300
  const ticks = o.ticks ?? 6
  const label = (v: number): string => `${v.toFixed(Math.abs(hi - lo) < 10 ? 1 : 0)} C`
  const textW = Math.max(...Array.from({ length: ticks }, (_, i) => label(lo + ((hi - lo) * i) / (ticks - 1)).length)) * 12
  const W = 40 + 8 + textW + 8
  const rgb = new Uint8Array(W * H * 3).fill(255)
  const top = 10
  const bottom = H - 10
  for (let y = top; y <= bottom; y++) {
    const c = colour((bottom - y) / (bottom - top))
    for (let x = 8; x < 40; x++) { const p = (y * W + x) * 3; rgb[p] = c[0]; rgb[p + 1] = c[1]; rgb[p + 2] = c[2] }
  }
  for (let i = 0; i < ticks; i++) {
    const y = Math.round(bottom - ((bottom - top) * i) / (ticks - 1))
    for (let x = 40; x < 46; x++) { const p = (y * W + x) * 3; rgb[p] = 20; rgb[p + 1] = 20; rgb[p + 2] = 20 }
    text(rgb, W, 48, Math.max(0, Math.min(H - 14, y - 7)), label(lo + ((hi - lo) * i) / (ticks - 1)))
  }
  return encodePng(W, H, rgb)
}

/** A line plot of series against time (deg C): axes, the series in distinct colours, min/max labels. */
export function linePlot(series: readonly { name: string; t: readonly number[]; y: readonly number[] }[], o: { width?: number; height?: number } = {}): Uint8Array {
  const W = o.width ?? 640
  const H = o.height ?? 360
  const rgb = new Uint8Array(W * H * 3).fill(255)
  const L = 70
  const R = W - 15
  const T = 15
  const B = H - 30
  const all = series.flatMap((s) => s.y).filter(Number.isFinite)
  const tmax = Math.max(...series.flatMap((s) => s.t), 1e-9)
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const span = hi - lo || 1
  const px = (t: number): number => Math.round(L + ((R - L) * t) / tmax)
  const py = (v: number): number => Math.round(B - ((B - T) * (v - lo)) / span)
  const put = (x: number, y: number, c: readonly number[]): void => { if (x >= 0 && y >= 0 && x < W && y < H) { const p = (y * W + x) * 3; rgb[p] = c[0]!; rgb[p + 1] = c[1]!; rgb[p + 2] = c[2]! } }
  for (let x = L; x <= R; x++) put(x, B, [0, 0, 0])
  for (let y = T; y <= B; y++) put(L, y, [0, 0, 0])
  series.forEach((s, k) => {
    const c = colour(series.length > 1 ? k / (series.length - 1) : 0.2)
    for (let i = 1; i < s.t.length; i++) {
      const x0 = px(s.t[i - 1]!)
      const y0 = py(s.y[i - 1]!)
      const x1 = px(s.t[i]!)
      const y1 = py(s.y[i]!)
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
      for (let q = 0; q <= n; q++) { put(Math.round(x0 + ((x1 - x0) * q) / n), Math.round(y0 + ((y1 - y0) * q) / n), c); put(Math.round(x0 + ((x1 - x0) * q) / n), Math.round(y0 + ((y1 - y0) * q) / n) + 1, c) }
    }
  })
  text(rgb, W, 2, T, `${hi.toFixed(1)}`, 1)
  text(rgb, W, 2, B - 7, `${lo.toFixed(1)}`, 1)
  text(rgb, W, R - 60, B + 10, `${tmax.toFixed(0)}`, 1)
  text(rgb, W, L, B + 10, '0', 1)
  return encodePng(W, H, rgb)
}
