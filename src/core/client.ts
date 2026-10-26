/**
 * This machine's connection to a trace installation, in ~/.trace/client.db (SQLite):
 *
 *   installation   region, Cognito pool/client/domain, the API runtime's ARN, TRACE_HOME — written by
 *                  `trace install`, or by `trace connect` from values an admin shares. Nothing secret.
 *   session        the signed-in person's Cognito tokens, written by `trace login`. The file is created 0600 and
 *                  `trace logout` deletes the row. Access tokens last an hour; the refresh token renews them.
 */
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { open, transaction } from './store.js'

export const InstallationSchema = z.object({
  name: z.string().default('default'),
  region: z.string(),
  account: z.string(),
  stack: z.string(),
  traceHome: z.string(),
  userPoolId: z.string(),
  clientId: z.string(),
  cognitoDomain: z.string().url(),
  apiRuntimeArn: z.string(),
  /** '' when unknown (`trace connect`: people other than the installer don't need these). Each project now has its
   * own worker runtime and GitHub OIDC role (its repository's variables), so the installer leaves the first two ''. */
  workerRuntimeArn: z.string().default(''),
  actionsRoleArn: z.string().default(''),
  githubSecretArn: z.string().default(''),
  /** Each project's AgentCore memory id (owner/repo → id, from its Project<hash>MemoryId output); empty without memory. */
  memoryIds: z.record(z.string(), z.string()).default({}),
  callbackPorts: z.array(z.number().int()).default([47821, 47822]),
}).strict()
export type Installation = z.output<typeof InstallationSchema>

export const SessionSchema = z.object({
  installation: z.string(),
  sub: z.string(),
  email: z.string().nullable(),
  groups: z.array(z.string()),
  accessToken: z.string(),
  idToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
}).strict()
export type Session = z.output<typeof SessionSchema>

export function clientPath(): string {
  return process.env.TRACE_CLIENT_DB || join(homedir(), '.trace', 'client.db')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS installations (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated REAL NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (installation TEXT PRIMARY KEY, value TEXT NOT NULL, updated REAL NOT NULL);
CREATE TABLE IF NOT EXISTS answers (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated REAL NOT NULL);
`

function db(): import('node:sqlite').DatabaseSync {
  const path = clientPath()
  // Sessions (refresh tokens) live here: the directory is private, and the rollback journal (not WAL) means no
  // long-lived -wal/-shm side files that could be created with a looser mode.
  const dir = dirname(path)
  const own = !existsSync(dir) || dir === join(homedir(), '.trace') // never tighten a directory someone else chose (e.g. /tmp)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (own) try { chmodSync(dir, 0o700) } catch { /* best effort on platforms without modes */ }
  const fresh = !existsSync(path)
  const d = open(path, { wal: false })
  d.exec(SCHEMA)
  if (fresh) try { chmodSync(path, 0o600) } catch { /* best effort on platforms without modes */ }
  return d
}

function put(table: 'installations' | 'sessions', key: string, value: unknown): void {
  const d = db()
  try {
    transaction(d, () => {
      d.prepare(`INSERT OR REPLACE INTO ${table} VALUES (?,?,?)`).run(key, JSON.stringify(value), Date.now() / 1000)
    })
  } finally {
    d.close()
  }
}

function get(table: 'installations' | 'sessions', key: string): unknown {
  const d = db()
  try {
    const r = d.prepare(`SELECT value FROM ${table} WHERE ${table === 'installations' ? 'name' : 'installation'}=?`).get(key)
    return r ? JSON.parse(String(r.value)) : null
  } finally {
    d.close()
  }
}

export function saveInstallation(i: z.input<typeof InstallationSchema>): void { const v = InstallationSchema.parse(i); put('installations', v.name, v) }

export function installation(name = process.env.TRACE_INSTALLATION || 'default'): Installation | null {
  const v = get('installations', name)
  return v ? InstallationSchema.parse(v) : null
}

export function saveSession(s: Session): void { put('sessions', s.installation, SessionSchema.parse(s)) }

export function session(name = process.env.TRACE_INSTALLATION || 'default'): Session | null {
  const v = get('sessions', name)
  return v ? SessionSchema.parse(v) : null
}

export function clearSession(name = process.env.TRACE_INSTALLATION || 'default'): boolean {
  const d = db()
  try {
    return Number(d.prepare('DELETE FROM sessions WHERE installation=?').run(name).changes) > 0
  } finally {
    d.close()
  }
}

/** Forget an installation on this machine (`trace uninstall`): its record and its session. */
export function forgetInstallation(name = process.env.TRACE_INSTALLATION || 'default'): void {
  const d = db()
  try {
    transaction(d, () => {
      d.prepare('DELETE FROM installations WHERE name=?').run(name)
      d.prepare('DELETE FROM sessions WHERE installation=?').run(name)
    })
  } finally {
    d.close()
  }
}

/** The installer's remembered, non-secret answers (so a second run starts where the first left off). */
export function saveAnswers(answers: Record<string, unknown>): void {
  const d = db()
  try {
    transaction(d, () => {
      for (const [k, v] of Object.entries(answers)) d.prepare('INSERT OR REPLACE INTO answers VALUES (?,?,?)').run(k, JSON.stringify(v), Date.now() / 1000)
    })
  } finally {
    d.close()
  }
}

export function answers(): Record<string, unknown> {
  const d = db()
  try {
    return Object.fromEntries(d.prepare('SELECT key, value FROM answers').all().map((r) => [String(r.key), JSON.parse(String(r.value)) as unknown]))
  } finally {
    d.close()
  }
}
