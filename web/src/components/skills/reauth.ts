/**
 * Asking again before money is committed (docs/ui-design.md, "Signing"): the release and order gates re-check the
 * person with their passkey, or with a code by email where passkeys are not available. Both go through trace's own
 * sign-in endpoints (/api/auth/start, /api/auth/respond) as the sign-in page does, so the fresh tokens carry a new
 * authentication time the API can require on gate.sign.
 */
import { respond, startSignIn } from '@/lib/auth'
import { getAssertion, passkeysSupported } from '@/lib/webauthn'

export type Reauth =
  | { done: true }
  | { done: false; next: 'email_code'; complete: (code: string) => Promise<boolean> }

/** Start the re-check. A passkey finishes here; otherwise an email code is sent and `complete(code)` finishes it. */
export async function reauthenticate(email: string): Promise<Reauth> {
  const start = await startSignIn(email)
  if (passkeysSupported() && start.choices.includes('passkey')) {
    let r = await respond({ email, session: start.session, kind: 'passkey', answer: null })
    if (!r.signedIn && r.next === 'passkey' && r.options) {
      const assertion = await getAssertion(r.options)
      r = await respond({ email, session: r.session, kind: 'passkey', answer: assertion })
    }
    if (r.signedIn) return { done: true }
    throw new Error('That passkey did not confirm it was you.')
  }
  if (!start.choices.includes('email_code')) throw new Error('No passkey or email code is set up for this account. Add a passkey in Preferences.')
  const r = await respond({ email, session: start.session, kind: 'email_code', answer: 'request' })
  if (r.signedIn) return { done: true }
  const session = r.session
  return {
    done: false,
    next: 'email_code',
    complete: async (code: string) => (await respond({ email, session, kind: 'email_code', answer: code })).signedIn,
  }
}
