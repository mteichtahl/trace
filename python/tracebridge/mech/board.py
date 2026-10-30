"""The board as solids, from board facts (facts.json) alone.

KiCad's frame has y down; the case is built in a right-handed frame with z up, so y is flipped (y_case = -y_kicad)
and the board's bottom face sits at z = 0. Nothing is moved after that: the case is built around the board where it
is, so a part's position in a result is the position a person reads in KiCad.

Parts are envelopes, not models: a box over the courtyard (or pads) as tall as the facts say, standing on the face
the part is mounted on. A through-hole part also gets a leads box on the far face, as deep as its `below_mm`, because
the leads are what reaches the floor (or the lid) first.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from build123d import Face, Pos, Shape, Solid, Vector, Wire

SLICE_MM = 0.2
MIN_BOX_MM = 0.01  # a zero-size box is not a solid; a part that thin still has to be checked


def case_xy(x: float, y: float) -> tuple[float, float]:
    """A KiCad point in the case's frame."""
    return float(x), -float(y)


def polygon_face(points: list[list[float]]) -> Face:
    """A planar face at z = 0 from a KiCad loop (closed implicitly; a repeated closing point is dropped)."""
    pts = [case_xy(*p) for p in points]
    if len(pts) > 3 and abs(pts[0][0] - pts[-1][0]) < 1e-9 and abs(pts[0][1] - pts[-1][1]) < 1e-9:
        pts = pts[:-1]
    clean: list[tuple[float, float]] = []
    for p in pts:
        if not clean or abs(p[0] - clean[-1][0]) > 1e-9 or abs(p[1] - clean[-1][1]) > 1e-9:
            clean.append(p)
    return Face(Wire.make_polygon([Vector(x, y, 0) for x, y in clean], close=True))


def extrude(face: Face, z0: float, z1: float) -> Solid:
    """A face at z = 0 extruded to the solid between z0 and z1."""
    return Solid.extrude(Pos(0, 0, z0) * face, Vector(0, 0, z1 - z0))


def box(x0: float, y0: float, z0: float, x1: float, y1: float, z1: float) -> Solid:
    """An axis-aligned box between two corners in the case's frame (in any order)."""
    lo = (min(x0, x1), min(y0, y1), min(z0, z1))
    size = [max(abs(a - b), MIN_BOX_MM) for a, b in ((x0, x1), (y0, y1), (z0, z1))]
    return Pos(*lo) * Solid.make_box(*size)


def kicad_box(b: dict[str, float], z0: float, z1: float, grow: float = 0.0) -> Solid:
    """A part's board-coordinate box (min/max x, y in KiCad's frame) between z0 and z1, grown by `grow` on every side."""
    x0, y0 = case_xy(b["min_x"] - grow, b["max_y"] + grow)
    x1, y1 = case_xy(b["max_x"] + grow, b["min_y"] - grow)
    return box(x0, y0, z0 - grow, x1, y1, z1 + grow)


@dataclass
class Board:
    """The board and its parts as solids. `parts` are the body envelopes by reference; `leads` the through-hole leads
    boxes on the far face; `slice` a 0.2 mm slab of the board at mid-thickness, so an edge gap is measured to the
    walls and not to the standoffs and rests that touch its faces."""

    facts: dict[str, Any]
    body: Shape
    slice: Shape
    outline: Face
    parts: dict[str, Solid] = field(default_factory=dict)
    leads: dict[str, Solid] = field(default_factory=dict)
    info: dict[str, dict[str, Any]] = field(default_factory=dict)
    top_z: float = 1.6
    bottom_z: float = 0.0

    @property
    def thickness(self) -> float:
        return self.top_z - self.bottom_z

    def part_span(self, ref: str) -> tuple[float, float]:
        """The z range a part's body envelope occupies."""
        p = self.info[ref]
        h = float(p.get("height_mm") or 0.0)
        return (self.top_z, self.top_z + h) if p["side"] == "top" else (self.bottom_z - h, self.bottom_z)


def load_board(facts: dict[str, Any]) -> Board:
    """Board solids from board facts: the outline extruded to the board's thickness with cutouts and holes taken out,
    a box per part, and a leads box per through-hole part."""
    t = float(facts.get("thickness_mm") or 1.6)
    outline = polygon_face(facts["outline"])
    body: Shape = extrude(outline, 0.0, t)
    slab: Shape = extrude(outline, t / 2 - SLICE_MM / 2, t / 2 + SLICE_MM / 2)
    for loop in facts.get("cutouts") or []:
        if len(loop) >= 3:
            cut = extrude(polygon_face(loop), -1.0, t + 1.0)
            body = body - cut
            slab = slab - cut
    for h in facts.get("holes") or []:
        x, y = case_xy(h["x"], h["y"])
        r = float(h["d"]) / 2
        if r <= 0:
            continue
        body = body - (Pos(x, y, -1.0) * Solid.make_cylinder(r, t + 2.0))
    board = Board(facts=facts, body=body, slice=slab, outline=outline, top_z=t, bottom_z=0.0)
    for p in facts.get("parts") or []:
        ref = p["ref"]
        board.info[ref] = p
        z0, z1 = board.part_span(ref)
        board.parts[ref] = kicad_box(p["box"], z0, z1)
        below = float(p.get("below_mm") or 0.0)
        if p.get("mount") == "through_hole" and below > 0:
            # Leads come out of the face opposite the one the part sits on.
            lz0, lz1 = (-below, 0.0) if p["side"] == "top" else (t, t + below)
            board.leads[ref] = kicad_box(p["box"], lz0, lz1)
    return board
