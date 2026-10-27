/**
 * Registers the File viewer with the chat, so every File card (any tool result shaped { path, kind?, url? }) draws as
 * the viewer's card size. The registration is tiny; the viewer itself loads on the first file card.
 */
import { lazy, Suspense } from 'react'
import { registerFileViewer } from '@/components/chat/cards'
import type { FileData } from '@/components/chat/cards'
import { useContextEntries } from '@/components/chat/context'
import { repoOf } from '@/lib/api'
import { runOf, type FileRef } from './data'

const ChatFile = lazy(() => import('./chat-file'))

/** The project a file card belongs to: its own repo, else the project in view. */
function useRepo(data: FileData): string | undefined {
  const { entries } = useContextEntries()
  if (data.repo) return data.repo
  const e = entries.find((x) => x.id === 'project')
  const v = e?.value as { repo?: string } | undefined
  if (v?.repo) return v.repo
  const id = typeof location !== 'undefined' ? /^\/(?:view\/)?p\/([^/]+)/.exec(location.pathname)?.[1] : undefined
  return id ? repoOf(decodeURIComponent(id)) : undefined
}

export function toFileRef(data: FileData, repo: string): FileRef {
  const run = data.run ? { id: data.run, name: data.path.split('/').pop() ?? data.path } : runOf(data.path)
  return { repo, path: data.path, size: data.size, url: data.url, run, kind: data.kind, cite: data.page ? { page: data.page } : undefined }
}

function Card({ file }: { file: FileData }) {
  const repo = useRepo(file)
  if (!repo) return null
  return (
    <Suspense fallback={<div className="my-2 h-24 animate-pulse rounded-xl border bg-muted/40" />}>
      <ChatFile file={toFileRef(file, repo)} />
    </Suspense>
  )
}

registerFileViewer('*', ({ file }) => <Card file={file} />, { ownFrame: true })
