/**
 * The Intent builder's conversation: trace opens it, and it is kept.
 *
 * - trace asks the topic's question when the builder opens (test-esp32 #8: the chat was empty on arrival, as the
 *   opening line was the bar's count, "0 of 7 checks met.", not a question). In a new conversation it is the first
 *   thing said; coming back to a kept one, it stands after what was said before, at the topic the person left.
 * - the conversation is kept with the person's preferences (one thread per project and skill), so it is there when
 *   they come back, on any device, as the rail promises: "trace picks up at the topic you left" (test-esp32 #21: a
 *   new, empty chat every visit).
 */
import { useCallback } from 'react'
import { Rich } from '@/components/rich'
import { getPath, useMe, useSetMe } from '@/lib/prefs'
import type { SkillDef } from './definitions'

/** trace's question for each topic of the intent, asked one at a time. */
export const TOPIC_QUESTIONS: Readonly<Record<string, string>> = {
  purpose: 'What does the product do, in one sentence, and who uses it?',
  environment: 'Where does it live? The operating and storage temperatures, the enclosure and its ingress protection, vibration, and where it is installed.',
  power: 'What powers it? The source, the input voltage range, the power budget, the battery life if it has a battery, and what it does on a brown-out.',
  interfaces: 'What does it connect to? For each one: its type, connector, protocol, rate and direction.',
  performance: 'Which numbers say it works? Accuracy, latency, resolution, range or throughput, each with its unit.',
  physical: 'How big may it be? The board size limits, mounting, height, where the connectors go, and the enclosure.',
  compliance: 'Which standards must it meet? The target standards and class, safety, and the markings.',
  build: 'How many, and at what cost? The quantity per run, the target unit cost, and how you would like it assembled.',
  constraints: 'Are there parts or vendors it must use or avoid, or an earlier design to reuse?',
  references: 'Is there anything to work from? Specs, datasheets, sketches or earlier boards.',
}

/**
 * trace's opening words for the topic the builder is on: the first topic's question in a new intent, or the topic
 * the person left, picked up. Any topic can be answered "don't care" or "not known yet". Pure.
 */
export function openingWords(def: Pick<SkillDef, 'steps'>, topic: number, answered: readonly string[]): string {
  const t = def.steps[topic] ?? def.steps[0]!
  const ask = TOPIC_QUESTIONS[t.id] ?? t.detail
  if (topic === 0 && answered.length === 0) {
    return `Let's write the intent, one topic at a time; I note each statement in the draft as you answer. Any topic can be "don't care" or "not known yet".\n\nFirst, **${t.title.toLowerCase()}**. ${ask}`
  }
  return `We're on **${t.title.toLowerCase()}** (topic ${topic + 1} of ${def.steps.length}). ${ask}`
}

/** trace's opening, drawn as trace's own message in the chat. */
export function IntentOpening({ words }: { words: string }) {
  return (
    <div className="mx-auto max-w-[680px] text-sm" aria-label="trace asks">
      <p className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="flex size-4 items-center justify-center rounded bg-foreground font-mono text-[10px] font-semibold text-background">t</span> trace
      </p>
      {words.split('\n\n').map((p, i) => <p key={i} className={i ? 'mt-2' : undefined}><Rich text={p} /></p>)}
    </div>
  )
}

/** Where a skill's conversation is kept in the person's preferences: plain names only, as preference keys take. */
export const threadKey = (repo: string, skill: string): string => `threads.${repo.replace(/[^A-Za-z0-9_-]/g, '_')}.${skill.replace(/[^A-Za-z0-9_-]/g, '_')}`

/**
 * The skill's kept conversation on the project: its thread (undefined for none yet), whether the preferences have
 * loaded (the chat waits for them, so a kept conversation is not replaced by a new one), and `keep` for a new thread.
 */
export function useSkillThread(repo: string, skill: string): { loaded: boolean; thread: string | undefined; keep: (id: string) => void } {
  const me = useMe()
  const set = useSetMe()
  const key = threadKey(repo, skill)
  const v = getPath(me.data, key)
  const { mutate } = set
  const keep = useCallback((id: string) => mutate({ key, value: id }), [mutate, key])
  return { loaded: me.isSuccess || me.isError, thread: typeof v === 'string' && v ? v : undefined, keep }
}
