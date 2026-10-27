/**
 * One conversation with trace, on CopilotKit v2 and AG-UI. Used by the Ask trace panel and embedded in Focus mode.
 *
 * - Messages come from the agent (`useAgent`); every reply streams in as markdown (markdown.tsx), tool calls draw as
 *   interface parts (`useRenderToolCall`, see renderers.tsx), reasoning is hidden or folded per preference.
 * - Every message is kept with the project: the thread is created on the first message (chats.append) and each
 *   message after it is appended, so the conversation is there on any device. Opening a thread loads it (chats.get).
 * - Controls: Stop while replying; per reply: read aloud (with the spoken word highlighted), Copy as markdown,
 *   Retry (the last reply), thumbs down with a reason.
 */
import { useAgent, useCopilotKit, useRenderToolCall } from '@copilotkit/react-core/v2'
import type { Message } from '@ag-ui/client'
import { ChevronRight, Copy, RotateCcw, ThumbsDown, Volume2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { call } from '@/lib/api'
import { usePrefs } from '@/lib/prefs'
import type { ChatMessage } from '@/lib/types'
import { cn } from '@/lib/utils'
import { ChatInput } from './chat-input'
import { AGENT_ID } from './agent'
import { pendingAsk, setThread, useRecallHistory } from './chat-state'
import { useStore } from '@/lib/store'
import { Markdown } from './markdown'
import { enqueueSpeech, speak, speakable, stopSpeaking, useSpeech } from './voice/speech'

type AnyMsg = Message & { content?: unknown; toolCalls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; toolCallId?: string }

const textOf = (m: AnyMsg): string =>
  typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? (m.content as { type: string; text?: string }[]).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('') : ''

/** Stored messages → AG-UI messages, so a thread replays with its cards. */
export function toAgui(ms: ChatMessage[]): Message[] {
  return ms
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'tool') return { id: m.id, role: 'tool', content: m.content, toolCallId: m.toolCallId ?? '' } as Message
      if (m.role === 'assistant')
        return { id: m.id, role: 'assistant', content: m.content, ...(m.toolCalls?.length ? { toolCalls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } })) } : {}) } as Message
      return { id: m.id, role: 'user', content: m.content } as Message
    })
}

/** AG-UI message → what chats.append stores. */
export function fromAgui(m: AnyMsg): Omit<ChatMessage, 'at'> | null {
  if (m.role === 'user') return { id: m.id, role: 'user', content: textOf(m) }
  if (m.role === 'assistant') return { id: m.id, role: 'assistant', content: textOf(m), ...(m.toolCalls?.length ? { toolCalls: m.toolCalls.map((t) => ({ id: t.id, name: t.function.name, args: t.function.arguments })) } : {}) }
  if (m.role === 'tool') return { id: m.id, role: 'tool', content: textOf(m), toolCallId: m.toolCallId }
  return null
}

export interface ChatViewProps {
  agentId: string
  /** the project this conversation belongs to (threads are kept per project) */
  repo?: string
  threadId?: string
  placeholder?: string
  /** shown when there are no messages yet (trace's summary of the step, in Focus mode) */
  intro?: React.ReactNode
  className?: string
}

