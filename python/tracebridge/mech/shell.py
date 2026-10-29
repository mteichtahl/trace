"""The printed two-part shell (template "printed-shell"): a base the board screws into and a lid that drops onto it.

Heights, in the case's frame (board bottom face at z = 0, top face at z = thickness):

  floor top      -standoff, where standoff = max(bottom-side part + its clearance, through-hole leads + below_mm,
                 3 mm): the board stands on bosses (or corner rests) this tall
  split          the board's top face: the base's walls stop there and the lid's start, so the board drops into the
                 base and the lid closes over it
  lid inner face top face + tallest top-side part + above_tallest_mm (a part's own clearance wins when larger)

In plan, the cavity is the board outline grown by `edge_mm`, and the outside is the cavity grown by `wall_mm`, with
its vertical edges filleted. The lid's lip is a ring `lip_mm` wide in the inner band of the wall, `lip_h_mm` deep
below the split; the base's wall is cut back to make room for it with the process's assembly clearance (from the
capabilities, through settings["resolved"]), so the lip's inner face stays flush with the cavity and the board's
edge gap is the same everywhere.

Openings are cut for connectors at an edge, and only in the wall (never the floor, the lid's top or a boss), so an
opening that spans the split is cut through both parts.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from build123d import Axis, Face, Kind, Pos, Shape, Solid, offset

from .board import Board, box, case_xy, extrude, kicad_box
from .settings import FALLBACK_ASSEMBLY_CLEARANCE_MM, part_clearance

MIN_STANDOFF_MM = 3.0
# How far from a corner a rest and its post may move, along either edge, to keep clear of the parts.
SUPPORT_SEARCH_MM = 25.0


def support_spots(board: Board, settings: dict[str, Any], side: float) -> list[tuple[float, float]]:
    """For a board without mounting holes: the lower-left corner (case frame) of one square support `side` wide near
    each corner of the outline, found by stepping in from the corner 0.5 mm at a time along both edges, nearest
    first. A spot is clear when the square lies on the board and is at least each part's clearance away, in plan,
    from that part: top-side bodies against the lid's post, bottom-side bodies and through-hole leads against the
    floor's rest. Corners with no clear spot within SUPPORT_SEARCH_MM are left out."""
    c = settings["clearance"]
    keep_out: list[tuple[float, float, float, float]] = []  # case-frame rectangles grown by the clearance they need
    for ref, p in board.info.items():
        b = p["box"]
        x0, y0 = case_xy(b["min_x"], b["max_y"])
        x1, y1 = case_xy(b["max_x"], b["min_y"])
        own = part_clearance(settings, ref)
        need = max(c["above_tallest_mm"], c["below_mm"], own or 0.0)
        keep_out.append((x0 - need, y0 - need, x1 + need, y1 + need))
    outline = board.outline
    area = side * side

    def clear(x: float, y: float) -> bool:
        if any(x < kx1 and x + side > kx0 and y < ky1 and y + side > ky0 for kx0, ky0, kx1, ky1 in keep_out):
            return False
        sq = Face.make_rect(side, side).moved(Pos(x + side / 2, y + side / 2, 0))
        return abs((sq & outline).area - area) < 1e-6 * max(area, 1.0)

    ob = outline.bounding_box()
    steps = [i * 0.5 for i in range(int(SUPPORT_SEARCH_MM / 0.5) + 1)]
    order = sorted(((dx, dy) for dx in steps for dy in steps), key=lambda d: (d[0] + d[1], d[0]))
    spots: list[tuple[float, float]] = []
    for sx_sign, sy_sign in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
        x_edge = ob.min.X if sx_sign > 0 else ob.max.X - side
        y_edge = ob.min.Y if sy_sign > 0 else ob.max.Y - side
        for dx, dy in order:
            x, y = x_edge + sx_sign * dx, y_edge + sy_sign * dy
            if clear(x, y) and all(abs(x - px) >= side or abs(y - py) >= side for px, py in spots):
                spots.append((x, y))
                break
    return spots
FAR = 1000.0  # past any case: an opening reaches this far outward, a column this far up
# Screw sizes by mounting-hole diameter (the contract's table), with pilot holes for thread-forming screws in plastic
# at 0.8 x the nominal diameter.
SCREWS = ((2.5, "M2", 2.0), (3.0, "M2.5", 2.5), (3.6, "M3", 3.0), (float("inf"), "M4", 4.0))
PILOT_RATIO = 0.8
SCREW_LENGTHS_MM = (3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 25, 30)


@dataclass
class Case:
    """What a case script returns. `parts` are the printable solids by name ("base", "lid", or "case" for a handed-in
    file); `joints` and `fasteners` feed the records; `notes` say what the engine changed or could not do; `source`
    is "script" or "file"; `meta` holds the built numbers the fit and rules read (heights, lip gap, openings)."""

    parts: dict[str, Shape] = field(default_factory=dict)
    joints: list[dict[str, Any]] = field(default_factory=list)
    fasteners: list[dict[str, Any]] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    source: str = "script"
    meta: dict[str, Any] = field(default_factory=dict)


