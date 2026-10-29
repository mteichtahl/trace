"""The printed two-part shell (template "printed-shell"): a base the board screws into and a lid that drops onto it.

Heights, in the case's frame (board bottom face at z = 0, top face at z = thickness):

  floor top      -standoff, where standoff = max(bottom-side part + its clearance, through-hole leads + below_mm,
                 3 mm): the board stands on bosses (or corner rests) this tall
  split          the board's top face: the base's walls stop there and the lid's start, so the board drops into the
                 base and the lid closes over it
  lid inner face top face + tallest top-side part + above_tallest_mm (a part's own clearance wins when larger)

In plan, the board sits in the inner cavity, the board outline grown by `edge_mm`. The lid's lip is a ring `lip_mm`
wide on the lid's underside whose inner face is the inner cavity's edge, hanging `lip_h_mm` below the split; the
base's cavity is the inner cavity grown by `lip_mm` + the process's assembly clearance (from the capabilities,
through settings["resolved"]), so the lip drops into the base with that clearance all round, and the base's wall
outside it is the full `wall_mm` (the outside is the base's cavity grown by `wall_mm`, with its vertical edges
filleted). Why this joint: the earlier design cut the lip's room out of the base's wall, leaving
wall - lip - clearance (0.6 mm with the defaults) beside the lip, under every printing process's minimum wall for a
case this size; here no section of the base or the lip is thinner than its own parameter, so a wall_mm and lip_mm
that meet the process minimum give a case whose built sections do (the rules measure them on the model). The lip
also stands beside the board's edge at edge_mm, so the board's edge gap is the same all round, to the lip where it
hangs and to the lid's wall above. The lid's wall above the split runs from the outside in to the inner cavity, so
it is wall_mm + clearance + lip_mm thick. The lip may hang no lower than the floor's top less LIP_FLOOR_MARGIN_MM
(see lip_room).

For a CNC process (service jlccnc or a process named CNC*) the inner vertical edges of the base's and lid's
cavities are filleted to R = depth / 10 + 0.5 mm (R0.5 for a cavity up to 3 mm deep), JLCCNC's rule for a cutter
reaching that deep, so the inside corners can be machined.

Openings are cut for connectors at an edge, and only in the wall (never the floor, the lid's top or a boss), so an
opening that spans the split is cut through both parts.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from build123d import Axis, Face, Kind, Pos, Shape, Solid, Vector, offset

from .board import Board, box, case_xy, extrude, kicad_box
from .settings import FALLBACK_ASSEMBLY_CLEARANCE_MM, InputError, part_clearance

MIN_STANDOFF_MM = 3.0
# The lip's lowest point stays this far above the base's floor: the lid bears on the base's wall, not on its lip, and
# 0.5 mm is more than the ±0.3 mm a printed part may be off by (JLC3DP's MJF tolerance, the loosest of the printing
# rows up to 100 mm), so a part at the far end of its tolerance still seats on the wall.
LIP_FLOOR_MARGIN_MM = 0.5
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


def lip_room(hz: dict[str, float]) -> float:
    """The deepest lip the base has room for: from the split down to the floor's top, less LIP_FLOOR_MARGIN_MM."""
    return round(hz["split_z"] - hz["floor_top_z"] - LIP_FLOOR_MARGIN_MM, 3)


def check_lip(board: Board, settings: dict[str, Any]) -> None:
    """InputError when params.lip_h_mm is deeper than the base has room for (see lip_room)."""
    room = lip_room(heights(board, settings))
    lip_h = settings["params"]["lip_h_mm"]
    if lip_h > room + 1e-9:
        raise InputError(f"params.lip_h_mm {lip_h:g} mm is deeper than the base has room for: {room:g} mm from the "
                         f"split to {LIP_FLOOR_MARGIN_MM:g} mm above the floor (raise clearance.below_mm or lower "
                         f"the lip)")


def is_cnc(settings: dict[str, Any]) -> bool:
    p = settings["process"]
    return p["service"].lower() == "jlccnc" or p["process"].lower().startswith("cnc")


def cnc_radius(depth: float) -> float:
    """JLCCNC's inside corner radius for a cavity `depth` deep: R = H / 10 + 0.5 mm, R0.5 up to 3 mm."""
    return 0.5 if depth <= 3 else round(depth / 10 + 0.5, 3)


# Corners blunter than this are not measured: the radius a probe infers grows without bound as a corner flattens.
CORNER_MAX_DEG = 135.0


def convex_corners(face: Face, with_edges: bool = False) -> list[tuple]:
    """The cavity outline's convex corners sharper than CORNER_MAX_DEG: (vertex, inward bisector, angle in rad)."""
    edges = face.outer_wire().edges()
    by_vertex: dict[tuple[float, float], list[tuple[float, float]]] = {}
    for e in edges:
        a, b = e.position_at(0), e.position_at(1)
        ka, kb = (round(a.X, 6), round(a.Y, 6)), (round(b.X, 6), round(b.Y, 6))
        by_vertex.setdefault(ka, []).append(kb)
        by_vertex.setdefault(kb, []).append(ka)
    out = []
    for v, nb in by_vertex.items():
        if len(nb) != 2:
            continue
        u = []
        for n in nb:
            dx, dy = n[0] - v[0], n[1] - v[1]
            ln = math.hypot(dx, dy)
            u.append((dx / ln, dy / ln))
        ang = math.acos(max(-1.0, min(1.0, u[0][0] * u[1][0] + u[0][1] * u[1][1])))
        bx, by = u[0][0] + u[1][0], u[0][1] + u[1][1]
        bl = math.hypot(bx, by)
        if bl < 1e-9 or math.degrees(ang) > CORNER_MAX_DEG:
            continue
        bis = (bx / bl, by / bl)
        if not face.is_inside(Vector(v[0] + bis[0] * 0.01, v[1] + bis[1] * 0.01, 0)):
            continue  # a reflex corner: the cutter leaves it sharp
        out.append((v, bis, ang, u) if with_edges else (v, bis, ang))
    return out


