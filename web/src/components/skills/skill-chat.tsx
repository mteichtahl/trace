/**
 * A skill's chat with trace, kept (test log R25): the same conversation opens again on the next visit or after a
 * reload, as the Intent builder's does (intent-chat.tsx useSkillThread). Its thread is kept in the person's
 * preferences per project and skill; the chat waits for them, so a kept conversation is not replaced by a new one.
 */
import type { ComponentProps } from 'react'
import { EmbeddedChat } from '@/components/chat/embedded-chat'
import { useSkillThread } from './intent-chat'

export function SkillChat({ repo, skill, ...rest }: Omit<ComponentProps<typeof EmbeddedChat>, 'repo' | 'threadId' | 'onThread'> & { repo: string; skill: string }) {
  const kept = useSkillThread(repo, skill)
  if (!kept.loaded) return <p className="px-4 py-3 text-sm text-muted-foreground">Opening the conversation…</p>
  return <EmbeddedChat repo={repo} threadId={kept.thread} onThread={kept.keep} {...rest} />
}
