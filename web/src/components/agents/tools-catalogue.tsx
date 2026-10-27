/**
 * The tools catalogue: tools.list grouped by family, each tool with its plain name and its mono tool name, its
 * description, where it runs, its status, when it was last used and its error rate (from the projects' runs), and Try
 * it for read-only tools. Bench tools never come from the API (they run only on a machine with hardware allowed), so
 * that family is described rather than listed.
 */
import { Link } from '@tanstack/react-router'
import { ChevronDown, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { SideSheet } from '@/components/side-sheet'
import { EmptyState, Loading, Partial, QueryError, SkeletonRows } from '@/components/states'
import { StatusBadge } from '@/components/status-badge'
import { Term } from '@/components/term'
import { ago } from '@/lib/format'
import { RUNS_ON_WORD, type ToolInfo, canTry, groupTools, plainName, runsOn } from '@/lib/tools-catalogue'
import { TryIt, useTryRepos } from './try-it'
import { type ToolUse, useCatalogue } from './use-agents'

export function lastUsedWords(u: ToolUse | undefined): string {
  if (!u?.lastUsed) return 'Not used on your projects yet'
  const rate = u.errorRate === null ? '' : ` · errors ${Math.round(u.errorRate * 100)}%`
  return `Last used ${ago(u.lastUsed * 1000)}${rate}`
}

export function ToolStatus({ t, u }: { t: ToolInfo; u?: ToolUse }) {
  void t
  if (u && u.runs >= 3 && (u.errorRate ?? 0) >= 0.5) return <StatusBadge status="warning" label="Often failing" />
  return <StatusBadge status="met" label="Available" />
}

export function ToolsCatalogue() {
  const c = useCatalogue()
  const [text, setText] = useState('')
  const [trying, setTrying] = useState<ToolInfo | null>(null)
  const reviewer = useTryRepos().length === 0
  const t = text.trim().toLowerCase()
  const groups = useMemo(() => groupTools(c.tools.filter((x) => !t || `${x.name} ${x.description} ${plainName(x)}`.toLowerCase().includes(t))), [c.tools, t])

  return (
    <section aria-labelledby="tools-h" className="mt-10">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 id="tools-h" className="section-label flex-1">Tools · grouped by family</h2>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search tools…" className="pl-8" aria-label="Search tools" />
        </div>
      </div>
      {c.runsFailed.length > 0 && <Partial onRetry={c.retry}>When tools were last used could not be read for every project; the rest is shown.</Partial>}
      {c.error ? (
        <QueryError error={c.error} what="the tools" onRetry={c.retry} />
      ) : c.loading ? (
        <Loading><SkeletonRows rows={4} /></Loading>
      ) : c.tools.length === 0 ? (
        <EmptyState>No tools are listed. You need to be on a project to see its tools.</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          {groups.map((g, i) => (
            <Collapsible key={g.family.id} defaultOpen={i < 3 || !!t} className="border-b last:border-b-0">
              <CollapsibleTrigger className="group flex w-full items-center gap-2 bg-muted/40 px-4 py-3 text-left">
                <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" aria-hidden />
                <span className="font-semibold">{g.family.label}</span>
                <span className="text-xs text-muted-foreground">{g.tools.length} {g.tools.length === 1 ? 'tool' : 'tools'}</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="divide-y">
                  {g.tools.map((tool) => {
                    const u = c.use.get(tool.name)
                    const where = runsOn(tool.name)
                    return (
                      <li key={tool.name} className="grid gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] md:pl-10">
                        <div className="min-w-0">
                          <Link to="/agents/tools/$tool" params={{ tool: tool.name }} className="font-medium hover:underline">{plainName(tool)}</Link>
                          <p className="font-mono text-xs text-muted-foreground">{tool.name}</p>
                          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{tool.description}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{lastUsedWords(u)}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-3 sm:flex-col sm:items-end">
                          <span className="text-xs text-muted-foreground">Runs on: {where === 'gpu' ? <Term term="GPU" definition="A graphics card: trace sends routing and rendering there">{RUNS_ON_WORD[where]}</Term> : RUNS_ON_WORD[where]}</span>
                          <ToolStatus t={tool} u={u} />
                          {canTry(tool, { reviewer }) && (
                            <Button variant="outline" size="sm" onClick={() => setTrying(tool)}>Try it</Button>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          ))}
          <div className="border-t bg-muted/20 px-4 py-3">
            <p className="font-semibold">Bench instruments (hardware in the loop)</p>
            <p className="text-sm text-muted-foreground"><StatusBadge plain status="idle" label="Bench only" /> These run on a machine with hardware allowed, never from the web, so they are not listed here.</p>
          </div>
        </div>
      )}
      <SideSheet open={!!trying} onOpenChange={(o) => !o && setTrying(null)} title={trying ? `Try ${plainName(trying)}` : ''} description={trying ? <span className="font-mono">{trying.name}</span> : undefined}>
        {trying && <TryIt tool={trying} />}
      </SideSheet>
    </section>
  )
}
