// Write ontology/context.jsonld from the ontology (src/ontology/jsonld.ts jsonLdContext). Needs the build (dist/).
// test/ontology/vocabulary.test.ts fails while the committed file differs from what this writes.
//
//   npm run build && node scripts/ontology-context.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { readVocabulary } = await import(join(root, 'dist/ontology/vocab.js'))
const { jsonLdContext } = await import(join(root, 'dist/ontology/jsonld.js'))
const out = join(root, 'ontology', 'context.jsonld')
writeFileSync(out, `${JSON.stringify(jsonLdContext(readVocabulary(join(root, 'ontology'))), null, 2)}\n`)
console.log(`wrote ${out}`)
