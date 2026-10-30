# Enclosure build contract

Status: build contract, October 2026. Implements [enclosure-cad.md](enclosure-cad.md) on top of the tools function
(PR #62: `agent/Dockerfile.tools`, `src/gpu/jobs.ts` FUNCTION_KINDS). Two streams build against this file: the Python
engine (`python/tracebridge/mech/`) and the TypeScript side (`src/tools/mech/`, jobs, specialist, skill, check).

## What a project holds

```
mechanical/
  case.json        the case's settings (CaseSettings below), edited by a person, by chat or by the mech tools
  case.py          the case script (build123d), copied from a template by mech.init; a person or the worker edits it
  <name>.step      a handed-in case (settings.source = "file"), when a person hands one in
  out/             what mech.build writes: case.step, case-base.step/.stl/.3mf, case-lid.step/.stl/.3mf,
                   fit.json, case.jsonld, order.json and order.md (mech.order)
```

## Units and frames

Millimetres throughout. Board facts are in KiCad's frame (x right, y down, origin KiCad's). The Python engine flips y
(y_case = -y_kicad) and puts the board's bottom face at z = 0 before placing it in the case; every result it returns
names parts by reference and walls by compass side in KiCad's view: `west` (min x), `east` (max x), `north` (min y),
`south` (max y), `top`, `bottom`.

## Board facts (TypeScript → Python), `facts.json`

Produced by `boardFacts(pcbPath)` in `src/tools/mech/board.ts` from the `.kicad_pcb` alone (no kicad-cli, no 3D models:
the images carry no KiCad 3D model library).

```jsonc
{
  "version": 1,
  "board": "hardware/x.kicad_pcb",          // repository-relative
  "sha256": "…",                            // of the board file: a build records it, so a stale build is detectable
  "thickness_mm": 1.6,                      // general/thickness, else 1.6 with a warning
  "outline": [[x, y], …],                   // the Edge.Cuts outer loop, closed implicitly, arcs sampled every <= 0.5 mm;
                                            // ends join when within 0.01 mm of each other (by distance). Segments
                                            // that close no loop are an error naming the open ends; every cutout and
                                            // every part's centre must lie inside the outline, else an error
  "cutouts": [[[x, y], …], …],              // inner Edge.Cuts loops
  "holes": [{ "x": 3.5, "y": 3.5, "d": 3.2, "kind": "mounting" | "npth" | "pth", "ref": "H1" | null }],
  "parts": [{
    "ref": "J1", "value": "USB_C", "footprint": "Connector_USB:USB_C_…", "side": "top" | "bottom",
    "x": 10, "y": 20, "rotation_deg": 90, "mount": "smd" | "through_hole" | "unspecified",
    "box": { "min_x": 6, "min_y": 17, "max_x": 14, "max_y": 25 },   // courtyard bounds in board coords, else pads + 0.25
    "box_source": "courtyard" | "pads",
    "height_mm": 3.3,                       // above the board face it sits on
    "height_source": "field" | "table" | "default",
    "below_mm": 0,                          // through-hole leads out of the far face (2.0 for through_hole, else 0)
    "connector": true,                      // ref J*/P*/USB*/CN*, or footprint library Connector*/USB*/Button*/LED_THT*
    "edge": { "side": "south", "distance_mm": 0.0 } | null   // nearest outline side when box is within 1.5 mm of it
  }],
  "warnings": ["U3 has no Height field and no table entry: assumed 5 mm"]
}
```

Heights, first match: a footprint field `Height` (mm, a number with or without "mm"); then the table in
`src/tools/mech/heights.ts` keyed by footprint name pattern (the KiCad library's common packages: 0402–1206 passives,
SOT-23/223, SOIC, QFN, TSSOP, LQFP, pin headers vertical/horizontal by pitch, USB-C/Micro-B receptacles, JST-PH/XH,
tactile switches, crystals HC49/SMD, electrolytics by diameter where the name says it, TO-220 vertical); then
5.0 mm, reported as `default` with a warning. DNP parts and parts with no pads are left out.

