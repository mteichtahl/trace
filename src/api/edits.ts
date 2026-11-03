/**
 * Recording an app edit (docs/stay-in-trace.md "1. App edits", src/core/app-edits.ts): every action that commits a
 * person's change on a branch of trace's own (settings.set, prompts.set for a project, journey.snapshot, projects.create,
 * design.handin, files.edit) calls recordEdit after its commit. It opens the pull request at once (so the app can show
 * the change straight away, without waiting for the harness to open it) and records the edit, which is what lets the
 * app list it, apply it and accept it.
 */
import { isAdmin } from '../core/access.js'
import { type AppEdit, AppEditStore, type EditKind, type RedoSpec, appliesOf } from '../core/app-edits.js'
import { PROJECTS_PREFIX } from '../core/project.js'
import { type Context, label, storeAt } from './action-kit.js'
import { holdLabel, publicName } from './actions-changes.js'

export const editStore = (ctx: Context): AppEditStore => new AppEditStore(storeAt(ctx, PROJECTS_PREFIX))

/** Who the app shows as having made it: their name in the user pool, else their initials (never the email). */
export async function editorName(ctx: Context): Promise<string> {
  return (await publicName(ctx)).replace(/^a person on the project \((.*)\)$/, '$1')
}

/**
 * Open the edit's pull request (or find the one open for its branch) and record the edit. Answers the pull request's
 * number, or null when this installation's GitHub client cannot open one (the harness opens it on the push, and the
 * edit is recorded without a number until applyEdits finds it).
 */
export async function recordEdit(ctx: Context, o: {
  repo: string; branch: string; base: string; commit: string; kind: EditKind; title: string; body?: string; redo: RedoSpec | null
  /** the only files it changes (src/core/app-edits.ts allowedPaths); absent: what its kind writes */
  paths?: string[]
}): Promise<{ number: number | null; applies: AppEdit['applies'] }> {
  const gh = await ctx.deps.github()
  const by = label(ctx.principal)
  const applies = appliesOf(o.kind, isAdmin(ctx.principal))
  const byName = await editorName(ctx)
  let number: number | null = null
  if (gh.openPull) {
    const body = [
      o.body ?? `${o.title}\n\nMade in trace by ${byName}.`,
      '',
      applies === 'auto' ? 'trace applies it once its checks pass.' : 'An admin accepts it in trace.',
    ].join('\n')
    number = (await gh.openPull(o.repo, { head: o.branch, base: o.base, title: o.title, body })).number
    // a review edit waits for an admin: held, so the harness's automerge does not merge it on passing checks alone
    // (a file that is not a protected path, such as CLAUDE.md, would otherwise go in with nobody accepting it)
    if (applies === 'review' && gh.request) {
      const hold = await holdLabel(ctx, o.repo)
      await gh.request('POST', `/repos/${o.repo}/issues/${number}/labels`, { labels: [hold] })
    }
  }
  await editStore(ctx).put({
    repo: o.repo, branch: o.branch, kind: o.kind, title: o.title, by, by_sub: ctx.principal.sub, by_name: byName, applies,
    commit: o.commit, number, at: new Date().toISOString(), redo: o.redo, ...(o.paths?.length ? { paths: o.paths } : {}),
  })
  return { number, applies }
}