def grow(face: Face, mm: float) -> Face:
    """A face offset outward by `mm`, keeping sharp corners so a gap is the same at a corner as along a side."""
    if mm <= 0:
        return face
    return max(offset(face, mm, kind=Kind.INTERSECTION).faces(), key=lambda f: f.area)


def screw_for(d: float) -> tuple[str, float]:
    """The screw size for a mounting hole of diameter d, and its pilot hole diameter."""
    for limit, size, nominal in SCREWS:
        if d < limit:
            return size, round(nominal * PILOT_RATIO, 2)
    raise AssertionError("unreachable")


def screw_length(reach_mm: float) -> int:
    """The longest standard length that does not pass through the boss into the floor."""
    fits = [n for n in SCREW_LENGTHS_MM if n <= reach_mm + 1e-9]
    return fits[-1] if fits else SCREW_LENGTHS_MM[0]


def heights(board: Board, settings: dict[str, Any]) -> dict[str, float]:
    """The standoff (board bottom to floor top) and the lid's inner face, from the parts and the clearances."""
    c = settings["clearance"]
    t = board.top_z
    above, below = c["above_tallest_mm"], c["below_mm"]
    up = [above]  # room needed above the top face
    down = [MIN_STANDOFF_MM - below]  # so the standoff is at least 3 mm
    up_override: list[float] = []
    down_override: list[float] = []
    for ref, p in board.info.items():
        h = float(p.get("height_mm") or 0.0)
        own = part_clearance(settings, ref)
        lead = float(p.get("below_mm") or 0.0) if p.get("mount") == "through_hole" else 0.0
        if p["side"] == "top":
            up.append(h + above)
            down.append(lead)
            if own is not None:
                up_override.append(h + own)
        else:
            down.append(h)
            up.append(lead + above if lead else above)
            if own is not None:
                down_override.append(h + own)
    standoff = max(max(down) + below, max(down_override, default=0.0), MIN_STANDOFF_MM)
    lid_in = t + max(max(up), max(up_override, default=0.0))
    return {"standoff_mm": standoff, "floor_top_z": -standoff, "split_z": t, "lid_inner_z": lid_in}


def _fillet(solid: Solid, r: float, notes: list[str]) -> Solid:
    if r <= 0:
        return solid
    try:
        out = solid.fillet(r, solid.edges().filter_by(Axis.Z))
        if out is None or not out.is_valid:
            raise ValueError("invalid result")
        return out
    except Exception as e:  # noqa: BLE001 - OpenCascade raises several kinds for a fillet it cannot make
        notes.append(f"corner fillet of {r} mm could not be made ({type(e).__name__}): the outside corners are sharp")
        return solid


def _opening_tool(board: Board, p: dict[str, Any], grow_mm: float) -> Shape:
    """The part's box grown by `grow_mm`, carried outward through its edge's wall."""
    z0, z1 = board.part_span(p["ref"])
    tool = kicad_box(p["box"], z0, z1, grow_mm)
    bb = tool.bounding_box()
    x0, y0, x1, y1 = bb.min.X, bb.min.Y, bb.max.X, bb.max.Y
    side = p["edge"]["side"]
    if side == "west":
        x0 = -FAR
    elif side == "east":
        x1 = FAR
    elif side == "north":  # KiCad's min y is the case's max y
        y1 = FAR
    else:
        y0 = -FAR
    return box(x0, y0, bb.min.Z, x1, y1, bb.max.Z)


def _volume(s: Shape | None) -> float:
    return float(s.volume) if s is not None else 0.0


