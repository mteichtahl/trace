import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { S3Backend } from '../../src/core/central.js'
import { loadJourney, recordOpen, setCriterion, startJourney } from '../../src/core/journey.js'
import { JourneyStore, forgetNoJourney } from '../../src/core/journey-store.js'
import { openProject } from '../../src/core/store.js'
import { FakeS3 } from './fake-s3.js'

const start = (store: JourneyStore) => store.update((db) => { startJourney(db, { template: 'board', by: 'a' }); return { result: null } })

describe('the journey store in the central bucket', () => {
  beforeEach(() => forgetNoJourney())

  it('keeps one database per project under projects/<slug>/journey/, with a version per change', async () => {
    const s3 = new FakeS3()
    const store = new JourneyStore(new S3Backend('bucket', 'projects', s3), 'Acme/Board')
    expect(await store.read((db) => loadJourney(db))).toEqual({ result: null, version: 0 })
    expect((await start(store)).version).toBe(1)
    expect([...s3.objects.keys()]).toEqual(['bucket/projects/acme/board/journey/journey.db'])
    const r = await store.update((db) => { setCriterion(db, 'define.accepted', 'met', [], 'trace'); return { result: 'ok' } })
    expect(r).toEqual({ result: 'ok', version: 2, changed: true })
    expect(await store.update(() => ({ result: 'nothing', changed: false }))).toEqual({ result: 'nothing', version: 2, changed: false })
    expect(s3.puts).toBe(2)
    const read = await store.read((db) => loadJourney(db)?.criteria.find((c) => c.id === 'define.accepted')?.status)
    expect(read).toEqual({ result: 'met', version: 2 })
    // another project is its own
    expect((await new JourneyStore(new S3Backend('bucket', 'projects', s3), 'acme/other').read((db) => loadJourney(db))).result).toBeNull()
  })

  it('makes its scratch folder when it is not there yet (the API\'s, a folder of /tmp nothing else creates)', async () => {
    const scratch = join(mkdtempSync(join(tmpdir(), 'trace-js-')), 'trace-api')
    const store = new JourneyStore(new S3Backend('bucket', 'projects', new FakeS3()), 'acme/board', { scratch })
    expect((await start(store)).version).toBe(1)
    expect((await store.read((db) => loadJourney(db) !== null)).result).toBe(true)
  })

  it('re-runs a change that lost a race on a fresh copy, keeping the other writer\'s change', async () => {
    const s3 = new FakeS3()
    const store = new JourneyStore(new S3Backend('bucket', 'projects', s3), 'acme/board')
    await start(store)
    let runs = 0
    s3.interleave = () => store.update((db) => { recordOpen(db, { criterion: 'define.accepted' }, 'someone-else'); return { result: null } })
    const r = await store.update((db) => { runs++; recordOpen(db, { criterion: 'define.measurable' }, 'me'); return { result: null } })
    expect(s3.conflicts).toBe(1)
    expect(runs).toBe(2)
    expect(r.version).toBe(3)
    const opens = (await store.read((db) => loadJourney(db)?.opens.map((o) => o.item).sort())).result
    expect(opens).toEqual(['define.accepted', 'define.measurable'])
  })

  it('gives up with a plain error when it keeps losing', async () => {
    const s3 = new FakeS3()
    const store = new JourneyStore(new S3Backend('bucket', 'projects', s3), 'acme/board', { retries: 1 })
    await start(store)
    const orig = s3.putObject.bind(s3)
    s3.putObject = async () => { throw Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } }) }
    await expect(store.update((db) => { recordOpen(db, { criterion: 'define.accepted' }, 'me'); return { result: null } })).rejects.toThrow(/kept changing/)
    s3.putObject = orig
  })

  it('imports a journey an older install kept in the repository, once; a project with none is not asked again at once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-legacy-'))
    mkdirSync(join(dir, '.git'))
    const repoDb = openProject(dir)
    startJourney(repoDb, { template: 'fpga', by: 'old', name: 'Old project' })
    repoDb.close()
    const bytes = new Uint8Array(readFileSync(join(dir, '.trace', 'project.db')))
    const s3 = new FakeS3()
    let asked = 0
    const store = new JourneyStore(new S3Backend('bucket', 'projects', s3), 'acme/old', { legacy: async () => { asked++; return bytes } })
    const r = await store.read((db) => loadJourney(db)?.journey)
    expect(r).toMatchObject({ result: { template: 'fpga', name: 'Old project' }, version: 1 })
    await store.read(() => null)
    expect(asked).toBe(1)
    expect(s3.objects.has('bucket/projects/acme/old/journey/journey.db')).toBe(true)

    let none = 0
    const empty = new JourneyStore(new S3Backend('bucket', 'projects', s3), 'acme/none', { legacy: async () => { none++; return null } })
    await empty.read(() => null)
    await empty.read(() => null)
    expect(none).toBe(1)
  })
})
