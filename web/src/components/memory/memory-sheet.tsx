/**
 * One memory in a side sheet (Knowledge's Agent memory and the project's Memory tab): its full text, kind, agent,
 * when it was learned, its history of switches, Switch off (reason required) or Switch back on, and "Correct it
 * instead": memories cannot be rewritten, so a correction switches the wrong one off and opens Question answer to
 * write it as a project rule (or Change request when it changes a requirement).
 */
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { StatusBadge } from '@/components/status-badge'
import { Facts, NeedsBuilding, SideSheet } from '@/components/side-sheet'
import { useTraceContext } from '@/components/chat/context'
import { projectId, projectName } from '@/lib/api'
import { type MemoryView, agentName, kindWord, switchedBy } from '@/lib/knowledge'
import { ago, time } from '@/lib/format'
import { SwitchOffForm, useMaySwitch, useMemorySwitch } from './switch'

const when = (at: string | null) => (at ? `${new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time(at)}` : 'Not recorded')

export function MemorySheet({ memory, onOpenChange }: { memory: MemoryView | null; onOpenChange: (open: boolean) => void }) {
  const m = memory
  const may = useMaySwitch()
  const sw = useMemorySwitch(m?.repo ?? '')
  const navigate = useNavigate()
  const [correcting, setCorrecting] = useState(false)
  useTraceContext(m ? { label: m.text.slice(0, 32) + (m.text.length > 32 ? '…' : ''), description: 'The memory the person has open', value: { repo: m.repo, id: m.id, text: m.text, kind: m.kind, agent: m.actor, active: m.active } } : null, 'memory')
  if (!m) return null
  const canSwitch = may(m)
  const id = projectId(m.repo)
  return (
    <SideSheet
      open={!!m}
      onOpenChange={(o) => {
        setCorrecting(false)
        onOpenChange(o)
      }}
      title="Memory"
      status={m.active ? <StatusBadge status="met" label="Active" /> : <StatusBadge status="idle" label="Switched off" />}
    >
      <p className="text-[15px] leading-relaxed">{m.text}</p>
      <Facts
        className="mt-5"
        items={[
          ['Kind', kindWord(m.kind)],
          ['Agent', m.actor?.startsWith('person/') ? <>You <span className="text-muted-foreground">(your own preference; only you see it)</span></> : agentName(m.actor)],
          ['Project', <Link key="p" to="/p/$id/memory" params={{ id }} className="text-primary hover:underline">{projectName(m.repo)}</Link>],
          ['Learned', when(m.createdAt)],
          ['Learned from', <span key="s" className="text-muted-foreground">{m.kind === 'sessions' ? 'This summary is of one agent session' : 'A session of this agent'}</span>],
        ]}
      />
      <NeedsBuilding className="mt-2">the session, chat or run it was learned from is not returned with the memory yet.</NeedsBuilding>

      <Separator className="my-5" />
      <h3 className="text-sm font-semibold">Used by</h3>
      <NeedsBuilding className="mt-1">trace does not record which runs recalled a memory yet.</NeedsBuilding>

      <Separator className="my-5" />
      <h3 className="text-sm font-semibold">History</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Learned {m.createdAt ? ago(m.createdAt) : ''}
        {m.inactive ? ` · switched off ${m.inactive.at ? ago(m.inactive.at) : ''} by ${switchedBy(m)}: “${m.inactive.reason}”` : ' · no changes'}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">trace keeps the latest switch with its reason; the full log is on the Changes tab of the project's Memory.</p>

      <Separator className="my-5" />
      {!canSwitch ? (
        <p className="text-sm text-muted-foreground">You can read memories on {projectName(m.repo)} but not switch them; contributors and admins can.</p>
      ) : m.active ? (
        <>
          <h3 className="mb-2 text-sm font-semibold">Switch off this memory</h3>
          <SwitchOffForm
            key={m.id + String(correcting)}
            onSubmit={async (reason) => {
              await sw.off([m.id], reason)
              if (correcting) void navigate({ to: '/p/$id/do/$skill', params: { id, skill: 'question-answer' }, search: { correct: m.id } as never })
              onOpenChange(false)
            }}
            onCancel={correcting ? () => setCorrecting(false) : undefined}
            autoFocus={correcting}
          />
          <p className="mt-2 text-xs text-muted-foreground">Every switch is logged. Reviewers can read memories but not switch them.</p>
        </>
      ) : (
        <Button variant="outline" disabled={sw.pending} onClick={() => void sw.on(m.id).then(() => onOpenChange(false))}>
          Switch back on
        </Button>
      )}

      {canSwitch && m.active && (
        <div className="mt-6 rounded-lg border p-3">
          <button type="button" className="text-sm font-medium text-primary hover:underline" onClick={() => setCorrecting(true)}>
            Correct it instead: add a project rule
          </button>
          <p className="mt-1 text-xs text-muted-foreground">
            Memories can't be edited. Give the reason above and switch it off; Question answer then opens to write the correction as a rule. When it changes a requirement,{' '}
            <Link to="/p/$id/do/$skill" params={{ id, skill: 'change-request' }} className="text-primary hover:underline">raise a change request</Link> instead.
          </p>
          {correcting && <p className="mt-2 text-xs font-medium">Write the reason above; switching off opens Question answer.</p>}
        </div>
      )}
    </SideSheet>
  )
}
