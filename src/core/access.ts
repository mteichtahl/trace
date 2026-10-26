/**
 * Who may do what to which project.
 *
 * People sign in with Amazon Cognito. Each person is in one of three classes, held as a Cognito group so it arrives
 * inside the person's signed token:
 *
 *   admin   (trace-admins)  everything, on every project — including managing people and assignments
 *   user    (trace-users)   read and write, on the projects they are assigned to
 *   guest   (trace-guests)  read only, on the projects they are assigned to
 *
 *   read    see a project: its status, settings, runs, measurements and artifacts; the read-only tools
 *   write   also change settings, start work (a task, a fix), and use the tools that record runs
 *
 * A person in none of the groups can do nothing. A person who isn't assigned to a project cannot tell it exists.
 * Assignments live in the central database (tables `users`, `assignments`, `assignment_log`), keyed by the person's
 * Cognito `sub` (the identity that never changes), with their email kept for display.
 *
 * This module only decides. The user-facing API (src/api) enforces it on every request, and changes the Cognito
 * group membership when an admin changes someone's class.
 */
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { ensureSchema, read, update } from './central.js'

export const CLASSES = ['admin', 'user', 'guest'] as const
export type PersonClass = (typeof CLASSES)[number]
export const GROUPS: Readonly<Record<PersonClass, string>> = { admin: 'trace-admins', user: 'trace-users', guest: 'trace-guests' }
/** Kept for callers that name the admin group directly. */
export const ADMIN_GROUP = GROUPS.admin

export const ROLES = ['read', 'write'] as const
export type Role = (typeof ROLES)[number]
const RANK: Record<Role, number> = { read: 1, write: 2 }
const CLASS_ROLE: Readonly<Record<Exclude<PersonClass, 'admin'>, Role>> = { user: 'write', guest: 'read' }

export const RepoSlug = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected OWNER/REPO').transform((s) => s.toLowerCase())

/** The signed-in person, from a verified Cognito token. */
export interface Principal {
  sub: string
  email: string | null
  groups: readonly string[]
}

/** A person's class from their groups; the highest wins when they are in several. Null: no access at all. */
export function classOf(p: Principal): PersonClass | null {
  for (const c of CLASSES) if (p.groups.includes(GROUPS[c])) return c
  return null
}

