/**
 * Admin › Project templates (plan P5.6): the four templates a project starts from, as this installation keeps them.
 * Each starts as trace's own; an admin changes one within trace's catalog (components/templates/template-editor.tsx),
 * and each save is the next version. Projects keep the version they started from. Data: templates.list, templates.get.
 */
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useTraceContext } from '@/components/chat/context'
import { Column } from '@/components/shell/app-shell'
import { NotShared, QueryError, SkeletonRows } from '@/components/states'
import { TemplateEditor } from '@/components/templates/template-editor'
import { useAuth } from '@/lib/auth'
import { ago } from '@/lib/format'
import { useAction } from '@/lib/queries'
import type { TemplateId } from '@/lib/types'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/admin/templates')({
  staticData: { crumb: 'Project templates' },
  component: Templates,
})

function Templates() {
  const { user } = useAuth()
  const admin = user?.class === 'admin'
  const [picked, setPicked] = useState<TemplateId>('board')
  const list = useAction('templates.list', {}, { enabled: admin })
  const one = useAction('templates.get', { template: picked }, { enabled: admin })
  useTraceContext({ label: 'Project templates', description: 'The screen the person is on: Admin, the project templates new projects start from, one open for editing', value: { templates: (list.data?.templates ?? []).map((t) => ({ id: t.id, name: t.name, version: t.version, changed: t.changed })), open: picked } }, 'screen')
  if (!admin) return <Column><NotShared /></Column>
  return (
    <Column>
      <h1 className="text-2xl font-semibold tracking-tight">Project templates</h1>
      <p className="mt-1 text-[15px] text-muted-foreground">
        The stages, gates and criteria a new project starts from. Each starts as trace's own; change one here, and new projects start from your version. A project keeps the version it started from.
      </p>
      {list.isError ? (
        <QueryError error={list.error} what="the templates" onRetry={() => void list.refetch()} />
      ) : list.isLoading ? (
        <SkeletonRows rows={2} />
      ) : (
        <div role="tablist" aria-label="Templates" className="mt-6 grid gap-2 sm:grid-cols-4">
          {(list.data?.templates ?? []).map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={picked === t.id} onClick={() => setPicked(t.id)}
              className={cn('rounded-lg border p-3 text-left transition-colors', picked === t.id ? 'border-foreground bg-accent' : 'hover:bg-accent/60')}>
              <span className="block font-medium">{t.name}</span>
              <span className="block text-xs text-muted-foreground">
                {t.changed ? `Version ${t.version}, by ${t.by ?? 'an admin'} ${t.updated ? ago(Date.parse(t.updated)) : ''}` : t.version ? `trace's own (version ${t.version})` : "trace's own"}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="mt-8">
        {one.isError ? (
          <QueryError error={one.error} what="the template" onRetry={() => void one.refetch()} />
        ) : one.isLoading || !one.data ? (
          <SkeletonRows rows={6} />
        ) : (
          <TemplateEditor view={one.data.template} catalog={one.data.catalog} code={one.data.code} history={one.data.history} />
        )}
      </div>
    </Column>
  )
}
