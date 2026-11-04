# Showcase fixtures

For `test/tools/render/showcase.test.ts`: the sample board (`templates/sample/hardware/trace-sample.kicad_pcb`) and its case, as
`render.showcase` takes them where neither kicad-cli nor build123d is installed.

- `board.glb`: a stand-in for kicad-cli's GLB of the sample board, made from its facts by `make_board.py`
  (`blender -b -P make_board.py -- …` or with the bpy module: `python make_board.py test/fixtures/case-build/good/facts.json board.glb`).
  Body, mask, silkscreen, pads and part boxes in KiCad's colours, offset from the case frame on purpose: the showcase
  places the board by its outline.
- `case-base.stl`, `case-lid.stl`: the sample board's case, built by the case engine (build123d 0.13) from
  `test/fixtures/case-build/good` (facts and settings).
- `logo.png`: a small made-up logo (navy block, red bar, grey band) for the colours.
