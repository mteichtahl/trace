/**
 * POST /api/agui: the "trace" chat agent (Ask trace), speaking AG-UI over server-sent events. Claude on Bedrock
 * (ConverseStream) does the talking; its tools are API actions called as the person, through the same path as
 * /api/call (src/web/call.ts), so the API runtime decides access exactly as it does for every other screen.
 *
 *   in       an AG-UI RunAgentInput: threadId, runId, messages, tools (the app's own, "frontend" tools), context
 *            (useAgentContext entries), state, forwardedProps
 *   out      RUN_STARTED, then per model turn TEXT_MESSAGE_START/CONTENT/END from the text deltas and
 *            TOOL_CALL_START/ARGS/END for each tool use; backend tools run between STEP_STARTED and STEP_FINISHED, each
 *            answered with TOOL_CALL_RESULT; then RUN_FINISHED (or RUN_ERROR). An SSE comment every 15 s keeps
 *            CloudFront and the browser from closing a quiet stream.
 *   tools    backend: read-only actions (status, runs, run, journey.get, kb.search, memory.recall, tools.list, tool
 *            for read-only tools, graph.neighbourhood, files.list, inbox) and start_task (`task`, a write: the answer
 *            carries the job id so the app shows a run card). Bedrock tool names allow no dots, so `journey.get` is
 *            offered as `journey_get`.
 *            frontend: every tool in RunAgentInput.tools is offered too. When the model calls one, its TOOL_CALL_*
 *            events go out, any backend tools of the same turn run, and the run finishes: the app runs the tool (a
 *            Decision card waits for the person, useHumanInTheLoop) and starts a new run with the tool's result as a
 *            `tool` message. That is the human-in-the-loop resume.
 *   prompt   the catalog's `chat` prompt (src/prompts/chat.ts): chat.role, then the context entries and state fenced as
 *            data; system and developer messages from the app follow it
 *   limits   eight tool rounds per run; nothing is stored here (the app keeps threads with chats.append).
 */
import { randomUUID } from 'node:crypto'
import { EventType } from '@ag-ui/core'
import type { BaseEvent, Context as AguiContext, Tool as AguiTool } from '@ag-ui/core'
import type { ContentBlock, ConverseStreamOutput, Message as BedrockMessage, Tool as BedrockTool, ToolResultContentBlock } from '@aws-sdk/client-bedrock-runtime'
import type { DocumentType } from '@smithy/types'
import { z } from 'zod'
import { composeChat } from '../prompts/chat.js'
import { type WebDeps, signedIn } from './deps.js'
import { type Caller, callApi, publishChange } from './call.js'
import type { Publisher } from './events.js'
import { MB, type Sink, parseBody, route } from './http.js'

export const AGENT_NAME = 'trace'
export const MAX_ROUNDS = 8
export const HEARTBEAT_MS = 15_000
const MAX_RESULT_CHARS = 60_000

// ------------------------------------------------------------------ the input

const Part = z.object({ type: z.string(), text: z.string().optional() }).loose()
const ToolCall = z.object({ id: z.string(), type: z.literal('function').optional(), function: z.object({ name: z.string(), arguments: z.string() }) }).loose()
const Msg = z.object({
  id: z.string().optional(),
  role: z.string(),
  content: z.union([z.string(), z.array(Part), z.record(z.string(), z.unknown())]).optional().nullable(),
  toolCalls: z.array(ToolCall).optional(),
  toolCallId: z.string().optional(),
  error: z.string().optional(),
}).loose()

export const RunInput = z.object({
  threadId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  parentRunId: z.string().optional(),
  messages: z.array(Msg).max(2000),
  tools: z.array(z.object({ name: z.string().min(1).max(64), description: z.string().max(4000).default(''), parameters: z.unknown().optional() }).loose()).default([]),
  context: z.array(z.object({ description: z.string().max(2000), value: z.string().max(20_000) })).default([]),
  state: z.unknown().optional(),
  forwardedProps: z.unknown().optional(),
}).loose()
export type RunInput = z.output<typeof RunInput>

// ------------------------------------------------------------------ the system prompt

/** The system prompt: the catalog's chat entries (src/prompts/chat.ts) with the screen's context and shared state.
 * The installation's prompt overrides are not read here yet: the defaults are used. */
export const systemPrompt = (context: readonly AguiContext[], state: unknown): string => composeChat(context, state).text

