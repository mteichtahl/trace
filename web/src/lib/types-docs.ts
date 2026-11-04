/**
 * The Documents tab's record, as documents.get answers it (src/api/actions-documents.ts; docs/scribe.md
 * "Publishing"): each project document with how current it is, its newest print and each revision's release copies.
 */
export type DocKind = 'hld' | 'lld' | 'protocol' | 'guide'

/**
 * current: nothing it is written from changed since it was written; behind: a record changed since, or a section due
 * by the stage is still to write; missing: the stage needs it and it is not written yet; later: not needed yet;
 * unknown: written, but trace could not compare its commit.
 */
export type DocState = 'current' | 'behind' | 'missing' | 'later' | 'unknown'

export interface Printed {
  kind: DocKind
  sha256: string
  bytes: number
  /** the commit it was printed at */
  commit: string | null
  /** the docs.publish run that printed it */
  run: string
  /** epoch ms */
  at: number
}

export interface DocSection {
  id: string
  title: string
  /** the stage it is due by (a stage id) */
  due: string
  written: boolean
  /** due by the project's stage and not written yet */
  overdue: boolean
}

export interface ProjectDocument {
  kind: DocKind
  title: string
  /** its path in the repository (docs/design/*.md) */
  file: string
  exists: boolean
  /** the stage needs it now */
  due: boolean
  /** the stage it starts at (a stage id) */
  from: string
  state: DocState
  revision: string | null
  /** the commit it was last written at (front matter) */
  commit: string | null
  /** the day it was last written, YYYY-MM-DD */
  updated: string | null
  /** the records changed since it was written (requirements, schematic, board, …) */
  behind: string[]
  sections: DocSection[]
  /** its newest print; `current`: printed from the text as it is now */
  printed: (Printed & { current: boolean }) | null
}

export interface ReleaseCopies {
  revision: string
  /** the record copied into the repository for the revision (journey.snapshot), when there is one */
  cut: { at: number; commit: string | null; branch: string | null } | null
  documents: (Printed & { title: string })[]
}

export interface DocumentsView {
  repo: string
  branch: string
  commit: string
  stage: string | null
  documents: ProjectDocument[]
  /** newest revision first */
  releases: ReleaseCopies[]
  /** the Documentation agent's job when one is queued or running */
  writing: { job: string; state: string; since: string | null } | null
  /** when the nightly check next runs (ISO) */
  next_check: string
}
