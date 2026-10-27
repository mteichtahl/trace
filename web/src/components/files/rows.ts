/** The Files screen's rows: grouped by kind, newest first, a release's files marked frozen. */
import type { ListedFile } from './data'
import { GROUPS, type FileGroup, baseName, groupOf, kindLabel } from './kinds'

export interface FileRow {
  path: string
  name: string
  folder: string
  group: string
  kind: string
  release: string
  frozen: boolean
  size: number
  at: string
  commit: string
  findings: number
  raw: ListedFile
}

export const GROUP_LABEL = Object.fromEntries(GROUPS.map((g) => [g.id, g.label])) as Record<FileGroup, string>

/** Newest first (by when the file last changed; files with no date after, by path). */
export function newestFirst<T extends { at: string; path: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (b.at || '').localeCompare(a.at || '') || a.path.localeCompare(b.path))
}

export function toRows(list: ListedFile[]): FileRow[] {
  return newestFirst(
    list.map((f) => {
      const parts = f.path.split('/')
      return {
        path: f.path,
        name: baseName(f.path),
        folder: parts.slice(0, -1).join('/'),
        group: GROUP_LABEL[groupOf(f.path, f.kind)],
        kind: kindLabel(f.path),
        release: f.release ?? '',
        frozen: f.frozen ?? !!f.release,
        size: f.size,
        at: f.at ?? f.versions?.[0]?.at ?? '',
        commit: (f.commit ?? f.versions?.[0]?.commit ?? '').slice(0, 7),
        findings: f.findings?.filter((x) => x.severity !== 'waived').length ?? 0,
        raw: f,
      }
    }),
  )
}

