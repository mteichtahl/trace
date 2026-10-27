/** A file by its address: the path from the URL, its details from files.list (kind, release, versions, findings). */
import { useMemo } from 'react'
import { useAction } from '@/lib/queries'
import { type FileRef, type ListedFile, runOf } from './data'

export function fileFromList(repo: string, path: string, list: ListedFile[] | undefined, cite?: FileRef['cite']): FileRef {
  const run = runOf(path)
  const hit = list?.find((f) => f.path === path)
  return {
    repo,
    path: run ? path : path,
    run,
    cite,
    ...(hit ? { kind: hit.kind, size: hit.size, release: hit.release, frozen: hit.frozen ?? !!hit.release, commit: hit.commit ?? hit.versions?.[0]?.commit, at: hit.at, revision: hit.revision, versions: hit.versions, findings: hit.findings } : {}),
  }
}

/** The file at `path` in `repo`, with whatever files.list says about it. `known`: the list answered and has it. */
export function useFile(repo: string, path: string, cite?: FileRef['cite']) {
  const list = useAction('files.list', { repo }, { enabled: !runOf(path) })
  const file = useMemo(() => fileFromList(repo, path, list.data as ListedFile[] | undefined, cite), [repo, path, list.data, cite])
  const known = !!runOf(path) || !!list.data?.some((f) => f.path === path)
  return { file, list, known }
}
