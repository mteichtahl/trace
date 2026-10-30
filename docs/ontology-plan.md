# Trace Ontology — Implementation Plan

Status: plan, 30 October 2026; nothing built yet. The design is [ontology.md](ontology.md).

The ontology ships in eight phases, about 35 working days with phases 6 to 8 overlapping (44 one after the other), each phase merged to main with its own exit check. History recording starts in phase 2 so the replay in phase 8 has history to play.

| Phase | Days | Starts after | Working days (overlapping) |
| --- | --- | --- | --- |
| 1 Vocabulary from the code | 2 | — | 0 to 2 |
| 2 Journey, mapping, history | 6 | 1 | 2 to 8 |
| 3 Board and capabilities | 7 | 2 | 8 to 15 |
| 4 Lineage and freshness | 3.5 | 3 | 15 to 18.5 |
| 5 Shapes and templates | 6.5 | 4 | 18.5 to 25 |
| 6 External actions and graph | 3.5 | 5 | 25 to 28.5 |
| 7 Mechanical and fit check | 9 | 5 | 25 to 34 |
| 8 Replay | 6.5 | 6 | 28.5 to 35 |

Days are working days for one engineer with coding agents; one after the other, all eight take 44 days.

Each phase depends on the one above it, except that phases 6 and 7 both start once phase 5 is done and can be split between two people or two agent streams, and phase 8 follows phase 6.

## Scope and assumptions

Rebased on trace's main branch as of 30 October 2026 (pull request 78): the plan now attaches the ontology to what trace has already built instead of adding a parallel store, new gates or new functions. That brings the work to about 44 working days, or about 35 if phases 6 to 8 overlap.

It builds what the [Trace Ontology design doc](ontology.md) now describes, including its new section "Fit with trace as built".

**In scope:** the core, journey, board and mechanical modules and the Si2 alignment; a mapping from trace's SQLite tables to the ontology, checked in CI; lineage and freshness for artifacts; SHACL shapes behind trace-owned criteria; moving templates into installation settings; board facts from KiCad; JLCPCB board and JLC3DP case capability sync; read actions for connected systems; graph view kinds generated from the ontology; the `mech` tools, case script, option pruning and the fit check; append-only history tables and a replay of each project's journey.

**Out of scope:** a second record store, new gates, new per-project AWS resources, a graph database, raw query access for connected systems, and fab houses other than JLCPCB.

**Assumptions**

