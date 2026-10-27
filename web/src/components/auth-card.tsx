import type { ReactNode } from 'react'
import { Wordmark } from '@/components/shell/app-sidebar'
import { cn } from '@/lib/utils'

/** The centred card every sign-in page uses, on a plain background. */
export function AuthCard({ title, description, children, wordmark = true, footer, className }: { title: ReactNode; description?: ReactNode; children: ReactNode; wordmark?: boolean; footer?: ReactNode; className?: string }) {
  return (
    <main id="main" className="flex min-h-dvh items-start justify-center bg-muted/40 px-4 pt-[12vh] pb-10 dark:bg-background">
      <div className={cn('w-full max-w-[400px] rounded-xl border bg-card p-8 shadow-xs', className)}>
        {wordmark && (
          <div className="mb-6">
            <Wordmark />
          </div>
        )}
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>}
        <div className="mt-6">{children}</div>
        {footer && <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div>}
      </div>
    </main>
  )
}

export function FieldError({ children }: { children?: ReactNode }) {
  if (!children) return null
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  )
}
