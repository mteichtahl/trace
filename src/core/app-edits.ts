/**
 * App edits (docs/stay-in-trace.md "1. App edits"): what a person changed in the app that the API committed on a branch
 * of trace's own (a setting, a project prompt, a release's copy of the record, a repository joining trace, its workflows
 * refreshed, KiCad files handed in). Each is recorded here so the app can show it as a change and trace can apply it
 * without anyone going to GitHub.
 *
 *   where     the central bucket, projects/<slug>/journey/edits/<branch with / as ~>.json: one plain JSON object per
 *             branch. Under the journey's folder, one of PEOPLE_RECORDS (src/infra/project.ts): the API writes it with
 *             conditional puts, and the agents' and workflows' roles read it and are denied writing it, so an agent
 *             cannot make its own branch look like a person's edit
 *   which     a pull request is an edit only while its head commit is the recorded `commit` (editOf in
 *             src/api/changes.ts): anyone who can push may push to a trace/… branch, and a pushed commit makes it no
 *             longer the edit trace made
 *   races     each branch is one person's edit, written by the API only; a lost race leaves the newest put, which is
 *             what the API last knew (a redo's new commit)
 */
import { z } from 'zod'
import { type Backend, Conflict } from './central.js'
import { projectSlug } from './project.js'

export const EDIT_KINDS = ['setting', 'prompt', 'release', 'join', 'workflows', 'handin', 'logo', 'rule'] as const
export type EditKind = (typeof EDIT_KINDS)[number]

/** The folder under a project's own prefix (projects/<slug>/journey/edits): inside the journey's, one of PEOPLE_RECORDS. */
export const EDITS = 'journey/edits'

export const RedoSpec = z.discriminatedUnion('op', [
  z.object({ op: z.literal('setting'), key: z.string(), value: z.unknown().optional(), unset: z.boolean().optional() }),
  // the prompt store's write (src/prompts/store.ts PromptWrite), kept as it was given
  z.object({ op: z.literal('prompt'), write: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal('release'), why: z.string() }),
  // a question answered as a rule for the project, added to .trace/rules.md (src/api/rule-answers.ts RuleAnswer):
  // made again by adding the same entry to the newest rules file, so two rules answered in a row never conflict
  z.object({ op: z.literal('rule'), rule: z.object({
    question: z.string(), asked: z.string(), askedBy: z.string(), rule: z.string(), reason: z.string().nullable(), decidedBy: z.string(), on: z.string(),
  }) }),
])
export type RedoSpec = z.infer<typeof RedoSpec>

export const AppEdit = z.object({
  repo: z.string(),
  branch: z.string(),
  kind: z.enum(EDIT_KINDS),
  /** what it does, in the app's words: "Boards per build: 5 → 10" */
  title: z.string(),
  /** label(principal): the email, for the decisions log */
  by: z.string(),
  /** who made it, matched only, never shown */
  by_sub: z.string(),
  /** their name in the user pool, else their initials: what the app shows */
  by_name: z.string(),
  /** auto: applied once its checks pass; review: an admin who did not make it accepts it */
  applies: z.enum(['auto', 'review']),
  /** the head commit trace wrote */
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  /** its pull request, once opened */
  number: z.number().int().positive().nullable(),
  at: z.string(),
  /** how to make it again on a newer default branch; null: it cannot be */
  redo: RedoSpec.nullable(),
  /** the only files it may change (allowedPaths); absent: what its kind writes */
  paths: z.array(z.string()).optional(),
}).loose()
export type AppEdit = z.infer<typeof AppEdit>

/** The object key of a branch's edit, under the projects prefix. */
export const editKey = (repo: string, branch: string): string => `${projectSlug(repo)}/${EDITS}/${branch.replace(/\//g, '~')}.json`

/** Whether an edit of this kind made by this person applies on its own once its checks pass (decision A). */
export const appliesOf = (kind: EditKind, admin: boolean): AppEdit['applies'] =>
  (admin || kind === 'join' || kind === 'workflows' || kind === 'handin' ? 'auto' : 'review')

