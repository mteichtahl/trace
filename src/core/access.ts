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
 * Each assignment carries the person's PART on that project, capped by their class (decided 27 Oct 2026):
 *
 *   contributor   read and write: changes the design, answers questions, runs tools. Only a user can be one
 *   reviewer      read only: reads everything and comments at gates. A guest is always one; a user may be one
 *
 * Admins need no assignment: they are on every project as contributors who may also sign gates. So write needs the
 * contributor part (or admin), and a user assigned as a reviewer reads only. Assignments made before parts existed
 * were migrated to their class's old right (users → contributor, guests → reviewer); the class still caps the part at
 * every check, so a stored contributor part never gives a guest write.
 *
 * A person in none of the groups can do nothing. A person who isn't assigned to a project cannot tell it exists.
 * Assignments live in the ACCESS store (tables `users`, `assignments`, `assignment_log`), keyed by the person's
 * Cognito `sub` (the identity that never changes), with their email kept for display. The access store is its own
 * SQLite database beside the central one ($TRACE_ACCESS_HOME, default: TRACE_HOME's sibling `access`), because the
 * repositories' workflows and the worker agent may write the central database (datasheets, parts) but must never be
 * able to write who has access: in AWS only the API runtime's role and the installing admin can write it.
 *
 * This module only decides. The user-facing API (src/api) enforces it on every request, and changes the Cognito
 * group membership when an admin changes someone's class.
 *
 * Connected systems (docs/external-access.md) are outside systems that call trace with a client-credentials token. Each
 * is a row in `services` (its Cognito app client id is its `sub`) and is assigned to projects in the same
 * `assignments` table, with a part, like a person. Its class is never stored: it is derived from its scopes, write →
 * user (it may be a contributor), read only → guest (always a reviewer). A system is never an admin, whatever its
 * token's groups say. Who did something is shown as `service:<name>` where a person's email would be. Changes to a
 * system (created, scopes changed, disabled, secrets rotated, deleted) go to `service_log`; its assignments to the
 * assignment log as for a person.
 */
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { join } from 'node:path'
import { type Central, central, ensureSchema, read as readCentral } from './central.js'
import { traceHome } from './store.js'

export const CLASSES = ['admin', 'user', 'guest'] as const
export type PersonClass = (typeof CLASSES)[number]
export const GROUPS: Readonly<Record<PersonClass, string>> = { admin: 'trace-admins', user: 'trace-users', guest: 'trace-guests' }
/** Kept for callers that name the admin group directly. */
export const ADMIN_GROUP = GROUPS.admin

export const ROLES = ['read', 'write'] as const
export type Role = (typeof ROLES)[number]
const RANK: Record<Role, number> = { read: 1, write: 2 }

export const PARTS = ['contributor', 'reviewer'] as const
export type Part = (typeof PARTS)[number]
const PART_ROLE: Readonly<Record<Part, Role>> = { contributor: 'write', reviewer: 'read' }
/** The part a person gets when none is named: their class's old right. */
export const defaultPart = (cls: PersonClass | null): Part => (cls === 'guest' ? 'reviewer' : 'contributor')
/** A part capped by the class: a guest is a reviewer whatever is stored. */
const capped = (cls: PersonClass | null, part: Part): Part => (cls === 'guest' ? 'reviewer' : part)
const asPart = (v: unknown): Part | null => (v === 'contributor' || v === 'reviewer' ? v : null)

/** Asked for a part the person's class does not allow (a guest as a contributor). */
export class PartRefused extends Error {
  override name = 'PartRefused'
}

export const RepoSlug = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected OWNER/REPO').transform((s) => s.toLowerCase())

/** The scopes a connected system may hold (the resource server's `read` and `write`). */
export const SERVICE_SCOPES = ['read', 'write'] as const
export type ServiceScope = (typeof SERVICE_SCOPES)[number]

/** The signed-in person (from a verified Cognito token), or a connected system (kind 'service'). */
export interface Principal {
  sub: string
  email: string | null
  groups: readonly string[]
  /** 'service': a connected system (src/api/service-auth.ts); 'backend': the web backend acting for no person
   * (src/api/backend-auth.ts: GitHub's webhook only); absent or 'person': a person */
  kind?: 'person' | 'service' | 'backend' | undefined
  /** a connected system's name (for logs and records: service:<name>) */
  name?: string | undefined
  /** a connected system's scopes for this request: its token's, within what it has now */
  scopes?: readonly ServiceScope[] | undefined
}

export const isService = (p: Principal): boolean => p.kind === 'service'
/** The web backend's own identity (src/api/backend-auth.ts): no class, no project, one action (hook.members). */
export const isBackend = (p: Principal): boolean => p.kind === 'backend'

/** Who did it, for people to read: a person's email (else their sub), `service:<name>` for a connected system, or
 * `backend:<name>` for the web backend's own identity. */
export const who = (p: Principal): string => (isService(p) ? `service:${p.name ?? p.sub}` : isBackend(p) ? `backend:${p.name ?? p.sub}` : p.email ?? p.sub)

/** A person's class from their groups; the highest wins when they are in several. Null: no access at all. A
 * connected system is never an admin, whatever its groups say. */
export function classOf(p: Principal): PersonClass | null {
  if (isBackend(p)) return null
  for (const c of CLASSES) if (p.groups.includes(GROUPS[c]) && !(c === 'admin' && isService(p))) return c
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
  part TEXT CHECK (part IN ('contributor', 'reviewer')),   -- capped by the class at every check
  PRIMARY KEY (sub, repo)
);
CREATE INDEX IF NOT EXISTS assignments_repo ON assignments(repo);
CREATE TABLE IF NOT EXISTS assignment_log (
  at REAL NOT NULL, by TEXT NOT NULL, sub TEXT NOT NULL, repo TEXT,
  action TEXT NOT NULL CHECK (action IN ('assign', 'unassign', 'class')), detail TEXT   -- assign: "part: reviewer → contributor"
);
CREATE TABLE IF NOT EXISTS services (
  client_id TEXT PRIMARY KEY,     -- the Cognito app client id; also its sub
  name TEXT NOT NULL UNIQUE,      -- service:<name> in logs and records
  description TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL CHECK (scopes IN ('read', 'read write')),   -- write → class user, read only → guest
  disabled INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at REAL NOT NULL,
  last_used REAL                  -- no longer written: when a system last called is in services-seen/ (src/core/services-seen.ts)
);
CREATE TABLE IF NOT EXISTS service_log (
  at REAL NOT NULL, by TEXT NOT NULL, client_id TEXT NOT NULL, name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'rotate', 'retire_secret', 'delete')), detail TEXT
);
CREATE TABLE IF NOT EXISTS preferences (
  sub TEXT PRIMARY KEY,           -- Cognito sub
  doc TEXT NOT NULL,              -- one JSON document (src/core/preferences.ts)
  updated REAL NOT NULL
);
`
ensureSchema(SCHEMA)

/**
 * Assignments made before parts existed: add the column, then give each row its class's old right (users and people
 * of no recorded class → contributor, guests → reviewer). Checks first, so it runs on every read and update.
 */
export function migrateParts(db: DatabaseSync): void {
  const cols = db.prepare("SELECT name FROM pragma_table_info('assignments')").all().map((r) => String(r.name))
  if (!cols.includes('part')) db.exec("ALTER TABLE assignments ADD COLUMN part TEXT CHECK (part IN ('contributor', 'reviewer'))")
  if (db.prepare('SELECT 1 FROM assignments WHERE part IS NULL LIMIT 1').get()) {
    db.exec(`UPDATE assignments SET part = CASE (SELECT class FROM users u WHERE u.sub = assignments.sub)
      WHEN 'guest' THEN 'reviewer' ELSE 'contributor' END WHERE part IS NULL`)
  }
}
ensureSchema(migrateParts)

/** Where the access store is: $TRACE_ACCESS_HOME, else beside TRACE_HOME (s3://b/central → s3://b/access). */
export function accessHome(): string {
  if (process.env.TRACE_ACCESS_HOME) return process.env.TRACE_ACCESS_HOME
  const home = traceHome()
  const s3 = /^s3:\/\/([^/]+)(\/.*)?$/.exec(home)
  if (s3) {
    const parts = (s3[2] ?? '').split('/').filter(Boolean)
    parts.pop()
    return `s3://${s3[1]}/${[...parts, 'access'].join('/')}`
  }
  return join(home.replace(/^file:\/\//, ''), 'access')
}

/** The access store itself (preferences live in it too: src/core/preferences.ts). */
export const accessStore = (): Central => central(accessHome())
const store = accessStore
const read = (): Promise<DatabaseSync> => store().read()
const update = <T>(fn: (db: DatabaseSync) => T): Promise<T> => store().update(fn)

export class AccessDenied extends Error {
  override name = 'AccessDenied'
}

export interface Assignment { sub: string; email: string | null; class: PersonClass | null; repo: string; part: Part; assigned_by: string; assigned_at: number }

const now = (): number => Date.now() / 1000
const asClass = (v: unknown): PersonClass | null => (v === 'admin' || v === 'user' || v === 'guest' ? v : null)

function rowToAssignment(r: Record<string, unknown>): Assignment {
  const cls = asClass(r.class)
  return {
    sub: String(r.sub), email: r.email === null || r.email === undefined ? null : String(r.email), class: cls,
    repo: String(r.repo), part: capped(cls, asPart(r.part) ?? defaultPart(cls)), assigned_by: String(r.assigned_by), assigned_at: Number(r.assigned_at),
  }
}

const by = who

/** The email and class of an assignment's holder: a person's from `users`, a connected system's derived from it
 * (`service:<name>`; write → user, read only → guest). Joined as `u` and `s`. */
const HOLDER = `COALESCE(u.email, 'service:' || s.name) AS email,
  COALESCE(u.class, CASE WHEN s.client_id IS NULL THEN NULL WHEN s.scopes = 'read write' THEN 'user' ELSE 'guest' END) AS class`
const HOLDER_JOIN = 'LEFT JOIN users u ON u.sub = a.sub LEFT JOIN services s ON s.client_id = a.sub'

function requireAdmin(p: Principal, what: string): void {
  if (!isAdmin(p)) throw new AccessDenied(`only an admin can ${what}`)
}

/** The part `p` has on `repo`, or null when they are not on it: admins are contributors everywhere; anyone else has
 * their assignment's part, capped by their class (a guest is always a reviewer). */
export function partIn(db: DatabaseSync, p: Principal, repo: string): Part | null {
  const cls = classOf(p)
  if (cls === null) return null
  if (cls === 'admin') return 'contributor'
  const row = db.prepare('SELECT part FROM assignments WHERE sub=? AND repo=?').get(p.sub, RepoSlug.parse(repo))
  if (!row) return null
  return capped(cls, asPart(row.part) ?? defaultPart(cls))
}

/** The role `p` holds on `repo`, or null: admin → write everywhere; a contributor → write; a reviewer → read. */
export function roleIn(db: DatabaseSync, p: Principal, repo: string): Role | null {
  const part = partIn(db, p, repo)
  return part === null ? null : PART_ROLE[part]
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

/** What `p` holds on `repo`: role and part, or null when they are not on it (or it does not exist). */
export async function standing(p: Principal, repo: string): Promise<{ role: Role; part: Part } | null> {
  const db = await read()
  try {
    const part = partIn(db, p, repo)
    return part === null ? null : { role: PART_ROLE[part], part }
  } finally {
    db.close()
  }
}

export interface ProjectOf { repo: string; role: Role; part: Part }

/** The projects `p` may see, with their role and part. Admins see every registered or assigned project. */
export async function projectsFor(p: Principal): Promise<ProjectOf[]> {
  const cls = classOf(p)
  if (cls === null) return []
  const db = await read()
  try {
    if (cls === 'admin') {
      // Every registered project (the registry is in the central database) and every assigned one.
      const c = await readCentral()
      let repos: string[] = []
      try {
        const hasProjects = c.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get()
        repos = hasProjects ? c.prepare('SELECT repo FROM projects').all().map((r) => String(r.repo).toLowerCase()) : []
      } finally {
        c.close()
      }
      const assigned = db.prepare('SELECT DISTINCT repo FROM assignments').all().map((r) => String(r.repo))
      return [...new Set([...repos, ...assigned])].sort().map((repo) => ({ repo, role: 'write' as const, part: 'contributor' as const }))
    }
    return db.prepare('SELECT repo, part FROM assignments WHERE sub=? ORDER BY repo').all(p.sub).map((r) => {
      const part = capped(cls, asPart(r.part) ?? defaultPart(cls))
      return { repo: String(r.repo), role: PART_ROLE[part], part }
    })
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

export interface AssignOptions {
  /** contributor or reviewer; default: the part they already have here, else their class's (guest → reviewer) */
  part?: Part | undefined
  /** the person's class as Cognito has it now (the caller looked); default: the class last recorded for them */
  class?: PersonClass | null | undefined
}

/** The words refusing a guest as a contributor. */
export const GUEST_ONLY_REVIEWER = 'A guest can only be a reviewer. Make them a user first (their account class), then a contributor.'

/**
 * Assign the person `sub` to `repo` with a part (admins only). A guest can only be a reviewer (PartRefused). A change
 * of part is written to the assignment log ("part: reviewer → contributor").
 */
export async function assign(admin: Principal, target: { sub: string; email?: string | null }, repo: string, o: AssignOptions = {}): Promise<Assignment> {
  requireAdmin(admin, 'assign people to projects')
  const slug = RepoSlug.parse(repo)
  if (o.class === 'guest' && o.part === 'contributor') throw new PartRefused(GUEST_ONLY_REVIEWER)
  return update((db) => {
    db.prepare(`INSERT INTO users (sub, email, class, first_seen, last_seen) VALUES (?,?,NULL,?,?)
      ON CONFLICT(sub) DO UPDATE SET email=COALESCE(excluded.email, users.email)`).run(target.sub, target.email ?? null, now(), 0)
    const cls = o.class !== undefined ? o.class : asClass(db.prepare('SELECT class FROM users WHERE sub=?').get(target.sub)?.class)
    if (cls === 'guest' && o.part === 'contributor') throw new PartRefused(GUEST_ONLY_REVIEWER)
    const before = asPart(db.prepare('SELECT part FROM assignments WHERE sub=? AND repo=?').get(target.sub, slug)?.part)
    const part = capped(cls, o.part ?? before ?? defaultPart(cls))
    db.prepare(`INSERT INTO assignments (sub, repo, assigned_by, assigned_at, part) VALUES (?,?,?,?,?)
      ON CONFLICT(sub, repo) DO UPDATE SET assigned_by=excluded.assigned_by, assigned_at=excluded.assigned_at, part=excluded.part`)
      .run(target.sub, slug, by(admin), now(), part)
    const detail = before === null ? `part: ${part}` : before !== part ? `part: ${before} → ${part}` : null
    db.prepare('INSERT INTO assignment_log VALUES (?,?,?,?,?,?)').run(now(), by(admin), target.sub, slug, 'assign', detail)
    const r = db.prepare(`SELECT a.*, ${HOLDER} FROM assignments a ${HOLDER_JOIN} WHERE a.sub=? AND a.repo=?`).get(target.sub, slug)
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
    return db.prepare(`SELECT a.*, ${HOLDER} FROM assignments a ${HOLDER_JOIN}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY a.repo, email`)
      .all(...args).map((r) => rowToAssignment(r as Record<string, unknown>))
  } finally {
    db.close()
  }
}

/** When each person last used the API (their sub → ISO time), from the access store's users (admins only). Never seen: absent. */
export async function lastSeen(admin: Principal): Promise<Map<string, string>> {
  requireAdmin(admin, 'list people')
  const db = await read()
  try {
    return new Map((db.prepare('SELECT sub, last_seen FROM users WHERE last_seen > 0').all() as Record<string, unknown>[])
      .map((r) => [String(r.sub), new Date(Number(r.last_seen) * 1000).toISOString()]))
  } finally {
    db.close()
  }
}

export interface LogEntry { at: string; by: string; repo: string | null; action: 'assign' | 'unassign' | 'class'; detail: string | null; text: string }

/** One line of the assignment log, in words. */
export function logWords(e: Omit<LogEntry, 'text'>): string {
  switch (e.action) {
    case 'class': return `${e.by} made them ${e.detail === 'admin' ? 'an admin' : `a ${e.detail ?? 'person without a class'}`}.`
    case 'unassign': return `${e.by} removed them from ${e.repo}.`
    case 'assign': {
      const m = /^part: (?:(contributor|reviewer) → )?(contributor|reviewer)$/.exec(e.detail ?? '')
      if (!m) return `${e.by} assigned them to ${e.repo} again.`
      return m[1] ? `${e.by} changed their part on ${e.repo} from ${m[1]} to ${m[2]}.` : `${e.by} added them to ${e.repo} as a ${m[2]}.`
    }
  }
}

/** A person's history from the assignment log, newest first, each line in words (admins only). */
export async function assignmentLog(admin: Principal, sub: string, limit = 200): Promise<LogEntry[]> {
  requireAdmin(admin, 'read the assignment log')
  const db = await read()
  try {
    return (db.prepare('SELECT at, by, repo, action, detail FROM assignment_log WHERE sub=? ORDER BY at DESC LIMIT ?').all(sub, limit) as Record<string, unknown>[]).map((r) => {
      const e = { at: new Date(Number(r.at) * 1000).toISOString(), by: String(r.by), repo: r.repo === null ? null : String(r.repo), action: r.action as LogEntry['action'], detail: r.detail === null ? null : String(r.detail) }
      return { ...e, text: logWords(e) }
    })
  } finally {
    db.close()
  }
}

export interface Member { sub: string; email: string | null; class: PersonClass | null; part: Part }

/**
 * The people assigned to `repo`, with their parts (capped by their recorded class). No admin check: the caller has
 * checked that the asker may read the project. Admins who are not assigned are not here; the caller adds them.
 */
export async function membersOf(repo: string): Promise<Member[]> {
  const slug = RepoSlug.parse(repo)
  const db = await read()
  try {
    return db.prepare(`SELECT a.sub, a.part, ${HOLDER} FROM assignments a ${HOLDER_JOIN} WHERE a.repo=? ORDER BY email, a.sub`)
      .all(slug).map((r) => {
        const cls = asClass(r.class)
        return { sub: String(r.sub), email: r.email === null || r.email === undefined ? null : String(r.email), class: cls, part: capped(cls, asPart(r.part) ?? defaultPart(cls)) }
      })
  } finally {
    db.close()
  }
}

// ------------------------------------------------------------------ connected systems

/** A connected system's name: short, lower case, unique (docs/external-access.md). */
export const ServiceName = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, 'a name of 2 to 40 lower-case letters, digits and dashes, starting with a letter')

export interface Service {
  client_id: string
  name: string
  description: string
  scopes: ServiceScope[]
  disabled: boolean
  created_by: string
  created_at: string
  last_used: string | null
}

/** The scopes as stored ('read' | 'read write'): write always brings read. */
const scopesText = (s: readonly ServiceScope[]): 'read' | 'read write' => (s.includes('write') ? 'read write' : 'read')
const scopesOf = (v: unknown): ServiceScope[] => (v === 'read write' ? ['read', 'write'] : ['read'])
/** A system's class, from its scopes: write → user (it may be a contributor), read only → guest (always a reviewer). */
export const serviceClass = (s: readonly ServiceScope[]): PersonClass => (s.includes('write') ? 'user' : 'guest')

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(Number(v) * 1000).toISOString())

function rowToService(r: Record<string, unknown>): Service {
  return {
    client_id: String(r.client_id), name: String(r.name), description: String(r.description ?? ''), scopes: scopesOf(r.scopes),
    disabled: Number(r.disabled) === 1, created_by: String(r.created_by), created_at: iso(r.created_at) ?? '', last_used: iso(r.last_used),
  }
}

/** Already a connected system by that name. */
export class ServiceExists extends Error {
  override name = 'ServiceExists'
}

const logService = (db: DatabaseSync, admin: Principal, s: { client_id: string; name: string }, action: 'create' | 'update' | 'rotate' | 'retire_secret' | 'delete', detail: string | null): void => {
  db.prepare('INSERT INTO service_log VALUES (?,?,?,?,?,?)').run(now(), by(admin), s.client_id, s.name, action, detail)
}

/** Record a new connected system (admins only); its Cognito app client exists already (the caller made it). */
export async function createService(admin: Principal, s: { client_id: string; name: string; description?: string | undefined; scopes: readonly ServiceScope[] }): Promise<Service> {
  requireAdmin(admin, 'connect systems')
  const name = ServiceName.parse(s.name)
  return update((db) => {
    if (db.prepare('SELECT 1 FROM services WHERE name=? OR client_id=?').get(name, s.client_id)) throw new ServiceExists(`a connected system called ${name} exists already`)
    db.prepare('INSERT INTO services (client_id, name, description, scopes, disabled, created_by, created_at, last_used) VALUES (?,?,?,?,0,?,?,NULL)')
      .run(s.client_id, name, s.description ?? '', scopesText(s.scopes), by(admin), now())
    logService(db, admin, { client_id: s.client_id, name }, 'create', `scopes: ${scopesText(s.scopes)}`)
    return rowToService(db.prepare('SELECT * FROM services WHERE client_id=?').get(s.client_id) as Record<string, unknown>)
  })
}

/** A connected system by its client id (the token's client_id), or null. No admin check: the verifier asks. */
export async function getService(clientId: string): Promise<Service | null> {
  const db = await read()
  try {
    const r = db.prepare('SELECT * FROM services WHERE client_id=?').get(clientId)
    return r ? rowToService(r as Record<string, unknown>) : null
  } finally {
    db.close()
  }
}

/** A connected system by its name, or null (admins only). */
export async function serviceByName(admin: Principal, name: string): Promise<Service | null> {
  requireAdmin(admin, 'read connected systems')
  const db = await read()
  try {
    const r = db.prepare('SELECT * FROM services WHERE name=?').get(name)
    return r ? rowToService(r as Record<string, unknown>) : null
  } finally {
    db.close()
  }
}

/** Every connected system, by name (admins only). */
export async function listServices(admin: Principal): Promise<Service[]> {
  requireAdmin(admin, 'list connected systems')
  const db = await read()
  try {
    return (db.prepare('SELECT * FROM services ORDER BY name').all() as Record<string, unknown>[]).map(rowToService)
  } finally {
    db.close()
  }
}

/**
 * Change a connected system's description, scopes or disabled flag (admins only). Losing write makes it a guest: every
 * part it holds becomes reviewer (written, and logged as a part change), and the cap holds at every check besides.
 */
export async function updateService(admin: Principal, name: string, change: { description?: string | undefined; scopes?: readonly ServiceScope[] | undefined; disabled?: boolean | undefined }): Promise<Service> {
  requireAdmin(admin, 'change connected systems')
  return update((db) => {
    const r = db.prepare('SELECT * FROM services WHERE name=?').get(name)
    if (!r) throw new AccessDenied(`no connected system called ${name}`)
    const before = rowToService(r as Record<string, unknown>)
    const words: string[] = []
    if (change.description !== undefined && change.description !== before.description) words.push('description')
    if (change.scopes !== undefined && scopesText(change.scopes) !== scopesText(before.scopes)) words.push(`scopes: ${scopesText(before.scopes)} → ${scopesText(change.scopes)}`)
    if (change.disabled !== undefined && change.disabled !== before.disabled) words.push(change.disabled ? 'disabled' : 'enabled')
    db.prepare('UPDATE services SET description=?, scopes=?, disabled=? WHERE client_id=?').run(
      change.description ?? before.description, scopesText(change.scopes ?? before.scopes), (change.disabled ?? before.disabled) ? 1 : 0, before.client_id)
    if (words.length) logService(db, admin, before, 'update', words.join('; '))
    // down to read only: a guest, so every part it holds is a reviewer's, written and logged as a part change
    if (change.scopes !== undefined && !change.scopes.includes('write')) {
      for (const a of db.prepare("SELECT repo FROM assignments WHERE sub=? AND part='contributor'").all(before.client_id)) {
        db.prepare("UPDATE assignments SET part='reviewer', assigned_by=?, assigned_at=? WHERE sub=? AND repo=?").run(by(admin), now(), before.client_id, String(a.repo))
        db.prepare('INSERT INTO assignment_log VALUES (?,?,?,?,?,?)').run(now(), by(admin), before.client_id, String(a.repo), 'assign', 'part: contributor → reviewer')
      }
    }
    return rowToService(db.prepare('SELECT * FROM services WHERE client_id=?').get(before.client_id) as Record<string, unknown>)
  })
}

/** Note a secret rotated or retired (admins only): the log keeps the secret's id and never its value. */
export async function logServiceSecret(admin: Principal, s: Service, action: 'rotate' | 'retire_secret', secretId: string | null): Promise<void> {
  requireAdmin(admin, 'change connected systems')
  await update((db) => { logService(db, admin, s, action, secretId ? `secret ${secretId}` : null) })
}

/** Remove a connected system and every assignment it holds (admins only), each logged. Returns whether it existed. */
export async function deleteService(admin: Principal, name: string): Promise<boolean> {
  requireAdmin(admin, 'remove connected systems')
  return update((db) => {
    const r = db.prepare('SELECT * FROM services WHERE name=?').get(name)
    if (!r) return false
    const s = rowToService(r as Record<string, unknown>)
    for (const a of db.prepare('SELECT repo FROM assignments WHERE sub=?').all(s.client_id)) {
      db.prepare('INSERT INTO assignment_log VALUES (?,?,?,?,?,?)').run(now(), by(admin), s.client_id, String(a.repo), 'unassign', null)
    }
    db.prepare('DELETE FROM assignments WHERE sub=?').run(s.client_id)
    db.prepare('DELETE FROM services WHERE client_id=?').run(s.client_id)
    logService(db, admin, s, 'delete', null)
    return true
  })
}

/**
 * Put a connected system on `repo` with a part (admins only). A read-only system is a guest, so always a reviewer:
 * asking for contributor is refused (PartRefused), as for a guest person. Logged in the assignment log.
 */
export async function assignService(admin: Principal, s: Service, repo: string, part?: Part | undefined): Promise<Assignment> {
  requireAdmin(admin, 'assign connected systems to projects')
  const slug = RepoSlug.parse(repo)
  const cls = serviceClass(s.scopes)
  if (cls === 'guest' && part === 'contributor') throw new PartRefused(READ_ONLY_REVIEWER)
  return update((db) => {
    const before = asPart(db.prepare('SELECT part FROM assignments WHERE sub=? AND repo=?').get(s.client_id, slug)?.part)
    const p = capped(cls, part ?? before ?? defaultPart(cls))
    db.prepare(`INSERT INTO assignments (sub, repo, assigned_by, assigned_at, part) VALUES (?,?,?,?,?)
      ON CONFLICT(sub, repo) DO UPDATE SET assigned_by=excluded.assigned_by, assigned_at=excluded.assigned_at, part=excluded.part`)
      .run(s.client_id, slug, by(admin), now(), p)
    const detail = before === null ? `part: ${p}` : before !== p ? `part: ${before} → ${p}` : null
    db.prepare('INSERT INTO assignment_log VALUES (?,?,?,?,?,?)').run(now(), by(admin), s.client_id, slug, 'assign', detail)
    const r = db.prepare(`SELECT a.*, ${HOLDER} FROM assignments a ${HOLDER_JOIN} WHERE a.sub=? AND a.repo=?`).get(s.client_id, slug)
    return rowToAssignment(r as Record<string, unknown>)
  })
}

/** The words refusing a read-only system as a contributor. */
export const READ_ONLY_REVIEWER = 'A system with only the read scope can only be a reviewer. Give it the write scope first, then make it a contributor.'

/** A connected system's own log (created, scopes, disabled, secrets, deleted), newest first, in words (admins only). */
export async function serviceLog(admin: Principal, clientId: string, limit = 200): Promise<{ at: string; by: string; action: string; detail: string | null; text: string }[]> {
  requireAdmin(admin, 'read the connected systems\' log')
  const db = await read()
  try {
    return (db.prepare('SELECT at, by, action, detail FROM service_log WHERE client_id=? ORDER BY at DESC LIMIT ?').all(clientId, limit) as Record<string, unknown>[]).map((r) => {
      const e = { at: new Date(Number(r.at) * 1000).toISOString(), by: String(r.by), action: String(r.action), detail: r.detail === null ? null : String(r.detail) }
      return { ...e, text: serviceWords(e) }
    })
  } finally {
    db.close()
  }
}

function serviceWords(e: { by: string; action: string; detail: string | null }): string {
  switch (e.action) {
    case 'create': return `${e.by} connected it (${e.detail ?? 'read'}).`
    case 'update': return `${e.by} changed it: ${e.detail ?? 'nothing'}.`
    case 'rotate': return `${e.by} added a new secret${e.detail ? ` (${e.detail})` : ''}.`
    case 'retire_secret': return `${e.by} removed an old secret${e.detail ? ` (${e.detail})` : ''}.`
    case 'delete': return `${e.by} deleted it.`
    default: return `${e.by}: ${e.action}.`
  }
}
