/**
 * Where you are, as a breadcrumb (Soil sensor · Rev A · Capture). Each route declares its crumb with
 * `staticData: { crumb: 'Projects' }` or a loader-free function of its params; a screen can also set the current
 * title at run time with `useCrumb('Soil sensor · Rev A')` (the project page does, once the journey has loaded).
 * On a phone it shrinks to the current page's title with a back arrow.
 */
import { Link, useMatches, useRouter } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
import { Fragment, useEffect } from 'react'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { createStore, useStore } from '@/lib/store'

const runtime = createStore<Record<string, string>>({})

/** Set the crumb for the current route at run time (cleared when the screen unmounts). */
export function useCrumb(routeId: string, label: string | undefined) {
  useEffect(() => {
    if (!label) return
    runtime.set((s) => ({ ...s, [routeId]: label }))
    return () => runtime.set((s) => {
      const { [routeId]: _gone, ...rest } = s
      return rest
    })
  }, [routeId, label])
}

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    crumb?: string | ((params: Record<string, string>) => string)
    /** a crumb shown before this route's own ("Projects" before a project) */
    parent?: { label: string; to: string }
    /** the route draws without the shell (Focus mode, sign-in) */
    bare?: boolean
  }
}

export function useCrumbs(): { label: string; to: string }[] {
  const matches = useMatches()
  const names = useStore(runtime)
  return matches.flatMap((m) => {
    const c = names[m.routeId] ?? (typeof m.staticData?.crumb === 'function' ? m.staticData.crumb(m.params as Record<string, string>) : m.staticData?.crumb)
    const out: { label: string; to: string }[] = []
    if (m.staticData?.parent) out.push(m.staticData.parent)
    if (c) out.push({ label: c, to: m.pathname })
    return out
  })
}

export function Breadcrumbs() {
  const crumbs = useCrumbs()
  const router = useRouter()
  const last = crumbs[crumbs.length - 1]
  return (
    <>
      <div className="flex min-w-0 items-center gap-1 md:hidden">
        {crumbs.length > 1 && (
          <button type="button" aria-label="Back" className="-ml-1 rounded p-1 hover:bg-accent" onClick={() => router.history.back()}>
            <ChevronLeft className="size-5" />
          </button>
        )}
        <span className="truncate font-medium">{last?.label}</span>
      </div>
      <Breadcrumb className="hidden min-w-0 md:block">
        <BreadcrumbList className="flex-nowrap">
          {crumbs.map((c, i) => (
            <Fragment key={c.to + i}>
              {i > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem className="min-w-0">
                {i === crumbs.length - 1 ? (
                  <BreadcrumbPage className="truncate font-medium">{c.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link to={c.to} className="truncate">{c.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
    </>
  )
}
