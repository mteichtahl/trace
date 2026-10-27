/** Enter the code: six single-digit boxes that accept a paste, with "Send a new code" counting down from 30 seconds. */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { AuthCard, FieldError } from '@/components/auth-card'
import { Button } from '@/components/ui/button'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { pending, respond } from '@/lib/auth'
import { HttpError } from '@/lib/http'
import { useStore } from '@/lib/store'
import { safeNext } from './index'

export const Route = createFileRoute('/sign-in/code')({
  validateSearch: z.object({ next: z.string().optional() }),
  component: Code,
})

export const RESEND_AFTER_S = 30

function Code() {
  const p = useStore(pending)
  const navigate = useNavigate()
  const { next } = Route.useSearch()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wait, setWait] = useState(RESEND_AFTER_S)

  useEffect(() => {
    if (!p) void navigate({ to: '/sign-in', search: next ? { next } : {} })
  }, [p, navigate, next])
  useEffect(() => {
    if (wait <= 0) return
    const t = setTimeout(() => setWait((w) => w - 1), 1000)
    return () => clearTimeout(t)
  }, [wait])

  if (!p) return null
  const totp = p.codeKind === 'totp'

  const submit = async (value: string) => {
    setBusy(true)
    setError(null)
    try {
      const r = await respond({ email: p.email, session: p.session, kind: totp ? 'totp' : 'email_code', answer: value })
      if (r.signedIn) {
        pending.set(null)
        void navigate({ to: safeNext(next ?? p.next) })
      } else {
        pending.set({ ...p, session: r.session })
        setError('That code did not work. Check it and try again.')
      }
    } catch (e) {
      setError(e instanceof HttpError && e.status === 400 ? 'That code is not right, or it has expired.' : e instanceof Error ? e.message : 'Something went wrong.')
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  const resend = async () => {
    setWait(RESEND_AFTER_S)
    try {
      const r = await respond({ email: p.email, session: p.session, kind: 'email_code', answer: 'request' })
      if (!r.signedIn) pending.set({ ...p, session: r.session })
    } catch {
      setError('A new code could not be sent. Try again in a moment.')
    }
  }

  return (
    <AuthCard
      wordmark={false}
      title="Enter the code"
      description={totp ? 'Open your authenticator app and enter the 6-digit code for trace.' : `We sent 6 digits to ${p.email}. You can paste it.`}
    >
      <div className="space-y-5">
        <InputOTP
          maxLength={6}
          value={code}
          onChange={setCode}
          onComplete={(v) => void submit(v)}
          autoFocus
          inputMode="numeric"
          pattern="^[0-9]*$"
          aria-label="Six-digit code"
          containerClassName="justify-center"
        >
          <InputOTPGroup className="gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <InputOTPSlot key={i} index={i} className="size-12 rounded-md border text-lg first:rounded-md last:rounded-md" />
            ))}
          </InputOTPGroup>
        </InputOTP>
        <FieldError>{error}</FieldError>
        {busy && (
          <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Checking
          </p>
        )}
        {!totp && (
          <p className="text-center text-sm text-muted-foreground" aria-live="polite">
            {wait > 0 ? (
              `Send a new code in ${wait} seconds`
            ) : (
              <Button variant="link" className="h-auto p-0" onClick={() => void resend()}>
                Send a new code
              </Button>
            )}
          </p>
        )}
      </div>
    </AuthCard>
  )
}
