/**
 * Who may do what to which project. People sign in with Amazon Cognito; each person holds a role per project:
 *
 *   read    see the project: its status, settings, runs, measurements and artifacts, and use the read-only tools
 *   write   everything read allows, plus: change settings, start work (a task, a fix), and use tools that record runs
 *
 * A person with no grant on a project cannot see that it exists. Members of the Cognito group `trace-admins` hold
 * write on every project and are the only ones who can grant and revoke. Grants live in the central database
 * (tables `users` and `grants`), keyed by the person's Cognito `sub` — the identity that never changes — with their
 * email kept for display. Every grant and revoke is kept in `grant_log`.
 *
 * This module only decides. The user-facing API (src/api) enforces it on every request; nothing else is reachable
 * with a person's token.
 */
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { ensureSchema, read, update } from './central.js'

export const ROLES = ['read', 'write'] as const
export type Role = (typeof ROLES)[number]
export const ADMIN_GROUP = 'trace-admins'

const RANK: Record<Role, number> = { read: 1, write: 2 }

export const RepoSlug = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected OWNER/REPO').transform((s) => s.toLowerCase())

/** The signed-in person, from a verified Cognito token. */
export interface Principal {
  sub: string
  email: string | null
  groups: readonly string[]
}

export const isAdmin = (p: Principal): boolean => p.groups.includes(ADMIN_GROUP)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  sub TEXT PRIMARY KEY,           -- Cognito sub
  email TEXT,
  first_seen REAL NOT NULL,
  last_seen REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
  sub TEXT NOT NULL,
  repo TEXT NOT NULL,             -- owner/repo, lower case
  role TEXT NOT NULL CHECK (role IN ('read', 'write')),
  granted_by TEXT NOT NULL,
  granted_at REAL NOT NULL,
  PRIMARY KEY (sub, repo)
);
CREATE INDEX IF NOT EXISTS grants_repo ON grants(repo);
CREATE TABLE IF NOT EXISTS grant_log (
  at REAL NOT NULL, by TEXT NOT NULL, sub TEXT NOT NULL, repo TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('grant', 'revoke')), role TEXT
);
`
ensureSchema(SCHEMA)

export class AccessDenied extends Error {
  override name = 'AccessDenied'
}

export interface Grant { sub: string; email: string | null; repo: string; role: Role; granted_by: string; granted_at: number }

const now = (): number => Date.now() / 1000

function rowToGrant(r: Record<string, unknown>): Grant {
  return {
    sub: String(r.sub), email: r.email === null || r.email === undefined ? null : String(r.email), repo: String(r.repo),
    role: r.role === 'write' ? 'write' : 'read', granted_by: String(r.granted_by), granted_at: Number(r.granted_at),
  }
}

/** The role `p` holds on `repo`, or null. Admins hold write everywhere. */
export function roleIn(db: DatabaseSync, p: Principal, repo: string): Role | null {
  if (isAdmin(p)) return 'write'
  const r = db.prepare('SELECT role FROM grants WHERE sub=? AND repo=?').get(p.sub, RepoSlug.parse(repo))
  return r ? (r.role === 'write' ? 'write' : 'read') : null
}

/** Throws AccessDenied unless `p` holds at least `need` on `repo`. Says nothing about whether the repo exists. */
export async function require_(p: Principal, repo: string, need: Role): Promise<Role> {
  const db = await read()
  try {
    const role = roleIn(db, p, repo)
    if (!role || RANK[role] < RANK[need]) throw new AccessDenied(`no ${need} access to ${repo}`)
    return role
  } finally {
    db.close()
  }
}

/** The projects `p` may see, with their role. Admins see every registered project. */
export async function projectsFor(p: Principal): Promise<{ repo: string; role: Role }[]> {
  const db = await read()
  try {
    if (isAdmin(p)) {
      const hasProjects = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get()
      const repos = hasProjects ? db.prepare('SELECT repo FROM projects').all().map((r) => String(r.repo).toLowerCase()) : []
      const granted = db.prepare('SELECT DISTINCT repo FROM grants').all().map((r) => String(r.repo))
      return [...new Set([...repos, ...granted])].sort().map((repo) => ({ repo, role: 'write' as const }))
    }
    return db.prepare('SELECT repo, role FROM grants WHERE sub=? ORDER BY repo').all(p.sub)
      .map((r) => ({ repo: String(r.repo), role: r.role === 'write' ? 'write' as const : 'read' as const }))
  } finally {
    db.close()
  }
}

/** Record that a person signed in (keeps their email current for display). */
export async function seen(p: Principal): Promise<void> {
  await update((db) => {
    db.prepare(`INSERT INTO users (sub, email, first_seen, last_seen) VALUES (?,?,?,?)
      ON CONFLICT(sub) DO UPDATE SET email=excluded.email, last_seen=excluded.last_seen`).run(p.sub, p.email, now(), now())
  })
}

/** Grant `role` on `repo` to the person `sub` (email kept for display). Admins only. */
export async function grant(by: Principal, target: { sub: string; email?: string | null }, repo: string, role: Role): Promise<Grant> {
  if (!isAdmin(by)) throw new AccessDenied('only an admin can grant access')
  const slug = RepoSlug.parse(repo)
  return update((db) => {
    db.prepare(`INSERT INTO users (sub, email, first_seen, last_seen) VALUES (?,?,?,?)
      ON CONFLICT(sub) DO UPDATE SET email=COALESCE(excluded.email, users.email)`).run(target.sub, target.email ?? null, now(), 0)
    db.prepare(`INSERT INTO grants (sub, repo, role, granted_by, granted_at) VALUES (?,?,?,?,?)
      ON CONFLICT(sub, repo) DO UPDATE SET role=excluded.role, granted_by=excluded.granted_by, granted_at=excluded.granted_at`)
      .run(target.sub, slug, role, by.email ?? by.sub, now())
    db.prepare('INSERT INTO grant_log VALUES (?,?,?,?,?,?)').run(now(), by.email ?? by.sub, target.sub, slug, 'grant', role)
    const r = db.prepare('SELECT g.*, u.email FROM grants g LEFT JOIN users u ON u.sub = g.sub WHERE g.sub=? AND g.repo=?').get(target.sub, slug)
    return rowToGrant(r as Record<string, unknown>)
  })
}

/** Remove the person's access to `repo`. Admins only. Returns whether there was a grant. */
export async function revoke(by: Principal, sub: string, repo: string): Promise<boolean> {
  if (!isAdmin(by)) throw new AccessDenied('only an admin can revoke access')
  const slug = RepoSlug.parse(repo)
  return update((db) => {
    const n = Number(db.prepare('DELETE FROM grants WHERE sub=? AND repo=?').run(sub, slug).changes)
    if (n) db.prepare('INSERT INTO grant_log VALUES (?,?,?,?,?,?)').run(now(), by.email ?? by.sub, sub, slug, 'revoke', null)
    return n > 0
  })
}

/** Every grant, optionally for one project or one person. Admins only. */
export async function grants(by: Principal, filter: { repo?: string; sub?: string } = {}): Promise<Grant[]> {
  if (!isAdmin(by)) throw new AccessDenied('only an admin can list grants')
  const db = await read()
  try {
    const where: string[] = []
    const args: string[] = []
    if (filter.repo) { where.push('g.repo=?'); args.push(RepoSlug.parse(filter.repo)) }
    if (filter.sub) { where.push('g.sub=?'); args.push(filter.sub) }
    return db.prepare(`SELECT g.*, u.email FROM grants g LEFT JOIN users u ON u.sub = g.sub${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY g.repo, u.email`)
      .all(...args).map((r) => rowToGrant(r as Record<string, unknown>))
  } finally {
    db.close()
  }
}
