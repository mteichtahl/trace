/**
 * Content hashes over a normalised form (docs/ontology.md "Content check"): where a file holds things that do not matter
 * to what is made from it (when it was written, which program version wrote it), the hash leaves them out, so the same
 * design in substance always has the same hash and lineage stops a cascade there (src/ontology/lineage.ts).
 *
 *   normalise(name, bytes)      the bytes the hash is taken over, by the file's kind (its name or extension)
 *   normalisedHash(name, bytes) sha256 of that, hex
 *
 * Kinds:
 *   KiCad files and exports (.kicad_sch, .kicad_pcb, .kicad_pro, netlists, s-expression .net)
 *                               the (date …), (tool …) and (generator_version …) fields dropped
 *   text reports (.rpt, .txt, .json, .csv, .log and anything that is UTF-8 text)
 *                               lines that only say when or by which version it was made dropped ("Date:", "Report
 *                               created on", "** Created on", "generated …"), line ends made \n, trailing spaces gone
 *   anything else               as it is
 */
import { createHash } from 'node:crypto'

const SEXPR = /\.(kicad_sch|kicad_pcb|kicad_pro|kicad_sym|kicad_mod|net)$|netlist/i
const TEXTY = /\.(rpt|txt|json|csv|log|md|xml|cir|sp|v|sv)$|report/i
const WHEN_LINE = /^\s*(\*\*\s*)?(date|report created on|created on|generated (on|at|by)|kicad version|tool version)\b.*$/gim

function asText(bytes: Uint8Array): string | null {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null }
}

/** The bytes `name`'s hash is taken over. */
export function normalise(name: string, bytes: Uint8Array): Uint8Array {
  const text = asText(bytes)
  if (text === null) return bytes
  if (SEXPR.test(name)) {
    const out = text.replace(/\(\s*(date|tool|generator_version)\s+"[^"]*"\s*\)/g, '').replace(/\r\n?/g, '\n')
    return new TextEncoder().encode(out)
  }
  if (TEXTY.test(name) || !/[\x00-\x08]/.test(text)) {
    const out = text.replace(/\r\n?/g, '\n').replace(WHEN_LINE, '').replace(/[ \t]+$/gm, '')
    return new TextEncoder().encode(out)
  }
  return bytes
}

/** The hash of `name`'s normalised content, hex. */
export function normalisedHash(name: string, bytes: Uint8Array): string {
  return createHash('sha256').update(normalise(name, bytes)).digest('hex')
}