export function ChatView({ agentId, repo, threadId, placeholder, intro, className }: ChatViewProps) {
  const { agent } = useAgent({ agentId })
  const { copilotkit } = useCopilotKit()
  const renderToolCall = useRenderToolCall()
  const prefs = usePrefs()
  const { history, push } = useRecallHistory(repo)
  const speaking = useSpeech()
  const messages = agent.messages as AnyMsg[]
  const running = agent.isRunning
  const saved = useRef(new Set<string>())
  const thread = useRef<string | undefined>(threadId)
  const scroller = useRef<HTMLDivElement>(null)
  const [loaded, setLoaded] = useState<string | undefined>()

  // open a stored thread
  useEffect(() => {
    thread.current = threadId
    if (!repo || !threadId || loaded === threadId) return
    let live = true
    void call('chats.get', { repo, id: threadId })
      .then((r) => {
        if (!live) return
        agent.threadId = threadId
        agent.setMessages(toAgui(r.messages))
        saved.current = new Set(r.messages.map((m) => m.id))
        setLoaded(threadId)
      })
      .catch(() => toast.error('Could not load that conversation.'))
    return () => {
      live = false
    }
  }, [agent, repo, threadId, loaded])

  // a new conversation (no thread chosen): start clean
  useEffect(() => {
    if (threadId) return
    agent.setMessages([])
    saved.current = new Set()
    setLoaded(undefined)
  }, [agent, threadId])

  const persist = useCallback(async () => {
    if (!repo) return
    for (const m of agent.messages as AnyMsg[]) {
      if (saved.current.has(m.id)) continue
      const stored = fromAgui(m)
      if (!stored) continue
      saved.current.add(m.id)
      try {
        const r = await call('chats.append', { repo, ...(thread.current ? { id: thread.current } : { title: stored.content.slice(0, 60) }), message: stored })
        if (!thread.current) {
          thread.current = r.id
          agent.threadId = r.id
          setLoaded(r.id)
          setThread(repo, r.id)
        }
      } catch {
        saved.current.delete(m.id)
      }
    }
  }, [agent, repo])

  const run = useCallback(async () => {
    try {
      await copilotkit.runAgent({ agent })
    } catch (e) {
      toast.error('trace could not reply', { description: e instanceof Error ? e.message : String(e) })
    }
    await persist()
    const last = [...(agent.messages as AnyMsg[])].reverse().find((m) => m.role === 'assistant' && textOf(m))
    if (last && prefs.voice.readAloud !== 'off') {
      const text = textOf(last)
      enqueueSpeech(last.id, prefs.voice.readAloud === 'summary' ? (text.split(/\n\n/)[0] ?? text) : text)
    }
  }, [agent, copilotkit, persist, prefs.voice.readAloud])

  const send = (text: string) => {
    stopSpeaking()
    agent.addMessage({ id: crypto.randomUUID(), role: 'user', content: text })
    push(text)
    void persist()
    void run()
  }

  const retry = () => {
    const ms = agent.messages as AnyMsg[]
    const lastUser = ms.map((m) => m.role).lastIndexOf('user')
    if (lastUser < 0) return
    agent.setMessages(ms.slice(0, lastUser + 1) as Message[])
    void run()
  }

  // a question handed over by a screen (askTrace): the main panel sends it once
  const pending = useStore(pendingAsk)
  useEffect(() => {
    if (agentId !== AGENT_ID || !pending || running) return
    pendingAsk.set(null)
    send(pending.text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, agentId])

  // keep the newest message in view while it streams
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight
  }, [messages])

  const toolResults = useMemo(() => new Map(messages.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m])), [messages])
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')?.id

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div ref={scroller} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite" aria-busy={running}>
        {messages.length === 0 && intro}
        {messages.map((m, i) => {
          if (m.role === 'user')
            return (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl bg-muted px-3.5 py-2">
                  <Markdown text={textOf(m)} />
                </div>
              </div>
            )
          if (m.role === 'reasoning') {
            if (prefs.chat.reasoning === 'hidden') return null
            return (
              <Collapsible key={m.id}>
                <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground">
                  <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" /> Show reasoning
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-1 whitespace-pre-wrap border-l pl-3 text-xs text-muted-foreground">{textOf(m)}</CollapsibleContent>
              </Collapsible>
            )
          }
          if (m.role !== 'assistant') return null
          const text = textOf(m)
          const streaming = running && i === messages.length - 1
          return (
            <div key={m.id} className="group/msg">
              {i === 0 || messages[i - 1]?.role !== 'assistant' ? (
                <p className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="flex size-4 items-center justify-center rounded bg-foreground font-mono text-[10px] font-semibold text-background">t</span> trace
                </p>
              ) : null}
              {text && <Markdown text={text} streaming={streaming} />}
              {speaking.messageId === m.id && <SpokenText text={text} />}
              {m.toolCalls?.map((tc) => (
                <div key={tc.id}>{renderToolCall({ toolCall: tc, toolMessage: toolResults.get(tc.id) as never })}</div>
              ))}
              {text && !streaming && (
                <MessageActions
                  onSpeak={() => void speak(m.id, text).catch(() => toast.error('Could not read that aloud.'))}
                  onCopy={() => void navigator.clipboard?.writeText(text).then(() => toast('Copied as markdown'))}
                  onRetry={m.id === lastAssistant ? retry : undefined}
                  onFeedback={(reason) => {
                    if (!repo || !thread.current) return
                    void call('chats.append', { repo, id: thread.current, message: { role: 'system', content: JSON.stringify({ feedback: 'down', messageId: m.id, reason }) } })
                    toast('Thanks. That helps trace improve.')
                  }}
                />
              )}
            </div>
          )
        })}
        {running && messages[messages.length - 1]?.role === 'user' && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="flex gap-1" aria-hidden>
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.2s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.1s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
            </span>
            trace is working
          </p>
        )}
      </div>
      <div className="border-t p-3">
        <ChatInput
          onSend={send}
          onStop={() => copilotkit.stopAgent({ agent })}
          running={running}
          history={history}
          placeholder={placeholder}
          repo={repo}
          onReadAgain={() => {
            const last = [...messages].reverse().find((m) => m.role === 'assistant' && textOf(m))
            if (last) void speak(last.id, textOf(last))
          }}
        />
      </div>
    </div>
  )
}

