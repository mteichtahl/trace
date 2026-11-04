/**
 * Registers how tool calls draw in the conversation, and the human-in-the-loop tools: `ask_person` (a Decision card)
 * and `start_task` (trace offers to start work: the exact request and agent, and only the person's Confirm calls `task`
 * as them; the job, or Cancel, goes back to trace as the tool's result and shows as a Run card), and `remember` (trace
 * offers to remember something: the exact words and whose they are, and only the person's Confirm calls memory.remember
 * as them).
 *
 * Tool calls are drawn by the shape of their result, so any tool that returns one of these shapes gets its card
 * without a registration per tool:
 *   { series, x, y }      → Plot card        (simulation and measurement tools)
 *   { findings, check }   → Findings card    (ERC, DRC, datasheet limits)
 *   { mpn }               → Part card        (parts tools)
 *   { path, kind? , url? }→ File card        (any tool that writes or reads a file)
 *   { run }               → Run card
 *   anything else         → Tool row         (one quiet folded line)
 * Explicit `show_*` tools (the agent asking to show a card) are matched by name first.
 */
import { useHumanInTheLoop, useRenderTool } from '@copilotkit/react-core/v2'
import { createContext, useContext, useState } from 'react'
import { z } from 'zod'
import { DecisionCard, type Decision } from '@/components/decision-card'
import { agentBlocked, useAgentSetup } from '@/components/project/agent-setup'
import { call } from '@/lib/api'
import { usePrefs } from '@/lib/prefs'
import {
  FileCard, FindingsCard, type FileData, type FindingsData, PartCard, type PartData, PlotCard, type PlotData, type RememberAnswer, RememberConfirmCard, RunCard, type RunCardData,
  type TaskAnswer, TaskConfirmCard, ToolRow, type ToolStatus, parseResult,
} from './cards'

type Shape = { kind: 'plot'; data: PlotData } | { kind: 'findings'; data: FindingsData } | { kind: 'part'; data: PartData } | { kind: 'file'; data: FileData } | { kind: 'run'; data: RunCardData } | null

export function shapeOf(name: string, args: unknown, result: unknown): Shape {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const pick = (o: Record<string, unknown>): Shape => {
    if (Array.isArray(o.series) && o.x && o.y) return { kind: 'plot', data: o as unknown as PlotData }
    if (Array.isArray(o.findings)) return { kind: 'findings', data: { check: String(o.check ?? name), findings: o.findings as FindingsData['findings'], thumbnail: o.thumbnail as string | undefined } }
    if (typeof o.mpn === 'string') return { kind: 'part', data: o as unknown as PartData }
    if (o.run && typeof o.run === 'object') return { kind: 'run', data: o as unknown as RunCardData }
    if (typeof o.path === 'string' && (o.url || o.kind || o.size !== undefined)) return { kind: 'file', data: o as unknown as FileData }
    return null
  }
  if (name.startsWith('show_')) return pick(a) ?? pick(r)
  return pick(r)
}

function Generic({ name, parameters, result, status, toolCallId }: { name: string; parameters: unknown; result?: string; status: ToolStatus; toolCallId?: string }) {
  const folded = usePrefs().chat.toolRows === 'folded'
  const shape = shapeOf(name, parameters, status === 'complete' ? parseResult(result) : undefined)
  switch (shape?.kind) {
    case 'plot': return <PlotCard data={shape.data} />
    case 'findings': return <FindingsCard data={shape.data} />
    case 'part': return <PartCard data={shape.data} />
    case 'file': return <FileCard data={shape.data} />
    case 'run': return <RunCard data={shape.data} />
    default: return <ToolRow name={name} args={parameters} result={result} status={status} defaultOpen={!folded} toolCallId={toolCallId} />
  }
}

const AskPerson = z.object({
  question: z.string(),
  recommended: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string(), detail: z.string().optional() })),
  why: z.string().optional(),
  givesUp: z.string().optional(),
  blocks: z.string().optional(),
  evidence: z.array(z.object({ kind: z.string(), label: z.string(), id: z.string().optional(), to: z.string().optional(), summary: z.string().optional() })).optional(),
})
type AskArgs = z.infer<typeof AskPerson>

