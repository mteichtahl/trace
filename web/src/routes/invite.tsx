/**
 * Accept an invitation. The invitation email (Cognito's, sent by users.invite) carries the person's user name and a
 * temporary password, and points here: nothing secret is ever in a link. The person:
 *
 *   1. enters their email and the temporary password (POST /api/auth/start, then respond with kind password)
 *   2. chooses their own password (Cognito's NEW_PASSWORD_REQUIRED: respond with kind new_password), which signs them in
 *   3. adds a passkey (recommended: "nothing to remember and it cannot be phished"), or an authenticator app (a QR code
 *      from the otpauth URI, then a code to confirm), with the signed-in /api/auth/passkeys/* and /api/auth/totp/* calls;
 *      or skips that for now
 *
 * The temporary password and the codes are held in this page's state only, never in the address or storage.
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { AuthCard, FieldError } from '@/components/auth-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { respond, startSignIn } from '@/lib/auth'
import { HttpError } from '@/lib/http'
import type { PublicKeyCredentialCreationOptionsJSONish } from '@/lib/types'
import { createCredential, passkeysSupported } from '@/lib/webauthn'
import { cn } from '@/lib/utils'
import { passwordProblem } from './sign-in/reset'

export const Route = createFileRoute('/invite')({ component: Invite })

function Qr({ uri }: { uri: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    void import('qrcode').then((q) => q.toDataURL(uri, { margin: 1, width: 192 })).then(setSrc)
  }, [uri])
  return src ? <img src={src} alt="QR code for your authenticator app" className="mx-auto size-48 rounded-md border bg-white p-1" /> : <div className="mx-auto size-48 animate-pulse rounded-md bg-muted" />
}

type Step = 'temporary' | 'password' | 'second' | 'totp'

const errText = (e: unknown): string => (e instanceof HttpError || e instanceof Error ? e.message : 'That did not work. Try again.')

/** The invitation, step by step: the temporary password, a password of their own, then a passkey or an app. */
export function Invite() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('temporary')
  const [email, setEmail] = useState('')
  const [temporary, setTemporary] = useState('')
  const [session, setSession] = useState('')
  const [pw, setPw] = useState('')
  const [way, setWay] = useState<'passkey' | 'totp'>(passkeysSupported() ? 'passkey' : 'totp')
  const [totp, setTotp] = useState<{ secret: string; uri: string } | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const withTemporary = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const s = await startSignIn(email.trim())
      try {
        const r = await respond({ email: email.trim(), session: s.session, kind: 'password', answer: temporary })
        setTemporary('')
        if (r.signedIn) return setStep('second') // already set up: straight to the second factor offer
        if (r.next === 'new_password') {
          setSession(r.session)
          return setStep('password')
        }
        throw new Error('This invitation has already been accepted. Sign in instead.')
      } catch (err) {
        if (err instanceof HttpError && (err.status === 400 || err.status === 401)) throw new Error('That email and temporary password do not match. Check the invitation email; a temporary password works for 7 days.')
        throw err
      }
    })
  }

  const withPassword = (e: FormEvent) => {
    e.preventDefault()
    const problem = passwordProblem(pw)
    if (problem) return setError(problem)
    void run(async () => {
      const r = await respond({ email: email.trim(), session, kind: 'new_password', answer: pw })
      setPw('')
      setSession('')
      if (!r.signedIn) throw new Error('Your password was set; sign in to finish.')
      setStep('second')
    })
  }

  const withPasskey = () =>
    void run(async () => {
      try {
        const { options } = await api<{ options: PublicKeyCredentialCreationOptionsJSONish }>('/api/auth/passkeys/start', { method: 'POST', body: {} })
        const credential = await createCredential(options)
        await api('/api/auth/passkeys/finish', { method: 'POST', body: { credential } })
        void navigate({ to: '/' })
      } catch (e) {
        throw e instanceof DOMException && e.name === 'NotAllowedError' ? new Error('The passkey was not made. Try again, or use an authenticator app instead.') : e
      }
    })

  const withApp = () =>
    void run(async () => {
      setTotp(await api<{ secret: string; uri: string }>('/api/auth/totp/start', { method: 'POST', body: {} }))
      setStep('totp')
    })

  const verify = (value: string) =>
    void run(async () => {
      try {
        const r = await api<{ ok: boolean }>('/api/auth/totp/verify', { method: 'POST', body: { code: value } })
        if (!r.ok) throw new Error('bad')
        void navigate({ to: '/' })
      } catch {
        setCode('')
        throw new Error('That code is not right. Check the time on your phone and try again.')
      }
    })

  if (step === 'temporary')
    return (
      <AuthCard title="Accept your invitation" description="Enter your email and the temporary password from your invitation email." footer="trace is by invitation. The invitation email came from the admin who added you.">
        <form onSubmit={withTemporary} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="temporary">Temporary password</Label>
            <Input id="temporary" type="password" autoComplete="one-time-code" required value={temporary} onChange={(e) => setTemporary(e.target.value)} />
          </div>
          <FieldError>{error}</FieldError>
          <Button type="submit" className="w-full" disabled={busy || !email.trim() || !temporary}>
            {busy && <Loader2 className="animate-spin" />}
            Continue
          </Button>
        </form>
      </AuthCard>
    )

  if (step === 'password')
    return (
      <AuthCard wordmark={false} title="Choose your password" description={email}>
        <form onSubmit={withPassword} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="new-pw">New password</Label>
            <Input id="new-pw" type="password" autoComplete="new-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} aria-describedby="pw-rule" />
            <p id="pw-rule" className="text-xs text-muted-foreground">At least 12 characters, with upper and lower case letters and a number.</p>
          </div>
          <FieldError>{error}</FieldError>
          <Button type="submit" className="w-full" disabled={busy || !pw}>
            {busy && <Loader2 className="animate-spin" />}
            Save and sign in
          </Button>
        </form>
      </AuthCard>
    )

  if (step === 'totp' && totp)
    return (
      <AuthCard wordmark={false} title="Add trace to your authenticator app" description="Scan this with your authenticator app, then enter the 6-digit code it shows.">
        <div className="space-y-4">
          <Qr uri={totp.uri} />
          <p className="text-center text-xs text-muted-foreground">
            Can't scan? Enter this key: <code className="font-mono">{totp.secret}</code>
          </p>
          <InputOTP maxLength={6} value={code} onChange={setCode} onComplete={(v) => verify(v)} inputMode="numeric" aria-label="Six-digit code" containerClassName="justify-center">
            <InputOTPGroup className="gap-2">
              {Array.from({ length: 6 }, (_, i) => (
                <InputOTPSlot key={i} index={i} className="size-11 rounded-md border first:rounded-md last:rounded-md" />
              ))}
            </InputOTPGroup>
          </InputOTP>
          <FieldError>{error}</FieldError>
          {busy && <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" />}
        </div>
      </AuthCard>
    )

  return (
    <AuthCard wordmark={false} title="You're in. Make signing in safer" description="Add a second way to prove it is you.">
      <fieldset className="space-y-3">
        <legend className="mb-3 text-sm font-medium">How do you want to sign in from now on?</legend>
        {passkeysSupported() && (
          <button type="button" onClick={() => setWay('passkey')} aria-pressed={way === 'passkey'} className={cn('flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left', way === 'passkey' && 'border-primary bg-primary-soft')}>
            <KeyRound className={cn('mt-0.5 size-5', way === 'passkey' ? 'text-primary' : 'text-muted-foreground')} />
            <span>
              <span className="block text-sm font-medium">A passkey (recommended)</span>
              <span className="block text-xs text-muted-foreground">Nothing to remember and it cannot be phished. Uses this device's screen lock.</span>
            </span>
          </button>
        )}
        <button type="button" onClick={() => setWay('totp')} aria-pressed={way === 'totp'} className={cn('flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left', way === 'totp' && 'border-primary bg-primary-soft')}>
          <ShieldCheck className={cn('mt-0.5 size-5', way === 'totp' ? 'text-primary' : 'text-muted-foreground')} />
          <span>
            <span className="block text-sm font-medium">Your password and an authenticator app</span>
            <span className="block text-xs text-muted-foreground">A code from an app on your phone each time.</span>
          </span>
        </button>
      </fieldset>
      <FieldError>{error}</FieldError>
      <Button className="mt-4 w-full" onClick={way === 'passkey' ? withPasskey : withApp} disabled={busy}>
        {busy && <Loader2 className="animate-spin" />}
        {way === 'passkey' ? 'Set up a passkey' : 'Set up the app'}
      </Button>
      <Button variant="link" className="mt-1 w-full" onClick={() => void navigate({ to: '/' })}>
        Not now
      </Button>
    </AuthCard>
  )
}
