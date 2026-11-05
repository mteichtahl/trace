/**
 * The project-database merge knows every area's tables and rules (src/core/project-tables.ts): each module that calls
 * ensureProjectSchema is listed there, so a process that merges the file without loading the area (the harness) still
 * merges that table by its own rule, never as a plain union that keeps an older row.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROJECT_TABLE_MODULES } from '../../src/core/project-tables.js'

const SRC = join(import.meta.dirname, '..', '..', 'src')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('project tables', () => {
  it('lists every module that registers a project table', () => {
    const registering = sources(SRC)
      .filter((p) => /\bensureProjectSchema\(\{/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(SRC, p).split('\\').join('/'))
      .filter((p) => p !== 'core/store.ts') // store's own tables are loaded by anything that opens a database
    expect([...PROJECT_TABLE_MODULES].sort()).toEqual(registering.sort())
  })

})
