/** A popped-out file (/view/p/:id/files/<path>): the full-page viewer with no shell, and Ask trace as a side sheet. */
import { createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'
import { z } from 'zod'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { AskTrace } from '@/components/chat/chat-panel'
import { openPanel, usePanel } from '@/components/chat/chat-state'
import { useTraceContext } from '@/components/chat/context'
import { NotShared } from '@/components/states'
import { FilePage } from '@/components/files/file-page'
import { baseName } from '@/components/files/kinds'
import { useFile } from '@/components/files/use-file'
import { ApiError, projectName, repoOf } from '@/lib/api'
import { useJourney } from '@/lib/queries'

export const Route = createFileRoute('/view/p/$id/files/$')({
  validateSearch: z.object({ page: z.coerce.number().int().positive().optional() }),
  component: PoppedOut,
})

function PoppedOut() {
  const { id, _splat } = Route.useParams()
  const { page } = Route.useSearch()
  const repo = repoOf(id)
  const path = decodeURIComponent(_splat ?? '')
  const j = useJourney(repo)
  const name = j.data?.name ?? projectName(repo)
  const { file, list, known } = useFile(repo, path, page ? { page } : undefined)
  const panel = usePanel()
  useTraceContext({ label: name, description: 'The project the person is looking at', value: { repo, name } }, 'project')
  useEffect(() => {
    document.title = `${baseName(path)} · ${name} · trace`
  }, [path, name])
  if (j.error instanceof ApiError && j.error.noAccess) return <NotShared />
  return (
    <>
      <FilePage id={id} file={file} list={list} known={known} bare />
      <Sheet open={panel.open} onOpenChange={(o) => openPanel(o)}>
        <SheetContent className="w-full gap-0 p-0 sm:max-w-[440px]" showCloseButton={false} aria-describedby={undefined}>
          <SheetTitle className="sr-only">Ask trace</SheetTitle>
          <AskTrace onClose={() => openPanel(false)} className="min-h-0 flex-1" />
        </SheetContent>
      </Sheet>
    </>
  )
}