/**
 * The only files an edit may change, or null (a repository joining trace, its workflows refreshed: trace's own scaffold,
 * fixed by the recorded commit). A setting, a project prompt and a release copy write the project database only. Checked
 * before an edit is merged or accepted (editStray): a commit someone slipped under trace's own (a push to the branch
 * between trace making it and trace committing on it) changes other files, and is refused.
 */
export function allowedPaths(e: Pick<AppEdit, 'kind' | 'paths'>): string[] | null {
  if (e.paths?.length) return e.paths
  return e.kind === 'join' || e.kind === 'workflows' ? null : ['.trace/project.db']
}

/** The files a pull request changes that its edit may not (none: it is only the edit). */
export function editStray(files: readonly { path: string; previous?: string | null }[], e: Pick<AppEdit, 'kind' | 'paths'>): string[] {
  const ok = allowedPaths(e)
  if (!ok) return []
  return files.flatMap((f) => [f.path, ...(f.previous ? [f.previous] : [])]).filter((p) => !ok.includes(p))
}

/** The app's words for an edit's kind: "a setting change", "a hand-in". */
export const EDIT_WORDS: Readonly<Record<EditKind, string>> = {
  setting: 'a setting change', prompt: 'a prompt change', release: 'a release copy', join: 'joining trace',
  workflows: 'a workflow update', handin: 'a hand-in', logo: 'a logo change', rule: 'a project rule',
}

/** The edits of the projects, in the central bucket's projects prefix (storeAt(ctx, PROJECTS_PREFIX)). */
export class AppEditStore {
  constructor(private readonly store: Backend) {}

  /** Write it (the API writes the central bucket only with conditional puts: If-Match the copy there, else If-None-Match). */
  async put(edit: AppEdit): Promise<void> {
    const e = AppEdit.parse(edit)
    await this.write(editKey(e.repo, e.branch), JSON.stringify(e))
  }

  private async write(key: string, text: string): Promise<void> {
    const body = new TextEncoder().encode(text)
    for (let i = 0; ; i++) {
      const etag = await this.store.head(key)
      try {
        await this.store.put(key, body, etag ? { ifMatch: etag, contentType: 'application/json' } : { ifNoneMatch: true, contentType: 'application/json' })
        return
      } catch (err) {
        // another write landed between the look and the put: each branch is one person's edit, so the newest wins
        if (!(err instanceof Conflict) || i >= 2) throw err
      }
    }
  }

  async get(repo: string, branch: string): Promise<AppEdit | null> {
    const got = await this.store.get(editKey(repo, branch))
    if (!got) return null
    let raw: unknown
    try { raw = JSON.parse(new TextDecoder().decode(got.body)) } catch { return null }
    if (raw && typeof raw === 'object' && 'removed' in raw) return null
    const p = AppEdit.safeParse(raw)
    // a record that does not read is not an edit: it is never applied or accepted
    return p.success && p.data.repo.toLowerCase() === repo.toLowerCase() ? p.data : null
  }

  /** Every edit recorded for the project, oldest first. */
  async list(repo: string): Promise<AppEdit[]> {
    const prefix = `${projectSlug(repo)}/${EDITS}/`
    const keys = (await this.store.list(prefix)).filter((k) => k.endsWith('.json'))
    const out: AppEdit[] = []
    for (const k of keys) {
      const branch = k.slice(k.lastIndexOf('/') + 1, -'.json'.length).replace(/~/g, '/')
      const e = await this.get(repo, branch).catch(() => null)
      if (e) out.push(e)
    }
    return out.sort((a, b) => a.at.localeCompare(b.at))
  }

  /** Mark it done (applied, accepted, discarded, or closed on GitHub): a tombstone, since the stores never delete. */
  async remove(repo: string, branch: string): Promise<void> {
    await this.write(editKey(repo, branch), JSON.stringify({ repo, branch, removed: new Date().toISOString() }))
  }
}