def two_part(board: Board, settings: dict[str, Any]) -> Case:
    """Base and lid around the board (see the module docstring for the geometry)."""
    prm, clr = settings["params"], settings["clearance"]
    resolved = settings.get("resolved") or {}
    fit_clr = float(resolved.get("assembly_clearance_mm", FALLBACK_ASSEMBLY_CLEARANCE_MM))
    case = Case(source="script")
    notes = case.notes
    if "resolved" not in settings:
        notes.append(f"no process capabilities given to the shell: lip clearance {fit_clr} mm assumed")
    t = board.top_z
    hz = heights(board, settings)
    floor_top, lid_in = hz["floor_top_z"], hz["lid_inner_z"]
    z_bot = floor_top - prm["floor_mm"]
    z_top = lid_in + prm["lid_mm"]

    cavity = grow(board.outline, clr["edge_mm"])
    outer = _fillet(extrude(grow(cavity, prm["wall_mm"]), z_bot, z_top), prm["corner_radius_mm"], notes)
    bb = outer.bounding_box()
    below_split = box(bb.min.X - 1, bb.min.Y - 1, z_bot - 1, bb.max.X + 1, bb.max.Y + 1, t)
    above_split = box(bb.min.X - 1, bb.min.Y - 1, t, bb.max.X + 1, bb.max.Y + 1, z_top + 1)

    base: Shape = (outer & below_split) - extrude(cavity, floor_top, t + 1)
    lid: Shape = (outer & above_split) - extrude(cavity, t - 1, lid_in)

    lip_made = prm["lip_mm"] + fit_clr < prm["wall_mm"]
    if lip_made:
        z_lip = t - prm["lip_h_mm"]
        base = base - extrude(grow(cavity, prm["lip_mm"] + fit_clr), z_lip, t + 1)
        ring = extrude(grow(cavity, prm["lip_mm"]), z_lip, t) - extrude(cavity, z_lip - 1, t + 1)
        lid = lid + ring
    else:
        notes.append(f"no lip: lip {prm['lip_mm']} mm + clearance {fit_clr} mm leaves no wall of the "
                     f"{prm['wall_mm']} mm base; the lid sits on the base's wall")

    holes = [h for h in board.facts.get("holes") or [] if h.get("kind") == "mounting"]
    standoff = hz["standoff_mm"]
    if holes:
        # Bosses stay inside the cavity, so one near the board edge never grows into the wall where the lid's lip sits.
        inside = extrude(cavity, floor_top - 1, t)
        for i, h in enumerate(holes, 1):
            ref = h.get("ref") or f"hole{i}"
            x, y = case_xy(h["x"], h["y"])
            size, pilot = screw_for(float(h["d"]))
            boss = Pos(x, y, floor_top - 0.01) * Solid.make_cylinder(prm["standoff_d_mm"] / 2, standoff + 0.01)
            base = (base + (boss & inside)) - Pos(x, y, floor_top) * Solid.make_cylinder(pilot / 2, standoff + 0.01)
            length = screw_length(t + standoff)
            case.fasteners.append({"id": f"fastener:{ref}", "ref": ref, "size": size, "length_mm": length,
                                   "pilot_d_mm": pilot, "hole_d_mm": float(h["d"]), "x": h["x"], "y": h["y"]})
            case.joints.append({"id": f"joint:{ref}", "type": "fastened", "connects": ["board", "base"],
                                "fastener": f"fastener:{ref}"})
    else:
        # No mounting holes: the board is clamped between rests on the floor and posts in the lid, one pair near each
        # corner, each at the nearest spot that keeps every part's clearance (a connector often sits in a corner).
        side = prm["standoff_d_mm"]
        spots = support_spots(board, settings, side)
        for sx, sy in spots:
            base = base + box(sx, sy, floor_top - 0.01, sx + side, sy + side, 0.0)
            lid = lid + box(sx, sy, t, sx + side, sy + side, lid_in + 0.01)
        missed = 4 - len(spots)
        notes.append(f"no mounting holes: the board rests on {len(spots)} rests and is held by {len(spots)} lid posts"
                     + (f"; {missed} corner{'s' if missed > 1 else ''} had no clear spot within "
                        f"{SUPPORT_SEARCH_MM:g} mm" if missed else ""))
        if len(spots) < 3:
            notes.append("fewer than three supports: the board is not held level; add mounting holes or free a corner")
    case.joints.append({"id": "joint:lid-base", "type": "press_fit", "connects": ["lid", "base"],
                        "clearance_mm": fit_clr if lip_made else None})

    wall_band = outer - extrude(cavity, z_bot - 1, z_top + 1)
    openings = []
    skip = set(settings["openings"]["skip"])
    for ref, p in sorted(board.info.items()):
        if not (p.get("connector") and p.get("edge")):
            continue
        side = p["edge"]["side"]
        if ref in skip:
            openings.append({"ref": ref, "side": side, "made": False, "reason": "skipped by openings.skip"})
            continue
        g = settings["openings"]["extra_mm"] + (part_clearance(settings, ref) or 0.0)
        tool = _opening_tool(board, p, g) & wall_band
        if tool is None or _volume(tool) < 1e-6:
            openings.append({"ref": ref, "side": side, "made": False, "reason": "does not reach the wall"})
            continue
        # Cut from both parts: a cut that misses one leaves it as it was, so an opening spanning the split is made
        # in each part it crosses.
        base = base - tool
        lid = lid - tool
        openings.append({"ref": ref, "side": side, "made": True})

    case.parts = {"base": base, "lid": lid}
    for name, s in case.parts.items():
        s.label = name
    case.meta = {
        **hz, "floor_bottom_z": z_bot, "lid_top_z": z_top,
        "wall_mm": prm["wall_mm"], "floor_mm": prm["floor_mm"], "lid_mm": prm["lid_mm"],
        "lip_gap_mm": fit_clr if lip_made else None, "lip_mm": prm["lip_mm"] if lip_made else None,
        "base_cavity_depth_mm": t - floor_top, "lid_cavity_depth_mm": lid_in - t,
        "openings": openings,
    }
    return case