## Case settings, `mechanical/case.json`

Validated by zod in TypeScript (`src/tools/mech/settings.ts`, the source of truth) and re-checked in Python. `board`
and `file` are repository paths: relative, no `..` or `.` segment, no leading `/`, no backslash. The process is stored
as the capabilities spell it (`pa12-hp` given, `PA12-HP` kept). A per-part clearance or an `openings.skip` entry naming
a reference that is not on the board is kept, with a warning in mech.settings' answer.

```jsonc
{
  "version": 1,
  "board": "hardware/x.kicad_pcb",
  "template": "printed-shell",              // the only template in this build
  "source": "script" | "file",              // file: the case body is the handed-in STEP named by `file`
  "file": "mechanical/my-case.step",        // when source = file
  "process": { "service": "jlc3dp", "process": "MJF", "material": "PA12-HP" },  // see capabilities
  "params": {
    "wall_mm": 2.0, "floor_mm": 2.0, "lid_mm": 2.0,
    "corner_radius_mm": 3.0,                // outside vertical edges
    "standoff_d_mm": 7.0,                   // boss diameter at each mounting hole
    "lip_mm": 2.0, "lip_h_mm": 3.0          // the lid's lip, hanging inside the base's cavity, that locates it
  },
  "clearance": {
    "edge_mm": 0.5,                         // board edge to inner wall (default 0.5)
    "above_tallest_mm": 1.0,                // tallest top-side part to the lid's inner face (default 1.0)
    "below_mm": 1.0,                        // bottom-side parts and leads to the floor (default 1.0)
    "parts": { "J1": { "mm": 2.0, "reason": "mating face of the plug" } }   // per-part: the gap this part needs
  },
  "openings": { "skip": ["J3"], "extra_mm": 0.5 },  // connectors at an edge get an opening; extra_mm around each
  "quantity": 5,                            // for mech.order
  "reasons": { "params.wall_mm": "thicker for drop test" }   // a reason per value changed from the recommendation
}
```

Defaults are the recommendation; `mech.settings` refuses to change a value away from its default without a reason.

## Capabilities (TypeScript → Python), `capabilities.json`

`src/tools/mech/capabilities.ts` holds JLC3DP's printing rules and JLCCNC's machining rules as data, each with its
source page and the date it was read (2026-10-29 for this build). Sources:
<https://jlc3dp.com/help/article/3d-printing-design-guideline>, <https://jlc3dp.com/capabilities/3d-printing-service>,
<https://jlccnc.com/help/article/CNC-Machining-Design-Guideline>.

Kept current by trace's own CI (`.github/workflows/capabilities.yml`, daily; README "Keeping the rules current"):
`src/tools/mech/capsync.ts` re-reads the pages and compares each stored figure (`FIGURES`: page, label, stored text,
optionally `nth`, `occurrence` and `apply`) with the first text of the same shape after its label, numbers as whole
numbers and labels ending in a letter or digit as whole words. A figure stated with other numbers and with an `apply`
is written to `src/tools/mech/capabilities.updates.ts` (`UPDATES`), which `capabilities.ts` applies on top of the
reviewed table (`BASE_CAPABILITIES` → `CAPABILITIES`), on a pull request a person reviews; when every figure is still
stated, `checked` moves on by a pull request that may merge itself (every 30 days); anything else becomes an issue for
a person and nothing changes. A build records `capabilities_sha256` (`capabilitiesStamp`: the figures the engine
reads, without the date) and is stale when that changes, not when `checked` moves on.

