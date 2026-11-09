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
import math
import sys
import time
from pathlib import Path

from build123d import Compound, Edge, ExportSVG, LineType, Location, Shape, Unit, import_step

LINE = 0.35        # visible edges, mm on paper
THIN = 0.18        # hidden edges and dimensions
GAP_MM = 18.0      # space between views, in model millimetres
EXPLODE = 0.6      # how far the parts move apart, as a share of the case's height


def _parts(shape: Shape) -> list[tuple[str, Shape]]:
    kids = list(getattr(shape, "children", []) or [])
    if not kids:
        return [(getattr(shape, "label", "") or "case", shape)]
    return [(getattr(k, "label", "") or f"part {i + 1}", k) for i, k in enumerate(kids)]


def _said(what: str, since: float) -> None:
    """How long a step took, on stderr: a drawing killed at its time limit says where it was (test-esp32-run3 S19)."""
    print(f"drawing: {what} in {time.monotonic() - since:.1f} s", file=sys.stderr, flush=True)


def _moved(edges, loc: Location) -> list[Edge]:
    """`edges` moved by `loc`. build123d's Shape.moved copies each edge deeply, about 12 ms an edge: the views' few
    hundred edges took 25 s here and longer on the cad function (test-esp32-run3 S19); OpenCascade's own move is instant."""
    return [Edge(e.wrapped.Moved(loc.wrapped)) for e in edges]


def _project(shape: Shape, eye: tuple[float, float, float], up: tuple[float, float, float]):
    """Visible and hidden edges of `shape` seen from direction `eye`, in the drawing's plane, its corner at (0, 0)."""
    c = shape.bounding_box().center()
    d = max(shape.bounding_box().diagonal, 1.0) * 4
    origin = (c.X + eye[0] * d, c.Y + eye[1] * d, c.Z + eye[2] * d)
    visible, hidden = shape.project_to_viewport(origin, viewport_up=up, look_at=(c.X, c.Y, c.Z))
    edges = list(visible) + list(hidden)
    bb = Compound(children=edges).bounding_box() if edges else None
    shift = Location((-bb.min.X, -bb.min.Y, 0)) if bb else Location()
    return (_moved(visible, shift), _moved(hidden, shift),
            (bb.size.X, bb.size.Y) if bb else (0.0, 0.0))


ARROW = 2.5        # dimension arrowheads, mm
TEXT_MM = 3.5      # dimension text height, mm


def _dim(a: tuple[float, float], b: tuple[float, float], normal: tuple[float, float], offset: float) -> tuple[list[Edge], tuple[float, float, float, bool]]:
    """A dimension between `a` and `b`, set `offset` out along `normal`: its extension lines, line and arrowheads as plain
    edges, and where its words go (x, y, value, upright). No build123d Draft: its text loads the system fonts through
    OpenCascade, which hung the cad function's drawing until its 840 s limit (test-esp32-run3 S19). The words are written
    into the SVG as text instead (_with_words)."""
    (ax, ay), (bx, by), (nx, ny) = a, b, normal
    length = math.hypot(bx - ax, by - ay)
    ux, uy = (bx - ax) / length, (by - ay) / length
    pa, pb = (ax + nx * offset, ay + ny * offset), (bx + nx * offset, by + ny * offset)
    line = lambda p, q: Edge.make_line((p[0], p[1], 0), (q[0], q[1], 0))  # noqa: E731
    gap, over = 1.0, 1.5
    edges = [line((ax + nx * gap, ay + ny * gap), (pa[0] + nx * over, pa[1] + ny * over)),
             line((bx + nx * gap, by + ny * gap), (pb[0] + nx * over, pb[1] + ny * over)),
             line(pa, pb)]
    w = ARROW * 0.3
    for tip, sx in ((pa, 1), (pb, -1)):
        base = (tip[0] + ux * ARROW * sx, tip[1] + uy * ARROW * sx)
        edges += [line(tip, (base[0] + nx * w, base[1] + ny * w)), line(tip, (base[0] - nx * w, base[1] - ny * w))]
    mid = ((pa[0] + pb[0]) / 2 + nx * 1.2, (pa[1] + pb[1]) / 2 + ny * 1.2)
    return edges, (mid[0], mid[1], length, abs(ux) >= abs(uy))


def _with_words(svg_path: Path, words: list[tuple[float, float, float, bool]], color: str) -> None:
    """Writes each dimension's value into the drawing as SVG text, at its model position (ExportSVG draws the model
    flipped in y, so the text goes outside that group at (x, -y), reading upright)."""
    text = svg_path.read_text()
    parts = []
    for x, y, value, upright in words:
        turn = "" if upright else f' transform="rotate(-90 {x:.3f} {-y:.3f})"'
        base = "hanging" if upright else "auto"
        parts.append(f'<text x="{x:.3f}" y="{-y:.3f}"{turn} font-family="sans-serif" font-size="{TEXT_MM}" fill="{color}" '
                     f'text-anchor="middle" dominant-baseline="{base}">{value:.1f}</text>')
    at = text.rindex("</svg>")
    svg_path.write_text(text[:at] + '  <g id="dims-text">' + "".join(parts) + "</g>\n" + text[at:])


def drawing(step: Path, out: Path, board: Path | None = None) -> dict[str, object]:
    out.mkdir(parents=True, exist_ok=True)
    t = time.monotonic()
    case = import_step(str(step))
    _said(f"read {step.name} ({len(case.faces())} faces)", t)
    whole: Shape = case
    if board and board.exists():
        whole = Compound(children=[case, import_step(str(board))])
    bb = case.bounding_box()
    size = {"width_mm": round(bb.size.X, 2), "depth_mm": round(bb.size.Y, 2), "height_mm": round(bb.size.Z, 2)}

    # third-angle: top above front, right side to the right of front
    t = time.monotonic()
    top_v, top_h, (tw, td) = _project(whole, (0, 0, 1), (0, 1, 0))
    _said("top view", t)
    t = time.monotonic()
    front_v, front_h, (fw, fh) = _project(whole, (0, -1, 0), (0, 0, 1))
    _said("front view", t)
    t = time.monotonic()
    side_v, side_h, (sw, sh) = _project(whole, (1, 0, 0), (0, 0, 1))
    _said("side view", t)
    t = time.monotonic()
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
            svg.add_shape(_moved(edges, loc), layer=layer)
    _said("views placed", t)
    # overall width under the front view, height left of it, depth under the side view
    t = time.monotonic()
    dims = [_dim((0, 0), (fw, 0), (0, -1), 8), _dim((0, 0), (0, fh), (-1, 0), 8),
            _dim((fw + GAP_MM, 0), (fw + GAP_MM + sw, 0), (0, -1), 8)]
    svg.add_shape([e for edges, _ in dims for e in edges], layer="dims")
    _said("dimensions", t)
    svg.write(str(out / "drawing.svg"))
    _with_words(out / "drawing.svg", [w for _, w in dims], "#0b5cad")

    # exploded three-quarter view: each part lifted by its order, the lowest first
    parts = sorted(_parts(case), key=lambda p: p[1].bounding_box().min.Z)
    lift = bb.size.Z * EXPLODE
    moved = [p.moved(Location((0, 0, i * lift))) for i, (_, p) in enumerate(parts)]
    if board and board.exists():
        b = import_step(str(board))
        moved.insert(1 if len(moved) > 1 else 0, b.moved(Location((0, 0, lift * 0.5))))
    t = time.monotonic()
    ex_v, ex_h, _ = _project(Compound(children=moved), (1, -1, 0.8), (0, 0, 1))
    _said("exploded view", t)
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
