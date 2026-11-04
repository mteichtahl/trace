/**
 * The criteria SHACL shapes back (docs/ontology.md "Gates as SHACL shapes"): one file per criterion,
 * ontology/shapes/<criterion>.ttl. shape.check (src/tools/shape/tools.ts) runs them; the specialists are told which.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ONTOLOGY_DIR } from './vocab.js'

export const SHAPES_DIR = join(ONTOLOGY_DIR, 'shapes')

/** The criteria that have a shape. */
export const shapedCriteria = (dir: string = SHAPES_DIR): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((f) => /^[a-z][a-z.]*\.ttl$/.test(f)).map((f) => f.slice(0, -4)).sort() : []