function MessageActions({ onSpeak, onCopy, onRetry, onFeedback }: { onSpeak: () => void; onCopy: () => void; onRetry?: () => void; onFeedback: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-1 flex items-center gap-0.5 text-muted-foreground opacity-70 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
      <Button variant="ghost" size="icon" className="size-7" aria-label="Read aloud" onClick={onSpeak}>
        <Volume2 className="size-3.5" />
      </Button>
      <Button variant="ghost" size="icon" className="size-7" aria-label="Copy as markdown" onClick={onCopy}>
        <Copy className="size-3.5" />
      </Button>
      {onRetry && (
        <Button variant="ghost" size="icon" className="size-7" aria-label="Retry" onClick={onRetry}>
          <RotateCcw className="size-3.5" />
        </Button>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Not helpful">
            <ThumbsDown className="size-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 space-y-2" align="start">
          <p className="text-sm font-medium">What was wrong?</p>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Wrong, unclear, too long…" />
          <Button size="sm" disabled={!reason.trim()} onClick={() => { onFeedback(reason.trim()); setOpen(false); setReason('') }}>
            Send
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  )
}

/** While a reply is read aloud: its spoken text with the current word highlighted; tap a sentence to jump there. */
function SpokenText({ text }: { text: string }) {
  const s = useSpeech()
  const spoken = speakable(text)
  const sentences = spoken.match(/[^.!?]+[.!?]*\s*/g) ?? [spoken]
  let offset = 0
  return (
    <p className="mt-2 rounded-md bg-muted/50 p-2 text-xs leading-relaxed text-muted-foreground">
      {sentences.map((sent, i) => {
        const start = offset
        offset += sent.length
        const w = s.word
        const inside = w && w.start >= start && w.start < start + sent.length
        return (
          <button key={i} type="button" className="text-left hover:text-foreground" onClick={() => void speak(s.messageId ?? '', text, { fromChar: start })}>
            {inside && w ? (
              <>
                {sent.slice(0, w.start - start)}
                <span className="speaking-word text-foreground">{sent.slice(w.start - start, w.end - start)}</span>
                {sent.slice(w.end - start)}
              </>
            ) : (
              sent
            )}
          </button>
        )
      })}
    </p>
  )
}
