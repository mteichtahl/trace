# Scribe: each project's documents, always current

Proposal approved 4 November 2026: Marc went with the design below. The build contract is at the end; where it and
the proposal disagree, the contract wins.

## What it is

Scribe is a specialist that keeps four documents for every **project** (not for trace itself) in step with the work:

| Document | File in the project repository | When it exists |
|---|---|---|
| High level design | `docs/design/high-level-design.md` | from Architect |
| Low level design | `docs/design/low-level-design.md` | from Capture |
| Protocol specification | `docs/design/protocol-specification.md` | only once the design has an interface to describe (I2C, SPI, UART, CAN, 1-Wire, I2S, or a message format of its own); otherwise the reason is recorded |
| User guide | `docs/design/user-guide.md` | from Layout, complete before Fabricate |

Markdown in the repository is the source of truth. Each document is rendered to a branded PDF with the project's logo.

## What goes in them

Everything is generated from trace's own records, and every figure and value says where it came from.

- **Diagrams, flowcharts and data flows** written as Mermaid inside the markdown (easy to review in a change), and
  block diagrams and data flows drawn from the same ontology records that drive the app's React Flow views, so the
  documents and the app always match.
- **Mechanical drawings**: dimensioned top, side and section views of the case and board, and an exploded assembly,
  from the build123d enclosure model (`mech.*`).
- **Photorealistic renders** with Blender (`render.*`, `python/blender`): top, bottom, three-quarter, in-case and
  exploded, with materials matching the fabrication choices (solder mask colour, surface finish, silkscreen). Draft
  renders use Eevee while a board is changing; release renders use Cycles with denoising on a GPU runner, falling back
  to the CPU. Renders are cached by board and case version. The app's interactive 3D view is unchanged.
- **Protocol traces**: timing diagrams and decoded bus captures from simulation and test runs (`protocol.diagram`,
  `protocol.capture`), next to the message layouts they prove.
- **Key engineering values**: power (budget per rail, worst-case current, regulator headroom), thermal (hottest parts,
  temperature rise, margin to rating) and load (connector and track current, bus loading), each with its margin and
  its basis: **estimated**, **simulated** or **measured**, and the run it came from.

| Document | Figures and values |
|---|---|
| High level design | system context, block diagram, data flow, journey flowchart, hero render, power summary, key margins |
| Low level design | module diagrams, pin plan, power tree, firmware flowcharts, data flow per interface, mechanical drawings, every render, full power, thermal and load tables |
| Protocol specification | sequence diagrams, state machines, message layouts, timing diagrams, decoded traces |
| User guide | renders, exploded view, setup and troubleshooting flowcharts |

Two rules keep it trustworthy:

- **No source, no number.** A value not yet worked out shows as *pending*, never a guess.
- **Images and values go stale like text.** When a source changes, the image is re-rendered or the value recalculated,
  through the same review and gate checks.

## How it stays current

1. **Sections declare their sources.** Each document is a fixed set of sections (`src/docs/catalog.ts`); each section
   names the records it is written from (requirements, decisions, architecture, schematic, board, enclosure, protocol
   specs and runs, power and thermal results, tests). Scribe writes only between its section markers, so a person's
   own notes outside them are kept.
2. **Event driven.** A merged change, a signed gate or a journey record update starts a recorded hand-off job for
   Scribe. A nightly drift check catches anything the events missed, and the app says when it next runs.
3. **Surgical updates.** Scribe works out which sections the change touched and rewrites only those, then opens a
   stacked pull request on the change it documents, reviewed in the app like any other.
4. **Quality bar.** Each document has its own writing rules, checked by `src/docs/checks.ts`: every section present,
   sections due by the current stage written, no unexplained acronyms, every figure captioned with its kind and source,
   only the diagram kinds that document allows, every value with a basis and a source. A failed check, or a diagram
   that does not render, blocks the change.
5. **Gates.** A SHACL shape marks the documents current; a stage's gate cannot be signed while its documents are stale.
6. **Rendering.** Pandoc with Typst on CodeBuild: Mermaid to SVG, then a PDF with a cover page (logo, project, revision,
   commit), a revision table and contents. PDFs go to the central bucket, are attached to each release with the journey
   record, and open in the app's file viewer. They are not committed, so the repository does not bloat.

## Models

Sonnet writes every section. Haiku does the light work: which sections a change touched, freshness, the glossary. Both
are settings (`agents.docs.model`, `docs.triage_model`), so either can be changed without code.

## Project logo

Uploaded when creating a project or later in its settings: SVG or PNG, with an optional version for dark backgrounds.
trace checks its size and format and shows a sample cover page before saving. It appears on every cover page and as a
small mark in the page header; without one, the project icon is used. A new logo re-renders the PDFs; the markdown
does not change.

## Build contract (the stack)

Each layer is one pull request that builds and passes on its own.

1. **Foundations** (this layer): this note; `src/docs/catalog.ts` (documents, sections, sources, figure and value
   kinds, writing rules, the skeleton each document starts from); `src/docs/markers.ts` (section, figure and value
   markers: read, replace one section); `src/docs/diagrams.ts` (which diagrams each document allows and how each is
   made); `src/docs/checks.ts` (the quality bar). Pure functions, no I/O.
2. **Logo**: upload, checks and the sample cover page (API and app).
3. **Render pipeline**: Mermaid to SVG, Pandoc and Typst to PDF with the cover, on CodeBuild; PDFs to the central bucket.
4. **Figures and values**: mechanical drawings from build123d, Blender document renders (Eevee drafts, Cycles
   releases, cache), protocol traces, and the power, thermal and load tables from their runs.
5. **Scribe**: the `docs` specialist (Sonnet writes, Haiku triages), its prompt in the catalog, stacked pull requests.
6. **Events and gates**: hand-off on merge, gate and journey changes; the nightly drift check; the "documents
   current" SHACL shape.
7. **Docs tab** in the web app: each document with a freshness badge, the PDF viewer, and when it next checks.
8. **Proof**: `test-esp32` through every stage, checking each document and figure as it appears (the I2C display
   exercises the protocol specification).

### Markers

```markdown
<!-- scribe:section id="power-budget" -->
## Power budget
…
<!-- scribe:end id="power-budget" -->

<!-- scribe:figure kind="render-top" source="run:r-8f2c" -->
![Top of the board](figures/render-top.png)

<!-- scribe:values kind="power" -->
| Quantity | Value | Limit | Margin | Basis | Source |
|---|---|---|---|---|---|
| 3.3 V rail current | 182 mA | 500 mA | 64 % | simulated | run:r-91aa |
| Battery life | pending | | | pending | |
```

A section whose body is only `_Pending: <what it needs>._` is pending. A figure marker is followed by its image or its
```` ```mermaid ```` block, then a caption line in italics.
