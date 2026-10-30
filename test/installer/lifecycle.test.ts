// `tracectl upgrade` (src/installer/lifecycle.ts): a trace run from a git clone (npm link) is updated with git, not
// `npm install -g`, which fails over the link (ENOTDIR renaming it) and would replace the clone with a packed copy.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isClone } from '../../src/installer/lifecycle.js'
import { REPO_ROOT } from '../../src/infra/stack.js'

describe('where trace runs from', () => {
  it('a clone has .git; an npm-installed copy, packed without it, does not', () => {
    const packed = mkdtempSync(join(tmpdir(), 'trace-packed-'))
    try {
      expect(isClone(packed)).toBe(false)
      mkdirSync(join(packed, '.git'))
      expect(isClone(packed)).toBe(true)
    } finally { rmSync(packed, { recursive: true, force: true }) }
    // these tests run from a clone
    expect(isClone(REPO_ROOT)).toBe(true)
  })
})
