/**
 * The File viewer, full page (/p/:id/files/<path>): the whole width, shareable by link, any format. Not nested in the
 * project header (the viewer needs the room); the breadcrumb carries Project · Files · name. `?page=12` opens a PDF at
 * a cited page. Pop out opens the same file at /view/p/:id/files/<path>, without the shell.
 */
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { useCrumb } from '@/components/shell/breadcrumbs'
import { useCommands } from '@/components/shell/command-menu'
import { NotShared } from '@/components/states'
import { useTraceContext } from '@/components/chat/context'
import { FilePage } from '@/components/files/file-page'
import { askAbout } from '@/components/files/file-viewer'
import { downloadFile } from '@/components/files/data'
import { baseName } from '@/components/files/kinds'
import { useFile } from '@/components/files/use-file'
import { ApiError, projectName, repoOf } from '@/lib/api'
import { useJourney } from '@/lib/queries'

export const Route = createFileRoute('/_app/p/$id_/files/$')({
  staticData: { crumb: (p) => baseName(decodeURIComponent(p._splat ?? '')), parent: { label: 'Projects', to: '/projects' } },
  validateSearch: z.object({ page: z.coerce.number().int().positive().optional() }),
  component: FilePageRoute,
})

function FilePageRoute() {
  const { id, _splat } = Route.useParams()
  const { page } = Route.useSearch()
  const repo = repoOf(id)
  const path = decodeURIComponent(_splat ?? '')
  const j = useJourney(repo)
  const name = j.data?.name ?? projectName(repo)
  const { file, list, known } = useFile(repo, path, page ? { page } : undefined)
  useTraceContext({ label: name, description: 'The project the person is looking at', value: { repo, name, revision: j.data?.revision ?? null } }, 'project')
  useCrumb('/_app/p/$id_/files/$', `${name}${j.data ? ` · ${j.data.revision}` : ''} · Files · ${baseName(path)}`)
  useCommands([
    { id: 'file-ask', label: 'Ask about this file', group: 'This file', run: () => askAbout(file) },
    { id: 'file-download', label: `Download ${baseName(path)}`, group: 'This file', run: () => void downloadFile(file) },
    { id: 'file-pop', label: 'Pop out this file', group: 'This file', run: () => window.open(`/view/p/${id}/files/${_splat}`, '_blank', 'noopener,popup') },
  ])
  if (j.error instanceof ApiError && j.error.noAccess) return <NotShared />
  return <FilePage id={id} file={file} list={list} known={known} popOut />
}