def cavity_edge_mm(board: Board, settings: dict[str, Any]) -> float:
    """How far the inner cavity stands off the board outline: edge_mm, or for a CNC case more where the lid pocket's
    corner radius R (cnc_radius of its depth) is larger than edge_mm. A fillet of radius R in a corner of interior
    angle θ comes R (1 / sin(θ/2) - 1) in from the sharp corner along its bisector, so to keep the board's own corner
    edge_mm clear of it the whole outline stands off by R - sin(θ/2) (R - edge_mm), at the board's sharpest convex
    corner. The gap is then the same all along the sides (only larger than asked), which the fit check reports."""
    e = settings["clearance"]["edge_mm"]
    if not is_cnc(settings):
        return e
    hz = heights(board, settings)
    r = cnc_radius(hz["lid_inner_z"] - (hz["split_z"] - settings["params"]["lip_h_mm"]))
    if r <= e:
        return e
    corners = convex_corners(board.outline)
    s = min((math.sin(a / 2) for _, _, a in corners), default=1.0)
    return round(r - s * (r - e), 3)


def _fillet(solid: Solid, r: float, notes: list[str], what: str = "corner fillet") -> Solid:
    if r <= 0:
        return solid
    try:
        out = solid.fillet(r, solid.edges().filter_by(Axis.Z))
        if out is None or not out.is_valid:
            raise ValueError("invalid result")
        return out
    except Exception as e:  # noqa: BLE001 - OpenCascade raises several kinds for a fillet it cannot make
        notes.append(f"{what} of {r} mm could not be made ({type(e).__name__}): those corners are sharp")
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

    check_lip(board, settings)
    edge = cavity_edge_mm(board, settings)
    if edge > clr["edge_mm"] + 1e-9:
        notes.append(f"CNC: the board's edge gap is {edge:g} mm, not {clr['edge_mm']:g} mm, so the cavity's R"
                     f"{cnc_radius(lid_in - (t - prm['lip_h_mm'])):g} mm inside corners clear the board's corners")
    cavity = grow(board.outline, edge)
    lip_w = prm["lip_mm"]
    base_cavity = grow(cavity, lip_w + fit_clr)
    outer = _fillet(extrude(grow(base_cavity, prm["wall_mm"]), z_bot, z_top), prm["corner_radius_mm"], notes)
    bb = outer.bounding_box()
    below_split = box(bb.min.X - 1, bb.min.Y - 1, z_bot - 1, bb.max.X + 1, bb.max.Y + 1, t)
    above_split = box(bb.min.X - 1, bb.min.Y - 1, t, bb.max.X + 1, bb.max.Y + 1, z_top + 1)

    # The pockets: the base's down to the floor's top; the lid's up to its inner face and down to the lip's foot (so
    # the lip's inner face is the inner cavity's edge, filleted with the lid's pocket on a CNC case).
    z_lip = t - prm["lip_h_mm"]
    base_pocket = extrude(base_cavity, floor_top, t + 1)
    lid_pocket = extrude(cavity, z_lip - 1, lid_in)
    inner_r: dict[str, float] = {}
    if is_cnc(settings):
        for name, depth in (("base", t - floor_top), ("lid", lid_in - z_lip)):
            r = cnc_radius(depth)
            pocket = base_pocket if name == "base" else lid_pocket
            done = _fillet(pocket, r, notes, what=f"inner corner fillet ({name})")
            if done is not pocket:
                inner_r[name] = r
            if name == "base":
                base_pocket = done
            else:
                lid_pocket = done
    base: Shape = (outer & below_split) - base_pocket
    ring_out: Shape = extrude(grow(cavity, lip_w), z_lip, t + 0.01)
    if "base" in inner_r and inner_r["base"] - fit_clr > 0.05:
        # The base pocket's corners are rounded: round the lip's outside corners concentrically (R less the
        # clearance), so the clearance is the same at a corner as along a side and the lip's corner does not bind.
        ring_out = _fillet(ring_out, round(inner_r["base"] - fit_clr, 3), notes, what="lip corner fillet")
    ring = ring_out - lid_pocket
    lid: Shape = ((outer & above_split) - lid_pocket) + ring

    holes = [h for h in board.facts.get("holes") or [] if h.get("kind") == "mounting"]
    standoff = hz["standoff_mm"]
    if holes:
        # Bosses stay inside the inner cavity, so one near the board edge never grows into the band the lip drops into.
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
                        "clearance_mm": fit_clr})

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
        "lip_gap_mm": fit_clr, "lip_mm": lip_w, "lip_bottom_z": z_lip, "inner_radius_mm": inner_r,
        "base_cavity_depth_mm": t - floor_top, "lid_cavity_depth_mm": lid_in - t,
        "openings": openings,
    }
    return case
