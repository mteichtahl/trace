// Refresh ontology/si2/terms.txt: the terms the Si2 EDA ontology defines, which test/ontology/vocabulary.test.ts checks
// every alignment in ontology/trace-si2-align.ttl against. trace never imports the Si2 file (docs/ontology.md
// "Alignment with Si2"), so this list is all it keeps of it, pinned to one commit.
//
//   git clone https://github.com/si2org/aiml_schema_ontology /tmp/si2
//   node scripts/ontology-si2.mjs /tmp/si2
//
// Then run the tests: an aligned term the new commit dropped fails them, naming it.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Parser } from 'n3'

const clone = process.argv[2]
if (!clone) { console.error('usage: node scripts/ontology-si2.mjs <path to a clone of si2org/aiml_schema_ontology>'); process.exit(2) }
const EDA = 'http://example.org/eda#'
const commit = execFileSync('git', ['-C', clone, 'log', '-1', '--format=%H %cs'], { encoding: 'utf8' }).trim().split(' ')
const quads = new Parser().parse(readFileSync(join(clone, 'ontology', 'eda_ontology.ttl'), 'utf8'))
const terms = [...new Set(quads.filter((q) => q.subject.termType === 'NamedNode' && q.subject.value.startsWith(EDA)).map((q) => q.subject.value.slice(EDA.length)))].sort()
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'ontology', 'si2', 'terms.txt')
writeFileSync(out, [
  `# Every term the Si2 EDA ontology defines (ontology/eda_ontology.ttl, namespace ${EDA}) at the commit`,
  `# trace-si2-align.ttl was written against: si2org/aiml_schema_ontology ${commit[0]}`,
  `# (${commit[1]}, Apache-2.0). Refresh with: node scripts/ontology-si2.mjs <path to a clone at the new commit>`,
  ...terms, '',
].join('\n'))
console.log(`${terms.length} terms at ${commit[0].slice(0, 7)} -> ${out}`)