/** Mount once per chat provider. */
export function ChatRenderers() {
  const detail = usePrefs().chat.recommendations
  useRenderTool({ name: '*', render: (p: { name: string; parameters: unknown; result?: string; status: ToolStatus; toolCallId?: string }) => <Generic {...p} /> }, [])
  useHumanInTheLoop<AskArgs>(
    {
      name: 'ask_person',
      description: 'Ask the person to decide. Give your recommendation first, why (with evidence), what it gives up, and the alternatives. The answer comes back as { option, recommended, reason? }.',
      parameters: AskPerson,
      render: ({ args, status, respond, result }) => {
        if (!args.options?.length || !args.recommended) return <ToolRow name="ask_person" args={args} status="inProgress" />
        const decision = args as unknown as Decision
        if (status === 'complete') {
          const chosen = parseResult<{ option: string; recommended: boolean; reason?: string }>(result)
          return <DecisionCard decision={decision} onChoose={() => undefined} chosen={chosen && typeof chosen === 'object' ? chosen : { option: '?', recommended: false }} />
        }
        return <DecisionCard decision={decision} detail={detail} onChoose={(c) => (respond ? respond(c) : undefined)} />
      },
    },
    [detail],
  )
  useHumanInTheLoop<TaskArgs>(
    {
      name: 'start_task',
      // the backend offers its own description and schema for this name; these only describe it to CopilotKit
      description: 'Offer to start a task on the project. The person confirms or cancels.',
      parameters: StartTask,
      render: ({ args, status, respond, result }) => <StartTaskCard args={args} status={status} respond={respond} result={result} />,
    },
    [],
  )
  useHumanInTheLoop<RememberArgs>(
    {
      name: 'remember',
      // the backend offers its own description and schema for this name; these only describe it to CopilotKit
      description: 'Offer to remember something the person asked to remember. The person confirms or cancels.',
      parameters: Remember,
      render: ({ args, status, respond, result }) => <RememberCard args={args} status={status} respond={respond} result={result} />,
    },
    [],
  )
  return null
}

/**
 * Whether a tool call belongs to the reply being written now (chat-view.tsx sets it per message). A kept offer the
 * conversation went on from without an answer is not live: it shows as not started, never as still waiting.
 */
export const LiveCall = createContext(true)

/** The project the conversation is on (chat-view.tsx sets it): the screen's notice already asks project.agent for it. */
export const ChatRepo = createContext<string | undefined>(undefined)

/** The stored conversation (chat-view.tsx sets it): what remember files its memory under (one session per thread). */
export const ChatThread = createContext<string | undefined>(undefined)

/**
 * The project a confirm card may act on: the conversation's own (ChatRepo), never one the model named. `refused` says
 * why not when the model named another (or, for `strict`, when the conversation is on no project at all); the card then
 * offers no Confirm.
 */
export function lockedRepo(chatRepo: string | undefined, named: string | undefined, o: { strict: boolean; doing: string }): { repo: string | undefined; refused: string | null } {
  if (!chatRepo) return o.strict ? { repo: undefined, refused: `This conversation is not on a project, so nothing can be ${o.doing} from it.` } : { repo: named, refused: null }
  if (named && named.toLowerCase() !== chatRepo.toLowerCase()) return { repo: chatRepo, refused: `trace named ${named}, but this conversation is on ${chatRepo}: nothing can be ${o.doing} on another project from here.` }
  return { repo: chatRepo, refused: null }
}

const StartTask = z.object({ repo: z.string(), request: z.string(), agent: z.string().optional(), branch: z.string().optional() })
type TaskArgs = z.infer<typeof StartTask>