// ------------------------------------------------------------------ backend tools

const repo = { type: 'string', description: 'The project, as OWNER/REPO' }

interface BackendTool { action: string; description: string; schema: Record<string, unknown>; write?: boolean; step: string }

export const BACKEND_TOOLS: Readonly<Record<string, BackendTool>> = {
  status: { action: 'status', step: 'Checking the project\'s status', description: 'The project\'s open pull requests, open agent-fix issues, recent trace workflow runs and last deploy.', schema: { type: 'object', properties: { repo }, required: ['repo'] } },
  runs: { action: 'runs', step: 'Reading the run record', description: 'The project\'s run record, newest first.', schema: { type: 'object', properties: { repo, kind: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['repo'] } },
  run: { action: 'run', step: 'Reading a run', description: 'One run: its arguments, result, measurements and artifact list.', schema: { type: 'object', properties: { repo, id: { type: 'string' } }, required: ['repo', 'id'] } },
  journey_get: { action: 'journey.get', step: 'Reading the project\'s journey', description: 'The project\'s journey: stages, gates and their criteria, the next step, open questions, waivers and decisions.', schema: { type: 'object', properties: { repo }, required: ['repo'] } },
  kb_search: { action: 'kb.search', step: 'Searching the knowledge base', description: 'Search the project\'s knowledge base (its documents, datasheets and design files).', schema: { type: 'object', properties: { repo, query: { type: 'string' }, top_k: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['repo', 'query'] } },
  memory_recall: { action: 'memory.recall', step: 'Recalling what the agents learned', description: 'The agents\' long-term memory records most relevant to a query (facts, preferences, session summaries).', schema: { type: 'object', properties: { repo, query: { type: 'string' }, top_k: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['repo', 'query'] } },
  tools_list: { action: 'tools.list', step: 'Listing the tools', description: 'The tools that can run on the project, with their inputs, and whether each needs write access.', schema: { type: 'object', properties: { repo }, required: ['repo'] } },
  tool: { action: 'tool', step: 'Running a tool', description: 'Run one read-only tool (from tools_list, needs "read") on the project\'s default branch.', schema: { type: 'object', properties: { repo, name: { type: 'string' }, args: { type: 'object' } }, required: ['repo', 'name'] } },
  graph_neighbourhood: { action: 'graph.neighbourhood', step: 'Exploring connected items', description: 'The items connected to a focus item (requirements, parts, runs, decisions, documents), depth 1 to 3.', schema: { type: 'object', properties: { repo, focus: { type: 'string' }, depth: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['repo', 'focus'] } },
  files_list: { action: 'files.list', step: 'Listing the project\'s files', description: 'The project\'s files by kind.', schema: { type: 'object', properties: { repo, kind: { type: 'string' } }, required: ['repo'] } },
  inbox: { action: 'inbox', step: 'Checking what needs the person', description: 'What needs the person across their projects: questions, gates to sign, failures, oldest and most blocking first.', schema: { type: 'object', properties: {} } },
  start_task: { action: 'task', write: true, step: 'Starting the work', description: 'Start a task on the project (an agent works on a branch and opens a pull request). Only when the person asked for it. Returns the job id.', schema: { type: 'object', properties: { repo, request: { type: 'string', description: 'What to do, in plain words' }, agent: { type: 'string', enum: ['verify', 'impl', 'ams', 'emc', 'render', 'thermal'] } }, required: ['repo', 'request'] } },
}

const spec = (name: string, description: string, schema: unknown): BedrockTool => ({
  toolSpec: { name, description, inputSchema: { json: (schema ?? { type: 'object', properties: {} }) as DocumentType } },
})

const ApiAnswer = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }).loose(),
  z.object({ ok: z.literal(false), error: z.string() }).loose(),
])

const ToolList = z.array(z.object({ name: z.string(), needs: z.string() }).loose())

