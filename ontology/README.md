# trace's ontology

The shared vocabulary of trace's records: what a gate, a waiver, a hand-off or a placed order is, and how they link.
[docs/ontology.md](../docs/ontology.md) is the design and [docs/ontology-plan.md](../docs/ontology-plan.md) the
build plan. trace's SQLite tables stay the record; the ontology is how they are read as one graph.

| File | Holds |
| --- | --- |
| `trace-core.ttl` | The design artifact and its versions, the input and output links (Si2's pattern), evidence, and the plain properties many records share |
| `trace-journey.ttl` | The journey record, the agents' facts and the job index: templates, stages, gates, criteria, signatures, waivers, questions, decisions, hand-offs, jobs, orders, boards, and the history tables |
| `trace-board.ttl` | The design record, the verification and run records, bench readings, parts and offers, and the board read from its file: components, pads, nets, layers; each revision's renders and the colours they used |
| `trace-mech.ttl` | The case a board goes in, from its newest build: its parts, material, fasteners, openings, joints, the fit check with each problem it found, the process's rule results, the settings and each part's space |
| `trace-docs.ttl` | The documents each project keeps (docs/scribe.md): document, section, figure, stated value, published copy, logo |
| `trace-si2-align.ttl` | How trace's terms relate to the Si2 EDA ontology's; the only file that names Si2 |
| `si2/terms.txt` | The terms Si2 defines at the pinned commit, which every alignment is checked against |
| `context.jsonld` | The JSON-LD context, written from the ontology by `scripts/ontology-context.mjs` |
| `shapes/<criterion>.ttl` | The SHACL shape behind a gate criterion trace owns, each naming its criterion (`tsh:criterion`) |
| `shapes/records/mech.ttl` | The shapes a sound case record keeps to (case.jsonld as the engine writes it) |
| `shapes/templates/journey-template.ttl` | The shape a project template keeps to, checked when an admin saves it (`templates.save`) |

## Conventions

- One namespace for every module: `https://trace-eda.com/ns/trace#`. The prefixes `tc:`, `tj:`, `tb:` and `tm:` in
  the docs name the module a term is defined in and all stand for it.
- Classes in UpperCamelCase and properties in lowerCamelCase, in words a person who is not an electronics engineer
  would use. Every term has an `rdfs:label` and an `rdfs:comment` in plain words; an acronym only as `skos:altLabel`.
- A class no mapped table stores says where its instances come from (`trace:keptIn`), or that it is worked out when
  read (`trace:derived`).
- Records are named `urn:trace:<installation>:<project>:<kind>:<key>`, from the table's own key.

## How the code uses it

- `src/ontology/vocab.ts` reads these files into one vocabulary.
- `src/ontology/mapping.ts` says which table and column becomes which class and property, for every column of the
  journey record (journey.db), the agents' facts (facts.db), the job index (jobs.db), the project database
  (.trace/project.db) and the parts database.
- `src/ontology/docs.ts` reads the project's documents from their markers when the graph is built (`documents` in the graph's sources).
- `src/ontology/board.ts` reads a board from its .kicad_pcb when the graph is built: nothing about the board is stored.
- `src/ontology/renders.ts` reads each revision's renders (render.showcase runs) when the graph is built.
- `src/ontology/mech.ts` reads the newest case build (mech.build's artifacts in the run record) when the graph is built.
- `src/ontology/graph.ts` builds a project's graph in memory through the mapping, and checks records against the
  ontology.
- `src/ontology/jsonld.ts` gives the JSON-LD context and one record as JSON-LD.
- `src/ontology/derived.ts` adds, for the shapes only, the facts no column stores (a requirement still live, the
  architecture option the design goes ahead with), worked out by the same code the app shows them with.
- Project templates (`src/core/templates.ts`, `src/core/template-store.ts`) are the installation's, seeded from the
  code's catalog (`src/core/journey-catalog.ts`); `src/ontology/template-graph.ts` gives one as a graph for its shape.
  A journey keeps the definition it started from (`journey_template`, mapped to its `JourneyTemplate` node).
- `shape.check` (`src/tools/shape/tools.ts`) runs a criterion's shape over the project's graph with pySHACL on the
  Python bridge (`python/tracebridge/shapes.py`) and records the result as that criterion's check: met with the run as
  evidence, or not met with each finding. A finding's message names the thing and what to do, in plain words.

## Changing it

- A new column or table in a mapped database fails `test/ontology/mapping.test.ts` until the mapping says what it
  becomes, or why it is left out.
- A new shape names a criterion trace owns and speaks in plain words (`test/ontology/shapes.test.ts`); its cases run
  against pySHACL there and in `python/tests/test_shapes.py`.
- A new term needs a label and a comment (`test/ontology/vocabulary.test.ts`), and the JSON-LD context written again:
  `npm run build && node scripts/ontology-context.mjs`.
- Each file's `owl:versionInfo` follows semantic versioning: adding a class or an optional property is a minor change;
  renaming or removing a term is a major one and needs a migration for stored records.
- To move to a newer Si2 commit, clone it and run `node scripts/ontology-si2.mjs <clone>`; the tests name any aligned
  term it dropped.
