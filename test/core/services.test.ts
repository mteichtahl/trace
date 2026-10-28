/** Connected systems in the access store (src/core/access.ts): records, derived class, assignments and their log. */
import { describe, expect, it } from 'vitest'
import {
  AccessDenied, type Principal, assignService, assignmentLog, createService, deleteService, getService, listServices, membersOf, projectsFor,
  require_, serviceByName, touchLastUsed, updateService,
} from '../../src/core/access.js'

const admin: Principal = { sub: 'a', email: 'admin@example.com', groups: ['trace-admins'] }
const user: Principal = { sub: 'u', email: 'user@example.com', groups: ['trace-users'] }

describe('connected systems in the access store', () => {
  it('only admins create, change and delete them', async () => {
    await expect(createService(user, { client_id: 'x', name: 'nope', scopes: ['read'] })).rejects.toThrow(AccessDenied)
    await expect(listServices(user)).rejects.toThrow(AccessDenied)
    await expect(deleteService(user, 'nope')).rejects.toThrow(AccessDenied)
  })

  it('a system is on projects like a person, shown as service:<name>, its class from its scopes', async () => {
    const s = await createService(admin, { client_id: 'cs1', name: 'store-sys', description: 'd', scopes: ['read', 'write'] })
    expect(s).toMatchObject({ client_id: 'cs1', name: 'store-sys', scopes: ['read', 'write'], disabled: false, created_by: 'admin@example.com', last_used: null })
    await expect(createService(admin, { client_id: 'cs2', name: 'store-sys', scopes: ['read'] })).rejects.toThrow(/exists already/)
    expect((await assignService(admin, s, 'o/sys', 'contributor')).part).toBe('contributor')
    expect(await membersOf('o/sys')).toEqual([{ sub: 'cs1', email: 'service:store-sys', class: 'user', part: 'contributor' }])
    const p: Principal = { sub: 'cs1', email: null, groups: ['trace-users'], kind: 'service', name: 'store-sys', scopes: ['read', 'write'] }
    expect(await require_(p, 'o/sys', 'write')).toBe('write')
    expect(await projectsFor(p)).toEqual([{ repo: 'o/sys', role: 'write', part: 'contributor' }])

    // read only: a guest, every part a reviewer's, logged
    const ro = await updateService(admin, 'store-sys', { scopes: ['read'] })
    expect(ro.scopes).toEqual(['read'])
    expect(await membersOf('o/sys')).toEqual([{ sub: 'cs1', email: 'service:store-sys', class: 'guest', part: 'reviewer' }])
    await expect(assignService(admin, ro, 'o/sys', 'contributor')).rejects.toThrow(/only be a reviewer/)
    expect((await assignmentLog(admin, 'cs1')).map((e) => e.text)).toContain('admin@example.com changed their part on o/sys from contributor to reviewer.')

    expect(await touchLastUsed('cs1', 1_000_000)).toBe(true)
    expect(await touchLastUsed('cs1', 1_030_000)).toBe(false)
    expect((await getService('cs1'))?.last_used).toBe(new Date(1_000_000).toISOString())

    expect(await deleteService(admin, 'store-sys')).toBe(true)
    expect(await serviceByName(admin, 'store-sys')).toBeNull()
    expect(await membersOf('o/sys')).toEqual([])
    expect((await assignmentLog(admin, 'cs1'))[0]?.text).toBe('admin@example.com removed them from o/sys.')
    expect(await deleteService(admin, 'store-sys')).toBe(false)
  })
})
