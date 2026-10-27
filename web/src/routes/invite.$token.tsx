/**
 * Accept an invitation: the card shows the person's email and who invited them, then they choose how to sign in —
 * a passkey (recommended, "nothing to remember and it cannot be phished") or a password with an authenticator app
 * (a QR code from the otpauth URI, then a code to confirm). Then they are signed in.
 *
 * Assumed endpoints (docs/web-build.md does not fix them yet): GET /api/auth/invite/:token → InviteInfo;
 * POST /api/auth/invite/:token/accept { password? } → the signed-in answer (it sets the refresh cookie). After that
 * the passkey and TOTP set-up calls are the contract's own (/api/auth/passkeys/*, /api/auth/totp/*).
 */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { AuthCard, FieldError } from '@/components/auth-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { accept } from '@/lib/auth'
import { request } from '@/lib/http'
import type { InviteInfo, PublicKeyCredentialCreationOptionsJSONish, SignedIn } from '@/lib/types'
import { createCredential, passkeysSupported } from '@/lib/webauthn'
import { cn } from '@/lib/utils'
import { passwordProblem } from './sign-in/reset'

export const Route = createFileRoute('/invite/$token')({ component: Invite })

function Qr({ uri }: { uri: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    void import('qrcode').then((q) => q.toDataURL(uri, { margin: 1, width: 192 })).then(setSrc)
  }, [uri])
  return src ? <img src={src} alt="QR code for your authenticator app" className="mx-auto size-48 rounded-md border bg-white p-1" /> : <div className="mx-auto size-48 animate-pulse rounded-md bg-muted" />
}

function Invite() {
  const { token } = Route.useParams()
  const navigate = useNavigate()
  const info = useQuery({ queryKey: ['invite', token], queryFn: () => request<InviteInfo>(`/api/auth/invite/${encodeURIComponent(token)}`), retry: false })
  const [way, setWay] = useState<'passkey' | 'password'>(passkeysSupported() ? 'passkey' : 'password')
  const [step, setStep] = useState<'choose' | 'totp'>('choose')
  const [pw, setPw] = useState('')
  const [totp, setTotp] = useState<{ secret: string; uri: string } | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const acceptInvite = async (password?: string) => {
    const r = await request<Omit<SignedIn, 'signedIn'>>(`/api/auth/invite/${encodeURIComponent(token)}/accept`, { method: 'POST', body: password ? { password } : {} })
    accept(r)
  }

  const withPasskey = async () => {
    setBusy(true)
    setError(null)
    try {
      await acceptInvite()
      const { options } = await api<{ options: PublicKeyCredentialCreationOptionsJSONish }>('/api/auth/passkeys/start', { method: 'POST', body: {} })
      const credential = await createCredential(options)
      await api('/api/auth/passkeys/finish', { method: 'POST', body: { credential } })
      void navigate({ to: '/' })
    } catch (e) {
      setError(e instanceof DOMException && e.name === 'NotAllowedError' ? 'The passkey was not made. Try again, or use a password instead.' : e instanceof Error ? e.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  const withPassword = async (e: FormEvent) => {
    e.preventDefault()
    const problem = passwordProblem(pw)
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      await acceptInvite(pw)
      setTotp(await api<{ secret: string; uri: string }>('/api/auth/totp/start', { method: 'POST', body: {} }))
      setStep('totp')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  const verify = async (value: string) => {
    setBusy(true)
    setError(null)
    try {
      await api('/api/auth/totp/verify', { method: 'POST', body: { code: value } })
      void navigate({ to: '/' })
    } catch {
      setError('That code is not right. Check the time on your phone and try again.')
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  if (info.isLoading) return <AuthCard title="Opening your invitation…"><div className="h-24 animate-pulse rounded bg-muted" /></AuthCard>
  if (info.isError || !info.data)
    return (
      <AuthCard title="This invitation can't be used" description="It may have expired or been used already. Ask the admin who invited you to send a new one.">
        <Button variant="outline" className="w-full" onClick={() => void navigate({ to: '/sign-in' })}>
          Go to sign in
        </Button>
      </AuthCard>
    )

  const inv = info.data
  if (step === 'totp' && totp)
    return (
      <AuthCard wordmark={false} title="Add trace to your authenticator app" description="Scan this with your authenticator app, then enter the 6-digit code it shows.">
        <div className="space-y-4">
          <Qr uri={totp.uri} />
          <p className="text-center text-xs text-muted-foreground">
            Can't scan? Enter this key: <code className="font-mono">{totp.secret}</code>
          </p>
          <InputOTP maxLength={6} value={code} onChange={setCode} onComplete={(v) => void verify(v)} inputMode="numeric" aria-label="Six-digit code" containerClassName="justify-center">
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
    <AuthCard
      title="You're invited to trace"
      description={
        <>
          {inv.invitedBy} invited <span className="font-medium text-foreground">{inv.email}</span>
          {inv.projects?.length ? <> to {inv.projects.map((p) => `${p.name} (${p.part === 'contributor' ? 'Contributor' : 'Reviewer'})`).join(', ')}</> : null}.
        </>
      }
    >
      <fieldset className="space-y-3">
        <legend className="mb-3 text-sm font-medium">How do you want to sign in?</legend>
        {passkeysSupported() && (
          <button type="button" onClick={() => setWay('passkey')} aria-pressed={way === 'passkey'} className={cn('flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left', way === 'passkey' && 'border-primary bg-primary-soft')}>
            <KeyRound className={cn('mt-0.5 size-5', way === 'passkey' ? 'text-primary' : 'text-muted-foreground')} />
            <span>
              <span className="block text-sm font-medium">A passkey (recommended)</span>
              <span className="block text-xs text-muted-foreground">Nothing to remember and it cannot be phished. Uses this device's screen lock.</span>
            </span>
          </button>
        )}
        <button type="button" onClick={() => setWay('password')} aria-pressed={way === 'password'} className={cn('flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left', way === 'password' && 'border-primary bg-primary-soft')}>
          <ShieldCheck className={cn('mt-0.5 size-5', way === 'password' ? 'text-primary' : 'text-muted-foreground')} />
          <span>
            <span className="block text-sm font-medium">A password and an authenticator app</span>
            <span className="block text-xs text-muted-foreground">A password, then a code from an app on your phone each time.</span>
          </span>
        </button>
      </fieldset>
      <div className="mt-5">
        {way === 'passkey' ? (
          <>
            <FieldError>{error}</FieldError>
            <Button className="mt-2 w-full" onClick={() => void withPasskey()} disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              Set up a passkey
            </Button>
          </>
        ) : (
          <form onSubmit={withPassword} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-pw">Choose a password</Label>
              <Input id="new-pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-describedby="pw-rule" />
              <p id="pw-rule" className="text-xs text-muted-foreground">At least 12 characters, with upper and lower case letters and a number.</p>
            </div>
            <FieldError>{error}</FieldError>
            <Button type="submit" className="w-full" disabled={busy || !pw}>
              {busy && <Loader2 className="animate-spin" />}
              Continue
            </Button>
          </form>
        )}
      </div>
    </AuthCard>
  )
}
