import { describe, expect, it } from 'vitest'
import { AccessDenied, assign, assignments, classOf, projectsFor, require_, setClass, unassign, type Principal } from '../../src/core/access.js'
import { update } from '../../src/core/central.js'

const admin: Principal = { sub: 'a', email: 'admin@example.com', groups: ['trace-admins'] }
const user: Principal = { sub: 'u', email: 'user@example.com', groups: ['trace-users'] }
const guest: Principal = { sub: 'g', email: 'guest@example.com', groups: ['trace-guests'] }
const nobody: Principal = { sub: 'n', email: 'nobody@example.com', groups: [] }

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

    expect(await projectsFor(user)).toEqual([{ repo: 'o/board', role: 'write' }])
    expect(await projectsFor(guest)).toEqual([{ repo: 'o/board', role: 'read' }])
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