/** One backend tool call as the person: the text the model reads (and the app's TOOL_CALL_RESULT carries). */
async function runBackendTool(deps: WebDeps, who: Caller, name: string, input: Record<string, unknown>, readTools: Map<string, Set<string>>, publisher?: Publisher): Promise<{ text: string; error: boolean }> {
  const t = BACKEND_TOOLS[name]
  if (!t) return { text: JSON.stringify({ ok: false, error: `no tool ${name}` }), error: true }
  let args = input
  if (name === 'tool') {
    const r = typeof input.repo === 'string' ? input.repo.toLowerCase() : ''
    let read = readTools.get(r)
    if (!read) {
      const list = await callApi(deps, who, 'tools.list', { repo: r })
      const a = ApiAnswer.safeParse(list.json)
      if (!a.success || !a.data.ok) return { text: JSON.stringify(a.success ? a.data : { ok: false, error: `the API answered ${list.status}` }), error: true }
      const tools = ToolList.safeParse(a.data.result)
      read = new Set(tools.success ? tools.data.filter((x) => x.needs === 'read').map((x) => x.name) : [])
      readTools.set(r, read)
    }
    if (!read.has(String(input.name))) return { text: JSON.stringify({ ok: false, error: `${String(input.name)} is not a read-only tool: the chat runs read-only tools only` }), error: true }
    args = { repo: input.repo, name: input.name, args: input.args ?? {} }
  }
  const answer = await callApi(deps, who, t.action, args)
  if (t.write) await publishChange(deps, who, t.action, args, answer, publisher)
  const a = ApiAnswer.safeParse(answer.json)
  if (!a.success) return { text: JSON.stringify({ ok: false, error: `the API answered ${answer.status}` }), error: true }
  let out = a.data.ok ? JSON.stringify(a.data.result ?? null) : JSON.stringify({ ok: false, error: a.data.error })
  if (out.length > MAX_RESULT_CHARS) out = `${out.slice(0, MAX_RESULT_CHARS)}… [cut: the result was ${out.length} characters]`
  return { text: out, error: !a.data.ok }
}

// ------------------------------------------------------------------ AG-UI messages → Bedrock messages

const textOf = (c: z.output<typeof Msg>['content']): string => {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => (p.type === 'text' && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n')
  return c ? JSON.stringify(c) : ''
}

const parseArgs = (s: string): DocumentType => {
  try {
    const v: unknown = JSON.parse(s || '{}')
    return (v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v }) as DocumentType
  } catch {
    return { raw: s }
  }
}

/**
 * The conversation as Bedrock wants it: roles alternate, it starts with the person, every tool use is answered in the
 * next person turn (an unanswered one is answered "no result" so the turn is valid). System and developer messages
 * join the system prompt.
 */
export function toBedrock(messages: RunInput['messages']): { messages: BedrockMessage[]; system: string[] } {
  const out: BedrockMessage[] = []
  const system: string[] = []
  const push = (role: 'user' | 'assistant', blocks: ContentBlock[]): void => {
    if (!blocks.length) return
    const last = out[out.length - 1]
    if (last && last.role === role) last.content = [...(last.content ?? []), ...blocks]
    else out.push({ role, content: blocks })
  }
  for (const m of messages) {
    switch (m.role) {
      case 'system': case 'developer': { const t = textOf(m.content); if (t) system.push(t); break }
      case 'user': { const t = textOf(m.content); if (t.trim()) push('user', [{ text: t }]); break }
      case 'assistant': {
        const blocks: ContentBlock[] = []
        const t = textOf(m.content)
        if (t.trim()) blocks.push({ text: t })
        for (const c of m.toolCalls ?? []) blocks.push({ toolUse: { toolUseId: c.id, name: c.function.name, input: parseArgs(c.function.arguments) } })
        push('assistant', blocks)
        break
      }
      case 'tool': {
        if (!m.toolCallId) break
        const content: ToolResultContentBlock[] = [{ text: textOf(m.content) || m.error || '(no output)' }]
        push('user', [{ toolResult: { toolUseId: m.toolCallId, content, ...(m.error ? { status: 'error' as const } : {}) } }])
        break
      }
      default: break // activity and reasoning messages are the app's own
    }
  }
  while (out.length && out[0]?.role !== 'user') out.shift()
  // every tool use answered in the next turn
  for (let i = 0; i < out.length; i++) {
    const m = out[i] as BedrockMessage
    if (m.role !== 'assistant') continue
    const uses = (m.content ?? []).flatMap((b) => (b.toolUse?.toolUseId ? [b.toolUse.toolUseId] : []))
    if (!uses.length) continue
    let next = out[i + 1]
    if (!next || next.role !== 'user') { next = { role: 'user', content: [] }; out.splice(i + 1, 0, next) }
    const answered = new Set((next.content ?? []).flatMap((b) => (b.toolResult?.toolUseId ? [b.toolResult.toolUseId] : [])))
    const missing = uses.filter((u) => !answered.has(u)).map((u): ContentBlock => ({ toolResult: { toolUseId: u, content: [{ text: '(no result)' }], status: 'error' } }))
    // tool results come first in a turn
    next.content = [...missing, ...(next.content ?? [])].sort((a, b) => Number(Boolean(b.toolResult)) - Number(Boolean(a.toolResult)))
  }
  return { messages: out, system }
}

