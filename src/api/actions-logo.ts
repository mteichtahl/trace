/**
 * The project logo (docs/scribe.md "Project logo"; src/docs/logo.ts): the picture every printed copy of the project's
 * documents carries on its cover and in its page header. It is kept in the repository beside the documents, so it is
 * versioned with them and the printed copies are made from it.
 *
 *   project.logo        read   { repo } → { light, dark }: each { path, format, base64 } from the default branch, or null
 *   project.logo_check  read   { repo, base64 } → the verdict (src/docs/logo.ts checkLogo), before anything is saved
 *   project.logo_set    admin  { repo, light?, dark? }: each { base64 } to set or replace, or null to remove; left out:
 *                              unchanged. One commit on trace/logo-<base36 time> that writes the new file and removes
 *                              the variant's other format, its pull request opened and the edit recorded (kind logo):
 *                              an admin's edit applies once its checks pass (src/core/app-edits.ts appliesOf)
 *
 * Limits: a logo is at most 1 MB, so two as base64 stay under the 5,000,000 bytes AWS WAF lets through to /api/*.
 */
import { z } from 'zod'
import { RepoSlug } from '../core/access.js'
import { checkLogo, LOGO_VARIANTS, type LogoFormat, logoPath, logoPaths, type LogoVariant, MAX_LOGO_BYTES } from '../docs/logo.js'
import { ActionError, type Context, def, label } from './action-kit.js'
import { editorName, recordEdit } from './edits.js'

const Base64 = z.string().min(1).max(Math.ceil(MAX_LOGO_BYTES / 3) * 4 + 4).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'the file\'s bytes as base64')
const Logo = z.object({ base64: Base64 })

export interface StoredLogo { path: string; format: LogoFormat; base64: string }

/** Each variant's logo on the default branch, or null. */
async function storedLogos(ctx: Context, repo: string, branch: string): Promise<{ files: Set<string>; logos: Record<LogoVariant, StoredLogo | null> }> {
  const gh = await ctx.deps.github()
  const files = new Set((await gh.tree(repo, branch)).files.map((f) => f.path))
  const logos = { light: null, dark: null } as Record<LogoVariant, StoredLogo | null>
  for (const v of LOGO_VARIANTS) {
    const path = logoPaths(v).find((p) => files.has(p))
    if (!path) continue
    const bytes = await gh.rawFile(repo, path, branch)
    if (bytes) logos[v] = { path, format: path.endsWith('.svg') ? 'svg' : 'png', base64: Buffer.from(bytes).toString('base64') }
  }
  return { files, logos }
}

const decode = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'))

/** The files one commit writes and removes to set the variants given (undefined: unchanged; null: removed). Pure. */
export function logoChanges(set: Partial<Record<LogoVariant, Uint8Array | null>>, existing: ReadonlySet<string>): { path: string; content: Uint8Array | null }[] {
  const out: { path: string; content: Uint8Array | null }[] = []
  for (const v of LOGO_VARIANTS) {
    const bytes = set[v]
    if (bytes === undefined) continue
    const keep = bytes ? logoPath(v, checkLogo(bytes).format!) : null
    if (bytes && keep) out.push({ path: keep, content: bytes })
    for (const p of logoPaths(v)) if (p !== keep && existing.has(p)) out.push({ path: p, content: null })
  }
  return out
}

export const LOGO_ACTIONS = {
  'project.logo': def('read', z.object({ repo: RepoSlug }), async (a, ctx) => {
    const gh = await ctx.deps.github()
    const { branch } = await gh.defaultBranch(a.repo)
    return { repo: a.repo, ...(await storedLogos(ctx, a.repo, branch)).logos }
  }),

  'project.logo_check': def('read', z.object({ repo: RepoSlug, base64: Base64 }), async (a) => ({ repo: a.repo, ...checkLogo(decode(a.base64)) })),

  'project.logo_set': def('admin', z.object({ repo: RepoSlug, light: Logo.nullable().optional(), dark: Logo.nullable().optional() }), async (a, ctx) => {
    if (a.light === undefined && a.dark === undefined) throw new ActionError('give a light or dark logo to set, or null to remove one')
    const set: Partial<Record<LogoVariant, Uint8Array | null>> = {}
    for (const v of LOGO_VARIANTS) {
      const given = a[v]
      if (given === undefined) continue
      if (given === null) { set[v] = null; continue }
      const bytes = decode(given.base64)
      const c = checkLogo(bytes)
      if (!c.ok) throw new ActionError(`The ${v === 'light' ? 'logo' : 'logo for dark backgrounds'} cannot be used. ${c.problems.join(' ')}`)
      set[v] = bytes
    }
    const gh = await ctx.deps.github()
    if (!gh.commitFiles) throw new ActionError('This installation cannot change files through the app.')
    const { branch: base } = await gh.defaultBranch(a.repo)
    const { files: existing } = await storedLogos(ctx, a.repo, base)
    const changes = logoChanges(set, existing)
    if (!changes.length) throw new ActionError('There is no logo to remove.')
    const removing = changes.every((c) => c.content === null)
    const title = removing ? 'Remove the project logo' : 'Set the project logo'
    const branch = `trace/logo-${Date.now().toString(36)}`
    const paths = changes.map((c) => c.path)
    const message = [title, '', ...changes.map((c) => `- ${c.content ? 'write' : 'remove'} ${c.path}`), '', `Changed by ${label(ctx.principal)} through the trace API.`].join('\n')
    const { commit } = await gh.commitFiles(a.repo, { branch, base, message, files: changes })
    const body = [title, '', ...changes.map((c) => `- ${c.content ? 'Writes' : 'Removes'} \`${c.path}\``), '', 'The printed copies of the project\'s documents are made again with it; their text does not change.', '', `Changed through trace by ${await editorName(ctx)}.`].join('\n')
    const edit = await recordEdit(ctx, { repo: a.repo, branch, base, commit, kind: 'logo', title, body, redo: null, paths })
    return { repo: a.repo, change: edit.number, branch, commit, written: changes.filter((c) => c.content).map((c) => c.path), removed: changes.filter((c) => !c.content).map((c) => c.path) }
  }),
}
