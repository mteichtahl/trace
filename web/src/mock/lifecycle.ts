/**
 * Mock answers for pausing and retiring projects (src/api/actions-lifecycle.ts): project.lifecycle, project.pause,
 * project.resume, project.retire, project.restore and projects.retired, kept in memory for the session. One project
 * starts paused and one retired so the banner, the badges and Admin › Retired projects all have something to show.
 * `withLifecycle` gives the `projects` answer its paused marks and leaves out the retired. projects.repo_check answers
 * from the same: a retired project keeps its repository, so New project names it (test-esp32 log #78); acme/bench-rig
 * stands for a repository on GitHub that no project knows. Registered in handlers.ts.
 */
import type { LifecycleMark, ProjectRef } from '@/lib/types'
import { ME, PROJECTS } from './fixtures'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown) => json({ ok: true, result })
const refuse = (error: string) => json({ ok: false, error })

const now = () => Date.now() / 1000
const state = new Map<string, { paused: LifecycleMark | null; retired: LifecycleMark | null }>([
  ['acme/panel-controller', { paused: { at: now() - 2 * 3600, by: 'ana@example.com', reason: 'Waiting on the enclosure supplier' }, retired: null }],
  ['acme/probe-v1', { paused: null, retired: { at: now() - 9 * 86400, by: 'marc@example.com', reason: 'Replaced by the soil sensor' } }],
])
const NAMES: Record<string, string> = { 'acme/probe-v1': 'Probe v1' }
/** On GitHub, though no project uses it. */
const GITHUB_ONLY = ['acme/bench-rig']
const onGitHub = (repo: string) => [...PROJECTS.map((p) => p.repo), ...state.keys(), ...GITHUB_ONLY].some((r) => r.toLowerCase() === repo.toLowerCase())

function repoCheck(repo: string) {
  const key = repo.toLowerCase()
  const life = state.get(key)
  const known = PROJECTS.some((p) => p.repo.toLowerCase() === key) || !!life
  const project = known ? { name: NAMES[key] ?? null, retired: !!life?.retired } : null
  const exists = onGitHub(repo)
  const [owner, name] = repo.split('/') as [string, string]
  const suggestion = exists ? [2, 3, 4, 5].map((n) => `${owner}/${name.replace(/-\d+$/, '')}-${n}`).find((r) => !onGitHub(r)) ?? null : null
  const whose = project ? `${repo} already exists: it holds the ${project.retired ? 'retired ' : ''}project ${project.name ?? name}.` : `${repo} already exists on GitHub.`
  return { repo, exists, project, suggestion, text: exists ? `${whose}${suggestion ? ` ${suggestion} is free.` : ''}` : null }
}

const of = (repo: string) => state.get(repo) ?? { paused: null, retired: null }

export function withLifecycle(projects: ProjectRef[]): ProjectRef[] {
  return projects.filter((p) => !of(p.repo).retired).map((p) => (of(p.repo).paused ? { ...p, paused: of(p.repo).paused } : p))
}

export function lifecycleAction(name: string, a: Record<string, unknown>): Response | undefined {
  const repo = String(a.repo ?? '')
  const reason = typeof a.reason === 'string' && a.reason.trim() ? a.reason.trim() : null
  const mark = (): LifecycleMark => ({ at: now(), by: ME.email, reason })
  const answer = (summary: string) => ok({ repo, ...of(repo), summary })
  switch (name) {
    case 'project.lifecycle': return ok({ repo, ...of(repo), history: [] })
    case 'project.pause':
      if (of(repo).paused) return refuse(`It is already paused (by ${of(repo).paused!.by}).`)
      state.set(repo, { ...of(repo), paused: mark() })
      return answer('Paused. The running task was asked to pause at its next safe point.')
    case 'project.resume':
      if (!of(repo).paused) return refuse('It is not paused.')
      state.set(repo, { ...of(repo), paused: null })
      return answer('Resumed: queued work starts at its turn. Paused tasks stay paused until someone resumes each one.')
    case 'project.retire':
      if (of(repo).retired) return refuse('It is already retired.')
      state.set(repo, { ...of(repo), retired: mark() })
      return answer('Retired: it is hidden from everyone, and kept, so an admin can restore it. Nothing was running.')
    case 'project.restore':
      if (!of(repo).retired) return refuse('It is not retired.')
      state.set(repo, { ...of(repo), retired: null })
      return answer(of(repo).paused ? `Restored. It is still paused (by ${of(repo).paused!.by}): resume it when it should carry on.` : 'Restored: it is back in everyone\'s lists, as it was.')
    case 'projects.repo_check':
      return ok(repoCheck(repo))
    case 'projects.retired':
      return ok({
        projects: [...state.entries()].flatMap(([r, l]) => (l.retired ? [{ repo: r, name: NAMES[r] ?? null, icon: null, description: null, retired: l.retired, paused: l.paused }] : []))
          .sort((x, y) => y.retired.at - x.retired.at),
      })
  }
  return undefined
}
