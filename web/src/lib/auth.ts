/**
 * Who is signed in. Access and id tokens live in memory only; the refresh token is the HTTP-only cookie `trace_rt`
 * that /api/auth sets, so a reload refreshes from the cookie. Tokens are refreshed a minute before they expire; when a
 * refresh is refused (401) while the person was signed in, the session-ended banner shows and nothing they typed is
 * touched. Any other failure (offline, 5xx, 429) keeps the session and tries again in 15 seconds.
 */
import { HttpError, request } from './http'
import { createStore, useStore } from './store'
import type { RespondKind, RespondResult, SignInChoice, SignedIn, User } from './types'

export interface AuthState {
  status: 'unknown' | 'signed-in' | 'signed-out'
  user: User | null
  accessToken: string | null
  idToken: string | null
  /** epoch ms */
  expiresAt: number | null
  /** a refresh failed after being signed in: show "Your session has ended" */
  sessionEnded: boolean
}

export const auth = createStore<AuthState>({ status: 'unknown', user: null, accessToken: null, idToken: null, expiresAt: null, sessionEnded: false })
export const useAuth = (): AuthState => useStore(auth)

const REFRESH_EARLY_MS = 60_000
let timer: ReturnType<typeof setTimeout> | undefined
let inflight: Promise<boolean> | null = null

function schedule(expiresAt: number) {
  if (timer) clearTimeout(timer)
  const wait = Math.max(5_000, expiresAt - Date.now() - REFRESH_EARLY_MS)
  timer = setTimeout(() => void refresh(), wait)
}

/** Take a signed-in answer from /api/auth/respond or /api/auth/refresh. */
export function accept(s: Pick<SignedIn, 'accessToken' | 'idToken' | 'expiresIn' | 'user'>) {
  const expiresAt = Date.now() + s.expiresIn * 1000
  auth.set({ status: 'signed-in', user: s.user, accessToken: s.accessToken, idToken: s.idToken, expiresAt, sessionEnded: false })
  schedule(expiresAt)
}

/** Refresh from the cookie. One at a time; resolves true when signed in afterwards. */
export function refresh(): Promise<boolean> {
  if (inflight) return inflight
  inflight = (async () => {
    const was = auth.get().status === 'signed-in'
    try {
      const r = await request<Omit<SignedIn, 'signedIn'>>('/api/auth/refresh', { method: 'POST', body: {} })
      accept(r)
      return true
    } catch (e) {
      // Only a 401 means the session has ended (the refresh token refused). Offline, or the backend not answering
      // (5xx, 429): keep what we have and try again shortly, so a busy or restarting service never signs anyone out
      if (!(e instanceof HttpError && e.status === 401) && was) {
        timer = setTimeout(() => void refresh(), 15_000)
        return false
      }
      auth.set((s) => ({ ...s, status: 'signed-out', accessToken: null, idToken: null, expiresAt: null, sessionEnded: was }))
      return false
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** On load: one refresh decides signed in or out. */
export async function bootstrap(): Promise<void> {
  if (auth.get().status !== 'unknown') return
  await refresh()
}

export const token = (): string | null => auth.get().accessToken

export async function signOut(): Promise<void> {
  if (timer) clearTimeout(timer)
  try {
    await request('/api/auth/sign-out', { method: 'POST', body: {}, token: token() })
  } catch {
    // the cookie is cleared server side when it can be; locally we forget everything either way
  }
  auth.set({ status: 'signed-out', user: null, accessToken: null, idToken: null, expiresAt: null, sessionEnded: false })
}

export const dismissSessionEnded = () => auth.set((s) => ({ ...s, sessionEnded: false }))

// ------------------------------------------------------------------ the sign-in calls

export const startSignIn = (email: string) =>
  request<{ session: string; choices: SignInChoice[] }>('/api/auth/start', { method: 'POST', body: { email } })

export async function respond(a: { email: string; session: string; kind: RespondKind; answer: unknown }): Promise<RespondResult> {
  const r = await request<RespondResult>('/api/auth/respond', { method: 'POST', body: a })
  if (r.signedIn) accept(r)
  return r
}

export const forgot = (email: string) => request<{ sent: true }>('/api/auth/forgot', { method: 'POST', body: { email } })
export const reset = (a: { email: string; code: string; password: string }) => request<{ ok: true }>('/api/auth/reset', { method: 'POST', body: a })

// ------------------------------------------------------------------ the pending sign-in, between pages

/** The email, session and choices carried from /sign-in to /sign-in/code (memory only, like the tokens). */
export interface Pending {
  email: string
  session: string
  choices: SignInChoice[]
  next?: string
  /** which kind of code /sign-in/code is asking for */
  codeKind?: 'email_code' | 'totp'
}
export const pending = createStore<Pending | null>(null)