// ------------------------------------------------------------------ the run

interface PendingUse { id: string; name: string; input: string }

type Emit = (e: BaseEvent & Record<string, unknown>) => void

/** One model turn, streamed into AG-UI events. Returns its stop reason, the assistant message, and the tool uses. */
async function modelTurn(stream: AsyncIterable<ConverseStreamOutput>, emit: Emit): Promise<{ stop: string; message: BedrockMessage; uses: PendingUse[] }> {
  const blocks: ContentBlock[] = []
  const uses: PendingUse[] = []
  let messageId: string | null = null
  let lastMessageId: string | null = null
  let text = ''
  let current: { kind: 'text' } | { kind: 'tool'; use: PendingUse } | null = null
  let stop = 'end_turn'
  // a text message ends where a tool call starts (its parentMessageId still names it); more text opens a new one
  const endText = (): void => {
    if (!messageId) return
    if (text) { blocks.push({ text }); text = '' }
    emit({ type: EventType.TEXT_MESSAGE_END, messageId })
    lastMessageId = messageId
    messageId = null
  }
  const closeBlock = (): void => {
    if (current?.kind === 'tool') {
      emit({ type: EventType.TOOL_CALL_END, toolCallId: current.use.id })
      blocks.push({ toolUse: { toolUseId: current.use.id, name: current.use.name, input: parseArgs(current.use.input) } })
      uses.push(current.use)
    } else if (current?.kind === 'text') {
      endText()
    }
    current = null
  }
  for await (const ev of stream) {
    const err = ev.internalServerException ?? ev.modelStreamErrorException ?? ev.serviceUnavailableException ?? ev.throttlingException ?? ev.validationException
    if (err) throw Object.assign(new Error(err.message ?? 'the model stream failed'), { name: err.name ?? 'ModelError' })
    if (ev.contentBlockStart?.start?.toolUse) {
      closeBlock()
      const t = ev.contentBlockStart.start.toolUse
      const use: PendingUse = { id: t.toolUseId ?? randomUUID(), name: t.name ?? '', input: '' }
      current = { kind: 'tool', use }
      emit({ type: EventType.TOOL_CALL_START, toolCallId: use.id, toolCallName: use.name, ...(lastMessageId ? { parentMessageId: lastMessageId } : {}) })
    } else if (ev.contentBlockDelta?.delta) {
      const d = ev.contentBlockDelta.delta
      if (typeof d.text === 'string' && d.text) {
        if (current?.kind !== 'text') { closeBlock(); current = { kind: 'text' } }
        if (!messageId) { messageId = randomUUID(); emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }) }
        text += d.text
        emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: d.text })
      } else if (d.toolUse && current?.kind === 'tool') {
        const piece = d.toolUse.input ?? ''
        if (piece) {
          current.use.input += piece
          emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: current.use.id, delta: piece })
        }
      }
    } else if (ev.contentBlockStop) {
      closeBlock()
    } else if (ev.messageStop) {
      stop = ev.messageStop.stopReason ?? 'end_turn'
    }
  }
  closeBlock()
  endText()
  return { stop, message: { role: 'assistant', content: blocks }, uses }
}

export interface AguiOptions { publisher?: () => Publisher; heartbeatMs?: number }

