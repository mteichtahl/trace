/** The full-page File viewer, shared by the page in the shell and the popped-out window. */
import { Link } from '@tanstack/react-router'
import type { UseQueryResult } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { Partial } from '@/components/states'
import { cn } from '@/lib/utils'
import type { FileRef } from './data'
import { FileViewer } from './file-viewer'

export function FilePage({ id, file, list, known, popOut, bare }: { id: string; file: FileRef; list: UseQueryResult<unknown>; known: boolean; popOut?: boolean; bare?: boolean }) {
  return (
    <div className={cn('flex min-h-0 flex-col', bare ? 'h-dvh' : 'h-[calc(100dvh-3.5rem)] max-md:h-[calc(100dvh-3.5rem-4.5rem)]')}>
      {!bare && (
        <div className="flex items-center gap-2 border-b px-4 py-1.5 text-xs md:hidden">
          <Link to="/p/$id/files" params={{ id }} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" /> All files
          </Link>
        </div>
      )}
      {list.isError && (
        <div className="px-4 pt-2">
          <Partial onRetry={() => void list.refetch()}>The project's file list could not be loaded, so versions and findings are missing. The file itself is shown.</Partial>
        </div>
      )}
      {list.isSuccess && !known && (
        <div className="px-4 pt-2">
          <Partial>This file is not in the project's file list. It may have moved or been removed; it is shown as the repository has it.</Partial>
        </div>
      )}
      <FileViewer file={file} size="page" popOut={popOut} className="min-h-0 flex-1" />
    </div>
  )
}
