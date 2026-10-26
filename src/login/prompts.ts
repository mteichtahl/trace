/**
 * `trace remote prompts …`: the prompt commands (src/prompts/cli.ts) through the API's prompts.* actions, signed in.
 *
 *   trace remote prompts list [--repo OWNER/REPO]                       with --repo: that project's overrides too
 *   trace remote prompts get ID [--repo OWNER/REPO]
 *   trace remote prompts set ID --reason "why" [--file F] (--repo OWNER/REPO | --installation)
 *   trace remote prompts reset|revert|history|diff ID … (--repo OWNER/REPO | --installation)
 *   trace remote prompts preview TARGET --repo OWNER/REPO [--marked] [--request "…"]
 *
 * A project change is a commit on a trace/prompts-<slug>-<ts> branch whose pull request waits for a person; an
 * installation change (admins) applies to jobs that start from then on.
 */
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { type PromptBackend, runPrompts } from '../prompts/cli.js'
import { invokeApi } from './invoke.js'

const Repo = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'expected OWNER/REPO')

export const REMOTE_PROMPTS_USAGE = 'usage: trace remote prompts list | get ID | set ID --reason "why" [--file F] | reset ID | revert ID VERSION | history ID | diff ID [FROM [TO]] | preview TARGET [--marked]  (--repo OWNER/REPO for a project, --installation for the installation\'s overrides)'

/** `invoke`: the API call (invokeApi; a stand-in in tests). */
export function remoteBackend(repo: string | undefined, invoke: (action: string, args: Record<string, unknown>) => Promise<unknown> = invokeApi): PromptBackend {
  const withRepo = (o: Record<string, unknown>): Record<string, unknown> => (repo ? { ...o, repo } : o)
  const needRepo = (what: string): string => {
    if (!repo) throw new z.ZodError([{ code: 'custom', path: ['repo'], message: `${what} needs --repo OWNER/REPO (or --installation)`, input: undefined }])
    return repo
  }
  return {
    list: () => invoke('prompts.list', withRepo({})),
    get: (id) => invoke('prompts.get', withRepo({ id })),
    write: (scope, w) => {
      const base = { id: w.id, scope, ...(scope === 'project' ? { repo: needRepo(w.op) } : {}) }
      switch (w.op) {
        case 'set': return invoke('prompts.set', { ...base, text: w.text, reason: w.reason })
        case 'reset': return invoke('prompts.reset', { ...base, reason: w.reason })
        case 'revert': return invoke('prompts.revert', { ...base, version: /^\d+$/.test(String(w.to)) ? Number(w.to) : String(w.to), ...(w.reason ? { reason: w.reason } : {}) })
      }
    },
    history: (scope, id) => invoke('prompts.history', { id, scope, ...(scope === 'project' ? { repo: needRepo('history') } : {}) }),
    preview: (target, request) => invoke('prompts.preview', { repo: needRepo('preview'), target, ...(request ? { job: { kind: 'task', request } } : {}) }),
  }
}

export async function remotePrompts(argv: string[], invoke?: (action: string, args: Record<string, unknown>) => Promise<unknown>): Promise<number> {
  const { values } = parseArgs({ args: argv.slice(1), allowPositionals: true, strict: false, options: { repo: { type: 'string' } } })
  const repo = typeof values.repo === 'string' ? Repo.parse(values.repo) : undefined
  return runPrompts(argv, remoteBackend(repo, invoke), REMOTE_PROMPTS_USAGE)
}
