/**
 * One Knowledge result: chips for the source (document and page, datasheet and page, memory and when) and the
 * project, the summary line, the matching passage with the query's words marked, and what to do with it.
 */
import { BookOpen, Brain, Cpu, FileText } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { askTrace } from '@/components/chat/chat-state'
import { projectName } from '@/lib/api'
import { type KnowledgeResult, markPieces, switchedBy } from '@/lib/knowledge'
import { ago } from '@/lib/format'
import { cn } from '@/lib/utils'

const ICON: Record<KnowledgeResult['kind'], ComponentType<{ className?: string }>> = { document: FileText, datasheet: BookOpen, memory: Brain, part: Cpu }
const KIND: Record<KnowledgeResult['kind'], string> = { document: 'Document', datasheet: 'Datasheet', memory: 'Agent memory', part: 'Part' }

export function Marked({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {markPieces(text, terms).map((p, i) =>
        p.mark ? (
          <mark key={i} className="match">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

export function Chip({ children, mono, className }: { children: ReactNode; mono?: boolean; className?: string }) {
  return <Badge variant="outline" className={cn('rounded-md font-normal text-foreground/80', mono && 'font-mono', className)}>{children}</Badge>
}

export interface ResultCardProps {
  r: KnowledgeResult
  terms: string[]
  onOpen: (r: KnowledgeResult) => void
  /** memory results: switch off / back on, when this person may */
  onSwitch?: (r: KnowledgeResult) => void
}

export function ResultCard({ r, terms, onOpen, onSwitch }: ResultCardProps) {
  const Icon = ICON[r.kind]
  const m = r.memory
  const off = m && !m.active
  const when = m?.createdAt ? ago(m.createdAt) : null
  return (
    <article className={cn('rounded-xl border bg-card p-4 md:p-5', off && 'border-dashed bg-muted/30')} data-result={r.kind}>
      <div className="flex flex-wrap items-center gap-1.5">
        {off && <StatusBadge status="idle" label="Switched off" />}
        <Chip>
          <Icon className="size-3 text-muted-foreground" aria-hidden />
          {KIND[r.kind]} · <span className={cn((r.kind === 'document' || r.kind === 'datasheet') && 'font-mono')}>{r.source}</span>
          {when ? ` · ${when}` : ''}
        </Chip>
        <Chip>{r.repo ? (r.kind === 'datasheet' ? `${projectName(r.repo)} knowledge base` : projectName(r.repo)) : 'Shared library'}</Chip>
      </div>
      <h3 className={cn('mt-2.5 text-[15px] font-medium leading-snug', off && 'text-muted-foreground line-through')}>
        {r.kind === 'memory' ? <Marked text={r.summary} terms={terms} /> : r.summary}
      </h3>
      {r.passage && r.passage !== r.summary && (
        <blockquote className="mt-2.5 rounded-lg bg-muted/60 px-3 py-2 text-sm text-foreground/85">
          “<Marked text={r.passage} terms={terms} />”
        </blockquote>
      )}
      {off && m?.inactive && (
        <p className="mt-2 text-sm text-muted-foreground">
          Switched off {m.inactive.at ? ago(m.inactive.at) : ''} by {switchedBy(m)}: “{m.inactive.reason}”. Agents no longer use it.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <button type="button" className="text-primary hover:underline" onClick={() => onOpen(r)}>
          {r.kind === 'datasheet' ? `Open at page ${r.page}` : r.kind === 'memory' ? 'Open memory' : 'Open document'}
        </button>
        <button type="button" className="text-muted-foreground hover:text-foreground hover:underline" onClick={() => askTrace(`Tell me more about this, from ${r.kind === 'memory' ? 'agent memory' : r.source}${r.repo ? ` on ${projectName(r.repo)}` : ''}: "${r.summary}"`)}>
          Add to chat
        </button>
        {m && m.active && <StatusBadge plain status="met" label="Active" />}
        {m && onSwitch && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => onSwitch(r)}>
            {off ? 'Switch back on' : 'Switch off…'}
          </Button>
        )}
      </div>
    </article>
  )
}
