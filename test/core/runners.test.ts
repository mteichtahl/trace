/**
 * Every build and automation job runs on AWS: trace's own CI, the workflows `trace onboard` writes and the starter
 * builds all name an AWS CodeBuild-hosted runner, never a GitHub-hosted one, and nothing falls back to one.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'
import { RUNNER_VARIABLE, SELF_CI_PROJECT } from '../../src/core/project.js'

const root = join(import.meta.dirname, '..', '..')
const RUN = '${{ github.run_id }}-${{ github.run_attempt }}'
const dirs = ['.github/workflows', 'templates/workflows', 'templates/build']
const files = dirs.flatMap((d) => readdirSync(join(root, d)).filter((f) => /\.ya?ml$/.test(f)).map((f) => `${d}/${f}`))
const Workflow = z.object({ jobs: z.record(z.string(), z.object({ 'runs-on': z.unknown() }).loose()) }).loose()

describe('runners', () => {
  it('finds the workflows', () => {
    expect(files).toContain('.github/workflows/ci.yml')
    expect(files.filter((f) => f.startsWith('templates/workflows/')).length).toBeGreaterThanOrEqual(4)
    expect(files.filter((f) => f.startsWith('templates/build/')).length).toBeGreaterThanOrEqual(4)
  })

  for (const file of files) {
    it(`${file}: every job runs on an AWS CodeBuild runner`, () => {
      const text = readFileSync(join(root, file), 'utf8')
      expect(text).not.toContain('TRACE_RUNNER')
      expect(text).not.toMatch(/ubuntu-(latest|\d)|windows-|macos-|self-hosted/)
      const wf = Workflow.parse(parse(text))
      const project = file.startsWith('.github/') ? SELF_CI_PROJECT : `\${{ vars.${RUNNER_VARIABLE} }}`
      const seen = new Set<string>()
      for (const [id, job] of Object.entries(wf.jobs)) {
        const labels = z.array(z.string()).min(2).parse(job['runs-on'])
        const [first, unique] = labels
        expect(first, `${file} job ${id}`).toMatch(/^codebuild-/)
        expect(first, `${file} job ${id}`).toContain(RUN)
        expect(first, `${file} job ${id}`).toBe(`codebuild-${project}-${RUN}`)
        // the second label keeps the job's runner apart from the run's other jobs
        expect(unique, `${file} job ${id}`).toMatch(new RegExp(`^${id}(-|$)`))
        expect(seen.has(unique ?? ''), `${file} job ${id}: label ${unique} is used twice`).toBe(false)
        seen.add(unique ?? '')
      }
    })
  }
})