- **Already built, and reused:** the journey record (`journey.db`, API-written), agents' facts (`facts.db`: questions, criterion checks, hand-offs, stuck), the job index, the design record and run record in each repository, eleven gates with person- and trace-owned criteria, waivers and signing rules, the per-project tools function, the per-project events topic, the external API and MCP endpoint with an allow-list, and the Cytoscape graph view behind `graph.neighbourhood`.
- **Languages:** TypeScript (Node's built-in SQLite) for the mapping, graph, freshness and API work, beside the code it extends; Python in the tools image for SHACL checks, board facts and build123d.
- **AWS footprint:** no new per-project resources, because each project's nested stack is sized to its CloudFormation budget; the only new resources are the capability sync's function and schedule in the parent stack.
- **Images:** build123d (about 850 MB) and pySHACL go in the tools image; the agent image stays under AgentCore's 2 GB limit.
- **Delivery:** one engineer with coding agents; each phase merges to main and installations update themselves. Fixtures come from the sample project (`trace-sample`).

**How to read the task tables:** each task has an ID (`P2.3` = phase 2, task 3), what it produces, an estimate in days and the tasks it depends on. Every phase ends with an exit check that must pass before the next phase starts.

## Repository layout and tooling

Everything lands in the trace repository beside the code it extends: ontology files at the root, the mapping and graph in `src/core`, new tools in their families, and Python for the tools image under `python/`.

```text
ontology/
  trace-core.ttl  trace-journey.ttl  trace-board.ttl  trace-mech.ttl
  trace-si2-align.ttl            # pins the Si2 commit
  context.jsonld                 # for JSON-LD at the edges only
  shapes/                        # one file per backed criterion, plus record and template shapes
src/core/ontology/
  mapping.ts      # table and column -> class and property
  graph.ts        # a project's graph, in memory, from its databases
  lineage.ts      # artifact inputs and freshness, computed on read
  templates.ts    # installation templates, seeded from journey.ts
src/tools/board/  # board.facts (calls python/kicad in the tools function)
src/tools/mech/   # mech.* tools (call python/mech)
src/tools/shape/  # shape.check (calls python/ontology)
src/infra/capsync.ts             # parent stack: capability sync function and schedule
python/kicad/     # existing; gains the board facts reader
python/ontology/  # pySHACL runner
python/mech/      # build123d case builder, fit check, option pruning
templates/case/   # starting case.py per project type
tools/gen-graph-kinds.ts         # ontology -> web/src/lib/graph.ts kinds
```

| Need | Choice | Why |
| --- | --- | --- |
| Ontology files | Turtle, parsed in tests with N3.js (TypeScript) and RDFLib (Python) | Both sides read the same files |
| Project graph in memory | N3.js store, built through `mapping.ts` | No new service; same process as the API |
| Shape checks | pySHACL with SHACL-SPARQL, in the tools function | Python is already in the tools image |
| KiCad reading | kiutils plus `kicad-cli`, both in the tools image | KiCad already moved there |
| Case model | build123d 0.13, pinned, in the tools image | Decided in the enclosure design note; too large for the agent image |
| Graph view kinds | Generated from the ontology into `web/src/lib/graph.ts` | The existing vocabulary test keeps API and web in step |

Tests use the existing runners: vitest for TypeScript and pytest under `python/tests`.

## AWS footprint

The ontology adds no per-project AWS resources: new work runs in each project's existing tools function and the API runtime, and only the capability sync adds a function and a schedule to the parent stack.

**Where each piece runs**

| Work | Runs in | Triggered by | Change to infrastructure |
| --- | --- | --- | --- |
| `board.facts`, `shape.check`, `mech.*` | The project's tools function (tools image) | A specialist's tool call, or the push that already re-runs a project's checks | Tools image gains pySHACL, kiutils and build123d; its job kinds gain these three |
| Project graph, lineage, freshness | The API runtime, on read | People's and connected systems' requests | None |
| `ontology.describe`, `record.get`, `artifact.lineage`, `artifact.stale` | The API, the external runtime and the MCP endpoint | Requests | Four actions in the allow-list, with read scope |
| Template settings | The API | An admin saving a template | None; stored with the installation's settings in the central bucket |
| Capability sync | One function in the parent stack | A daily schedule | Function, role, log group and schedule: four parent resources, well within the parent's budget at 60 projects |

**Events.** None are added. The project's events topic already carries writes of `journey.db`, `jobs.db` and `facts.db`, so a shape's result written to the agents' facts wakes waiting agents and updates the main screen. Freshness is computed on read, as trace computes every journey state. A failed capability sync is logged and shown on the operations screen from the function's metrics.

**Storage.** Capabilities live in the central database under `central/` (shared, conditional writes, as parts and datasheets are). Board facts and case outputs are artifacts of runs in each project's `.trace/project.db`. No new buckets, tables or prefixes.

**Permissions.** The tools function's role already reads and writes only its project's job files, and the external runtime already checks project access per call; nothing is widened.

## Phase 1 — Vocabulary from the code (2 days)

Phase 1 takes every name from what trace already uses, so the ontology describes trace rather than renaming it.

| ID | Task | Produces | Days | Depends on |
| --- | --- | --- | --- | --- |
| P1.1 | List the names in use: journey tables and columns (`src/core/journey.ts`), agents' facts, job index, design record (`src/tools/design/db.ts`), run record (`src/core/store.ts`), gate and criterion ids, stage and template names, specialist kinds, graph node and link kinds | Raw term list with where each is defined | 0.5 | — |
| P1.2 | Match each to a design-doc class or property, and each class to a table; note gaps both ways (classes with no table, tables with no class) | Term-to-table map | 0.75 | P1.1 |
| P1.3 | Write label, comment and alt labels for every term, reusing trace's existing plain words (criterion texts, stage names) | `ontology/terms.csv` | 0.5 | P1.2 |
| P1.4 | Pick the sample project's revision used for fixtures and list which gates and criteria it reaches | Fixture plan | 0.25 | — |

**Exit check:** every class maps to a table or is marked as derived; every table a person or agent writes maps to a class; every label passes the no-acronyms lint.

## Phase 2 — Core and journey modules, the mapping and history (6 days)

Phase 2 makes trace's journey record, agents' facts and job index readable as one graph, with CI catching any drift between the ontology and the tables.

| ID | Task | Produces | Days | Depends on |
| --- | --- | --- | --- | --- |
| P2.1 | Write `trace-core.ttl` and `trace-journey.ttl` using trace's names: journey, stage, gate, criterion, signature, question, waiver, decision, design decision, order, hand-off, job, specialist, skill | Two ontology files | 1 | P1.3 |
| P2.2 | Write `trace-si2-align.ttl` and pin the Si2 commit | Alignment file | 0.25 | P2.1 |
| P2.3 | `mapping.ts` for `journey.db`, `facts.db` and `jobs.db`, including JSON columns (a question's options, a signature's criteria) | Mapping | 1.25 | P2.1 |
| P2.4 | Schema-drift test: every column in `ensureProjectSchema` and the facts and job tables is mapped or listed as ignored, and every mapped column exists | vitest | 0.5 | P2.3 |
| P2.5 | `graph.ts`: build a project's graph in memory from its databases through the mapping, with record shapes run in tests over the sample's records | Graph builder | 1 | P2.3 |
| P2.6 | JSON-LD context and `record.get` serialisation, used only at the edges | `context.jsonld`, serialiser | 0.5 | P2.5 |
| P2.7 | Point `graph.neighbourhood` at `graph.ts` for the journey kinds it already shows, with no change to what the view draws | Refactor, existing tests green | 0.5 | P2.5 |
| P2.8 | History tables `criterion_history`, `stage_history` and `journey_history` in `journey.db`: append-only, union merge, registered with the journey tables; written in the same path as each in-place update in `src/core/journey.ts`; a backfill from the decisions log marked as reconstructed | Three tables, writers, backfill, tests | 1 | P2.3 |

**Exit check:** the sample project's journey, facts and jobs load as a graph that passes every record shape; adding a column to any of those tables without a mapping fails CI; the graph view looks the same as before; signing, returning and reopening on the sample each add exactly one history row, and no history row is ever changed or removed.

## Phase 3 — Board module, board facts and capabilities (7 days)

Phase 3 brings the design record, run record and parts into the graph, adds the board facts trace does not yet record, and keeps JLCPCB's board limits current without anyone typing them in.

| ID | Task | Produces | Days | Depends on |
| --- | --- | --- | --- | --- |
| P3.1 | Write `trace-board.ttl`, aligned with the design record's own terms (intent statements, requirements, architecture options, blocks, connections, pin plan) | Board ontology file | 1 | P2.1 |
| P3.2 | Extend `mapping.ts` to the design record, the run record (runs, measurements, artifacts) and the central parts database (stock, prices) | Mapping, drift test extended | 1.25 | P3.1, P2.4 |
| P3.3 | Board facts reader in `python/kicad`: components, nets, footprints, placements, outline, mounting holes, component heights; skip what existing tools already record | Python module and tests | 1.5 | P3.1 |
| P3.4 | `board.facts` tool: runs in the tools function, stores its output as a run artifact, and is added to what a push already re-runs | Tool and job kind | 0.5 | P3.3 |
| P3.5 | Find JLCPCB's best machine-readable capability source and write the parser into capability and design rule records | Parser, saved source fixtures | 1.5 | P3.1 |
| P3.6 | Capability sync: the parent-stack function and daily schedule, writing to the central database only when something changed; on failure keep the last good version and report it on the operations screen with the last and next run | `src/infra/capsync.ts`, function | 0.75 | P3.5 |
| P3.7 | Fixture: the sample project's records, from intent to order approval, as a test graph | Fixture | 0.5 | P3.2, P3.4 |

**Exit check:** a push to the sample project produces its board facts with no hand edits; the sample's full graph passes every record shape; the capability parser passes on a saved copy of JLCPCB's source and fails safely on a deliberately altered one.

## Phase 4 — Lineage and freshness (3.5 days)

Phase 4 records what each artifact was made from and works out freshness on every read, as trace already does for stage states and the pin plan agreement, so nothing stored can drift.

| ID | Task | Produces | Days | Depends on |
| --- | --- | --- | --- | --- |
| P4.1 | Add inputs and a content hash to the run record: each run and artifact keeps the commit, the artifact ids it was made from, and a hash of its content over a normalised form defined per artifact kind (timestamps and row order removed); a schema change through `ensureProjectSchema`, with its merge rule | Lineage and hash columns, tools filling them, normaliser per kind | 1.25 | P3.2 |
| P4.2 | `lineage.ts`: freshness on read, following inputs to the newest version of each and stopping where a new version's hash equals the one it replaced; returns the cause in plain words, including why the walk stopped | Library and tests | 1 | P4.1 |
| P4.3 | A trace-owned criterion whose evidence is stale reads as not met until its checker runs again; the main screen's next step says why | Journey view change | 0.5 | P4.2 |
| P4.4 | Main screen and artifact views: "Layout is out of date because the schematic changed", linking to the change; on request, why something is still current | Web change | 0.75 | P4.2 |

**Exit check:** on the fixture, a new schematic commit that swaps a part makes the netlist, layout, rule check report, release package and order sheet read as stale and nothing else; a commit that only moves a schematic label regenerates an identical netlist and leaves the layout current, with the reason shown; the layout review's criteria that used stale evidence read as not met until re-checked.

## Phase 5 — Shapes behind criteria, and templates in settings (6.5 days)

Phase 5 backs the first trace-owned criteria with SHACL shapes, leaving gates, signing and waivers exactly as built, and moves the project templates into each installation's settings.

| ID | Task | Produces | Days | Depends on |
| --- | --- | --- | --- | --- |
| P5.1 | `shape.check` tool: pySHACL runner in the tools image, given a criterion's shape and the project graph; returns each finding with its message and focus | Tool and job kind | 1 | P2.5 |
| P5.2 | Shapes for `architect.mapped`, `architect.stock`, `capture.stock`, `signoff.bom` and `fabricate.order.stock` | Five shape files | 1.5 | P5.1, P3.2 |
| P5.3 | Checkers call `shape.check` and write the result to `criterion_checks` with each finding as evidence, so a finding is waivable on its own | Checker changes | 0.75 | P5.2 |
| P5.4 | Broken fixtures, one per rule, each with its expected message and focus | Fixtures | 0.5 | P5.2 |
| P5.5 | Message review: every message names the thing, the problem and the next step in under 25 words, tried on someone who isn't an electronics engineer | Reviewed messages | 0.25 | P5.2 |
| P5.6 | Templates in installation settings: seed from `TEMPLATES` and `GATES`, store with the installation's settings, admin screen to edit, `tsh:JourneyTemplateShape` on save, each journey keeps the template version it started from | `templates.ts`, admin screen | 2 | P2.1 |
| P5.7 | Gate view: findings listed under their criterion with fix and waive actions | Web change | 0.5 | P5.3 |

**Exit check:** each broken fixture fails its criterion with exactly its expected message; a matching waiver lets the criterion be signed, a non-matching one does not; an admin can change a template and a broken one is refused on save; existing journeys keep their template.

## Phase 6 — External actions and graph kinds (3.5 days)

Phase 6 lets connected systems read the ontology's answers through the external API and MCP endpoint that already exist, and makes the existing graph view show board, gate and case items.

| ID | Task | Produces | Days | Depends on |
| --- | --- | --- | --- | --- |
| P6.1 | Actions `ontology.describe`, `record.get`, `artifact.lineage` and `artifact.stale` in the API, added to `SERVICE_ACTIONS` with read scope; the MCP endpoint exposes them as `trace_<action>` without further work | Four actions, allow-list tests | 1.25 | P2.6, P4.2 |
| P6.2 | Update `docs/external-access.md` and the README's "Connecting other systems" | Docs | 0.25 | P6.1 |
| P6.3 | Generate the graph view's node and link kinds from the ontology; keep `test/api/graph-vocabulary.test.ts` as the check | Generator, regenerated kinds | 0.75 | P3.1 |
| P6.4 | `graph.neighbourhood` adds component, net, artifact, gate, criterion, waiver and case items, with stale and failing status from lineage and shapes | API change | 1 | P6.3, P4.2 |
| P6.5 | Graph view: colours and filters for the new kinds; the focus, distance and failing-chain rules stay as built | Web change | 0.25 | P6.4 |

**Exit check:** an MCP client calls `trace_artifact_stale` and `trace_journey_status` on the sample project and gets correct answers; a system without access to a project gets nothing from it through any action; the graph view, opened from a failing criterion, shows the chain back to the requirement.

## Phase 7 — Mechanical module and the fit check (9 days)

Phase 7 builds the enclosure work the enclosure design note decided: a build123d case script in each project's repository, option pruning from the assembly ontology, and the shape behind the layout review's existing fit criterion.

| ID | Task | Produces | Days | Depends on |
| --- | --- | --- | --- | --- |
| P7.1 | Write `trace-mech.ttl`: interface, regions, joints, assembly, options, case edits; map them to the case script's records and the run record | Mechanical ontology file, mapping | 1 | P3.1 |
| P7.2 | build123d 0.13 in the tools image (not the agent image); measure image size and cold start | Image change | 0.5 | — |
| P7.3 | `mech` tool family and a starting `mechanical/case.py` per project type (printed two-part shell, extruded box, DIN rail); the implementation specialist gets the tools | Tools, case templates | 1 | P7.2 |
| P7.4 | Board into case: the populated board from `kicad-cli pcb export step`, plus outline, holes, edge connectors and tallest parts from board facts; clearance defaults (0.5 mm to wall, 1.0 mm above parts), overridable per project and per part with the reason recorded as a design decision | Interface draft, clearance settings | 1 | P7.3, P3.4 |
| P7.5 | Option generation and qualitative pruning: split line, mounting, closure and connector faces; feasibility rules on regions and relations only; pruned options kept with their rule | `python/mech` options | 1.5 | P7.1, P7.4 |
| P7.6 | Surviving options asked as a question with options recommended first and why, using the existing `questions` record | Question | 0.5 | P7.5 |
| P7.7 | Fit check and the `layout.fit` shape: clashes and gaps named by part, both clearances, standoffs, openings, size; each finding waivable; case renders join the board renders for approval | Shape, checker, renders | 1 | P5.1, P7.4 |
| P7.8 | Three ways to change a case, all ending in the script: a pushed edit is rebuilt and checked; a chat change shows a render and the diff before committing; a handed-in `case.py` is used as is and a STEP is imported as the case body, with a question when a later board change leaves it behind | Change routes | 1 | P7.7 |
| P7.9 | JLC3DP capabilities: find the source (none published that has been found), parse per-process rules (walls, holes, bosses; tool reach and corner radius for machining) into the capability sync | Sync extension | 1 | P3.6 |
| P7.10 | Fixture: the sample project with a case, including a clashing variant | Fixture | 0.5 | P7.7 |

**Exit check:** on the sample board Trace offers at least two feasible case options with reasons and shows why others were dropped; the chosen case is rebuilt on a board push and the fit check names any clash by part; `layout.fit` is met on the good fixture and not met on the clashing one; a chat change survives the next rebuild; the case's STL opens in a slicer without errors.

## Phase 8 — Replay (6.5 days)

Phase 8 plays any project back as an animation of its graph, from intent to its latest gate, using the event stream that phase 2's history tables complete.

| ID | Task | Produces | Days | Depends on |
| --- | --- | --- | --- | --- |
| P8.1 | `journey.events`: merge the decisions log, history tables, design decisions, questions, waivers, signatures, criterion checks, hand-offs, jobs, runs and commits in time order, each typed by the ontology and linked to its nodes | Event stream and tests | 1.5 | P2.8, P4.2 |
| P8.2 | "As of" for `graph.ts` and `lineage.ts`: use only records that existed at a given time | As-of graph and freshness | 1 | P8.1 |
| P8.3 | Player in the graph view: play, pause, speed, scrubber, stage chips, captions naming who did what and from which record, chapters by stage, filters by person or specialist, click through to the record | Web screen | 2 | P8.2, P6.5 |
| P8.4 | `journey.replay` action, paged, with the person's project access; read-only, so it can join the external allow-list later if wanted | API action | 0.5 | P8.1 |
| P8.5 | Video export: render frames headless and encode with ffmpeg as a CPU job, stored as a run artifact | MP4 export | 1 | P8.3 |
| P8.6 | Replay test: on the sample project, the graph at each signature's time matches what that signature recorded | Fixture test | 0.5 | P8.2 |

**Exit check:** the sample project replays from intent to its latest gate with every stage start, signature, reopening and waiver in order; scrubbing to any signature shows exactly the criteria and evidence it recorded; a two-minute MP4 of the replay exports and plays.

## Testing, CI and release

Every pull request runs the suite in trace's existing CI on CodeBuild (Ubuntu 24.04), and a phase ships by merging to main, which updates installations automatically.

**Checks added to CI**

1. **Ontology lint:** Turtle parses; every term has a label and comment; labels pass the no-acronyms lint; aligned Si2 terms exist in the pinned commit.
2. **Schema drift:** every column trace creates is mapped or listed as ignored, and every mapped column exists.
3. **Fixtures:** the sample's graph passes every record shape; each broken fixture fails its criterion with its expected message; waivers behave; the staleness test marks exactly the expected set.
4. **Graph vocabulary:** the generated kinds match what the API answers (the existing test).
5. **Allow-list:** the new actions are read-only, need read scope and refuse projects the system cannot reach.
6. **Images:** the tools image builds with pySHACL, kiutils and build123d; the agent image stays under 2 GB (the existing runtime-mode start check covers the rest).

**Release and migration**

- Installations, tracectl and onboarded projects' workflows follow the main branch; there are no release tags.
- Schema changes (the lineage columns in P4.1) go through `ensureProjectSchema` with merge rules, so older project databases upgrade in place and a release copy keeps working.
- Nothing here re-runs the installer or adds an installer input.

## Risks and decisions during the build

**Risks**

| Risk | Phase | Effect | Mitigation |
| --- | --- | --- | --- |
| Neither JLCPCB nor JLC3DP has a machine-readable capabilities source | 3, 7 | Sync breaks on page changes | Parse defensively, keep the last good version, report failures; altered-source test in CI |
| The tools image grows past what a Lambda cold start tolerates with build123d added | 7 | Slow fit checks | Measure in P7.2; run large rebuilds as CPU Batch jobs, which already exist per project |
| Mapping JSON columns (options, evidence, signatures) loses detail | 2 | Shapes see less than people do | Map the JSON fields explicitly; drift test covers them |
| Shapes slow on large boards | 5, 7 | Sluggish checks | Measure on the fixture; move hot rules into precomputed board facts |
| Two vocabularies drift (graph kinds, criterion ids, ontology) | 2, 6 | Screens and records disagree | Generate graph kinds; drift and vocabulary tests in CI |
| Template editing lets an admin remove a gate a journey relies on | 5 | Broken journeys | Journeys keep their starting template version; the template shape refuses gates without criteria |

**Decisions to make during the build** (each with a default if nobody decides)

| Decision | When | Default |
| --- | --- | --- |
| Whether board facts become their own table or stay run artifacts | P3.4 | Run artifacts, like every other tool's output |
| Capability sync frequency | P3.6 | Daily |
| Which criteria get shapes after the first six | After P5 | Every trace-owned criterion whose checker is a rule over records rather than a program's report |
| Whether a separate mechanical specialist is needed | After P7 | No: the implementation specialist keeps the `mech` tools until case work grows |

Already decided: SQLite stays the store of record with JSON-LD only at the edges; build123d in the tools image; JLC3DP for cases, sharing a cart with boards; clearance defaults of 0.5 mm and 1.0 mm, overridable per project and per part with a reason; three ways to change a case, all ending in the script; templates in installation settings; everything follows main.
