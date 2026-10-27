/** Which GitHub repository the running trace came from (src/installer/source.ts): what the installer builds on AWS as
 * trace's own repository. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { githubRepository, traceRepository } from '../../src/installer/source.js'

const root = join(import.meta.dirname, '..', '..')

describe("trace's own repository", () => {
  it('reads OWNER/REPO from the ways a GitHub repository is written, and nothing else', () => {
    for (const t of ['github:mteichtahl/trace', 'mteichtahl/trace', 'https://github.com/mteichtahl/trace', 'https://github.com/mteichtahl/trace.git',
      'git+https://github.com/mteichtahl/trace.git', 'git@github.com:mteichtahl/trace.git', 'ssh://git@github.com/mteichtahl/trace', 'github:mteichtahl/trace#v1', 'https://x-access-token:abc@github.com/mteichtahl/trace']) {
      expect(githubRepository(t), t).toBe('mteichtahl/trace')
    }
    for (const t of ['gitlab:o/r', 'https://gitlab.com/o/r', 'bitbucket:o/r', 'file:../trace', 'trace', 'o/r/x', 'a/..', '']) expect(githubRepository(t), t).toBeNull()
  })

  it('takes TRACE_SOURCE first, then the checkout\'s origin, then package.json\'s repository field', () => {
    const pkg = () => JSON.stringify({ repository: 'github:mteichtahl/trace' })
    expect(traceRepository({ root, env: { TRACE_SOURCE: 'fork/trace' }, origin: () => 'https://github.com/other/trace.git', packageJson: pkg })).toBe('fork/trace')
    expect(traceRepository({ root, env: {}, origin: () => 'git@github.com:other/trace.git', packageJson: pkg })).toBe('other/trace')
    // an installed copy (npm install -g github:…) has no .git: its package.json says where it came from
    expect(traceRepository({ root, env: {}, origin: () => null, packageJson: pkg })).toBe('mteichtahl/trace')
    expect(traceRepository({ root, env: {}, origin: () => null, packageJson: () => JSON.stringify({ repository: { type: 'git', url: 'git+https://github.com/x/y.git' } }) })).toBe('x/y')
    // an origin that is not GitHub's is passed over
    expect(traceRepository({ root, env: {}, origin: () => 'https://gitlab.com/o/r.git', packageJson: pkg })).toBe('mteichtahl/trace')
    expect(traceRepository({ root, env: {}, origin: () => null, packageJson: () => '{}' })).toBeNull()
    expect(traceRepository({ root, env: {}, origin: () => null, packageJson: () => null })).toBeNull()
    expect(traceRepository({ root, env: {}, origin: () => null, packageJson: () => 'not json' })).toBeNull()
  })

  it("is in trace's own package.json, so an installed copy knows it", () => {
    expect((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { repository?: string }).repository).toBe('github:mteichtahl/trace')
  })
})