export async function runAgent(deps: WebDeps, who: Caller, input: RunInput, sink: Sink, o: AguiOptions = {}): Promise<void> {
  sink.open(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
  const emit: Emit = (e) => { sink.write(`data: ${JSON.stringify({ ...e, timestamp: deps.now() })}\n\n`) }
  const beat = setInterval(() => { sink.write(': keep-alive\n\n') }, o.heartbeatMs ?? HEARTBEAT_MS)
  const { threadId, runId } = input
  try {
    emit({ type: EventType.RUN_STARTED, threadId, runId, ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}) })
    const fwd = z.object({ readOnly: z.boolean().optional() }).loose().safeParse(input.forwardedProps ?? {})
    const readOnly = fwd.success && fwd.data.readOnly === true
    const backend = Object.entries(BACKEND_TOOLS).filter(([, t]) => !(readOnly && t.write))
    const frontend: AguiTool[] = input.tools.filter((t) => !Object.hasOwn(BACKEND_TOOLS, t.name)).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
    const frontendNames = new Set(frontend.map((t) => t.name))
    const toolSpecs: BedrockTool[] = [
      ...backend.map(([name, t]) => spec(name, t.description, t.schema)),
      ...frontend.map((t) => spec(t.name, t.description || t.name, t.parameters)),
    ]
    const converted = toBedrock(input.messages)
    if (!converted.messages.length) throw Object.assign(new Error('there is no message from the person to answer'), { name: 'BadInput' })
    const system = [systemPrompt(input.context, input.state), ...converted.system].join('\n\n')
    const conversation = converted.messages
    const config = who.config
    const readTools = new Map<string, Set<string>>()
    const publisher = o.publisher?.()
    for (let round = 1; ; round++) {
      const turn = await modelTurn(deps.bedrock(config).converseStream({
        modelId: config.model,
        system: [{ text: system }],
        messages: conversation,
        inferenceConfig: { maxTokens: 8192 },
        ...(toolSpecs.length ? { toolConfig: { tools: toolSpecs } } : {}),
      }), emit)
      conversation.push(turn.message)
      if (turn.stop !== 'tool_use' || !turn.uses.length) break
      const backendUses = turn.uses.filter((u) => !frontendNames.has(u.name))
      const results: ContentBlock[] = []
      if (backendUses.length) {
        const stepName = backendUses.map((u) => BACKEND_TOOLS[u.name]?.step ?? `Running ${u.name}`).filter((s, i, a) => a.indexOf(s) === i).join('; ')
        emit({ type: EventType.STEP_STARTED, stepName })
        for (const u of backendUses) {
          let input: Record<string, unknown> = {}
          try { const v: unknown = JSON.parse(u.input || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) input = v as Record<string, unknown> } catch { /* bad arguments: the tool says so */ }
          const r = await runBackendTool(deps, who, u.name, input, readTools, publisher).catch((e: unknown) => ({ text: JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), error: true }))
          emit({ type: EventType.TOOL_CALL_RESULT, messageId: randomUUID(), toolCallId: u.id, content: r.text, role: 'tool' })
          results.push({ toolResult: { toolUseId: u.id, content: [{ text: r.text }], ...(r.error ? { status: 'error' as const } : {}) } })
        }
        emit({ type: EventType.STEP_FINISHED, stepName })
      }
      // a frontend tool: the app runs it (or asks the person) and resumes with a new run carrying its result
      if (backendUses.length < turn.uses.length) break
      conversation.push({ role: 'user', content: results })
      if (round >= MAX_ROUNDS) {
        const messageId = randomUUID()
        emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' })
        emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: `I stopped after ${MAX_ROUNDS} rounds of looking things up. Ask me to carry on, or narrow the question.` })
        emit({ type: EventType.TEXT_MESSAGE_END, messageId })
        break
      }
    }
    emit({ type: EventType.RUN_FINISHED, threadId, runId })
  } catch (e) {
    const name = e instanceof Error ? e.name : 'Error'
    const throttled = /Throttl|TooManyRequests|ServiceQuota/.test(name)
    deps.log({ warning: 'agui run failed', error: name, message: e instanceof Error ? e.message.slice(0, 300) : String(e) })
    emit({
      type: EventType.RUN_ERROR,
      message: throttled ? 'trace is busy right now: try again in a moment' : `the run stopped: ${e instanceof Error ? e.message.slice(0, 300) : 'internal error'}`,
      code: throttled ? 'throttled' : name,
    })
  } finally {
    clearInterval(beat)
    sink.end()
  }
}

export function aguiRoutes(deps: WebDeps, o: AguiOptions = {}) {
  return [
    route('POST', '/api/agui', async (req, ctx) => {
      const s = await signedIn(req, ctx, deps)
      const input = parseBody(req, RunInput, 4 * MB)
      const who: Caller = { config: s.config, token: s.token, sub: s.claims.sub }
      return { stream: (sink) => runAgent(deps, who, input, sink, o) }
    }),
  ]
}
