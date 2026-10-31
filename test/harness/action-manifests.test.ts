// harness/actions/*/action.yml as GitHub's runner reads them. An unquoted description in a flow mapping
// (`{ description: … (read only, structured output); …, value: … }`) is split at its comma: GitHub's runner refused
// the whole action ("Unexpected value 'structured output); worker-delegate — the worker's'", Failed to load
// mteichtahl/trace/main/harness/actions/run/action.yml), while a lenient parser silently made an extra key of it.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const ROOT = join(import.meta.dirname, '..', '..', 'harness', 'actions')
const KEYS: Record<string, readonly string[]> = { inputs: ['description', 'required', 'default', 'deprecationMessage'], outputs: ['description', 'value'] }

describe('the harness actions\' manifests', () => {
  for (const name of readdirSync(ROOT)) {
    it(`${name}: every input and output is exactly its known keys, with a whole description`, () => {
      const m = parse(readFileSync(join(ROOT, name, 'action.yml'), 'utf8')) as Record<string, Record<string, Record<string, unknown>>>
      for (const section of ['inputs', 'outputs'] as const) {
        for (const [key, v] of Object.entries(m[section] ?? {})) {
          const odd = Object.keys(v).filter((k) => !KEYS[section]!.includes(k))
          expect(odd, `${name} ${section}.${key}: a description split at a comma or colon? quote it`).toEqual([])
          expect(typeof v.description, `${name} ${section}.${key}.description`).toBe('string')
        }
      }
    })
  }
})
