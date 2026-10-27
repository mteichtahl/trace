/**
 * The one live connection: AppSync Events over a WebSocket, subscribed to this person's channel /trace/users/<sub>.
 * Events never carry project content; each one names what changed, and the app invalidates those queries so they
 * refetch. The connection drives the status dot in the top bar: Live, Reconnecting (with the time of the last
 * update) or Offline.
 *
 * Protocol (AppSync Events real-time): connect to wss://<realtime>/event/realtime with the subprotocols
 * `aws-appsync-event-ws` and `header-<base64url {host, Authorization}>`; send connection_init, wait for
 * connection_ack (it says how long a silence means the connection is dead), subscribe with the same authorization,
 * and take `data` messages. `ka` keep-alives reset the silence timer.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { auth } from './auth'
import { createStore, useStore } from './store'
import type { LiveEvent } from './types'

export type LiveState = 'live' | 'connecting' | 'reconnecting' | 'offline'
export interface LiveStatus {
  state: LiveState
  /** epoch ms of the last event or keep-alive */
  lastUpdate: number | null
  /** epoch ms of when the connection was last live (for "Showing what was true at 10:42") */
  liveSince: number | null
}

export const liveStatus = createStore<LiveStatus>({ state: 'connecting', lastUpdate: null, liveSince: null })
export const useLiveStatus = (): LiveStatus => useStore(liveStatus)

// ------------------------------------------------------------------ events → query invalidations

/** The query-key prefixes one event makes stale. Pure, so it is tested on its own. */
export function invalidationsFor(e: LiveEvent): QueryKey[] {
  switch (e.type) {
    case 'record.changed': {
      const r = e.repo
      const byWhat: Record<typeof e.what, QueryKey[]> = {
        journey: [['journey.get', r], ['inbox'], ['runs', r]],
        settings: [['settings.get', r], ['journey.get', r]],
        memory: [['memory.list', r], ['memory.recall', r]],
        chats: [['chats.list', r], ['chats.get', r], ['chats.recall', r]],
        people: [['project.members', r], ['users.list'], ['assignments'], ['projects']],
        prompts: [['prompts.list'], ['prompts.get'], ['prompts.history'], ['prompts.preview', r]],
        kb: [['kb.search', r], ['files.list', r]],
      }
      return byWhat[e.what] ?? [['journey.get', r]]
    }
    case 'job.updated':
      return [['job'], ['journey.get', e.repo], ['tools.waits', e.repo], ['runs', e.repo]]
    case 'notification':
      return [['inbox'], ['journey.get', e.repo]]
  }
}

export function applyEvent(qc: QueryClient, e: LiveEvent): void {
  for (const queryKey of invalidationsFor(e)) void qc.invalidateQueries({ queryKey })
}

// ------------------------------------------------------------------ the AppSync Events client

