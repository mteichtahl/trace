/**
 * The project logo (docs/scribe.md "Project logo"; src/docs/logo.ts, src/api/actions-logo.ts): what a logo file must
 * be, and that project.logo_set commits it beside the documents (removing the variant's other format), opens the
 * change and records the edit, admins only; project.logo reads it back.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { logoChanges } from '../../src/api/actions-logo.js'
import { assign } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { checkLogo, pngSize, sniffLogo, svgHazards, svgSize } from '../../src/docs/logo.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

/** A PNG header (signature and IHDR) of this size: enough for the checks, which read only the header. */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(64)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const v = new DataView(b.buffer)
  v.setUint32(16, width)
  v.setUint32(20, height)
  return b
}
const svg = (inner = '<rect width="10" height="10"/>', attrs = 'viewBox="0 0 200 80"'): Uint8Array =>
  new TextEncoder().encode(`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`)

describe('what a logo must be', () => {
  it('knows SVG and PNG by their content, not their name', () => {
    expect(sniffLogo(png(512, 512))).toBe('png')
    expect(sniffLogo(svg())).toBe('svg')
    expect(sniffLogo(new TextEncoder().encode('﻿<!-- made in Inkscape -->\n<svg viewBox="0 0 1 1"/>'))).toBe('svg')
    expect(sniffLogo(new TextEncoder().encode('GIF89a'))).toBeNull()
  })

  it('reads a PNG\'s size from its header and an SVG\'s from its viewBox, else its width and height', () => {
    expect(pngSize(png(800, 300))).toEqual({ width: 800, height: 300 })
    expect(svgSize('<svg viewBox="0 0 200 80">')).toEqual({ width: 200, height: 80 })
    expect(svgSize('<svg width="120" height="40px">')).toEqual({ width: 120, height: 40 })
    expect(svgSize('<svg>')).toBeNull()
  })

  it('accepts a plain logo', () => {
    expect(checkLogo(png(1024, 512))).toMatchObject({ ok: true, format: 'png', width: 1024, height: 512, problems: [] })
    expect(checkLogo(svg())).toMatchObject({ ok: true, format: 'svg', width: 200, height: 80 })
  })

  it('refuses, in words a person can act on, what would print badly or do more than draw', () => {
    expect(checkLogo(new Uint8Array()).problems).toEqual(['The file is empty.'])
    expect(checkLogo(new TextEncoder().encode('GIF89a...')).problems.join()).toMatch(/not an SVG or PNG/)
    expect(checkLogo(png(120, 120)).problems.join()).toMatch(/at least 256 pixels/)
    expect(checkLogo(png(5000, 1000)).problems.join()).toMatch(/at most 4096/)
    expect(checkLogo(png(3000, 300)).problems.join()).toMatch(/more than six times wider/)
    expect(checkLogo(svg('', 'width="10"')).problems.join()).toMatch(/no viewBox/)
    const big = new Uint8Array(1024 * 1024 + 1)
    big.set(png(512, 512))
    expect(checkLogo(big).problems.join()).toMatch(/at most 1 MB/)
  })

  it('refuses an SVG that would run code or load from elsewhere', () => {
    expect(svgHazards('<svg><script>alert(1)</script></svg>')).toEqual(['it contains a script'])
    expect(svgHazards('<svg onload="x()"/>')).toEqual(['it has event handlers (on… attributes)'])
    expect(svgHazards('<svg><image href="https://example.com/a.png"/></svg>')).toEqual(['it loads something from another site'])
    expect(svgHazards('<svg><style>@import url(x.css)</style></svg>')).toEqual(['it loads something from another site'])
    expect(svgHazards('<svg><foreignObject/></svg>')).toEqual(['it embeds other content (foreignObject)'])
    expect(svgHazards('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>')).toEqual(['it defines entities'])
    expect(svgHazards('<svg><use href="#a"/></svg>')).toEqual([])
    expect(checkLogo(svg('<script/>')).ok).toBe(false)
  })

  it('setting a variant writes its file and removes its other format; null removes it', () => {
    const have = new Set(['docs/design/logo.png', 'docs/design/logo-dark.svg'])
    expect(logoChanges({ light: svg() }, have).map((c) => [c.path, c.content ? 'write' : 'remove'])).toEqual([['docs/design/logo.svg', 'write'], ['docs/design/logo.png', 'remove']])
    expect(logoChanges({ dark: null }, have).map((c) => [c.path, c.content])).toEqual([['docs/design/logo-dark.svg', null]])
    expect(logoChanges({ dark: null }, new Set())).toEqual([])
  })
})

