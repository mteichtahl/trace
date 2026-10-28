import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CheckCircle2, Circle, CircleMinus, CircleX, Clock, ExternalLink, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { Step } from '../../answers.js'
import { checkWaitNow } from '../actions.js'
import { account, region, waitLine } from '../model.js'
import { CopyButton, Note, Steps } from '../parts.js'
import { useStore } from '../store.js'

const ICON: Record<Step['status'], ReactNode> = {
  pending: <Circle className="text-muted-foreground/50" />,
  running: <Loader2 className="animate-spin text-primary" />,
  done: <CheckCircle2 className="text-verified" />,
  skipped: <CircleMinus className="text-muted-foreground" />,
  failed: <CircleX className="text-destructive" />,
}
const STATE: Record<Step['status'], string> = { pending: 'Pending', running: 'Running', done: 'Done', skipped: 'Skipped', failed: 'Failed' }

/** A display tick while a timer wait is open: redraws the countdown, asks the installer nothing. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [on])
  return now
}

function Log() {
  const s = useStore()
  const [open, setOpen] = useState(false)
  const show = open || Boolean(s.result && !s.result.ok)
  const pre = useRef<HTMLPreElement>(null)
  const follow = useRef(true)
  useLayoutEffect(() => { const el = pre.current; if (el && follow.current) el.scrollTop = el.scrollHeight }, [s.log.length, show])
  if (!s.log.length) return null
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => setOpen(!show)}>{show ? 'Hide the log' : 'Show the log'}</Button>
        <span className="text-xs text-muted-foreground">Tokens and keys are hidden in the log.</span>
        {show ? <span className="ml-auto"><CopyButton text={s.log.join('\n')} label="Copy the log" /></span> : null}
      </div>
      {show ? (
        <pre ref={pre} onScroll={(e) => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}
          className="max-h-80 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{s.log.join('\n')}</pre>
      ) : null}
    </div>
  )
}

/** The one step that may need the person: authorising the AWS connection to GitHub, once per account and region. */
function Authorise({ name }: { name: string }) {
  const s = useStore()
  const reg = region(s)
  const url = `https://${reg}.console.aws.amazon.com/codesuite/settings/connections?region=${reg}`
  const repos = [...s.projects.keys()]
  return (
    <div className="mt-2 grid gap-3 rounded-lg border border-primary bg-primary-soft/50 p-4">
      <div className="grid gap-1">
        <p className="font-semibold">Authorise the connection once in the AWS console</p>
        <p className="text-xs text-muted-foreground">A new connection starts as pending. A person has to approve it once; trace can't do this for you.</p>
      </div>
      <Steps>
        {[
          <>Open the link below. It goes to the connections in the AWS console, in <span className="font-mono">{reg}</span>, and choose <span className="font-mono">{name}</span>.</>,
          <>Choose <strong>"Update pending connection"</strong>.</>,
          <>Install the <strong>AWS Connector for GitHub</strong> app and give it access to {repos.length ? repos.map((r, i) => <span key={r}>{i ? ', ' : ''}<span className="font-mono">{r}</span></span>) : 'your repositories'}.</>,
        ]}
      </Steps>
      <div className="flex flex-wrap gap-2">
        <Button asChild><a href={url} target="_blank" rel="noopener">Open the AWS console<ExternalLink /></a></Button>
        <CopyButton text={url} label="Copy link" />
      </div>
    </div>
  )
}

export function InstallStep() {
  const s = useStore()
  const now = useNow(s.waits.size > 0)
  const f = s.pre?.facts
  const total = s.steps.length
  const done = s.steps.filter((x) => x.status === 'done' || x.status === 'skipped').length
  const title = s.result ? (s.result.ok ? 'trace is installed' : 'The installation stopped') : s.ready ? 'trace is ready' : 'Installing trace'
  const failed = s.steps.find((x) => x.status === 'failed')
  return (
    <Card className="gap-5">
      <CardHeader>
        <CardTitle className="text-xl tracking-tight">{title}</CardTitle>
        <CardDescription className="grid gap-1">
          <span className="text-foreground">Account <span className="font-mono">{f?.account ? account(f.account) : ''}</span> · <span className="font-mono">{region(s)}</span> · {s.projects.size} project{s.projects.size === 1 ? '' : 's'}</span>
          <span>{s.result ? `${done} of ${total} steps done.` : `${done} of ${total} steps done. You can leave this page open; everything runs on its own, and only a step that needs you will say so.`}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {s.appUrl && (s.ready || s.result?.ok) ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-primary-soft p-3">
            <Button asChild><a href={s.appUrl} target="_blank" rel="noopener">Open trace<ExternalLink /></a></Button>
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{s.appUrl}</span>
            <CopyButton text={s.appUrl} label="Copy address" />
          </div>
        ) : null}
        {s.result ? (
          <Note tone={s.result.ok ? 'ok' : 'fail'} title={s.result.ok ? 'Done' : failed ? `Stopped at "${failed.title}"` : 'Stopped'}>
            <ul className="grid list-disc gap-1 pl-4">{s.result.summary.map((l) => <li key={l}>{l}</li>)}</ul>
            {!s.result.ok ? <p>Fix the cause (the log below says what went wrong), then run <code className="font-mono">tracectl install</code> again: it picks up where this stopped.</p> : null}
          </Note>
        ) : s.ready ? (
          <Note tone="ok" title={s.appUrl ? 'Sign in at the address above, or with tracectl login' : 'Sign in with tracectl login'}>
            <p>Only the graphics card image is still being made (its first build takes 30 to 60 minutes); you don't need to wait for it.</p>
            <ul className="grid list-disc gap-1 pl-4">{s.ready.map((l) => <li key={l}>{l}</li>)}</ul>
          </Note>
        ) : null}

        <ol className="grid">
          {s.steps.map((st) => {
            const w = s.waits.get(st.id)
            return (
              <li key={st.id} className="flex gap-3 border-b py-3 last:border-b-0" aria-current={st.status === 'running' ? 'step' : undefined}>
                <span className="mt-0.5 [&_svg]:size-5">{ICON[st.status]}</span>
                <div className="grid min-w-0 flex-1 gap-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className={cn('font-medium', st.status === 'pending' && 'text-muted-foreground')}>{st.title}</span>
                    <Badge variant="outline" className={cn('font-normal', w ? 'border-primary/40 text-primary' : 'text-muted-foreground', st.status === 'failed' && 'border-destructive/40 text-destructive')}>{w ? 'Waiting' : STATE[st.status]}</Badge>
                  </p>
                  <p className="text-xs break-words text-muted-foreground">{st.detail}</p>
                  {w && /to be authori[sz]ed$/.test(w.wait.what) ? <Authorise name={w.wait.what.replace(/ to be authori[sz]ed$/, '')} /> : null}
                  {w ? (
                    <div className="mt-2 grid gap-2 rounded-lg border border-primary/40 p-3">
                      <div className="flex items-start gap-2 text-sm">
                        <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <p className="flex-1" aria-live="off">{waitLine(w.wait, now)}</p>
                        <Button size="sm" variant="outline" disabled={w.asked} onClick={() => void checkWaitNow(st.id)}>{w.asked ? <Loader2 className="animate-spin" /> : null}{w.asked ? 'Checking…' : 'Check now'}</Button>
                      </div>
                      {w.wait.why ? <p className="text-xs text-muted-foreground">Checked on a timer because {w.wait.why}.</p> : null}
                      {w.error ? <p className="text-xs text-destructive">Check now did not go through: {w.error}</p> : null}
                    </div>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ol>
        <Log />
      </CardContent>
    </Card>
  )
}