export const isAdmin = (p: Principal): boolean => classOf(p) === 'admin'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  sub TEXT PRIMARY KEY,           -- Cognito sub
  email TEXT,
  class TEXT CHECK (class IN ('admin', 'user', 'guest')),   -- as last set by an admin (Cognito's groups decide)
  first_seen REAL NOT NULL,
  last_seen REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS assignments (
  sub TEXT NOT NULL,
  repo TEXT NOT NULL,             -- owner/repo, lower case
  assigned_by TEXT NOT NULL,
  assigned_at REAL NOT NULL,
  PRIMARY KEY (sub, repo)
);
CREATE INDEX IF NOT EXISTS assignments_repo ON assignments(repo);
CREATE TABLE IF NOT EXISTS assignment_log (
  at REAL NOT NULL, by TEXT NOT NULL, sub TEXT NOT NULL, repo TEXT,
  action TEXT NOT NULL CHECK (action IN ('assign', 'unassign', 'class')), detail TEXT
);
`
ensureSchema(SCHEMA)

export class AccessDenied extends Error {
  override name = 'AccessDenied'
}

export interface Assignment { sub: string; email: string | null; class: PersonClass | null; repo: string; assigned_by: string; assigned_at: number }

const now = (): number => Date.now() / 1000
const asClass = (v: unknown): PersonClass | null => (v === 'admin' || v === 'user' || v === 'guest' ? v : null)

function rowToAssignment(r: Record<string, unknown>): Assignment {
  return {
    sub: String(r.sub), email: r.email === null || r.email === undefined ? null : String(r.email), class: asClass(r.class),
    repo: String(r.repo), assigned_by: String(r.assigned_by), assigned_at: Number(r.assigned_at),
  }
}

const by = (p: Principal): string => p.email ?? p.sub

function requireAdmin(p: Principal, what: string): void {
  if (!isAdmin(p)) throw new AccessDenied(`only an admin can ${what}`)
}

/** The role `p` holds on `repo`, or null: admin → write everywhere; an assigned user → write; an assigned guest → read. */
export function roleIn(db: DatabaseSync, p: Principal, repo: string): Role | null {
  const cls = classOf(p)
  if (cls === null) return null
  if (cls === 'admin') return 'write'
  const assigned = db.prepare('SELECT 1 FROM assignments WHERE sub=? AND repo=?').get(p.sub, RepoSlug.parse(repo))
  return assigned ? CLASS_ROLE[cls] : null
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

/** The projects `p` may see, with their role. Admins see every registered or assigned project. */
export async function projectsFor(p: Principal): Promise<{ repo: string; role: Role }[]> {
  const cls = classOf(p)
  if (cls === null) return []
  const db = await read()
  try {
    if (cls === 'admin') {
      const hasProjects = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get()
      const repos = hasProjects ? db.prepare('SELECT repo FROM projects').all().map((r) => String(r.repo).toLowerCase()) : []
      const assigned = db.prepare('SELECT DISTINCT repo FROM assignments').all().map((r) => String(r.repo))
      return [...new Set([...repos, ...assigned])].sort().map((repo) => ({ repo, role: 'write' as const }))
    }
    return db.prepare('SELECT repo FROM assignments WHERE sub=? ORDER BY repo').all(p.sub)
      .map((r) => ({ repo: String(r.repo), role: CLASS_ROLE[cls] }))
  } finally {
    db.close()
  }
}

/** Record that a person signed in (keeps their email and class current for display). */
export async function seen(p: Principal): Promise<void> {
  await update((db) => {
    db.prepare(`INSERT INTO users (sub, email, class, first_seen, last_seen) VALUES (?,?,?,?,?)
      ON CONFLICT(sub) DO UPDATE SET email=excluded.email, class=excluded.class, last_seen=excluded.last_seen`)
      .run(p.sub, p.email, classOf(p), now(), now())
  })
}

/** Record a person's class (admins only). The caller also changes their Cognito group, which is what decides. */
export async function setClass(admin: Principal, target: { sub: string; email?: string | null }, cls: PersonClass): Promise<void> {
  requireAdmin(admin, 'change a person\'s class')
  await update((db) => {
    db.prepare(`INSERT INTO users (sub, email, class, first_seen, last_seen) VALUES (?,?,?,?,?)
      ON CONFLICT(sub) DO UPDATE SET class=excluded.class, email=COALESCE(excluded.email, users.email)`)
      .run(target.sub, target.email ?? null, cls, now(), 0)
    db.prepare('INSERT INTO assignment_log VALUES (?,?,?,?,?,?)').run(now(), by(admin), target.sub, null, 'class', cls)
  })
}

/** Assign the person `sub` to `repo` (admins only). What they may do there follows from their class. */
export async function assign(admin: Principal, target: { sub: string; email?: string | null }, repo: string): Promise<Assignment> {
  requireAdmin(admin, 'assign people to projects')
  const slug = RepoSlug.parse(repo)
  return update((db) => {
    db.prepare(`INSERT INTO users (sub, email, class, first_seen, last_seen) VALUES (?,?,NULL,?,?)
      ON CONFLICT(sub) DO UPDATE SET email=COALESCE(excluded.email, users.email)`).run(target.sub, target.email ?? null, now(), 0)
    db.prepare(`INSERT INTO assignments (sub, repo, assigned_by, assigned_at) VALUES (?,?,?,?)
      ON CONFLICT(sub, repo) DO UPDATE SET assigned_by=excluded.assigned_by, assigned_at=excluded.assigned_at`)
      .run(target.sub, slug, by(admin), now())
    db.prepare('INSERT INTO assignment_log VALUES (?,?,?,?,?,?)').run(now(), by(admin), target.sub, slug, 'assign', null)
    const r = db.prepare('SELECT a.*, u.email, u.class FROM assignments a LEFT JOIN users u ON u.sub = a.sub WHERE a.sub=? AND a.repo=?').get(target.sub, slug)
    return rowToAssignment(r as Record<string, unknown>)
  })
}

/** Remove the person from `repo` (admins only). Returns whether they were assigned. */
export async function unassign(admin: Principal, sub: string, repo: string): Promise<boolean> {
  requireAdmin(admin, 'remove people from projects')
  const slug = RepoSlug.parse(repo)
  return update((db) => {
    const n = Number(db.prepare('DELETE FROM assignments WHERE sub=? AND repo=?').run(sub, slug).changes)
    if (n) db.prepare('INSERT INTO assignment_log VALUES (?,?,?,?,?,?)').run(now(), by(admin), sub, slug, 'unassign', null)
    return n > 0
  })
}

/** Every assignment, optionally for one project or one person (admins only). */
export async function assignments(admin: Principal, filter: { repo?: string; sub?: string } = {}): Promise<Assignment[]> {
  requireAdmin(admin, 'list assignments')
  const db = await read()
  try {
    const where: string[] = []
    const args: string[] = []
    if (filter.repo) { where.push('a.repo=?'); args.push(RepoSlug.parse(filter.repo)) }
    if (filter.sub) { where.push('a.sub=?'); args.push(filter.sub) }
    return db.prepare(`SELECT a.*, u.email, u.class FROM assignments a LEFT JOIN users u ON u.sub = a.sub${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY a.repo, u.email`)
      .all(...args).map((r) => rowToAssignment(r as Record<string, unknown>))
  } finally {
    db.close()
  }
}
