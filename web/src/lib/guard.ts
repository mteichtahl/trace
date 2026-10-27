/**
 * The route guard: unauthenticated → /sign-in?next=<here>; signed in without an account class → /no-access.
 * Used in the `beforeLoad` of the `_app` (shell) and `_focus` (Focus mode) layouts.
 */
import { redirect } from '@tanstack/react-router'
import { auth, bootstrap } from './auth'

export async function requireSignedIn(location: { href: string }): Promise<void> {
  await bootstrap()
  const a = auth.get()
  if (a.status !== 'signed-in') throw redirect({ to: '/sign-in', search: { next: location.href } })
  if (!a.user?.class) throw redirect({ to: '/no-access' })
}