const b64url = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** The host AppSync expects in the authorization header: the HTTP endpoint's host. */
export const hostOf = (endpoint: string): string => endpoint.replace(/^\w+:\/\//, '').replace(/\/.*$/, '')

export function realtimeUrl(endpoint: string): string {
  const host = hostOf(endpoint)
  return `wss://${host}/event/realtime`
}

export function subprotocols(httpEndpoint: string, idToken: string): string[] {
  return ['aws-appsync-event-ws', `header-${b64url(JSON.stringify({ host: hostOf(httpEndpoint), Authorization: idToken }))}`]
}

export interface LiveOptions {
  http: string
  realtime: string
  channel: string
  onEvent: (e: LiveEvent) => void
  idToken: () => string | null
  /** for tests */
  WebSocketImpl?: typeof WebSocket
}

/** Connect and stay connected (backoff 1 s → 30 s with jitter). Returns a function that disconnects. */
export function connectLive(o: LiveOptions): () => void {
  const WS = o.WebSocketImpl ?? WebSocket
  let ws: WebSocket | null = null
  let stopped = false
  let attempt = 0
  let silence: ReturnType<typeof setTimeout> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let timeoutMs = 300_000
  const subId = crypto.randomUUID()

  const set = (state: LiveState) => liveStatus.set((s) => ({ ...s, state, ...(state === 'live' ? { liveSince: Date.now(), lastUpdate: Date.now() } : {}) }))
  const touch = () => {
    liveStatus.set((s) => ({ ...s, lastUpdate: Date.now() }))
    if (silence) clearTimeout(silence)
    silence = setTimeout(() => ws?.close(4000, 'silent'), timeoutMs)
  }

  const open = () => {
    if (stopped) return
    const id = o.idToken()
    if (!id) {
      set('offline')
      return
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      set('offline')
      return
    }
    set(attempt === 0 ? 'connecting' : 'reconnecting')
    const sock = new WS(realtimeUrl(o.realtime), subprotocols(o.http, id))
    ws = sock
    sock.onopen = () => sock.send(JSON.stringify({ type: 'connection_init' }))
    sock.onmessage = (m) => {
      let msg: { type: string; id?: string; event?: string | string[]; connectionTimeoutMs?: number; errors?: unknown }
      try {
        msg = JSON.parse(String(m.data))
      } catch {
        return
      }
      switch (msg.type) {
        case 'connection_ack':
          timeoutMs = msg.connectionTimeoutMs ?? timeoutMs
          touch()
          sock.send(JSON.stringify({
            type: 'subscribe', id: subId, channel: o.channel,
            authorization: { host: hostOf(o.http), Authorization: o.idToken() ?? id },
          }))
          break
        case 'subscribe_success':
          attempt = 0
          set('live')
          touch()
          break
        case 'ka':
          touch()
          break
        case 'data': {
          touch()
          const raw = Array.isArray(msg.event) ? msg.event : [msg.event]
          for (const r of raw) {
            try {
              const e = typeof r === 'string' ? JSON.parse(r) : r
              if (e && typeof e.type === 'string') o.onEvent(e as LiveEvent)
            } catch {
              // a malformed event is dropped; the next refetch catches up
            }
          }
          break
        }
        case 'subscribe_error':
        case 'connection_error':
        case 'error':
          sock.close(4001, 'error')
          break
      }
    }
    sock.onclose = () => {
      if (silence) clearTimeout(silence)
      if (stopped) return
      attempt++
      set(attempt > 6 ? 'offline' : 'reconnecting')
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5)) * (0.75 + Math.random() * 0.5)
      retry = setTimeout(open, delay)
    }
  }

  const online = () => {
    if (retry) clearTimeout(retry)
    attempt = Math.max(attempt, 1)
    open()
  }
  const offline = () => {
    set('offline')
    ws?.close()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
  }
  open()

  return () => {
    stopped = true
    if (silence) clearTimeout(silence)
    if (retry) clearTimeout(retry)
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
    }
    if (ws && ws.readyState <= 1) {
      try {
        ws.send(JSON.stringify({ type: 'unsubscribe', id: subId }))
      } catch {
        // closing anyway
      }
      ws.close()
    }
  }
}

/** Start the live connection for the signed-in person; restarts when the person changes. */
export function startLive(qc: QueryClient, cfg: { http: string; realtime: string }): () => void {
  let stop: (() => void) | null = null
  let sub: string | null = null
  const sync = () => {
    const a = auth.get()
    const next = a.status === 'signed-in' ? (a.user?.sub ?? null) : null
    if (next === sub) return
    stop?.()
    stop = null
    sub = next
    if (!sub) return
    stop = connectLive({
      http: cfg.http,
      realtime: cfg.realtime,
      channel: `/trace/users/${sub}`,
      idToken: () => auth.get().idToken,
      onEvent: (e) => applyEvent(qc, e),
    })
  }
  const unsub = auth.subscribe(sync)
  sync()
  return () => {
    unsub()
    stop?.()
  }
}