/** start_task's card: the person's Confirm calls `task` as them; the answer (the job, or why not) goes back to trace. */
export function StartTaskCard({ args, status, respond, result, readOnly }: { args: Partial<TaskArgs>; status: string; respond?: (r: unknown) => unknown; result?: string; readOnly?: boolean }) {
  const [busy, setBusy] = useState(false)
  const live = useContext(LiveCall)
  // the conversation's own project: what the notice on the screen already knows of its agent (nothing asked from
  // here); another project's is asked for, so Confirm waits for that project's agent too
  const chatRepo = useContext(ChatRepo)
  // locked to the conversation's project: another one the model named is refused on the card (a conversation on no
  // project, the app's own, has none to lock to: the card names the project the model gave)
  const { repo, refused } = lockedRepo(chatRepo, args.repo, { strict: false, doing: 'started' })
  const other = !!repo && repo.toLowerCase() !== (chatRepo ?? '').toLowerCase()
  // asked only while Confirm is offered (a finished or past offer needs no answer)
  const offered = status === 'executing' && !!respond
  const blocked = agentBlocked(useAgentSetup(repo, { fetch: other && offered && !refused }).data)
  if (status === 'complete') return <TaskConfirmCard task={args} answer={parseResult<TaskAnswer>(result)} />
  if (!live && status !== 'executing') return <TaskConfirmCard task={args} answer={{ confirmed: false, reason: 'not confirmed' }} />
  if (status !== 'executing' || !respond) return <TaskConfirmCard task={args} readOnly={readOnly} busy />
  if (refused) return <TaskConfirmCard task={args} refused={refused} onCancel={() => respond({ confirmed: false, reason: refused } satisfies TaskAnswer)} />
  const confirm = async () => {
    if (!repo || !args.request) return
    setBusy(true)
    try {
      const r = await call('task', { repo, request: args.request, ...(args.agent ? { agent: args.agent } : {}), ...(args.branch ? { branch: args.branch } : {}) })
      respond({ confirmed: true, accepted: r.accepted, jobId: r.jobId, ...(r.reason ? { reason: r.reason } : {}) } satisfies TaskAnswer)
    } catch (e) {
      respond({ confirmed: true, accepted: false, reason: e instanceof Error ? e.message : 'the task could not be started' } satisfies TaskAnswer)
    } finally {
      setBusy(false)
    }
  }
  return <TaskConfirmCard task={args} busy={busy} readOnly={readOnly} blocked={blocked} onConfirm={() => void confirm()} onCancel={() => respond({ confirmed: false, reason: 'cancelled' } satisfies TaskAnswer)} />
}

const Remember = z.object({ repo: z.string(), text: z.string(), scope: z.enum(['personal', 'project']) })
type RememberArgs = z.infer<typeof Remember>

/**
 * remember's card: the person's Confirm calls memory.remember as them (the API takes who they are from their sign-in,
 * never from these arguments, and records it in the conversation's session), on the conversation's own project (a
 * different `repo` from the model is refused on the card); the answer goes back to trace.
 */
export function RememberCard({ args, status, respond, result, readOnly, thread }: { args: Partial<RememberArgs>; status: string; respond?: (r: unknown) => unknown; result?: string; readOnly?: boolean; thread?: string }) {
  const [busy, setBusy] = useState(false)
  const live = useContext(LiveCall)
  const chatThread = useContext(ChatThread) ?? thread
  // locked to the conversation's project: what the model named is only checked against it, never written to
  const { repo, refused } = lockedRepo(useContext(ChatRepo), args.repo, { strict: true, doing: 'remembered' })
  if (status === 'complete') return <RememberConfirmCard memory={args} answer={parseResult<RememberAnswer>(result)} />
  if (!live && status !== 'executing') return <RememberConfirmCard memory={args} answer={{ confirmed: false, reason: 'not confirmed' }} />
  if (status !== 'executing' || !respond) return <RememberConfirmCard memory={args} readOnly={readOnly} busy />
  if (refused) return <RememberConfirmCard memory={args} refused={refused} onCancel={() => respond({ confirmed: false, reason: refused } satisfies RememberAnswer)} />
  const confirm = async () => {
    if (!repo || !args.text?.trim() || (args.scope !== 'personal' && args.scope !== 'project')) return
    setBusy(true)
    try {
      const r = await call('memory.remember', { repo, text: args.text, scope: args.scope, ...(chatThread ? { thread: chatThread } : {}) })
      respond({ confirmed: true, recorded: r.recorded, note: r.note } satisfies RememberAnswer)
    } catch (e) {
      respond({ confirmed: true, recorded: false, reason: e instanceof Error ? e.message : 'it could not be recorded' } satisfies RememberAnswer)
    } finally {
      setBusy(false)
    }
  }
  return <RememberConfirmCard memory={args} busy={busy} readOnly={readOnly} onConfirm={() => void confirm()} onCancel={() => respond({ confirmed: false, reason: 'cancelled' } satisfies RememberAnswer)} />
}
