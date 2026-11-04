# Revision renders

Status: design, 4 November 2026. Not built yet. It waits for the ontology to land: phase 7, the mechanical module, and
the additions listed under [What the ontology needs](#what-the-ontology-needs).

## What it does

When a revision is cut, trace makes a set of photorealistic images of the board, the case and the board in the case,
including an exploded view. It renders them with Blender and needs nobody to ask for them. The set is part of the
revision, like the journey record that is copied into the repository with it.

- **When.** A revision is cut when the release approval gate is signed (`gate.sign`, `signed.released`), or when an
  admin copies the record by hand (`journey.snapshot`). Right after the record is copied in, trace starts a render job.
- **Board, case, or both.** The board shots are always made. The case shots are made only when the project has a case
  (`mechanical/case.json` and a built `mechanical/out/case.step`).
- **Out of date.** A change to the board or the case after a release starts a new revision. That revision then gets
  its own set, so a set never has to be redone in place.

## The shots

| Shot | What it shows | Camera |
| --- | --- | --- |
| `board` | The populated board, top side | Three-quarter view from the front left, 30° up |
| `board-top` | The board from straight above | Orthographic plan view |
| `board-bottom` | The underside | Orthographic plan view from below |
| `case` | The closed case | Three-quarter view |
| `board-in-case` | The board in the base, lid off | Three-quarter view from higher up, 45° |
| `exploded` | Base, board and lid pulled apart along their assembly axis, fasteners between them | Three-quarter view, framed on the whole stack |

**Exploded view.** The board and the case are placed in the case frame from [enclosure-build.md](enclosure-build.md):
y flipped from KiCad, and the board's bottom face at z = 0. The base stays at 0. The board is lifted by 60% of the
case's inside height, and the lid by 140% of it. Fasteners sit halfway between the parts they join. Thin dashed lines
along the assembly axis are an option, off by default.

## Look

- **Quality.** The shots render on the GPU queue at 2560 × 1600 with 256 samples, denoised. They use Blender's AgX
  view transform rather than Standard, which suits photoreal work. If there is no GPU queue, the CPU renders them at
  1920 × 1200 with 128 samples, and the run's notes say so.
- **Surfaces.** The board's surfaces come from `render_board.py`. The case uses the material its process gives it:
  printed nylon is matte grey, and machined aluminium is brushed metal.
- **Floor.** A shadow catcher under the subject gives a soft contact shadow, so the subject does not float.

### Colours from the logo

When the project has a logo, trace takes its colours from it.

- **The palette.** Trace takes the logo's dominant colours by k-means on its opaque pixels, ignoring near-white and
  near-black. It keeps three of them:
  - a **base**, the most common colour;
  - an **accent**, the most saturated colour that is far from the base;
  - a **neutral**, the most common low-saturation colour.
- **The background.** A soft vertical gradient from the base colour, lightened, to the base colour, darkened. If the
  base colour is too saturated to sit behind a green solder mask, trace uses the neutral colour instead.
- **The light.** The rim light is tinted towards the accent colour. The key and fill lights stay neutral, so the board
  keeps its true colours.
- **The logo itself** is not placed in the images, unless a person asks for it.

**With no logo,** the background is a neutral studio gradient from `#eceef1` to `#c8ccd2`, with neutral lights.

**The palette is recorded** with the set, so a reader can see where each colour came from.

### The logo

Nothing in trace stores a logo yet: the project icon's upload is dropped before it is saved. This feature adds a
project logo. The documentation agent needs it too, for the logo in each document.

- **Upload.** A person uploads the logo in the project's settings, as PNG, JPEG, WebP or SVG.
- **Where it is kept.** It is committed to the repository as `.trace/brand/logo.<ext>`, with the palette in
  `.trace/brand/palette.json`.
- **SVG.** An SVG is turned into a 1024-pixel PNG for the palette.

## Names and where the images go

Each image's name carries the project, the revision and the date the revision was cut:

```
<project>_rev-<revision>_<YYYY-MM-DD>_<shot>.png
test-esp32_rev-B_2026-11-04_exploded.png
```

- **The date** is the day of the `journey.snapshot` decision, in the installation's time zone (UTC when none is set).
- **In the repository**, the images are committed under `renders/rev-<revision>/`. They go on the release branch, as
  an app edit like the record itself, so the person sees them in trace and never in GitHub.
- **In the run record**, they are also kept as artifacts of one `render.showcase` run, with the device, the time each
  shot took, and the commits of the board and the case.

## How it is built

1. **`render_showcase.py`** (Blender, `python/blender/`). It imports the board GLB and the case's base and lid, places
   them in the case frame, and renders each asked-for shot. It writes a `TRACE_RESULT` line with each image's
   statistics, so a blank image fails the run as the other render tools do.
2. **`render.showcase` tool** (`src/tools/render/`).
   - It takes a project, a revision and a date, and optional shots, size and samples.
   - It exports the board with `exportBoard`, and tessellates the case's STEP files through `stepToMesh`.
   - It names the files as above and stores them as one run.
3. **`brand.palette` tool and the logo upload.**
   - The tool works out the palette from the logo on the tools function, using Pillow.
   - The web app gets a "Logo" field in project settings, with screen renders shown before it is built.
4. **The hook.** After `snapshot()` succeeds in `gate.sign` and `journey.snapshot`, trace starts a job with
   `agent: 'render'` and a request naming the revision, the date and the shots. The signature stands even if the job
   cannot start, as with `STAGE_WORK`.
5. **In the app.** The revision's images show on the Release stage and in the run page's file viewer. The phone gets
   the same images.

## What the ontology needs

- **From phase 7 (planned in P7.1):**
  - `tm:Enclosure`, `tm:EnclosurePart` (base, lid) and `tm:MechanicalModelFile`. They let a set name the case version
    it came from.
- **Additions this feature asks for (none are planned in any phase yet):**

| Class or property | Module | Meaning |
| --- | --- | --- |
| `trace:ProjectLogo` | core | The project's logo, a `FileArtifact` with its format |
| `trace:BrandPalette` | core | The colours taken from a logo version: `baseColour`, `accentColour`, `neutralColour`, `madeFrom` the logo version |
| `trace:RenderSet` | board | The images made for one revision: `ofRevision`, `renderedAt`, `madeFrom` the board version, the enclosure version and the palette version |
| `trace:Render` | board | One image of a set, a `RunArtifact`: `shotKind` (board, board-top, board-bottom, case, board-in-case, exploded), `inSet` |

With `madeFrom` recorded, a set reads as out of date when its board, case or logo changes. The freshness rules from
phase 4 cover this with no new code.

## Open questions

- **The time zone for the date in the name.** This note uses the installation's time zone. A per-project setting is
  the alternative.
- **Turntables.** Should each revision also get a turntable movie of the closed case? It is off in this note, because
  movies are slow on a CPU.