// ------------------------------------------------------------------ the actions, over the fake GitHub

const REPO = 'acme/logo'
const ADMIN = { sub: 'l-admin', email: 'l-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'l-user', email: 'l-user@example.com', groups: ['trace-users'] }

class LogoGitHub extends FakeGitHub {
  committed: { branch: string; files: { path: string; removed: boolean }[] }[] = []
  async openPull(): Promise<{ number: number; existed: boolean }> { return { number: 201, existed: false } }
  async commitFiles(repo: string, o: { branch: string; base: string; message: string; files: { path: string; content: Uint8Array | null }[] }): Promise<{ commit: string }> {
    this.committed.push({ branch: o.branch, files: o.files.map((f) => ({ path: f.path, removed: f.content === null })) })
    this.branches.set(`${repo}:${o.branch}`, 'c'.repeat(40))
    return { commit: 'c'.repeat(40) }
  }
}

const github = new LogoGitHub([REPO])
const scratch = mkdtempSync(join(tmpdir(), 'trace-logo-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-logo-bucket-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })
const deps: ActionDeps = {
  github: async () => github, cognito: () => new FakeCognito(), tools: () => new Registry([]), scratch,
  jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [] }),
  store: (p) => backendFor(join(bucket, p)),
}
const run = async (who: Context['principal'], action: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (await perform(action, args, { principal: who, deps })).result as Record<string, unknown>
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64')

beforeAll(async () => {
  await assign(ADMIN, USER, REPO, { class: 'user' })
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  openProject(dir).close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  github.files.set(`${REPO}:main:docs/design/logo.png`, png(512, 256))
})

describe('the logo actions', () => {
  it('project.logo reads each variant from the default branch', async () => {
    const r = await run(USER, 'project.logo', { repo: REPO })
    expect(r.light).toMatchObject({ path: 'docs/design/logo.png', format: 'png' })
    expect(r.dark).toBeNull()
  })

  it('project.logo_check answers the verdict without saving anything', async () => {
    expect(await run(USER, 'project.logo_check', { repo: REPO, base64: b64(png(100, 100)) })).toMatchObject({ ok: false, format: 'png' })
    expect(github.committed).toEqual([])
  })

  it('only an admin sets the logo', async () => {
    await expect(run(USER, 'project.logo_set', { repo: REPO, light: { base64: b64(svg()) } })).rejects.toThrow()
  })

  it('project.logo_set commits the new file, removes the old format and opens the change', async () => {
    const r = await run(ADMIN, 'project.logo_set', { repo: REPO, light: { base64: b64(svg()) }, dark: { base64: b64(png(600, 300)) } })
    expect(r).toMatchObject({ change: 201, written: ['docs/design/logo.svg', 'docs/design/logo-dark.png'], removed: ['docs/design/logo.png'] })
    expect(github.committed.at(-1)!.branch).toMatch(/^trace\/logo-/)
  })

  it('refuses a logo that fails its checks, saying why', async () => {
    await expect(run(ADMIN, 'project.logo_set', { repo: REPO, light: { base64: b64(svg('<script/>')) } })).rejects.toThrow(/contains a script/)
    await expect(run(ADMIN, 'project.logo_set', { repo: REPO, dark: null })).rejects.toThrow(/no logo to remove/)
  })
})