```jsonc
{
  "checked": "2026-10-29",
  "processes": [{
    "service": "jlc3dp", "process": "MJF", "materials": ["PA12-HP", "PA12S", "PA11-HP"],
    "max_mm": [370, 276, 360], "min_mm": [5, 5, 5],
    "wall_by_size": [[5, 1.0], [10, 1.2], [50, 1.5], [100, 2.0], [200, 2.0]],   // [largest part size up to, min wall]
    "assembly_clearance_mm": 0.2, "moving_clearance_mm": 0.6,
    "tolerance": "±0.3 mm up to 100 mm, ±0.4% above", "hole_min_d_mm": 1.5,
    "source": "https://jlc3dp.com/help/article/3d-printing-design-guideline"
  }, …],
  "cnc": { "wall_min_mm": { "metal": 0.5, "plastic": 1.0 }, "wall_recommended_mm": { "metal": 0.8, "plastic": 1.5 },
           "corner_radius": "R = H / 10 + 0.5 mm for a cavity H deep; R0.5 for H <= 3 mm", "tolerance": "±0.1 mm", … }
}
```

Rows (per the guideline as read): SLA (two resin groups, 780×780×530 and 580×580×380, walls 0.5/0.8/1.0/1.5/2.0,
hole Φ1.0), MJF PA12/PA12S/PA11 370×276×360 and PAC 320×175×225 (walls 1.0/1.2/1.5/2.0/2.0), SLS 350×350×400 (same
walls), FDM ABS/PA12-CF 580×480×480 and ASA/PLA/TPU 250×250×300 (walls -/-/1.6/2.0/2.5, min part 30×30×10, clearance
0.5), SLM 316L/TC4 390×290×390 (walls 1.5/1.5/1.5/2.0/2.5, clearance 0.5), CNC aluminium and plastics.

## The engine (Python), `python -m tracebridge.mech run`

```
python -m tracebridge.mech run --facts facts.json --settings case.json --capabilities capabilities.json \
  [--script case.py] [--case-file handed-in.step] --out OUTDIR [--formats step,stl,3mf]
```

A case script runs in a child process (`python -m tracebridge.mech build-only`, in a private temporary folder) that
writes only one STEP per part and a `claims.json` (joints, fasteners, notes). The parent never imports the script: it
reads those files strictly (fixed names, regular files, size caps), and runs the fit and the rules with its own copy of
the facts, settings and capabilities, measuring the geometry; what the script claims is used for records and notes,
never for a pass. The built-in template (no `--script`) runs in the parent on deep copies.

Writes into OUTDIR: `result.json` (below), and the files it names. Exit 0 whenever it produced a result (a failing fit
is a result, not an error); exit 2 with `{"error": "…"}` in `result.json` for bad input; anything else is a crash.

The script (`case.py`) is a module with `build(board, settings) -> Case`; the template's is:

```python
from tracebridge.mech import shell

def build(board, settings):
    case = shell.two_part(board, settings)
    # Your changes go here: case.parts["lid"] = case.parts["lid"] - …  (build123d)
    return case
```

API in `tracebridge.mech` (public, documented in its module docstring):

- `Board` (from `load_board(facts)`): `.body` (board solid with holes and cutouts), `.slice` (a 0.2 mm slab at
  mid-thickness, for edge gaps), `.parts: dict[ref, Solid]` (envelope boxes), `.facts` (the dict), `.top_z`, `.bottom_z`.
- `Case`: `.parts: dict[str, Solid]` (`base`, `lid`), `.joints: list[dict]`, `.fasteners: list[dict]`,
  `.notes: list[str]`.
