/**
 * What shows while a page is on its way (test-esp32 #15: the project page was blank, all black, for about 3 s on first
 * navigation). ShellSkeleton is the signed-in shell's outline (rail, top bar, a page), shown while trace checks who is
 * signed in; PageSkeleton is a page's outline inside the shell, shown while its code loads. index.html draws the same
 * outline before any script has run.
 */
import { Skeleton } from '@/components/ui/skeleton'

export function PageSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-6 px-4 pt-4 md:px-6 md:pt-8" role="status" aria-label="Loading">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-32 rounded-xl" />
      <Skeleton className="h-44 rounded-xl" />
    </div>
  )
}

export function ShellSkeleton() {
  return (
    <div className="flex min-h-dvh bg-background">
      <div className="hidden w-12 shrink-0 flex-col gap-3 border-r bg-sidebar p-3 md:flex xl:w-64" aria-hidden>
        <Skeleton className="h-6 w-6 xl:w-24" />
        <div className="mt-4 space-y-3">
          {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-5 w-6 xl:w-36" />)}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex h-14 items-center gap-3 border-b px-4 md:px-6" aria-hidden>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="ml-auto h-8 w-48 max-md:hidden" />
          <Skeleton className="size-8 rounded-full" />
        </div>
        <PageSkeleton />
      </div>
    </div>
  )
}
