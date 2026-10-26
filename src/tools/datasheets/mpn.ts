/**
 * Manufacturer part numbers as the library keys them.
 *
 * A part number is written many ways: "lm5069mm-1/nopb", "LM5069MM-1/NOPB ", "LM5069MM‑1/NOPB" (a non-breaking
 * hyphen pasted from a PDF). `mpnKey` makes those one key: upper case, no whitespace, every dash a plain hyphen.
 * It does nothing cleverer, because two part numbers that differ by a character are often different parts.
 *
 * Packaging and reel suffixes (/TR, -REEL7, #PBF, ,115 …) name the same silicon on a different carrier, but the
 * library never merges on a guess: `packagingBase` only says that a key *looks like* a packaging variant of a shorter
 * one, so a lookup that misses can suggest it, and the variant is recorded as an alias only when someone says so.
 */

const DASHES = /[‐-―−﹘﹣－]/g

/** The key a part number is stored and looked up under. */
export function mpnKey(mpn: string): string {
  return mpn.normalize('NFKC').replace(DASHES, '-').replace(/\s+/g, '').toUpperCase()
}

/** Letters and digits only: for "is this the same part number?" comparisons across distributors. */
export function mpnLoose(mpn: string): string {
  return mpnKey(mpn).replace(/[^A-Z0-9]/g, '')
}

/** Suffixes distributors and manufacturers add for the carrier (tape and reel, cut tape, tube) or lead-free marking. */
const PACKAGING_SUFFIXES: readonly RegExp[] = [
  /[-/#]?(?:TR|T&R|TAPE|REEL|REEL7|REEL13|R7|R13|CT|CUT)$/, // -TR, /TR, -REEL7, /R7
  /[-/]?(?:NOPB|PBF|LF)$/, // lead-free markers: /NOPB, #PBF
  /,\d{3}$/, // NXP-style ordering code: ,115
  /-T\d?$/, // -T, -T1
]

/** A shorter key this one looks like a packaging variant of, or null. A hint, never a merge. */
export function packagingBase(key: string): string | null {
  for (const re of PACKAGING_SUFFIXES) {
    const base = key.replace(re, '')
    if (base !== key && base.length >= 3) return base
  }
  return null
}
