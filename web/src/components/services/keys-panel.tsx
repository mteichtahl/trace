/**
 * The Keys panel, shown once after a connected system is created or given a new secret: the client id and the secret
 * with copy buttons and the words "This secret is shown once", the sign-in, API and MCP addresses, and three
 * ready-made snippets (get a sign-in token, call the API, connect an AI agent). The secret lives only in this
 * component's props: nothing stores it, and "I've stored it" drops it for good.
 */
import { Check, Copy, KeyRound, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { type ShownKeys, snippets } from '@/lib/services'
import { cn } from '@/lib/utils'

/** A small copy button; says what it copied. */
export function CopyButton({ value, label, className, variant = 'ghost' }: { value: string; label: string; className?: string; variant?: 'ghost' | 'outline' }) {
  const [done, setDone] = useState(false)
  const t = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(t.current), [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setDone(true)
      clearTimeout(t.current)
      t.current = setTimeout(() => setDone(false), 1500)
      toast(`${label.charAt(0).toUpperCase()}${label.slice(1)} copied`)
    } catch {
      toast.error(`Could not copy the ${label}: select it and copy it by hand.`)
    }
  }
  return (
    <Button type="button" variant={variant} size="sm" className={cn('h-8 shrink-0', className)} onClick={() => void copy()} aria-label={`Copy the ${label}`}>
      {done ? <Check aria-hidden /> : <Copy aria-hidden />}
      <span className="sr-only sm:not-sr-only">{done ? 'Copied' : 'Copy'}</span>
    </Button>
  )
}

/** A label, a value in mono that wraps anywhere, and its copy button. */
export function CopyRow({ label, value, copyLabel, strong }: { label: string; value: string; copyLabel?: string; strong?: boolean }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className={cn('flex items-start gap-2 rounded-lg border bg-muted/40 py-1.5 pl-3 pr-1.5', strong && 'border-warning/60 bg-warning/10')}>
        <code className="min-w-0 flex-1 break-all py-1 font-mono text-[13px] leading-5">{value}</code>
        <CopyButton value={value} label={copyLabel ?? label.toLowerCase()} />
      </div>
    </div>
  )
}

function Snippet({ code, label }: { code: string; label: string }) {
  return (
    <div className="relative rounded-lg border bg-muted/40">
      <pre className="max-h-64 overflow-auto p-3 pr-24 font-mono text-[12.5px] leading-5"><code>{code}</code></pre>
      <CopyButton value={code} label={label} variant="outline" className="absolute right-2 top-2 bg-background" />
    </div>
  )
}

export function KeysPanel({ keys, onDone, className }: { keys: ShownKeys; onDone: () => void; className?: string }) {
  const s = snippets(keys)
  return (
    <section aria-labelledby="keys-title" className={cn('space-y-5', className)}>
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><KeyRound className="size-4" aria-hidden /></span>
        <div className="min-w-0">
          <h2 id="keys-title" className="font-semibold">{keys.secret_id ? `A new secret for ${keys.name}` : `Keys for ${keys.name}`}</h2>
          <p className="text-sm text-muted-foreground">
            {keys.secret_id ? 'The old secret keeps working until you retire it, so the system can switch over without stopping.' : 'Give these to the system. It swaps them for a sign-in token, then calls trace with the token.'}
          </p>
        </div>
      </div>

      <div role="alert" className="flex items-start gap-2 rounded-lg border border-warning/60 bg-warning/15 p-3 text-sm">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-hidden />
        <p><strong className="font-semibold">This secret is shown once. Store it now.</strong> Put it in your password manager or the other system's secret store. trace does not keep it; if it is lost, make a new one.</p>
      </div>

      <div className="space-y-3">
        <CopyRow label="Client id" value={keys.client_id} />
        <CopyRow label="Secret" value={keys.secret} strong />
      </div>

      <div className="space-y-3">
        <p className="section-label">Addresses</p>
        <CopyRow label="Sign-in (token) address" value={keys.token_url || 'Not given by this installation yet'} copyLabel="sign-in address" />
        <CopyRow label="API address" value={keys.api_url || 'Not given by this installation yet'} copyLabel="API address" />
        <CopyRow label="MCP address (for AI agents)" value={keys.mcp_url || 'Not given by this installation yet'} copyLabel="MCP address" />
      </div>

      <div className="space-y-2">
        <p className="section-label">Ready-made snippets</p>
        <Tabs defaultValue="token">
          <TabsList className="h-auto w-full flex-wrap justify-start">
            <TabsTrigger value="token">Get a sign-in token</TabsTrigger>
            <TabsTrigger value="api">Call the API</TabsTrigger>
            <TabsTrigger value="mcp">Connect an AI agent (MCP)</TabsTrigger>
          </TabsList>
          <TabsContent value="token" className="space-y-2">
            <p className="text-xs text-muted-foreground">A token lasts an hour. Reuse it until it nears expiry: each new sign-in costs a little.</p>
            <Snippet code={s.token} label="sign-in snippet" />
          </TabsContent>
          <TabsContent value="api" className="space-y-2">
            <p className="text-xs text-muted-foreground">The same actions as the app, as JSON. This one lists the projects the system is on.</p>
            <Snippet code={s.api} label="API snippet" />
          </TabsContent>
          <TabsContent value="mcp" className="space-y-2">
            <p className="text-xs text-muted-foreground">Add this to an MCP client's settings (Claude Code, for example), with a token from the first snippet.</p>
            <Snippet code={s.mcp} label="MCP settings" />
          </TabsContent>
        </Tabs>
      </div>

      <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">After this, the secret can't be shown again.</p>
        <Button onClick={onDone}>I've stored it</Button>
      </div>
    </section>
  )
}
