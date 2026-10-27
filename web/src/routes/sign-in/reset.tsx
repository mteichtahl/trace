/** Forgot password: email → a code by email → a new password. Never says whether the email has an account. */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { AuthCard, FieldError } from '@/components/auth-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { Label } from '@/components/ui/label'
import { forgot, pending, reset, respond } from '@/lib/auth'
import { safeNext } from './index'

export const Route = createFileRoute('/sign-in/reset')({
  validateSearch: z.object({ email: z.string().optional(), mode: z.enum(['forgot', 'new']).optional() }),
  component: Reset,
})

export const passwordProblem = (pw: string): string | null =>
  pw.length < 12 ? 'At least 12 characters.' : !/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw) ? 'Use upper and lower case letters and a number.' : null

function Reset() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const [email, setEmail] = useState(search.email ?? '')
  const [step, setStep] = useState<'email' | 'code'>(search.mode === 'new' ? 'code' : 'email')
  const [code, setCode] = useState('')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const newPassword = search.mode === 'new'

  const send = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await forgot(email.trim())
      setStep('code')
    } catch {
      setError('The code could not be sent. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    const problem = passwordProblem(pw)
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      if (newPassword) {
        const p = pending.get()
        const r = await respond({ email, session: p?.session ?? '', kind: 'new_password', answer: pw })
        if (r.signedIn) return void navigate({ to: safeNext(p?.next) })
      } else {
        await reset({ email, code, password: pw })
      }
      void navigate({ to: '/sign-in' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work. Check the code and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (step === 'email')
    return (
      <AuthCard title="Reset your password" description="We will email you a code to set a new one.">
        <form onSubmit={send} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <FieldError>{error}</FieldError>
          <Button type="submit" className="w-full" disabled={!email.trim() || busy}>
            {busy && <Loader2 className="animate-spin" />}
            Send a code
          </Button>
          <Button type="button" variant="link" className="w-full" onClick={() => void navigate({ to: '/sign-in' })}>
            Back to sign in
          </Button>
        </form>
      </AuthCard>
    )

  return (
    <AuthCard
      wordmark={false}
      title={newPassword ? 'Choose a new password' : 'Set a new password'}
      description={newPassword ? 'Your account asks for a new password before you continue.' : `If ${email} has an account, a code is on its way.`}
    >
      <form onSubmit={save} className="space-y-4">
        {!newPassword && (
          <div className="space-y-1.5">
            <Label>Code from the email</Label>
            <InputOTP maxLength={6} value={code} onChange={setCode} inputMode="numeric" aria-label="Six-digit code">
              <InputOTPGroup className="gap-2">
                {Array.from({ length: 6 }, (_, i) => (
                  <InputOTPSlot key={i} index={i} className="size-11 rounded-md border first:rounded-md last:rounded-md" />
                ))}
              </InputOTPGroup>
            </InputOTP>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="pw">New password</Label>
          <Input id="pw" type="password" autoComplete="new-password" required value={pw} onChange={(e) => setPw(e.target.value)} aria-describedby="pw-rule" />
          <p id="pw-rule" className="text-xs text-muted-foreground">At least 12 characters, with upper and lower case letters and a number.</p>
        </div>
        <FieldError>{error}</FieldError>
        <Button type="submit" className="w-full" disabled={busy || (!newPassword && code.length < 6) || !pw}>
          {busy && <Loader2 className="animate-spin" />}
          Save and sign in
        </Button>
      </form>
    </AuthCard>
  )
}
