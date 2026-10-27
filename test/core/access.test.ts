import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  AccessDenied, PartRefused, accessHome, accessStore, assign, assignments, classOf, membersOf, migrateParts, projectsFor, require_, setClass, standing, unassign, type Principal,
} from '../../src/core/access.js'
import { Central, update } from '../../src/core/central.js'

const admin: Principal = { sub: 'a', email: 'admin@example.com', groups: ['trace-admins'] }
const user: Principal = { sub: 'u', email: 'user@example.com', groups: ['trace-users'] }
const guest: Principal = { sub: 'g', email: 'guest@example.com', groups: ['trace-guests'] }
const nobody: Principal = { sub: 'n', email: 'nobody@example.com', groups: [] }

describe('the access store', () => {
  it('sits beside the central database, not in it', () => {
    const prior = process.env.TRACE_HOME
    process.env.TRACE_HOME = 's3://bucket/central'
    expect(accessHome()).toBe('s3://bucket/access')
    process.env.TRACE_HOME = 's3://bucket/a/b/central'
    expect(accessHome()).toBe('s3://bucket/a/b/access')
    process.env.TRACE_HOME = prior
  })
})

describe('the three classes', () => {
  it('come from the token groups, highest first', () => {
    expect(classOf(admin)).toBe('admin')
    expect(classOf({ ...user, groups: ['trace-guests', 'trace-users'] })).toBe('user')
    expect(classOf(nobody)).toBeNull()
  })

  it('admin: everything everywhere; user: read+write where assigned; guest: read where assigned; else nothing', async () => {
    await update((db) => { db.exec("CREATE TABLE IF NOT EXISTS projects (repo TEXT PRIMARY KEY, added REAL NOT NULL, path TEXT)"); db.prepare('INSERT OR IGNORE INTO projects VALUES (?,?,?)').run('o/secret', 0, null) })
    await assign(admin, user, 'O/Board')
    await assign(admin, guest, 'o/board')

    expect(await require_(admin, 'o/secret', 'write')).toBe('write')
    expect(await require_(admin, 'o/never-registered', 'write')).toBe('write')

    expect(await require_(user, 'o/board', 'write')).toBe('write')
    expect(await require_(guest, 'o/board', 'read')).toBe('read')
    await expect(require_(guest, 'o/board', 'write')).rejects.toThrow(AccessDenied)

    // Unassigned and nonexistent projects give exactly the same answer.
    const a = await require_(user, 'o/secret', 'read').catch((e: Error) => e.message)
    const b = await require_(user, 'o/does-not-exist', 'read').catch((e: Error) => e.message)
    expect(a.replace('o/secret', 'X')).toBe(b.replace('o/does-not-exist', 'X'))

    // In no group: nothing, even when assigned.
    await assign(admin, nobody, 'o/board')
    await expect(require_(nobody, 'o/board', 'read')).rejects.toThrow(AccessDenied)
    expect(await projectsFor(nobody)).toEqual([])

    expect(await projectsFor(user)).toEqual([{ repo: 'o/board', role: 'write', part: 'contributor' }])
    expect(await projectsFor(guest)).toEqual([{ repo: 'o/board', role: 'read', part: 'reviewer' }])
    expect((await projectsFor(admin)).map((p) => p.repo)).toEqual(expect.arrayContaining(['o/board', 'o/secret']))
  })

  it('only admins manage people, assignments and classes', async () => {
    await expect(assign(user, guest, 'o/board')).rejects.toThrow(/only an admin/)
    await expect(unassign(user, 'g', 'o/board')).rejects.toThrow(/only an admin/)
    await expect(assignments(guest)).rejects.toThrow(/only an admin/)
    await expect(setClass(user, guest, 'admin')).rejects.toThrow(/only an admin/)
    await setClass(admin, guest, 'guest')
    const list = await assignments(admin, { repo: 'o/board' })
    expect(list.find((x) => x.sub === 'g')?.class).toBe('guest')
    expect(await unassign(admin, 'g', 'o/board')).toBe(true)
    await expect(require_(guest, 'o/board', 'read')).rejects.toThrow(AccessDenied)
  })
})

