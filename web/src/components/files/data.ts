/**
 * Where a file's bytes come from. A file in the repository is read through `files.url` (a short-lived signed link,
 * re-asked for before it expires, never stored); a run's output through the existing `artifact` action (bytes as
 * base64, turned into a local object URL). Content is cached by repo, path and version, never by the signed link,
 * so a fresh link does not mean a fresh download.
 */
import { useQuery } from '@tanstack/react-query'
import { type ArgsOf, call, projectId } from '@/lib/api'
import { baseName } from './kinds'

/** One version of a file, newest first in `FileRef.versions`. */
export interface FileVersion {
  commit: string
  at?: string | null
  /** who made the commit, as GitHub has it */
  by?: string | null
  release?: string
  size?: number
  /** "Push abc123: 2 findings fixed" */
  note?: string
}

/** A marker on a drawing or board, in its own millimetres (KiCad's ERC/DRC `pos`). */
export interface FileFinding {
  id: string
  severity: 'blocks' | 'fix' | 'waived'
  text: string
  x_mm: number
  y_mm: number
  ref?: string
  /** a schematic finding: the sheet path KiCad gave it ('/', '/Power/') */
  sheet?: string
}

/** Everything a viewer needs to know about a file. Only repo and path are required. */
export interface FileRef {
  repo: string
  path: string
  /** the API's kind (a group such as design, fabrication) or an extension */
  kind?: string
  size?: number
  release?: string
  /** a release's files are frozen */
  frozen?: boolean
  commit?: string
  at?: string
  revision?: string
  versions?: FileVersion[]
  findings?: FileFinding[]
  /** a run's output, read through `artifact` */
  run?: { id: string; name: string }
  /** an address already in hand (a nested file inside an archive, a tool's own link) */
  url?: string
  /** cited place: a PDF page, with an optional region in PDF points [x, y, w, h] from the page's top left */
  cite?: { page?: number; region?: [number, number, number, number]; text?: string }
}

/** What files.list answers per file: the documented fields, and the ones the viewer reads when the API gives them. */
export type ListedFile = { path: string; kind: string; size: number; release?: string } & Partial<Pick<FileRef, 'frozen' | 'commit' | 'at' | 'revision' | 'versions' | 'findings'>>

export const fileName = (f: Pick<FileRef, 'path'>) => baseName(f.path)

/** The app's own address for a file (what Copy link copies; never the signed link). */
export function fileHref(f: Pick<FileRef, 'repo' | 'path' | 'run'>, o: { bare?: boolean } = {}): string {
  const path = f.run ? `runs/${f.run.id}/${f.run.name}` : f.path
  return `${o.bare ? '/view' : ''}/p/${projectId(f.repo)}/files/${path.split('/').map(encodeURIComponent).join('/')}`
}

/** A path under runs/<id>/<name> is a run's output. */
export function runOf(path: string): { id: string; name: string } | undefined {
  const m = /^runs\/([^/]+)\/(.+)$/.exec(path)
  return m ? { id: m[1]!, name: m[2]! } : undefined
}

const b64ToBytes = (b64: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// object URLs made from artifacts, one per run file (the bytes cannot change)
const artifactUrls = new Map<string, string>()

/** Resolve a link for the file (and version). Signed links live 5 minutes; we ask again after 4. */
export async function resolveUrl(f: FileRef, commit?: string): Promise<{ url: string; mime?: string | null; size?: number }> {
  if (f.url && !commit) return { url: f.url }
  if (f.run) {
    const key = `${f.repo}|${f.run.id}|${f.run.name}`
    const have = artifactUrls.get(key)
    if (have) return { url: have }
    const a = await call('artifact', { repo: f.repo, id: f.run.id, name: f.run.name })
    const url = URL.createObjectURL(new Blob([b64ToBytes(a.base64)], { type: a.mime ?? 'application/octet-stream' }))
    artifactUrls.set(key, url)
    return { url, mime: a.mime, size: a.size }
  }
  // `commit` asks for an earlier version. The API answers bytes (base64) up to 8 MB or GitHub's link above that;
  // call() turns bytes into a local address (lib/readers.ts readFileUrl), so `url` is always there
  const args: ArgsOf<'files.url'> = { repo: f.repo, path: f.path, ...(commit ? { commit } : {}) }
  return call('files.url', args)
}

const versionKey = (f: FileRef, commit?: string) => [f.repo, f.run ? `runs/${f.run.id}/${f.run.name}` : f.path, commit ?? f.commit ?? 'current', f.url ?? ''] as const

/** The signed link for a file, kept fresh. */
export function useFileUrl(f: FileRef | null, commit?: string) {
  return useQuery({
    queryKey: ['files.url', ...(f ? versionKey(f, commit) : ['none'])],
    queryFn: () => resolveUrl(f!, commit),
    enabled: !!f,
    staleTime: 4 * 60_000,
    refetchInterval: f?.url || f?.run ? false : 4 * 60_000,
  })
}

async function fetchBytes(f: FileRef, commit?: string, limit?: number): Promise<ArrayBuffer> {
  const { url } = await resolveUrl(f, commit)
  const res = await fetch(url, limit ? { headers: { range: `bytes=0-${limit - 1}` } } : undefined)
  if (!res.ok && res.status !== 206) throw new Error(`The file could not be read (${res.status}).`)
  return res.arrayBuffer()
}

/** The file's bytes (cached by version, not by link). */
export function useFileBytes(f: FileRef | null, o: { commit?: string; enabled?: boolean; refetchMs?: number | false } = {}) {
  return useQuery({
    queryKey: ['file.bytes', ...(f ? versionKey(f, o.commit) : ['none'])],
    queryFn: () => fetchBytes(f!, o.commit),
    enabled: !!f && o.enabled !== false,
    staleTime: Infinity,
    refetchInterval: o.refetchMs ?? false,
  })
}

/** The file as text (UTF-8). */
export function useFileText(f: FileRef | null, o: { commit?: string; enabled?: boolean; refetchMs?: number | false } = {}) {
  return useQuery({
    queryKey: ['file.text', ...(f ? versionKey(f, o.commit) : ['none'])],
    queryFn: async () => new TextDecoder().decode(await fetchBytes(f!, o.commit)),
    enabled: !!f && o.enabled !== false,
    staleTime: o.refetchMs ? 0 : Infinity,
    refetchInterval: o.refetchMs ?? false,
  })
}

/** Save the file with its own name. */
export async function downloadFile(f: FileRef, commit?: string): Promise<void> {
  const { url } = await resolveUrl(f, commit)
  const a = document.createElement('a')
  a.href = url
  a.download = baseName(f.path)
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
}
