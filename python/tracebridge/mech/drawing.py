"""Mechanical drawings of a case for the project's documents (docs/scribe.md "Mechanical drawings").

    python -m tracebridge.mech drawing --step case.step --out OUTDIR [--board board.step]

writes, from the case the engine built (and the board, when its 3D model is given):

    drawing.svg    three views in third-angle projection (top, front, right side), visible edges solid and hidden
                   edges dashed, with the overall width, depth and height dimensioned in millimetres
    exploded.svg   the parts drawn apart along the vertical axis in a three-quarter view, the lid lifted off the base,
                   so a reader sees how the case goes together
    drawing.json   the overall size and each part's size, the numbers the drawing states

Lines only, no shading: they print sharply at any size and the PDF keeps them as vectors. Nothing is downloaded.
"""
from __future__ import annotations

import json
from pathlib import Path

from build123d import Compound, Draft, ExportSVG, ExtensionLine, LineType, Location, Shape, Unit, import_step

LINE = 0.35        # visible edges, mm on paper
THIN = 0.18        # hidden edges and dimensions
GAP_MM = 18.0      # space between views, in model millimetres
EXPLODE = 0.6      # how far the parts move apart, as a share of the case's height


def _parts(shape: Shape) -> list[tuple[str, Shape]]:
    kids = list(getattr(shape, "children", []) or [])
    if not kids:
        return [(getattr(shape, "label", "") or "case", shape)]
    return [(getattr(k, "label", "") or f"part {i + 1}", k) for i, k in enumerate(kids)]


def _project(shape: Shape, eye: tuple[float, float, float], up: tuple[float, float, float]):
    """Visible and hidden edges of `shape` seen from direction `eye`, in the drawing's plane, its corner at (0, 0)."""
    c = shape.bounding_box().center()
    d = max(shape.bounding_box().diagonal, 1.0) * 4
    origin = (c.X + eye[0] * d, c.Y + eye[1] * d, c.Z + eye[2] * d)
    visible, hidden = shape.project_to_viewport(origin, viewport_up=up, look_at=(c.X, c.Y, c.Z))
    edges = list(visible) + list(hidden)
    bb = Compound(children=edges).bounding_box() if edges else None
    shift = Location((-bb.min.X, -bb.min.Y, 0)) if bb else Location()
    return ([e.moved(shift) for e in visible], [e.moved(shift) for e in hidden],
            (bb.size.X, bb.size.Y) if bb else (0.0, 0.0))


def _dim(a: tuple[float, float], b: tuple[float, float], offset: float, draft: Draft) -> Compound:
    return ExtensionLine(border=[(a[0], a[1], 0), (b[0], b[1], 0)], offset=offset, draft=draft)


def drawing(step: Path, out: Path, board: Path | None = None) -> dict[str, object]:
    out.mkdir(parents=True, exist_ok=True)
    case = import_step(str(step))
    whole: Shape = case
    if board and board.exists():
        whole = Compound(children=[case, import_step(str(board))])
    bb = case.bounding_box()
    size = {"width_mm": round(bb.size.X, 2), "depth_mm": round(bb.size.Y, 2), "height_mm": round(bb.size.Z, 2)}
    draft = Draft(font_size=3.5, decimal_precision=1, display_units=False, unit=Unit.MM, arrow_length=2.5, extension_gap=1)

    # third-angle: top above front, right side to the right of front
    top_v, top_h, (tw, td) = _project(whole, (0, 0, 1), (0, 1, 0))
    front_v, front_h, (fw, fh) = _project(whole, (0, -1, 0), (0, 0, 1))
    side_v, side_h, (sw, sh) = _project(whole, (1, 0, 0), (0, 0, 1))
    at_top = Location((0, fh + GAP_MM, 0))
    at_side = Location((fw + GAP_MM, 0, 0))
    svg = ExportSVG(unit=Unit.MM, line_weight=LINE, margin=12)
    svg.add_layer("visible", line_weight=LINE)
    svg.add_layer("hidden", line_weight=THIN, line_color=0x8c8c8c, line_type=LineType.ISO_DASH)
    svg.add_layer("dims", line_weight=THIN, line_color=0x0b5cad, fill_color=0x0b5cad)
    for edges, layer, loc in ((front_v, "visible", Location()), (front_h, "hidden", Location()),
                              (top_v, "visible", at_top), (top_h, "hidden", at_top),
                              (side_v, "visible", at_side), (side_h, "hidden", at_side)):
        if edges:
            svg.add_shape([e.moved(loc) for e in edges], layer=layer)
    # overall width under the front view, height left of it, depth right of the side view
    svg.add_shape(_dim((0, 0), (fw, 0), 8, draft), layer="dims")
    svg.add_shape(_dim((0, fh), (0, 0), 8, draft), layer="dims")
    svg.add_shape(_dim((fw + GAP_MM, 0), (fw + GAP_MM + sw, 0), 8, draft), layer="dims")
    svg.write(str(out / "drawing.svg"))

    # exploded three-quarter view: each part lifted by its order, the lowest first
    parts = sorted(_parts(case), key=lambda p: p[1].bounding_box().min.Z)
    lift = bb.size.Z * EXPLODE
    moved = [p.moved(Location((0, 0, i * lift))) for i, (_, p) in enumerate(parts)]
    if board and board.exists():
        b = import_step(str(board))
        moved.insert(1 if len(moved) > 1 else 0, b.moved(Location((0, 0, lift * 0.5))))
    ex_v, ex_h, _ = _project(Compound(children=moved), (1, -1, 0.8), (0, 0, 1))
    ex = ExportSVG(unit=Unit.MM, line_weight=LINE, margin=12)
    ex.add_layer("visible", line_weight=LINE)
    ex.add_layer("hidden", line_weight=THIN, line_color=0xbebebe, line_type=LineType.ISO_DASH)
    ex.add_shape(ex_v, layer="visible")
    if ex_h:
        ex.add_shape(ex_h, layer="hidden")
    ex.write(str(out / "exploded.svg"))

    facts = {**size, "parts": [{"name": n, "width_mm": round(p.bounding_box().size.X, 2), "depth_mm": round(p.bounding_box().size.Y, 2),
                               "height_mm": round(p.bounding_box().size.Z, 2)} for n, p in parts],
             "board": bool(board and board.exists()), "views": ["top", "front", "right"]}
    (out / "drawing.json").write_text(json.dumps(facts, indent=2))
    return facts