describe('parts on each project', () => {
  const u2: Principal = { sub: 'u2', email: 'u2@example.com', groups: ['trace-users'] }
  const g2: Principal = { sub: 'g2', email: 'g2@example.com', groups: ['trace-guests'] }

  it('a user is a contributor by default and may be made a reviewer, who reads only', async () => {
    expect((await assign(admin, u2, 'o/parts')).part).toBe('contributor')
    expect(await require_(u2, 'o/parts', 'write')).toBe('write')
    const r = await assign(admin, u2, 'o/parts', { part: 'reviewer' })
    expect(r.part).toBe('reviewer')
    expect(await require_(u2, 'o/parts', 'read')).toBe('read')
    await expect(require_(u2, 'o/parts', 'write')).rejects.toThrow(AccessDenied)
    expect(await projectsFor(u2)).toEqual([{ repo: 'o/parts', role: 'read', part: 'reviewer' }])
    expect(await standing(u2, 'o/parts')).toEqual({ role: 'read', part: 'reviewer' })
    // assigning again without a part keeps the part they have
    expect((await assign(admin, u2, 'o/parts')).part).toBe('reviewer')
  })

  it('a guest can only be a reviewer: refused as a contributor, and capped whatever is stored', async () => {
    await setClass(admin, g2, 'guest')
    await expect(assign(admin, g2, 'o/parts', { part: 'contributor' })).rejects.toThrow(PartRefused)
    await expect(assign(admin, g2, 'o/parts', { part: 'contributor', class: 'guest' })).rejects.toThrow(/A guest can only be a reviewer/)
    expect((await assign(admin, g2, 'o/parts')).part).toBe('reviewer')
    // a contributor row for someone whose token says guest still reads only
    expect(await accessStore().update((db) => Number(db.prepare("UPDATE assignments SET part='contributor' WHERE sub='g2'").run().changes))).toBe(1)
    await expect(require_(g2, 'o/parts', 'write')).rejects.toThrow(AccessDenied)
    expect(await projectsFor(g2)).toEqual([{ repo: 'o/parts', role: 'read', part: 'reviewer' }])
  })

  it('admins are contributors everywhere without an assignment', async () => {
    expect(await standing(admin, 'o/anything')).toEqual({ role: 'write', part: 'contributor' })
    expect((await projectsFor(admin)).every((p) => p.part === 'contributor')).toBe(true)
  })

  it('logs part changes, and lists members with their parts', async () => {
    const u3: Principal = { sub: 'u3', email: 'u3@example.com', groups: ['trace-users'] }
    await assign(admin, u3, 'o/log', { part: 'reviewer' })
    await assign(admin, u3, 'o/log', { part: 'contributor' })
    await assign(admin, u3, 'o/log', { part: 'contributor' })
    const db = await accessStore().read()
    try {
      const details = db.prepare("SELECT detail FROM assignment_log WHERE sub='u3' AND action='assign' ORDER BY at").all().map((r) => r.detail)
      expect(details).toEqual(['part: reviewer', 'part: reviewer → contributor', null])
    } finally {
      db.close()
    }
    expect(await membersOf('o/log')).toEqual([{ sub: 'u3', email: 'u3@example.com', class: null, part: 'contributor' }])
  })

  it('migrates assignments made before parts: users → contributor, guests → reviewer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-access-old-'))
    const old = new DatabaseSync(join(dir, 'central.db'))
    old.exec(`CREATE TABLE users (sub TEXT PRIMARY KEY, email TEXT, class TEXT, first_seen REAL NOT NULL, last_seen REAL NOT NULL);
      CREATE TABLE assignments (sub TEXT NOT NULL, repo TEXT NOT NULL, assigned_by TEXT NOT NULL, assigned_at REAL NOT NULL, PRIMARY KEY (sub, repo));
      INSERT INTO users VALUES ('ou', 'ou@x', 'user', 0, 0), ('og', 'og@x', 'guest', 0, 0);
      INSERT INTO assignments VALUES ('ou', 'o/old', 'a', 0), ('og', 'o/old', 'a', 0), ('nobody-known', 'o/old', 'a', 0);`)
    old.close()
    const db = await new Central({ home: dir }).read()
    try {
      expect(Object.fromEntries(db.prepare('SELECT sub, part FROM assignments').all().map((r) => [r.sub, r.part]))).toEqual({ ou: 'contributor', og: 'reviewer', 'nobody-known': 'contributor' })
    } finally {
      db.close()
    }
    // and it runs again harmlessly
    const again = new DatabaseSync(join(dir, 'central.db'))
    migrateParts(again)
    again.close()
  })
})
