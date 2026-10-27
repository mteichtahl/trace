import { Column } from '@/components/shell/app-shell'

/** A screen that is specified in docs/ui-design.md but not built yet. Replace the route's component when building it. */
export function NotBuilt({ title, section }: { title: string; section?: string }) {
  return (
    <Column>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        This screen is designed{section ? ` (docs/ui-design.md, “${section}”)` : ''} but not built yet.
      </p>
    </Column>
  )
}
