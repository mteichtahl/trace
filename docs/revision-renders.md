# Revision renders

Status: building, 5 November 2026, as a stack of pull requests. The mechanical module landed in #243 and #245, and the
ontology additions are layer 1 of the stack. The documentation stream (docs/scribe.md) owns the project logo's upload;
these renders read the logo it saves and are the Blender engine its document renders use.

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
| `board-in-case` | The board in the base, lid off, its screws seated | Three-quarter view from higher up, 45° |
| `exploded` | Base, board and lid pulled apart along their assembly axis, fasteners between them | Three-quarter view, framed on the whole stack |
| `turntable` | A video: the closed case (the board when there is no case) turning once on its floor | Three-quarter view, 22° up, framed on everything the turn sweeps |

**Exploded view.** The board and the case are placed in the case frame from [enclosure-build.md](enclosure-build.md):
y flipped from KiCad, and the board's bottom face at z = 0. The board model is placed by its own outline, so where
kicad-cli puts its origin does not matter. The base stays put; the board is lifted until its lowest point clears the
base's top by half the case's height, and the lid until it clears the board's tallest part by the same gap.

**Screws.** When the board is screwed down, the screws are the ones the case was built for: each `Fastener` and its
`MountingPoint` in `mechanical/out/case.jsonld` (size, length and hole). Each is drawn as an ISO 7045 pan head screw
(head height and diameter as the case's fit check uses them, a cross recess, the shank's thread as fine ridges at the
coarse pitch) in zinc-plated steel. They sit seated in the board-in-case shot. In the exploded view they are lifted out
of their holes on their own axes, tip clear of the board, and the lid is lifted clear of them. A board held by rests and
lid posts has no screws to show. A case built before its records were written shows none, and the run says so; the
records are one of the run's inputs, so the pictures go out of date when the screws change.

## Look

- **Quality.** The shots render on the GPU queue at 2560 × 1600 with 256 samples, denoised. They use Blender's AgX
  view transform rather than Standard, which suits photoreal work. If there is no GPU queue, the CPU renders them at
  1920 × 1200 with 128 samples, and the run's notes say so.
- **Surfaces.** The board's surfaces come from `render_board.py`. The case uses the material its process gives it:
  printed nylon is matte grey, and machined aluminium is brushed metal.
- **Floor.** A shadow catcher under the subject gives a soft contact shadow, so the subject does not float.
- **Turntable.** The subject turns once about its own centre while the camera and lights stay still, as on a real
  turntable, so the light moves over the case as it turns. The first frame is the case shot's view. It is 96 frames at
  24 fps (four seconds), encoded as H.264 MP4 by ffmpeg. Its frames are smaller than the pictures and use fewer
  samples, because each is seen for a 24th of a second and is denoised: 1920 × 1200 with 64 samples on the GPU queue,
  1280 × 800 with 24 on a CPU. A draft is 48 frames at a quarter of that. It renders after the pictures, in the same
  Blender run, so on a CPU it is the longest part of the set.

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

The logo is the documentation module's (`trace:projectLogo`, docs/scribe.md "Project logo"), uploaded in Scribe's layer 3.
These renders only read it, so there is one logo for the documents and the pictures.

- **Upload.** A person uploads the logo when creating the project or in its settings, as PNG or SVG (Scribe, layer 3).
- **Where it is kept.** In the repository, as Scribe keeps it: `docs/design/logo.png` or `logo.svg` (`src/docs/logo.ts`).
  The renders use the logo for light backgrounds.
- **SVG.** Blender cannot open an SVG, so its colours are read from its fills and strokes, each weighted by how often it is used.

## Names and where the images go

Each image's name carries the project, the revision and the date the revision was cut:

```
<project>_rev-<revision>_<YYYY-MM-DD>_<shot>.png
test-esp32_rev-B_2026-11-04_exploded.png
test-esp32_rev-B_2026-11-04_turntable.mp4
```

- **The project** is the project's name in its record (test-esp32 #215: the pictures were once named after the
  agent's working folder). In order: the `project_name` given to the tool, the journey's name, the KiCad project's
  name, the repository's name, and the folder the run is in only when there is nothing else. The result's `name` says
  which it was.
- **The date** is the day of the `journey.snapshot` decision, in the installation's time zone (UTC when none is set).
- **In the run record**, they are kept as artifacts of one `render.showcase` run, with the device, the time each
  shot took, and the commits of the board and the case. On an installation the pictures themselves (about 5 MB each)
  are kept in the project's folder in the installation's bucket, and the run record holds only a reference to each, so
  renders do not grow the repository (docs/artifact-store.md).

## How it is built

1. **`render_showcase.py`** (Blender, `python/blender/`). It imports the board GLB and the case's base and lid, places
   them in the case frame, and renders each asked-for shot. It writes a `TRACE_RESULT` line with each image's
   statistics, so a blank image fails the run as the other render tools do.
