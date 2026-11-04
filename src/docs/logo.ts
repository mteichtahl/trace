/**
 * The project logo (docs/scribe.md "Project logo"): what a logo file must be before trace keeps it, and where it is
 * kept. A logo is part of the project's design record, so it lives in the repository beside the documents, and the
 * printed copies are made from it: a new logo makes the printed copies stale, never the text.
 *
 *   docs/design/logo.svg | logo.png            on light backgrounds (covers, page headers)
 *   docs/design/logo-dark.svg | logo-dark.png  on dark backgrounds; optional
 *
 * Pure: bytes in, a verdict in plain words out.
 */
export const LOGO_DIR = 'docs/design'
export const LOGO_VARIANTS = ['light', 'dark'] as const
export type LogoVariant = (typeof LOGO_VARIANTS)[number]
export const LOGO_FORMATS = ['svg', 'png'] as const
export type LogoFormat = (typeof LOGO_FORMATS)[number]

/** Most a logo may be: it goes on every page of every printed copy. */
export const MAX_LOGO_BYTES = 1024 * 1024
/** A PNG's shortest side, at least: sharp on a printed cover at about 4 cm. */
export const MIN_PNG_SIDE = 256
export const MAX_PNG_SIDE = 4096
/** Widest and tallest a logo may be, as width over height. */
export const MAX_ASPECT = 6

export const logoPath = (variant: LogoVariant, format: LogoFormat): string => `${LOGO_DIR}/${variant === 'light' ? 'logo' : 'logo-dark'}.${format}`

/** Every path a variant may be kept at: one is kept, the others are removed when it is set. */
export const logoPaths = (variant: LogoVariant): string[] => LOGO_FORMATS.map((f) => logoPath(variant, f))

export interface LogoCheck {
  ok: boolean
  format: LogoFormat | null
  width: number | null
  height: number | null
  /** What is wrong, in words a person can act on; empty when ok. */
  problems: string[]
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** The format the bytes are, by their content (never by the file's name), or null. */
export function sniffLogo(bytes: Uint8Array): LogoFormat | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return 'png'
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 2048)).replace(/^﻿/, '').trimStart()
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg'
  return null
}

/** A PNG's width and height from its header, or null when the header is not there. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: v.getUint32(16), height: v.getUint32(20) }
}

/** What an SVG would do besides draw: run code, load from elsewhere or define entities. Each in words. */
export function svgHazards(text: string): string[] {
  const out: string[] = []
  if (/<script[\s/>]/i.test(text)) out.push('it contains a script')
  if (/\son[a-z]+\s*=/i.test(text)) out.push('it has event handlers (on… attributes)')
  if (/javascript:/i.test(text)) out.push('it has a javascript: link')
  if (/<foreignObject[\s/>]/i.test(text)) out.push('it embeds other content (foreignObject)')
  if (/<!ENTITY/i.test(text)) out.push('it defines entities')
  if (/(?:xlink:)?href\s*=\s*["']\s*(?:https?:|\/\/)/i.test(text) || /url\(\s*["']?\s*(?:https?:|\/\/)/i.test(text) || /@import/i.test(text)) out.push('it loads something from another site')
  return out
}

/** An SVG's size from its viewBox, else its width and height attributes, or null. */
export function svgSize(text: string): { width: number; height: number } | null {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? ''
  const vb = /viewBox\s*=\s*["']\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*["']/i.exec(tag)
  if (vb) return { width: Number(vb[1]), height: Number(vb[2]) }
  const w = /\swidth\s*=\s*["']\s*([\d.]+)/i.exec(tag)
  const h = /\sheight\s*=\s*["']\s*([\d.]+)/i.exec(tag)
  return w && h ? { width: Number(w[1]), height: Number(h[1]) } : null
}

/** Whether these bytes may be kept as a project logo, and if not, why. */
export function checkLogo(bytes: Uint8Array): LogoCheck {
  const problems: string[] = []
  const format = sniffLogo(bytes)
  if (bytes.length === 0) return { ok: false, format: null, width: null, height: null, problems: ['The file is empty.'] }
  if (bytes.length > MAX_LOGO_BYTES) problems.push(`It is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; a logo is at most 1 MB.`)
  if (!format) return { ok: false, format: null, width: null, height: null, problems: [...problems, 'It is not an SVG or PNG image. Save the logo as SVG (best, sharp at any size) or PNG.'] }
  let size: { width: number; height: number } | null
  if (format === 'png') {
    size = pngSize(bytes)
    if (!size) problems.push('The PNG\'s header cannot be read: the file may be damaged.')
    else {
      const short = Math.min(size.width, size.height)
      if (short < MIN_PNG_SIDE) problems.push(`It is ${size.width} × ${size.height} pixels; a PNG logo needs at least ${MIN_PNG_SIDE} pixels on its shorter side to print sharply. An SVG has no such limit.`)
      if (Math.max(size.width, size.height) > MAX_PNG_SIDE) problems.push(`It is ${size.width} × ${size.height} pixels; at most ${MAX_PNG_SIDE} on its longer side.`)
    }
  } else {
    const text = new TextDecoder().decode(bytes)
    const hazards = svgHazards(text)
    if (hazards.length) problems.push(`The SVG cannot be used as it is: ${hazards.join('; ')}. Export it again as a plain drawing.`)
    size = svgSize(text)
    if (!size) problems.push('The SVG has no viewBox or width and height, so its shape is unknown. Export it with a viewBox.')
  }
  if (size && size.width > 0 && size.height > 0) {
    const ratio = size.width / size.height
    if (ratio > MAX_ASPECT || ratio < 1 / MAX_ASPECT) problems.push(`It is ${ratio > 1 ? 'more than six times wider than tall' : 'more than six times taller than wide'}; it would be too small to read on the cover. Use a more compact version of the logo.`)
  } else if (size) problems.push('Its width or height is zero.')
  return { ok: problems.length === 0, format, width: size?.width ?? null, height: size?.height ?? null, problems }
}
