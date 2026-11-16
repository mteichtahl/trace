# Starting a project from fabrication files

A board designed outside trace, with no KiCad source to hand, can still be ordered, built and brought up through
trace. The person gives trace the files a fab house takes and a written overview of the project; trace checks them,
puts the project in its repository and starts the journey at Fabricate (or Bring up for a board already built), with
the design stages signed on the import's evidence.

This is the second way into an existing design (docs/user-journey.md, "Starting from an existing design"): that one
reads a KiCad project; this one reads its outputs.

## What the person gives

All four are required. The New project screen asks for them on its own step, "Fabrication files", when the person
chooses **From fabrication files** under "How does it start?".

| Input | Accepted | What trace reads from it |
| --- | --- | --- |
| Gerbers | one `.zip`, at most 25 MB | every layer by its Gerber X2 file function (`TF.FileFunction`), else by its name (Protel `.gtl`, `.gbl`, `.g1`…; KiCad `F_Cu`, `Edge_Cuts`…); the outline's size from the profile layer; the job file (`.gbrjob`) for layer count, thickness, finish and impedance control; the drill files (Excellon) for the smallest hole and the hole count; the design tool and revision from the X2 attributes |
| Bill of materials | `.csv`, at most 2 MB | one line per part: designators, value, footprint, LCSC part, MPN, manufacturer, quantity; JLCPCB's library (basic or extended) and stock when the file carries them |
| Pick and place | `.csv`, at most 2 MB | one row per placed part: designator, centre X and Y, side, rotation |
| Project overview | typed or a `.md`/`.txt` file, 300 to 40,000 characters | the intent: what it does, where it is used, power, interfaces, size and mounting, quantity and cost |

Column names are matched loosely (`Designator`/`Reference`/`Ref`, `LCSC Part #`/`LCSC`/`JLCPCB Part #`, `Mid X`/`PosX`,
`Layer`/`Side`, …) and units in a cell (`279.05mm`, `350mil`) are understood, so JLCPCB's, KiCad's and EasyEDA's exports
read without editing. The samples this was built from are KiCad 10's JLCPCB outputs for a 10-layer, 200 × 160 mm board
(test/fixtures/fab-import).

### The overview's quality bar

Trace's intent comes from the overview, so it is held to the Intent builder's topics. Each is found by what the text
talks about, and a missing one is shown with the question that would answer it:

1. **What it does**: its purpose, in a sentence or two.
2. **Where it is used**: the setting, enclosure, environment.
3. **Power**: what feeds it, voltages and currents.
4. **Interfaces**: connectors, buses, what it talks to.
5. **Size and mounting**: the outline, holes, case.
6. **Quantity and cost**: how many, a target cost or budget.

At least 300 characters and four topics, or the import cannot go ahead; all six are recommended.

## What trace checks

`fab.inspect` (src/tools/fab/inspect.ts) is pure: it reads the four inputs and answers a summary and a list of findings,
each **blocking** (the import cannot go ahead), a **warning** (it can, and the finding is carried into the project) or
a **note**, in plain words with what to do about it.

| Check | Finding |
| --- | --- |
| No outline (profile) layer | blocking |
| No copper layer, or no drill file | blocking |
| More copper layers than JLCPCB builds, or a board smaller than it makes | blocking |
| An odd number of copper layers above two; the job file's layer count differs from the files | warning |
| No solder mask or silkscreen layer; no paste layer while parts are placed | warning |
| A hole smaller than JLCPCB's smallest drill | warning |
| A designator on two BOM lines, or twice in the pick and place | blocking |
| Most placements outside the outline (the files do not share an origin) | blocking; a few: warning |
| A BOM line's quantity differs from its designators | warning |
| A BOM line with no LCSC part, or one not in JLCPCB's form (`C` and digits) | warning: JLCPCB will not place it |
| A BOM line JLCPCB lists with no stock, or less than the build needs | warning: today's stock check confirms at Fabricate |
| A BOM part with no placement | warning: placed by hand, or through-hole |
| A placement with no BOM line | warning: JLCPCB skips it |
| The overview below its bar | blocking |

Nothing is changed in the files: a problem is the person's to fix in their design tool and give again.

## What trace sets up

`projects.create` with `start: 'import'` and an `import` (the upload and the entry stage) does what it does for every
project (repository, registry, people, journey, the project's cloud resources), then:

1. **The files go into the repository** as one change on `trace/import-<time>`, applied once its checks pass like a
   hand-in (edit kind `import`): `hardware/<board>/release/revA/<board>-gerbers.zip`, `<board>-jlc-bom.csv`,
   `<board>-jlc-cpl.csv` (the names the order sheet marks for upload), the inspection as `import.json` beside them,
   and the overview as `docs/overview.md`.
2. **The journey enters at the chosen stage.** Every criterion before it is met on the import's evidence (the overview,
   the files and the inspection), and each gate before it is signed once, by the admin who imported it, with the note
   "Signed on the import evidence". The decisions log says so (`journey.imported`). The person sees every gate that will
   be signed this way before they confirm.
3. **The stage's work starts.** At Fabricate, the Implementation agent records the package with `fab.import` (the same
   inspection, recorded as an `import.fab` run whose result has `kicad.fab`'s shape: files, order options, placements,
   parts placed by hand, problems) and checks today's stock with `parts.bom_check` on the imported BOM. The order
   sheet, Order submit, quotes and the Build page read the newest `kicad.fab` or `import.fab` run as the release
   package. The Verification agent drafts requirements from `docs/overview.md`, each marked inferred, for the person to
   confirm during the fab wait, so Bring up has something to verify.

### Where it enters

| Entry | When trace recommends it |
| --- | --- |
| **Fabricate** | the boards are not made yet (the usual case) |
| **Bring up** | the person says the boards are already built: revision A's bench results become the first evidence |

The earlier stages are not redone: there is no source for trace to check them on. A later change to the design comes
back as a new revision, designed in trace or imported again.

## The actions

| Action | Need | Does |
| --- | --- | --- |
| `projects.import_upload { upload, file, give, part, parts, base64 }` | admin | keeps one part (at most 3 MB) of one file under `imports/<uploader>/<upload>/` in the central bucket; parts keep a 25 MB zip within the 5,000,000-byte limit AWS WAF puts on each request, and `give` (when the file was given) makes the newest give of a file the one checked |
| `projects.import_check { upload, overview, quantity }` | admin | joins the parts, inspects them and answers the summary, findings, overview topics and recommended entry |
| `projects.create { …, start: 'import', import: { upload, overview, entry } }` | admin | as above; refused while the inspection has a blocking finding |

Uploads are kept for a day and are the uploader's own: another admin's upload id is not found.

## Decisions

- The design stages' gates are signed by the importing admin on the import's evidence, in one confirmation that lists
  each gate, rather than one Gate signing per stage: there is nothing in them for a person to review apart from the
  files and the overview the import already checked.
- The imported package is recorded as its own run kind (`import.fab`), not as a `kicad.fab` run, so the record never
  says trace built a package it only read. Readers of the release package take either.
- The files are uploaded in parts to the central bucket rather than through presigned S3 uploads: no new bucket
  policy, CORS rule or role, and the same sign-in and admin check as every other action.