2. **`render.showcase` tool** (`src/tools/render/`).
   - It takes a project, a revision and a date, and optional shots, size and samples.
   - It exports the board with `exportBoard` (GLB), and reads the case as mech.build's `mechanical/out/case-base.stl` and
     `case-lid.stl`, which are already in the case frame.
   - It names the files as above and stores them as one run.
   - **Parts without a body** (test-esp32 #214). A footprint whose model KiCad's 3D library does not have, or that
     names none, gets its vendor's model: by its LCSC part code, the STEP EasyEDA keeps for the part
     (`src/tools/kicad/vendor3d.ts`). EasyEDA's footprint is matched to KiCad's by their pads (a quarter turn at a
     time), and the model goes where EasyEDA puts it on its own footprint. The export reads a copy of the board that
     names the model; the board itself is not changed. Without the network, without an LCSC code, or when the pads
     do not match, the part stays without a body. The result's `bodies` lists the parts drawn with a vendor model and
     those still without a body, with why, and the notes say so.
   - **Off-board parts.** A case part beyond the base and lid (an off-board module that mech.build placed at its
     mount, `mechanical/out/case-<part>.stl`) is drawn with the part it is mounted to: with the lid when it sits above
     the board, else with the base. The architecture's off-board parts (`off_board` in its blocks) that the case does
     not place, and their cables, are not drawn: the result's `off_board.not_drawn` lists them, with why.
3. **`brand.palette` tool and the logo upload.**
   - The tool works out the palette from the logo on the tools function, using Pillow.
   - The web app gets a "Logo" field in project settings, with screen renders shown before it is built.
4. **The hook.** After `snapshot()` succeeds in `gate.sign` and `journey.snapshot`, trace starts a job with
   `agent: 'render'` and a request naming the revision, the date and the shots. The signature stands even if the job
   cannot start, as with `STAGE_WORK`.
5. **In the app: the Renders tab** (chosen by Marc, November 2026, over the Build tab; screens in
   `docs/ui/screens/Renders*.png`). It shows from Release on.
   - **Each revision, newest first** (`renders.list`). The newest is a gallery, with the exploded view large. Earlier
     revisions are a row each.
   - **A revision still being made** shows what the rendering agent is doing, and its log.
   - **The viewer** steps through a revision's pictures with the arrow keys. It shows the file, the revision, the
     commit, the case's material, the size and the colours. On a phone it opens full screen.
   - **The turntable** plays muted and looping beside the exploded view, and with the player's controls in the viewer.
     A thumbnail shows its first frame with a play mark. Someone who asks their device for reduced motion sees it
     still until they press play. It downloads as its MP4 and is in the zip with the pictures.
   - **Downloads.** One picture, or all of them as a zip. The browser makes the zip from the pictures, because a full
     set at 2560 × 1600 is over the API's 8 MB answer limit.
   - **When they are ready**, people get a push notification and an item in Next.

## When they are ready

The rendering agent's change, which commits its render runs to the run record, applies on its own once its checks
pass, as trace's own release record does (Marc, November 2026). This is `src/api/apply-renders.ts`, run in the same
pass that applies trace's own edits.

It applies only a change that is renders and nothing else:

- one of trace's changes, made by the rendering agent;
- open, not a draft, and aimed at the default branch;
- every check passed, and the agent did not say it is unfinished;
- it touches `.trace/project.db` and no other file;
- every run it adds is a render, and every other row of the run record is as the default branch has it.

Anything else waits for a person, like any agent change.

An applied change records `renders.ready` for each revision it rendered. That decision becomes a Next item,
"Revision B's renders are ready: 6 pictures", for everyone on the project. The item leaves a person's Next once they open
the Renders tab (`renders.seen`), and leaves for everyone after 14 days.

It is also a push of kind `renders`, which opens the Renders tab. Push for it is off until the person turns notifications
on. It follows each person's settings and quiet hours. A project set to "gates and spend only" does not push it.

## What the ontology needs

- **From phase 7 (planned in P7.1):**
  - `tm:Enclosure`, `tm:EnclosurePart` (base, lid) and `tm:MechanicalModelFile`. They let a set name the case version
    it came from.
- **Additions this feature asks for (none are planned in any phase yet):**

| Class or property | Module | Meaning |
| --- | --- | --- |
| `trace:RenderSet` | board | A `render.showcase` run: `ofRevision`, `revisionDate`, `usedPalette` |
| `trace:Render` | board | One picture, a `RunArtifact`: `shotKind` (board, board-top, board-bottom, case, board-in-case, exploded), `inRenderSet` |
| `trace:BrandPalette` | board | The colours used: `paletteSource` (logo or neutral), `baseColour`, `accentColour`, `neutralColour`, `backgroundColours`, `paletteFromLogo` |

The logo itself is the documentation module's `trace:projectLogo`, so no logo class is added. `src/ontology/renders.ts`
reads these from each showcase run's result when the graph is built.

With `madeFrom` recorded, a set reads as out of date when its board, case or logo changes. The freshness rules from
phase 4 cover this with no new code.

## Open questions

- **The time zone for the date in the name.** This note uses the installation's time zone. A per-project setting is
  the alternative.
- **Turntables.** Settled: each revision gets one (see "Look"). On a CPU it adds the most time to the set, so an
  installation without a GPU queue may want it shorter; `turntable_frames` sets it per run.
