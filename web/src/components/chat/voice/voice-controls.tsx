/** The chat header's voice controls (Read aloud toggle, voice picker with Preview, speed) and the player bar. */
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Pause, Play, SkipForward, Square, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { usePrefs, useSetPref } from '@/lib/prefs'
import { listVoices, pauseSpeaking, previewVoice, setRate, setVoice, skipSpeaking, speech, stopSpeaking, useSpeech } from './speech'

const RATES = [0.75, 1, 1.25, 1.5]

export function VoiceControls() {
  const prefs = usePrefs()
  const setPref = useSetPref()
  const s = useSpeech()
  const voices = useQuery({ queryKey: ['voice.voices', prefs.voice.language], queryFn: () => listVoices(prefs.voice.language), staleTime: 3600_000, retry: false })
  const current = s.voice ?? prefs.voice.voice ?? voices.data?.voices[0]?.id
  const name = voices.data?.voices.find((v) => v.id === current)?.name ?? current ?? 'Voice'
  const rate = s.rate !== 1 ? s.rate : prefs.voice.rate
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1">
        <Switch checked={prefs.voice.readAloud !== 'off'} onCheckedChange={(on) => setPref('voice', 'readAloud', on ? 'all' : 'off')} aria-label="Read replies aloud" className="scale-90" />
        <Volume2 className="size-3.5" aria-hidden /> Read aloud
      </label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 text-xs">
            Voice: {name} <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-auto">
          <DropdownMenuLabel>Voices for {prefs.voice.language}</DropdownMenuLabel>
          {voices.isError && <p className="px-2 py-1.5 text-xs text-muted-foreground">Voices could not be loaded.</p>}
          {voices.data?.voices.map((v) => (
            <DropdownMenuItem
              key={v.id}
              onSelect={() => {
                setVoice(v.id)
                setPref('voice', 'voice', v.id)
              }}
              className="justify-between"
            >
              <span>
                {v.name} <span className="text-muted-foreground">({v.engines.join(', ')})</span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-xs"
                onClick={(e) => {
                  e.stopPropagation()
                  void previewVoice(v.id)
                }}
              >
                Preview
              </Button>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 w-12 text-xs" aria-label={`Speed ${rate}×`}>
            {rate}×
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Speaking speed</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {RATES.map((r) => (
            <DropdownMenuItem key={r} onSelect={() => { setRate(r); setPref('voice', 'rate', r) }}>
              {r}×
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function PlayerBar() {
  const s = useSpeech()
  if (!s.messageId) return null
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-1.5 text-xs" role="status">
      <Volume2 className="size-3.5 text-primary" aria-hidden />
      <span className="flex-1">
        Speaking · {speech.get().voice ?? 'voice'} · {s.rate}×
      </span>
      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={pauseSpeaking}>
        {s.playing ? <Pause /> : <Play />} {s.playing ? 'Pause' : 'Play'}
      </Button>
      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={skipSpeaking} aria-label="Skip to next reply">
        <SkipForward />
      </Button>
      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={stopSpeaking}>
        <Square /> Stop
      </Button>
    </div>
  )
}
