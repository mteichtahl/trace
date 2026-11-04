/**
 * The Renders tab's record, as renders.list answers it (src/api/actions-renders.ts): each revision's photorealistic
 * renders, newest first, and the revisions whose renders are still being made.
 */
export type Shot = 'board' | 'board-top' | 'board-bottom' | 'case' | 'board-in-case' | 'exploded'

export interface RenderPicture {
  /** the file name: <project>_rev-<revision>_<YYYY-MM-DD>_<shot>.png, also the run artifact's name */
  name: string
  shot: Shot
  label: string
  bytes: number | null
  width: number | null
  height: number | null
}

export interface RevisionRenders {
  revision: string
  /** the day the revision was cut, YYYY-MM-DD */
  date: string
  /** the render run whose artifacts the pictures are */
  run: string
  at: string | null
  commit: string | null
  palette: { source: 'logo' | 'neutral'; base: string; accent: string; neutral: string; background: [string, string]; logo: string | null }
  /** the case's look (nylon, resin, black, pla, aluminium), or null when there is no case */
  case: string | null
  pictures: RenderPicture[]
}

export interface MakingRenders {
  revision: string
  date: string | null
  /** the rendering job, whose log RunSheet opens */
  job: string
  state: string
  step: string | null
  since: string | null
}

export interface RendersView { repo: string; revisions: RevisionRenders[]; making: MakingRenders[]; shots: Shot[] }
