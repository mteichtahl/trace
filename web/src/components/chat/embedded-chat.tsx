/**
 * The chat embedded in Focus mode: the same conversation, scoped to the step (its own agent registration so it keeps
 * its own thread beside the Ask trace panel). Pass `intro` for trace's summary of the step and its recommendation.
 */
import { Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { FOCUS_AGENT_ID } from './agent'
import { ChatView } from './chat-view'
import { PlayerBar } from './voice/voice-controls'

export function EmbeddedChat({ repo, threadId, intro, title = 'trace', placeholder = 'Ask about this step…' }: { repo?: string; threadId?: string; intro?: ReactNode; title?: string; placeholder?: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3 font-semibold">
        <Sparkles className="size-4 text-primary" aria-hidden /> {title}
      </div>
      <ChatView agentId={FOCUS_AGENT_ID} repo={repo} threadId={threadId} intro={intro} placeholder={placeholder} />
      <div className="px-3 pb-2">
        <PlayerBar />
      </div>
    </div>
  )
}
