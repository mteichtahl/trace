/**
 * The message box: Enter sends and Shift+Enter adds a line (or ⌘Enter sends, per preference); Up and Down recall
 * sent messages (recall.ts); Escape leaves recall and restores the draft. A microphone button dictates (hold to
 * talk, or tap to start and stop) with a level meter and "Listening…", words appearing live; spoken commands send,
 * cancel, stop and read that again. On a phone a history button lists sent messages to pick from.
 */
import { ArrowUp, History, Loader2, Mic, Square } from 'lucide-react'
import { useRef, useState, type KeyboardEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { usePrefs } from '@/lib/prefs'
import { cn } from '@/lib/utils'
import { type RecallState, dedupe, down, escape, initialRecall, up } from './recall'
import { type Dictation, spokenCommand, startDictation } from './voice/dictation'
import { stopSpeaking } from './voice/speech'

export interface ChatInputProps {
  onSend: (text: string) => void
  onStop?: () => void
  running?: boolean
  history: string[]
  placeholder?: string
  repo?: string
  /** "read that again" */
  onReadAgain?: () => void
  disabled?: boolean
  className?: string
}

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export function ChatInput({ onSend, onStop, running, history, placeholder = 'Ask about this project…', repo, onReadAgain, disabled, className }: ChatInputProps) {
  const prefs = usePrefs()
  const [value, setValue] = useState('')
  const [recall, setRecall] = useState<RecallState>(initialRecall)
  const [listening, setListening] = useState<'off' | 'starting' | 'on'>('off')
  const [level, setLevel] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const dict = useRef<Dictation | null>(null)
  const before = useRef('')
  const holdTimer = useRef<number>(0)

  const send = (text = value) => {
    const t = text.trim()
    if (!t || disabled) return
    onSend(t)
    setValue('')
    setRecall(initialRecall)
  }

  const setAndPlace = (v: string, where: 'start' | 'end') => {
    setValue(v)
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      const p = where === 'start' ? 0 : v.length
      el.setSelectionRange(p, p)
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    const cursor = el.selectionStart ?? 0
    const enterSends = prefs.chat.enter === 'enter'
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      if ((enterSends && !e.shiftKey && !e.metaKey && !e.ctrlKey) || (!enterSends && (e.metaKey || e.ctrlKey))) {
        e.preventDefault()
        send()
      }
      return
    }
    if (!prefs.chat.recall || el.selectionStart !== el.selectionEnd) return
    if (e.key === 'ArrowUp') {
      const r = up(recall, history, value, cursor)
      if (r.value !== null) {
        e.preventDefault()
        setRecall(r.state)
        setAndPlace(r.value, 'end')
      }
    } else if (e.key === 'ArrowDown') {
      const r = down(recall, history, value, cursor)
      if (r.value !== null) {
        e.preventDefault()
        setRecall(r.state)
        setAndPlace(r.value, 'end')
      }
    } else if (e.key === 'Escape') {
      const r = escape(recall)
      if (r.value !== null) {
        e.preventDefault()
        e.stopPropagation()
        setRecall(r.state)
        setAndPlace(r.value, 'end')
      }
    }
  }

  const startMic = async () => {
    if (listening !== 'off') return
    stopSpeaking()
    setListening('starting')
    before.current = value
    try {
      dict.current = await startDictation({
        language: prefs.voice.language,
        repo,
        onLevel: setLevel,
        onText: (text, partial) => {
          const cmd = !partial && prefs.voice.commands ? spokenCommand(text) : null
          const joined = `${before.current}${before.current && text ? ' ' : ''}${cmd ? cmd.rest : text}`
          setValue(joined)
          if (!cmd) return
          if (cmd.command === 'send') {
            stopMic()
            send(joined)
          } else if (cmd.command === 'cancel') {
            stopMic()
            setValue(before.current)
          } else if (cmd.command === 'stop') {
            stopMic()
            onStop?.()
            stopSpeaking()
          } else if (cmd.command === 'read-again') onReadAgain?.()
        },
        onError: (m) => toast.error('Dictation stopped', { description: m }),
        onEnd: () => {
          setListening('off')
          setLevel(0)
        },
      })
      setListening('on')
    } catch (e) {
      setListening('off')
      toast.error('Could not start the microphone', { description: e instanceof Error ? e.message : String(e) })
    }
  }
  const stopMic = () => {
    dict.current?.stop()
    dict.current = null
    setListening('off')
    setLevel(0)
    if (prefs.voice.sendOnStop) requestAnimationFrame(() => send(ref.current?.value ?? ''))
  }

  // hold to talk, or tap to start and tap again to stop
  const micDown = () => {
    if (listening === 'on') return stopMic()
    holdTimer.current = window.setTimeout(() => (holdTimer.current = -1), 350)
    void startMic()
  }
  const micUp = () => {
    if (holdTimer.current === -1 && prefs.voice.mic === 'hold') stopMic()
    else clearTimeout(holdTimer.current)
    holdTimer.current = 0
  }

  const list = dedupe(history).slice(0, 30)

  return (
    <div className={cn('rounded-xl border bg-background p-2 focus-within:ring-2 focus-within:ring-ring/40', className)}>
      {listening !== 'off' && (
        <div className="mb-1.5 flex items-center gap-2 rounded-md bg-primary/10 px-2 py-1 text-xs text-primary" role="status">
          <span className="flex h-3 items-end gap-px" aria-hidden>
            {[0.4, 0.7, 1, 0.7, 0.4].map((k, i) => (
              <span key={i} className="w-0.5 rounded-sm bg-primary transition-[height]" style={{ height: `${Math.max(2, level * k * 12)}px` }} />
            ))}
          </span>
          {listening === 'starting' ? 'Starting the microphone…' : 'Listening…'}
        </div>
      )}
      <Textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          stopSpeaking()
          if (recall.index !== -1) setRecall((r) => r)
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={2}
        aria-label="Message to trace"
        className="max-h-48 min-h-[44px] resize-none border-0 p-1.5 shadow-none focus-visible:ring-0"
      />
      <div className="flex items-center gap-1">
        <p className="hidden flex-1 truncate px-1 text-[11px] text-muted-foreground sm:block">
          {prefs.chat.recall && '↑↓ recall earlier messages · '}
          {prefs.chat.enter === 'enter' ? 'Enter sends · Shift+Enter new line' : `${mac ? '⌘' : 'Ctrl'}+Enter sends`}
        </p>
        <span className="flex-1 sm:hidden" />
        {list.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8 sm:hidden" aria-label="Sent messages">
                <History />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="max-h-72 w-72 overflow-auto p-1">
              {list.map((h, i) => (
                <button key={i} type="button" className="block w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-accent" onClick={() => setAndPlace(h, 'end')}>
                  {h}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        )}
        <Button
          variant={listening === 'on' ? 'default' : 'outline'}
          size="icon"
          className="size-8"
          aria-label={listening === 'on' ? 'Stop dictating' : 'Dictate (hold to talk, or tap)'}
          aria-pressed={listening === 'on'}
          onPointerDown={micDown}
          onPointerUp={micUp}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              if (listening === 'on') stopMic()
              else void startMic()
            }
          }}
        >
          {listening === 'starting' ? <Loader2 className="animate-spin" /> : <Mic />}
        </Button>
        {running ? (
          <Button size="icon" className="size-8" variant="outline" aria-label="Stop the reply" onClick={onStop}>
            <Square className="fill-current" />
          </Button>
        ) : (
          <Button size="icon" className="size-8" aria-label="Send" disabled={!value.trim() || disabled} onClick={() => send()}>
            <ArrowUp />
          </Button>
        )}
      </div>
    </div>
  )
}
