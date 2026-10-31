/**
 * Where every job runs: trace's own CI, the workflows `tracectl onboard` writes and the starter builds all name the
 * repository's AWS CodeBuild runner when the repository variable TRACE_CODEBUILD_PROJECT is set (the installer sets it
 * only once that runner exists), and GitHub's ubuntu-24.04 runner, the one fallback, until then. No other runner.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'
import { GITHUB_HOSTED_FALLBACK, RUNNER_VARIABLE } from '../../src/core/project.js'

const root = join(import.meta.dirname, '..', '..')
const dirs = ['.github/workflows', 'templates/workflows', 'templates/build']
const files = dirs.flatMap((d) => readdirSync(join(root, d)).filter((f) => /\.ya?ml$/.test(f)).map((f) => `${d}/${f}`))
const Workflow = z.object({ jobs: z.record(z.string(), z.object({ 'runs-on': z.unknown() }).loose()) }).loose()

/** The one runs-on a job may have: the CodeBuild labels when the variable is set, else the GitHub-hosted fallback.
 * `label` is the job's own label inside the format string; `extra` the format arguments after the run attempt; `size`
 * an instance-size override (a heavier job asking CodeBuild for a bigger machine; ignored on the fallback); `image` an
 * image override (a job that must run on another architecture, such as arm64 image builds; ignored on the fallback). */
const expected = (label: string, extra: string[] = [], size = '', image = ''): string =>
  `\${{ vars.${RUNNER_VARIABLE} && fromJSON(format('["codebuild-{0}-{1}-{2}",${image ? `"image:${image}",` : ''}${size ? `"instance-size:${size}",` : ''}"${label}"]', ${['vars.' + RUNNER_VARIABLE, 'github.run_id', 'github.run_attempt', ...extra].join(', ')})) || '${GITHUB_HOSTED_FALLBACK}' }}`

/** Parse a job's runs-on into its parts, or null when it is not the pattern. */
const PATTERN = new RegExp(
  '^\\$\\{\\{ vars\\.' + RUNNER_VARIABLE + " && fromJSON\\(format\\('\\[\"codebuild-\\{0\\}-\\{1\\}-\\{2\\}\",(?:\"image:(arm-3\\.0)\",)?(?:\"instance-size:(small|medium|large|xlarge|2xlarge)\",)?\"([a-z0-9-]+(?:\\{3\\})?)\"\\]', "
  + 'vars\\.' + RUNNER_VARIABLE + ', github\\.run_id, github\\.run_attempt((?:, [a-z_.]+)?)\\)\\) \\|\\| \'' + GITHUB_HOSTED_FALLBACK.replace(/\./g, '\\.') + "' \\}\\}$",
)

/** What GitHub makes of the expression (format, fromJSON, && and ||), for one value of the variable. */
function evaluate(runsOn: string, vars: Record<string, string>, ctx: { run_id: string; run_attempt: string; extra?: string }): unknown {
  const m = PATTERN.exec(runsOn)
  if (!m) throw new Error(`not the pattern: ${runsOn}`)
  const project = vars[RUNNER_VARIABLE] ?? ''
  if (!project) return GITHUB_HOSTED_FALLBACK
  const args = [project, ctx.run_id, ctx.run_attempt, ctx.extra ?? '']
  const text = `["codebuild-{0}-{1}-{2}",${m[1] ? `"image:${m[1]}",` : ''}${m[2] ? `"instance-size:${m[2]}",` : ''}"${m[3] ?? ''}"]`.replace(/\{(\d)\}/g, (_, i: string) => args[Number(i)] ?? '')
  return JSON.parse(text) as unknown
}

describe('runners', () => {
  it('finds the workflows', () => {
    expect(files).toContain('.github/workflows/ci.yml')
    expect(files.filter((f) => f.startsWith('templates/workflows/')).length).toBeGreaterThanOrEqual(4)
    expect(files.filter((f) => f.startsWith('templates/build/')).length).toBeGreaterThanOrEqual(4)
  })

  it('evaluates to the CodeBuild labels with the variable, and to ubuntu-24.04 without it', () => {
    const plain = expected('check')
    expect(evaluate(plain, { [RUNNER_VARIABLE]: 'trace-ci-0123abcd' }, { run_id: '42', run_attempt: '1' })).toEqual(['codebuild-trace-ci-0123abcd-42-1', 'check'])
    expect(evaluate(plain, {}, { run_id: '42', run_attempt: '1' })).toBe('ubuntu-24.04')
    expect(evaluate(plain, { [RUNNER_VARIABLE]: '' }, { run_id: '42', run_attempt: '1' })).toBe('ubuntu-24.04')
    const matrix = expected('work-{3}', ['matrix.item.number'])
    expect(evaluate(matrix, { [RUNNER_VARIABLE]: 'lab-ci-0123abcd' }, { run_id: '7', run_attempt: '2', extra: '19' })).toEqual(['codebuild-lab-ci-0123abcd-7-2', 'work-19'])
    const sized = expected('typescript', [], 'xlarge')
    expect(evaluate(sized, { [RUNNER_VARIABLE]: 'trace-ci-0123abcd' }, { run_id: '42', run_attempt: '1' })).toEqual(['codebuild-trace-ci-0123abcd-42-1', 'instance-size:xlarge', 'typescript'])
    expect(evaluate(sized, {}, { run_id: '42', run_attempt: '1' })).toBe('ubuntu-24.04')
    const arm = expected('publish-arm64', [], '', 'arm-3.0')
    expect(evaluate(arm, { [RUNNER_VARIABLE]: 'trace-ci-0123abcd' }, { run_id: '42', run_attempt: '1' })).toEqual(['codebuild-trace-ci-0123abcd-42-1', 'image:arm-3.0', 'publish-arm64'])
    expect(evaluate(arm, {}, { run_id: '42', run_attempt: '1' })).toBe('ubuntu-24.04')
  })

  for (const file of files) {
    it(`${file}: every job runs on the AWS CodeBuild runner when it exists, else on ubuntu-24.04 alone`, () => {
      const text = readFileSync(join(root, file), 'utf8')
      expect(text).not.toContain('TRACE_RUNNER')
      // no other runner: no other GitHub-hosted image, no self-hosted runner, no codebuild label outside the pattern
      const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
      const withoutFallback = code.split(`'${GITHUB_HOSTED_FALLBACK}'`).join('')
      expect(withoutFallback).not.toMatch(/ubuntu-(latest|\d)|windows-|macos-|self-hosted/)
      const wf = Workflow.parse(parse(text))
      const seen = new Set<string>()
      for (const [id, job] of Object.entries(wf.jobs)) {
        const runsOn = z.string().parse(job['runs-on'])
        const m = PATTERN.exec(runsOn)
        expect(m, `${file} job ${id}: ${runsOn}`).not.toBeNull()
        const image = m?.[1] ?? ''
        const size = m?.[2] ?? ''
        const label = m?.[3] ?? ''
        const extra = (m?.[4] ?? '').replace(/^, /, '')
        expect(runsOn, `${file} job ${id}`).toBe(expected(label, extra ? [extra] : [], size, image))
        // the job's own label keeps its runner apart from the run's other jobs; a matrix job's carries its item
        expect(label, `${file} job ${id}`).toMatch(new RegExp(`^${id}(-\\{3\\})?$`))
        if (label.endsWith('{3}')) expect(extra, `${file} job ${id}`).toMatch(/^matrix\./)
        else expect(extra, `${file} job ${id}`).toBe('')
        expect(seen.has(label), `${file} job ${id}: label ${label} is used twice`).toBe(false)
        seen.add(label)
      }
    })
  }
})
