/**
 * Sign in: one field and one button. After Continue the card offers what this person has set up, best first: a
 * passkey, a code by email, or their password (then a code from their authenticator app). No sign-up: trace is
 * invitation only.
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Loader2, Lock, Mail, UserRoundCheck } from 'lucide-react'
import { useState, type ComponentType, type FormEvent } from 'react'
import { z } from 'zod'
import { AuthCard, FieldError } from '@/components/auth-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { pending, respond, startSignIn } from '@/lib/auth'
import { HttpError } from '@/lib/http'
import type { SignInChoice } from '@/lib/types'
import { getAssertion, passkeysSupported } from '@/lib/webauthn'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/sign-in/')({
  validateSearch: z.object({ next: z.string().optional() }),
  component: SignIn,
})

const CHOICES: Record<SignInChoice, { title: string; detail: string; icon: ComponentType<{ className?: string }> }> = {
  passkey: { title: 'Use your passkey', detail: 'Recommended: nothing to type, cannot be phished', icon: UserRoundCheck },
  email_code: { title: 'Email me a code', detail: 'A 6-digit code, valid for 3 minutes', icon: Mail },
  password: { title: 'Use my password', detail: 'Then a code from your authenticator app', icon: Lock },
}

const errText = (e: unknown) => (e instanceof HttpError ? e.message : e instanceof Error ? e.message : 'Something went wrong. Try again.')

/** Where to go after signing in: only an address inside the app. */
export const safeNext = (next?: string): string => (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/sign-in') ? next : '/')

function SignIn() {
  const { next } = Route.useSearch()
  const navigate = useNavigate()
  const [email, setEmail] = useState(pending.get()?.email ?? '')
  const [step, setStep] = useState<'email' | 'choose' | 'password'>('email')
  const [choices, setChoices] = useState<SignInChoice[]>([])
  const [session, setSession] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const done = () => void navigate({ to: safeNext(next) })

  const onEmail = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy('email')
    try {
      const r = await startSignIn(email.trim())
      setSession(r.session)
      const order: SignInChoice[] = ['passkey', 'email_code', 'password']
      setChoices(order.filter((c) => r.choices.includes(c) && (c !== 'passkey' || passkeysSupported())))
      setStep('choose')
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(null)
    }
  }

  const choose = async (c: SignInChoice) => {
    setError(null)
    if (c === 'password') return setStep('password')
    setBusy(c)
    try {
      if (c === 'email_code') {
        const r = await respond({ email, session, kind: 'email_code', answer: 'request' })
        if (!r.signedIn) {
          pending.set({ email, session: r.session, choices, next, codeKind: 'email_code' })
          void navigate({ to: '/sign-in/code', search: next ? { next } : {} })
        } else done()
        return
      }
      // passkey: the backend answers with the WebAuthn options, the browser signs, the backend checks
      let r = await respond({ email, session, kind: 'passkey', answer: null })
      if (!r.signedIn && r.next === 'passkey' && r.options) {
        const assertion = await getAssertion(r.options)
        r = await respond({ email, session: r.session, kind: 'passkey', answer: assertion })
      }
      if (r.signedIn) done()
      else setError('That passkey did not work. Choose another way to sign in.')
    } catch (err) {
      setError(err instanceof DOMException && err.name === 'NotAllowedError' ? 'The passkey was not used. Try again, or choose another way.' : errText(err))
    } finally {
      setBusy(null)
    }
  }

  const onPassword = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy('password')
    try {
      const r = await respond({ email, session, kind: 'password', answer: password })
      if (r.signedIn) return done()
      if (r.next === 'totp' || r.next === 'email_code') {
        pending.set({ email, session: r.session, choices, next, codeKind: r.next })
        void navigate({ to: '/sign-in/code', search: next ? { next } : {} })
      } else if (r.next === 'new_password') {
        pending.set({ email, session: r.session, choices, next })
        void navigate({ to: '/sign-in/reset', search: { email, mode: 'new' } })
      }
    } catch (err) {
      setError(err instanceof HttpError && err.status === 400 ? 'That password is not right. Try again, or reset it.' : errText(err))
    } finally {
      setBusy(null)
    }
  }

  if (step === 'email')
    return (
      <AuthCard title="Sign in to trace" description="Enter your work email to continue." footer="trace is by invitation. Ask an admin on your team to invite you.">
        <form onSubmit={onEmail} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="username webauthn" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <FieldError>{error}</FieldError>
          <Button type="submit" className="w-full" disabled={!email.trim() || busy !== null}>
            {busy && <Loader2 className="animate-spin" />}
            Continue
          </Button>
        </form>
      </AuthCard>
    )

  if (step === 'password')
    return (
      <AuthCard
        wordmark={false}
        title="Enter your password"
        description={
          <>
            {email} ·{' '}
            <button type="button" className="text-primary hover:underline" onClick={() => setStep('choose')}>
              Another way
            </button>
          </>
        }
      >
        <form onSubmit={onPassword} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <FieldError>{error}</FieldError>
          <Button type="submit" className="w-full" disabled={!password || busy !== null}>
            {busy && <Loader2 className="animate-spin" />}
            Continue
          </Button>
          <Button type="button" variant="link" className="w-full" onClick={() => void navigate({ to: '/sign-in/reset', search: { email } })}>
            Forgot your password?
          </Button>
        </form>
      </AuthCard>
    )

  return (
    <AuthCard
      wordmark={false}
      title="Welcome back"
      description={
        <>
          {email} ·{' '}
          <button type="button" className="text-primary hover:underline" onClick={() => setStep('email')}>
            Not you?
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {choices.length === 0 && <p className="text-sm text-muted-foreground">This account has no way to sign in set up yet. Ask an admin to send a new invitation.</p>}
        {choices.map((c, i) => {
          const o = CHOICES[c]
          return (
            <button
              key={c}
              type="button"
              disabled={busy !== null}
              onClick={() => void choose(c)}
              className={cn(
                'flex w-full items-center gap-3.5 rounded-lg border px-4 py-3 text-left transition-colors hover:bg-accent disabled:opacity-60',
                i === 0 && 'border-primary bg-primary-soft hover:bg-primary-soft/70',
              )}
            >
              {busy === c ? <Loader2 className="size-5 animate-spin text-primary" /> : <o.icon className={cn('size-5', i === 0 ? 'text-primary' : 'text-muted-foreground')} />}
              <span>
                <span className="block text-sm font-medium">{o.title}</span>
                <span className="block text-xs text-muted-foreground">{o.detail}</span>
              </span>
            </button>
          )
        })}
        <FieldError>{error}</FieldError>
      </div>
    </AuthCard>
  )
}
