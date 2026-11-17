/**
 * What the screens say of a project started from fabrication files (docs/fab-import.md; potroller-carrier-m20). Its
 * design was made outside trace: there is no schematic, board file, architecture or pin plan to show, and no release
 * trace built. The Design and Build tabs used to say "trace drafts the sheets from the architecture in Capture" and
 * "No release yet. The release gate freezes the design files into one", neither of which will ever happen for it.
 * Pure.
 */
import type { Journey } from './types'

export type Imported = NonNullable<Journey['imported']>

/** "revision M.20 of potroller-supervisor, made in KiCad Pcbnew 10.0.8", or '' when the Gerbers named nothing. */
export function designWords(i: Imported): string {
  const what = [i.revision ? `revision ${i.revision}` : '', i.name ? `of ${i.name}` : ''].filter(Boolean).join(' ')
  return [what, i.tool ? `made in ${i.tool}` : ''].filter(Boolean).join(', ')
}

/** The Design tab's one statement for an imported project. */
export function importedDesign(i: Imported): string {
  const w = designWords(i)
  return `This board was designed outside trace and started from its fabrication files${w ? ` (${w})` : ''}. trace holds no schematic, board file, block diagram or pin plan for it, and runs no rule checks on it: the earlier gates were signed on the files and the overview. Its Gerbers, bill of materials and placement file are under Files, and its order is on Build. A change to the design comes back as a new revision.`
}

/** The Design tab's empty states, by tab, for an imported project. */
export const IMPORTED_EMPTY = {
  architecture: 'No block diagram: the design was made outside trace. The project overview under Files says what the board does.',
  sheets: 'No schematic: the design was made outside trace, and only its fabrication files were given.',
  pins: 'No pin plan: the design was made outside trace.',
  board: 'No board file: trace has the Gerbers the board is made from, under Files, not the layout they came from.',
} as const

/** Build's "Releases" empty state for an imported project. */
export function importedRelease(i: Imported): string {
  const w = designWords(i)
  return `No release made in trace: the package is the imported one${w ? `, ${w}` : ''}${i.dir ? `, kept under ${i.dir}` : ''}. Open it from Files.`
}
