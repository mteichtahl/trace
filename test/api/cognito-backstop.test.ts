/**
 * The backstop under services.* (src/api/aws.ts HttpCognito): the connected systems' client calls touch only a
 * connected system's own app client. A new one must be named <prefix>-svc-<name>; every other call must name a client
 * that is a connected system in the access store, and an update must keep its record's name. Refused calls never
 * reach Cognito.
 */
import { describe, expect, it } from 'vitest'
import { HttpCognito, NotAServiceClient } from '../../src/api/aws.js'

const creds = async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' })

function cognito(services: Record<string, string> = { 'svc-1': 'ci-dash', 'bad-1': 'Not A Name' }) {
  const sent: { op: string; body: Record<string, unknown> }[] = []
  const fetch = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    const op = String(init.headers['x-amz-target']).split('.').at(-1) ?? ''
    sent.push({ op, body: JSON.parse(init.body) as Record<string, unknown> })
    const answers: Record<string, unknown> = {
      CreateUserPoolClient: { UserPoolClient: { ClientId: 'new-1', ClientSecret: 's3cret' } },
      AddUserPoolClientSecret: { ClientSecretDescriptor: { ClientSecretId: 'k2', ClientSecretValue: 'v2' } },
      ListUserPoolClientSecrets: { ClientSecrets: [{ ClientSecretId: 'k1' }] },
    }
    return new Response(JSON.stringify(answers[op] ?? {}), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  const c = new HttpCognito({ region: 'us-east-1', poolId: 'us-east-1_X', credentials: creds, fetch, prefix: 'tr', service: async (id) => (services[id] ? { name: services[id] } : null) })
  return { c, sent }
}

describe('the connected systems\' client calls (backstop)', () => {
  it('make only a client named <prefix>-svc-<name>', async () => {
    const { c, sent } = cognito()
    await expect(c.createServiceClient({ clientName: 'tr-cli', scopes: [] })).rejects.toThrow(NotAServiceClient)
    await expect(c.createServiceClient({ clientName: 'other-svc-x1', scopes: [] })).rejects.toThrow(NotAServiceClient)
    await expect(c.createServiceClient({ clientName: 'tr-svc-Bad', scopes: [] })).rejects.toThrow(NotAServiceClient)
    expect(sent).toEqual([])
    expect(await c.createServiceClient({ clientName: 'tr-svc-ci-dash', scopes: ['trace-external/read'] })).toEqual({ clientId: 'new-1', secret: 's3cret' })
  })

  it('refuse a client that is not a connected system: the people\'s CLI or web client, or anything else', async () => {
    const { c, sent } = cognito()
    for (const id of ['people-cli-client', 'web-client']) {
      await expect(c.updateServiceClient(id, { clientName: 'tr-svc-ci-dash', scopes: [] })).rejects.toThrow(/not a connected system/)
      await expect(c.deleteServiceClient(id)).rejects.toThrow(/not a connected system/)
      await expect(c.addClientSecret(id)).rejects.toThrow(/not a connected system/)
      await expect(c.deleteClientSecret(id, 'k1')).rejects.toThrow(/not a connected system/)
      await expect(c.listClientSecrets(id)).rejects.toThrow(/not a connected system/)
    }
    expect(sent).toEqual([])
  })

  it('refuse a record whose name trace would not give, and an update that renames the client', async () => {
    const { c, sent } = cognito()
    await expect(c.addClientSecret('bad-1')).rejects.toThrow(/would not give/)
    await expect(c.updateServiceClient('svc-1', { clientName: 'tr-svc-other', scopes: [] })).rejects.toThrow(/rename/)
    expect(sent).toEqual([])
  })

  it('let every call through for a connected system\'s own client', async () => {
    const { c, sent } = cognito()
    await c.updateServiceClient('svc-1', { clientName: 'tr-svc-ci-dash', scopes: ['trace-external/read'] })
    await c.addClientSecret('svc-1')
    await c.listClientSecrets('svc-1')
    await c.deleteClientSecret('svc-1', 'k1')
    expect(await c.deleteServiceClient('svc-1')).toBe(true)
    expect(sent.map((s) => s.op)).toEqual(['UpdateUserPoolClient', 'AddUserPoolClientSecret', 'ListUserPoolClientSecrets', 'DeleteUserPoolClientSecret', 'DeleteUserPoolClient'])
    expect(sent.every((s) => s.body.ClientId === 'svc-1')).toBe(true)
  })

  it('let services.create undo a client it just made, before its record exists', async () => {
    const { c, sent } = cognito({})
    const made = await c.createServiceClient({ clientName: 'tr-svc-new', scopes: [] })
    expect(await c.deleteServiceClient(made.clientId)).toBe(true)
    expect(sent.map((s) => s.op)).toEqual(['CreateUserPoolClient', 'DeleteUserPoolClient'])
    // once deleted, it is like any other: a second delete is refused
    await expect(c.deleteServiceClient(made.clientId)).rejects.toThrow(/not a connected system/)
  })
})
