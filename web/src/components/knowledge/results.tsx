/**
 * The ranked results list shared by Knowledge's tabs: strong matches first with the summary line ("6 strong matches ·
 * only from projects you're on · Show weaker matches"), the rest behind Show weaker matches; what did not arrive is a
 * Partial with Try again; opening a result opens its viewer in a side sheet.
 */
import { useState } from 'react'
import { SkeletonRows, Loading, Partial, EmptyState } from '@/components/states'
import { MemorySheet } from '@/components/memory/memory-sheet'
import { useMaySwitch, useMemorySwitch } from '@/components/memory/switch'
import { projectName } from '@/lib/api'
import { type KnowledgeResult, type MemoryView, queryTerms } from '@/lib/knowledge'
import { plural } from '@/lib/format'
import { ResultCard } from './result-card'
import { type SearchOutcome, failedWords, libraryRepo } from './use-knowledge'
import { DatasheetSheet, type DocTarget, DocumentSheet, type SheetTarget } from './viewers'

export function useOpeners(all: string[]) {
  const [doc, setDoc] = useState<DocTarget | null>(null)
  const [sheet, setSheet] = useState<SheetTarget | null>(null)
  const [memory, setMemory] = useState<MemoryView | null>(null)
  const open = (r: KnowledgeResult, terms: string[] = []) => {
    if (r.memory) setMemory(r.memory)
    else if (r.kind === 'datasheet' && r.mpn) setSheet({ repo: r.repo ?? libraryRepo({ q: '', scope: 'library', inactive: false, weak: false }, all) ?? '', mpn: r.mpn, page: r.page ?? 1, terms })
    else if (r.repo && r.path) setDoc({ repo: r.repo, path: r.path })
  }
  const sheets = (
    <>
      <DocumentSheet doc={doc} onOpenChange={(o) => !o && setDoc(null)} />
      <DatasheetSheet target={sheet} onOpenChange={(o) => !o && setSheet(null)} />
      <MemorySheet memory={memory} onOpenChange={(o) => !o && setMemory(null)} />
    </>
  )
  return { open, sheets, setMemory, setSheet, setDoc }
}

export function ResultsList({ outcome, query, weak, onWeak, includeInactive, all, empty }: {
  outcome: SearchOutcome
  query: string
  weak: boolean
  onWeak: (on: boolean) => void
  includeInactive: boolean
  all: string[]
  empty?: string
}) {
  const terms = queryTerms(query)
  const { open, sheets, setMemory } = useOpeners(all)
  const may = useMaySwitch()
  const sw = useMemorySwitch()
  const visible = (rs: KnowledgeResult[]) => rs.filter((r) => includeInactive || !r.memory || r.memory.active)
  const strong = visible(outcome.strong)
  const weaker = visible(outcome.weak)
  const shown = weak ? [...strong, ...weaker] : strong

  const onSwitch = (r: KnowledgeResult) => {
    const m = r.memory!
    if (m.active) setMemory(m)
    else void sw.on(m.id, m.repo)
  }

  return (
    <div>
      {outcome.failed.length > 0 && (
        <Partial onRetry={outcome.retry}>Could not reach {failedWords(outcome.failed)}. The results below are from the rest.</Partial>
      )}
      {outcome.loading && strong.length === 0 ? (
        <Loading>
          <SkeletonRows rows={3} className="mt-3" />
        </Loading>
      ) : (
        <>
          <p className="mt-3 text-sm text-muted-foreground" aria-live="polite">
            {plural(strong.length, 'strong match', 'strong matches')} · only from projects you're on
            {weaker.length > 0 && (
              <>
                {' · '}
                <button type="button" className="text-primary hover:underline" onClick={() => onWeak(!weak)}>
                  {weak ? 'Hide weaker matches' : `Show ${weaker.length} weaker ${weaker.length === 1 ? 'match' : 'matches'}`}
                </button>
              </>
            )}
            {outcome.off.length > 0 && <> · not turned on for {outcome.off.map((o) => `${projectName(o.repo)}'s ${o.what}`).join(', ')}</>}
          </p>
          {shown.length === 0 ? (
            <EmptyState className="mt-3">{empty ?? `Nothing strong matches “${query}”. Try other words, or widen the scope to All my projects.`}</EmptyState>
          ) : (
            <div className="mt-3 space-y-3">
              {shown.map((r, i) => (
                <div key={r.id}>
                  {weak && i === strong.length && <p className="mb-3 mt-6 text-xs font-medium uppercase tracking-wide text-muted-foreground">Weaker matches</p>}
                  <ResultCard r={r} terms={terms} onOpen={(x) => open(x, terms)} onSwitch={r.memory && may(r.memory) ? onSwitch : undefined} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {sheets}
    </div>
  )
}
