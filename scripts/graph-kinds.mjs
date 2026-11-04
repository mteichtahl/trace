// Write the graph view's kinds from the ontology (src/ontology/graph-kinds.ts) to src/ontology/graph-kinds.gen.ts and
// web/src/lib/graph-kinds.gen.ts. Needs the build (dist/). test/api/graph-vocabulary.test.ts fails while they differ.
//
//   npm run build && node scripts/graph-kinds.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { readVocabulary } = await import(join(root, 'dist/ontology/vocab.js'))
const { graphKinds, renderGraphKinds } = await import(join(root, 'dist/ontology/graph-kinds.js'))
const text = renderGraphKinds(graphKinds(readVocabulary(join(root, 'ontology'))))
for (const out of [join(root, 'src/ontology/graph-kinds.gen.ts'), join(root, 'web/src/lib/graph-kinds.gen.ts')]) {
  writeFileSync(out, text)
  console.log(`wrote ${out}`)
}