- `shell.two_part(board, settings) -> Case`: base (floor, a full `wall_mm` wall up to the board's top face, a boss
  with a pilot hole at each mounting hole: M2 for d < 2.5, M2.5 for d < 3.0, M3 for d < 3.6, else M4; with no mounting
  holes, a rest under the board and a post in the lid near each corner, each at the nearest spot within 25 mm that
  keeps every part's clearance), lid (top and walls down to the split, and a lip `lip_mm` thick hanging into the base:
  the base's cavity is the inner cavity grown by `lip_mm` plus the process's assembly clearance, and the lip's inner
  face sits on the inner cavity, so the board's edge gap is the same everywhere and no wall is thinned), openings
  through the wall for each `connector` with an `edge` (its box grown by `openings.extra_mm` and its clearance, clipped
  to the wall), outside vertical edges filleted; for a CNC process, inner vertical pocket edges filleted to
  R = depth/10 + 0.5 (the edge gap grows so the board's corners keep `edge_mm` from the fillet, with a note). Standoff
  height = max(bottom-side part height and leads) + `below_mm`, at least 3 mm. Lid inner face clears the tallest
  top-side part and each screw's pan head (ISO 7045 maxima: M2 1.6, M2.5 2.1, M3 2.4, M4 3.1 mm) by
  `above_tallest_mm`. `lip_h_mm` deeper than the split to the floor top less 0.5 mm is bad input (exit 2).
- `fit_check(case, board, settings) -> dict`, `rules_check(case, settings, capabilities) -> list[dict]`,
  `export(case, out_dir, formats) -> list[str]`, `import_case(path) -> Case` (the whole STEP as `parts["case"]`).

`result.json`:

```jsonc
{
  "version": 1, "seconds": 1.2, "source": "script" | "file", "board_sha256": "…",
  "case": { "parts": [{ "name": "base", "volume_mm3": 1, "bbox_mm": [55, 55, 12] }], "bbox_mm": [55, 55, 20] },
  "fit": {
    "status": "pass" | "fail",
    "clashes": [{ "ref": "J1", "case_part": "base", "volume_mm3": 2.4 }],
    "gaps": [{ "ref": "board" | "<ref>", "where": "edge" | "above" | "below" | "around",
               "measured_mm": 0.5, "required_mm": 0.5, "ok": true }],
    "openings": [{ "ref": "J1", "side": "south", "made": true }],
    "assumptions": [{ "ref": "U3", "height_mm": 5.0, "source": "default" }],
    "summary": "2 clashes (J1 with base 2.4 mm³; …); 1 gap under its clearance; 3 heights assumed"
  },
  "rules": [{ "rule": "wall", "ok": false, "detail": "wall 1.0 mm is under MJF's 1.5 mm for a 55 mm part",
              "measured": 1.0, "limit": 1.5, "source": "https://…" }],
  "files": ["case.step", "case-base.step", "case-base.stl", "case-base.3mf", …, "case.jsonld", "fit.json"],
  "records": { "@context": …, "@graph": […] }    // also written as case.jsonld
}
```

Fit rules: a clash is any intersection over 0.001 mm³ between a part envelope or the board body and a case part. Gaps:
`board/edge` is the board's mid-thickness slab to the case (so standoffs and rests, which touch the faces, do not
count) against `edge_mm`; each top-side part's distance to the case against its own clearance or `above_tallest_mm`;
each bottom-side part (and through-hole leads, as a box `below_mm` deep under the part) against `below_mm`; a connector
at an edge with an opening is measured against its per-part clearance only (default 0, it may touch its opening).
Each screw's pan head is an envelope too (`screw H1`, clashes and an `above` gap). A part with nothing of the case over
it (top side) or under it (bottom side) fails its gap with a `detail` ("nothing covers U1 from above"). The case must be
around the board (`fit.enclosed`): rays from the board in ±x and ±y (three per side, so one opening is not a miss) and
up and down from its faces must meet the case, and an edge gap over max(10 × `edge_mm`, 20 mm) fails as "the case is not
around the board (likely a different origin or frame; KiCad's y is down)". A part's own `around` clearance is measured
on its own side of the board only. Through-hole leads on the far face use max(`above_tallest_mm`, `below_mm`), in the
shell and the fit alike. `status` is `fail` when any clash or gap is not ok or the case is not around the board. For a
handed-in file the same checks run against `parts["case"]`.

Rules (each row's `basis` says whether it is measured on the model, read from the parameters or from the bounding
box): the built sections measured by rays on the model (`base_wall`, `lip_wall`, `lid_wall`, `base_floor`, `lid_top`)
against the process's minimum wall for the case's largest dimension; the boss (`standoff`) against the pilot plus two
minimum walls; the bounding box against the process's maximum (and FDM's
minimum) size; pilot holes (measured) against the process's smallest hole; the lip gap (measured) against its assembly clearance;
for CNC, walls against the plastic or metal minimum and each pocket's corner radius, measured on the model, against
R = H/10 + 0.5. A handed-in file's wall
thickness is not measured: one rule row says so (`ok: null`).

Records (`case.jsonld`): the ontology's mechanical module ([ontology.md](ontology.md)), `@context`
`{"tm": "https://trace-eda.com/ns/trace/mech#", "@vocab": …}`; nodes `Enclosure` (`hasPart`, `outerSize`, `material`,
`encloses`), `EnclosurePart` per part (`partKind` base/lid, `wallThickness`, `hasStandoff`), `Material` (name, process,
service), `Fastener` and `MountingPoint` per screw, `Opening` per connector cut (`forComponent`, `face`), `Joint` per
fastened or press-fit pair (`jointKind` from the ontology's closed list, `joins`, `usesFastener`), the board's
`BoardOutline`, and a `FitCheck` (`status`, `enclosed`, `clashes`, `gapViolations`, `boardSha256`). The SHACL shape
behind the layout gate's fit criterion is the ontology work's; these are the records it reads.

Packaging: `python/pyproject.toml` gains `mech = ["build123d==0.13.0"]`, and `dev` includes it. The tools image
installs `/app/python[mech]` into `/opt/trace-venv`. The agent image does not get it.

## TypeScript

- `src/gpu/jobs.ts`: job kind `cad`, in FUNCTION_KINDS. `agent/Dockerfile.tools` installs build123d (above) and its
  final check imports it.
- `src/tools/mech/`: `board.ts` (facts), `heights.ts`, `settings.ts` (zod CaseSettings, defaults, read/write, reasons),
  `capabilities.ts` (data + staleness: older than 90 days is stale), `engine.ts` (`runCase`: stages facts, settings,
  capabilities, script and handed-in file as job inputs; `runJob({ kind: 'cad', … })`; locally `TRACE_PYTHON` or
  python3 with PYTHONPATH at the repo's `python/`; on the function `python3` from the venv), `tools.ts`.
- Tools (all recorded runs via `recorded()`; each answer carries `run_id` and a one-line `summary`):
  - `mech.board` — the board facts for a board path (default: the project's one `.kicad_pcb`), with warnings.
  - `mech.init` — writes `mechanical/case.json` (defaults, board path, process from input or the recommendation:
    MJF PA12-HP) and `mechanical/case.py` from the template; refuses to overwrite without `replace: true`.
  - `mech.settings` — shows the settings with each value's recommendation; `set` (path → value, reason) and
    `clearance` (ref → mm, reason) change them, refusing a change from the recommendation without a reason.
  - `mech.build` — runs the engine, writes `mechanical/out/`, records `fit.json`, `result.json` and the STEP files as
    run artifacts, measures `clashes`, `gap_violations`, `assumed_heights`; run status `pass` / `fail` from the fit
    and rules. Its answer says, when it passes, to record `layout.fit` with `journey.check` and this run id.
  - `mech.fit` — the latest `mech.build` run's fit, and whether it is stale (`src/tools/mech/stale.ts`): the build
    records its `inputs` (the board and its sha256, the sha256 of case.json, case.py and a handed-in file, the facts'
    sha256, the capabilities' `checked` date, and the engine: `ENGINE_VERSION` in stale.ts, `tracebridge.mech.__version__`
    when the package states one, and a sha256 over `python/tracebridge/mech/**/*.py`); any that changed is a reason.
    mech.order and the Case design skill's `fit` check use the same function (the skill compares the files on the
    default branch).
  - `mech.hand_in` — copies a STEP (or a `case.py`) from a path in the repository into `mechanical/`, sets
    `source`/`file` (or replaces the script), and runs `mech.build`.
  - `mech.capabilities` — the table, its sources and whether it is stale; `mech.capabilities_check` fetches each
    source page and reports, per stored figure, whether the page still states it (`same`, `changed`, `unreadable`).
  - `mech.order` — writes `mechanical/out/order.json` and `order.md` (service, process, material, finish, quantity,
    files to upload, the fit run id, and the upload page) for a person to submit and pay; it never places an order.
- `src/agents/impl/index.ts`: the mech tools, workflow lines (init when the project has no case and the intent asks for
  an enclosure; build; read clashes; delegate script changes; journey.check layout.fit with the build run), keywords
  (enclosure, case, housing, fit check), escalation (a clash that needs the board outline or a part moved).
- `tracectl check`: with `mechanical/case.json` present, runs `mech.build` and fails on a failing fit; when build123d
  is not importable it says so and skips (not a failure); with `TRACE_CHECK_MECH=0` it skips with
  `TRACE_CHECK_MECH_WHY` (or that variable) as the reason. `templates/build/kicad.yml` installs build123d when the
  repository has `mechanical/case.json`, and sets `TRACE_CHECK_MECH=0` for a pull request from a fork (see Trust).
- Paths (`src/tools/mech/paths.ts`): every file the mech tools read or write (hand_in's source and destination,
  mech.init's two files, case.json, everything under `mechanical/out/` and its clean-up) is resolved by realpath
  inside the repository's realpath, not under `.git/`, and is not a symbolic link; writes open with `O_NOFOLLOW`.
- Skill `case-design` ("Case design", stage Layout, stepped, picture `render`): steps `process` (Process and material),
  `clearances` (Clearances), `case` (Review the case), `fit` (Fit check), `order` (Order files); checks `process`
  ("Process and material within JLC3DP's limits"), `clearances` ("Every clearance change has a reason"), `fit` ("Fit
  check passes or each clash is waived"), `rules` ("Within the process's design rules"), plus the shared `reasons`.
  In `web/src/components/skills/definitions.ts`, `src/core/skills.ts` and `src/api/skill-checks.ts` (reading the
  latest `mech.build` run, as placement does with `pcb.placement_check`). Counts that say "nineteen" become twenty.
- Docs: README "Enclosures" section; `docs/enclosure-cad.md` status line.

## Trust

`mechanical/case.py` is code: Python that a person, the worker or a pull request wrote. A review found that in one
process, or one Lambda function, with the job runner, a script can read the runner's credentials from `/proc`, leave a
daemon behind in a warm function, and rewrite `result.json` after the check. So in the cloud the script runs where there
is nothing to take: a function of its own, with no credentials and no S3 access, that only hands back solids. Two job
kinds (`src/gpu/jobs.ts`):

| Kind | Runs | Where, in the cloud | Where, on a laptop or CI |
| --- | --- | --- | --- |
| `cad-script` | the case script (`python -m tracebridge.mech build-only`): the board facts and settings in, one STEP per part and `claims.json` out | the project's **cad function** (`<prefix>-cad-<hash>`, `src/infra/tools.ts CadFunction`), the tools image, a role that may write its own log group and nothing else | a local child process (as any repository code `tracectl check` runs: a firmware build) |
| `cad` | trace's own code only: the built-in template in-process, or the parts of a `cad-script` job (`--built`), or a handed-in STEP; then the fit, the rules, the exports and the records | the tools function, as the other kinds | local |

`mech.build` runs one `cad` job when `case.py` is byte-for-byte the template (its sha256 against the packaged
template's) or the case is a handed-in file, and a `cad-script` job followed by a `cad` job otherwise.

The cad function (`src/gpu/function.ts runCadScript`, `src/gpu/lambda.ts`, `src/gpu/runner.ts`):

- **Credentials.** Its role has `logs:CreateLogStream` and `logs:PutLogEvents` on its log group, and nothing else: no
  S3, no X-Ray. The worker stages the job under `jobs/<slug>/<id>/` as for every job, then signs URLs with its own
  credentials (`@aws-sdk/s3-request-presigner`, 20 minutes): GET for the spec and each input, PUT for each output
  (`part-1.step` … `part-16.step`, `claims.json`), stdout, stderr and the exit record. The event is
  `{"urls": {"spec": …, "inputs": {name: url}, "outputs": {name: url}, "stdout": …, "stderr": …, "exit": …}, "traceparent"?}`.
  The runner moves the files through those URLs (`UrlStore`, the same `get`/`put` as `S3Backend`); the function
  never holds a key that reaches anything but this job's own files, and a script that reads the runner's memory or
  `/proc` finds only its own job's URLs. The function refuses an event with `spec` (an S3 address): it has no S3.
- **The script's outputs are claims.** The `cad` job that follows reads them with `read_private` (fixed names,
  regular files opened once with `O_NOFOLLOW` and checked by `fstat`, size caps, part names `^[a-z][a-z0-9_-]{0,31}$`,
  claims type-checked) and measures the geometry itself with its own copy of the facts, settings and capabilities,
  on the tools function, which runs no script. Whatever a script, or a process it left behind in a warm cad function,
  writes to those outputs can only change the solids the check measures.
- **Nothing to inherit.** The job's program still runs with `isolate` (a scrubbed environment: PATH, HOME, the
  locale, TMPDIR, the XDG folders and what Python needs; HOME, TMPDIR and XDG in the job's folder; its own process
  group, killed when the job ends). On the cad function this is tidiness, not the boundary: the boundary is the role.
- **Flat layout.** A flat stack has no room for four more resources per project, so there is no cad function there:
  `mech.build` of a custom `case.py` is refused in the cloud with a message saying it builds on a laptop or in CI, and
  that a handed-in STEP or the template builds anywhere. The tools function refuses a case script however it is asked
  (a `urls` event, or a `cad-script` spec in S3), so a script never runs beside credentials.

A laptop and CI run the script as a local child process (`child.py`): `tracectl check` already runs repository code
there (firmware builds), and the person or the workflow chose to run it. In CI the script step runs only when the
workflow sets `TRACE_CHECK_MECH=1`, which `templates/build/kicad.yml` does for pushes and for pull requests from the
repository itself and never for a fork's (`github.event.pull_request.head.repo.fork`); unset, as on a laptop, it runs.
A script someone else wrote is reviewed like any other code before it is built on a laptop.

**Files stay in the repository** (`src/tools/mech/paths.ts`): a handed-in file or a `mechanical/` path that is a
symbolic link, or that leads outside the repository or into `.git/` (any letter case), is refused; a write checks the
real path before opening and, by `fstat` against `lstat`, that what it opened is the file at that path, so a folder
swapped for a link between the check and the open is caught.

## Tests

- Python: `python/tests/test_mech.py` — a synthetic 50 × 40 board with four holes, a USB-C at the south edge and a tall
  part; template build passes; a too-tight lid clashes and names the part; an edge clearance override fails the gap;
  a connector with its opening skipped clashes with the wall; rules flag a 1.0 mm MJF wall; a handed-in STEP round
  trip; exports exist and are non-empty; records have the expected node types.
- TypeScript: `test/tools/mech/` — facts from `templates/sample/hardware/trace-sample.kicad_pcb` (outline loop closed,
  holes, courtyard boxes, heights with sources); settings validation and reasons; capabilities staleness; job kind
  dispatch; and, when `python -c "import build123d"` works, `mech.init` + `mech.build` end to end on the sample board.
