"""Two more case templates beside the printed two-part shell (plan P7.3): an extruded box and a DIN rail enclosure.

Both are built around the board where it is, in the case's frame (board bottom face at z = 0, x along the board's
width as KiCad shows it, y flipped), from the same heights the shell uses (shell.heights: the room above the tallest
part and below the bottom side), so a part that fits the shell fits these too unless it is near an edge that one of
them holds the board by.

extruded_box(board, settings) -> Case   template "extruded-box"
    A rectangular tube along x, open at both ends, and two end plates. The board slides in along two guides on each
    side wall, one under its edge and one over it, each `GUIDE_MM` deep and reaching `GUIDE_OVER_MM` over the board,
    with the process's assembly clearance above and below the board; the guides stop `lip_h_mm` + 1 mm short of each
    end, where the end plates' skirts go. Each end plate is a flat plate the wall's thickness with a skirt `lip_mm`
    thick and `lip_h_mm` deep that slides over the tube's end with the assembly clearance all round (a press fit).
    Parts: tube, end-west, end-east. The tube's cross-section is the board's box grown by edge_mm in y; its length is
    the board's box grown by edge_mm in x. Openings: a connector at the west or east edge is cut through that end
    plate, one at the north or south edge through the tube's wall. The board's mounting holes are not used (the
    guides hold it), so no screws stand on the board.

din_rail(board, settings) -> Case   template "din-rail"
    The printed two-part shell with a foot under the base that clips onto a 35 mm top-hat rail (EN 60715, the rail
    along x): a spacer `RAIL_SPACER_MM` under the floor, a slot for the rail's two flanges (`RAIL_FLANGE_MM` thick,
    with the assembly clearance), and a hook `RAIL_HOOK_MM` thick under each flange, reaching `RAIL_HOOK_OVER_MM`
    under it. The foot is at least as wide as the rail and its hooks; on a narrow board it is wider than the case.

section_probes(template, board, settings) gives the rays rules.py measures each built section on, worked out here in
the parent process from the board and the settings (never from what a case script claims), the same way the
templates place their walls: for the extruded box its tube's wall, floor and top, the end plates and their skirts;
for the DIN rail enclosure the shell's sections and the rail clip's hooks. The fit check reads the template from the
settings too: the extruded box puts no screws in the board's mounting holes, so no screw heads stand on the board.
"""
from __future__ import annotations

from typing import Any

from build123d import Axis, Shape, Solid

from .board import Board, box
from .settings import FALLBACK_ASSEMBLY_CLEARANCE_MM, part_clearance
from .shell import Case, _opening_tool, _volume, heights, two_part

# extruded box
GUIDE_MM = 1.5  # how tall each guide is (z)
GUIDE_OVER_MM = 1.0  # how far a guide reaches over the board's edge (y)
END_GAP_MM = 1.0  # beyond the skirt's depth, how far short of each end the guides stop

# DIN rail (EN 60715 top-hat rail, 35 mm wide, 1 mm flanges; 7.5 mm tall)
RAIL_WIDTH_MM = 35.0
RAIL_FLANGE_MM = 1.0
RAIL_FLANGE_WIDTH_MM = 5.0
RAIL_SPACER_MM = 2.0
RAIL_HOOK_MM = 2.0
RAIL_HOOK_OVER_MM = 1.5
RAIL_SIDE_MM = 2.0  # the foot's wall beside each flange's edge


def _fit_clearance(settings: dict[str, Any]) -> float:
    return float((settings.get("resolved") or {}).get("assembly_clearance_mm", FALLBACK_ASSEMBLY_CLEARANCE_MM))


def _fillet_x(solid: Solid, r: float, notes: list[str]) -> Solid:
    """The tube's long edges rounded (its corners as seen down its length)."""
    if r <= 0:
        return solid
    try:
        out = solid.fillet(r, solid.edges().filter_by(Axis.X))
        if out is None or not out.is_valid:
            raise ValueError("invalid result")
        return out
    except Exception as e:  # noqa: BLE001 - OpenCascade raises several kinds for a fillet it cannot make
        notes.append(f"corner fillet of {r} mm could not be made ({type(e).__name__}): the tube's long edges are sharp")
        return solid


def _box_frame(board: Board, settings: dict[str, Any]) -> dict[str, float]:
    """Where the extruded box's walls are, from the board and the settings alone."""
    prm = settings["params"]
    e = settings["clearance"]["edge_mm"]
    hz = heights(board, settings)
    bb = board.outline.bounding_box()
    f = {**hz, "fit": _fit_clearance(settings), "w": prm["wall_mm"], "skirt": prm["lip_mm"], "skirt_h": prm["lip_h_mm"],
         "x0": bb.min.X - e, "x1": bb.max.X + e, "y0": bb.min.Y - e, "y1": bb.max.Y + e,
         "z_bot": hz["floor_top_z"] - prm["floor_mm"], "z_top": hz["lid_inner_z"] + prm["lid_mm"]}
    f["cz"] = (f["lid_inner_z"] + f["split_z"] + f["fit"] + GUIDE_MM) / 2  # between the upper guides and the top
    return f


def extruded_box(board: Board, settings: dict[str, Any]) -> Case:
    prm = settings["params"]
    e = settings["clearance"]["edge_mm"]
    case = Case(source="script")
    notes = case.notes
    fr = _box_frame(board, settings)
    fit = fr["fit"]
    if "resolved" not in settings:
        notes.append(f"no process capabilities given to the box: sliding clearance {fit} mm assumed")
    hz = heights(board, settings)
    t, floor_top, lid_in = hz["split_z"], hz["floor_top_z"], hz["lid_inner_z"]
    w, skirt, skirt_h = fr["w"], fr["skirt"], fr["skirt_h"]
    z_bot, z_top = fr["z_bot"], fr["z_top"]
    x0, x1, y0, y1 = fr["x0"], fr["x1"], fr["y0"], fr["y1"]
    yo0, yo1 = y0 - w, y1 + w  # the tube's outside

    tube: Shape = _fillet_x(box(x0, yo0, z_bot, x1, yo1, z_top), prm["corner_radius_mm"], notes)
    tube = tube - box(x0 - 1, y0, floor_top, x1 + 1, y1, lid_in)
    # the guides: under and over each side edge of the board, stopping short of the end plates' skirts
    gx0, gx1 = x0 + skirt_h + END_GAP_MM, x1 - skirt_h - END_GAP_MM
    reach = e + GUIDE_OVER_MM
    for ya, yb in ((y0, y0 + reach), (y1 - reach, y1)):
        tube = tube + box(gx0, ya - 0.01, -fit - GUIDE_MM, gx1, yb, -fit)
        tube = tube + box(gx0, ya - 0.01, t + fit, gx1, yb, t + fit + GUIDE_MM)

    # the end plates: a plate the wall's thickness, and a skirt over the tube's end with the assembly clearance
    ends: dict[str, Shape] = {}
    for name, xa, xb, xs in (("end-west", x0 - w, x0, x0 + skirt_h), ("end-east", x1, x1 + w, x1 - skirt_h)):
        plate = box(xa, yo0 - fit - skirt, z_bot - fit - skirt, xb, yo1 + fit + skirt, z_top + fit + skirt)
        lo, hi = (xb, xs) if xs > xb else (xs, xa)
        ring = box(lo, yo0 - fit - skirt, z_bot - fit - skirt, hi, yo1 + fit + skirt, z_top + fit + skirt) \
            - box(lo - 1, yo0 - fit, z_bot - fit, hi + 1, yo1 + fit, z_top + fit)
        ends[name] = plate + ring

    # openings: a connector at the west or east edge through that end plate, north or south through the tube's wall
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
        tool = _opening_tool(board, p, g)
        name = {"west": "end-west", "east": "end-east"}.get(side, "tube")
        target = ends[name] if name != "tube" else tube
        if _volume(tool & target) < 1e-6:
            openings.append({"ref": ref, "side": side, "made": False, "reason": "does not reach the wall"})
            continue
        if name == "tube":
            tube = tube - tool
        else:
            ends[name] = ends[name] - tool
        openings.append({"ref": ref, "side": side, "made": True, "parts": [name]})

    case.parts = {"tube": tube, **ends}
    for name, s in case.parts.items():
        s.label = name
    case.joints = [
        {"id": "joint:end-west", "type": "press_fit", "connects": ["end-west", "tube"], "clearance_mm": fit},
        {"id": "joint:end-east", "type": "press_fit", "connects": ["end-east", "tube"], "clearance_mm": fit},
        {"id": "joint:board-guides", "type": "sliding", "connects": ["board", "tube"], "clearance_mm": fit},
    ]
    case.meta = {
        **hz, "template": "extruded-box", "floor_bottom_z": z_bot, "lid_top_z": z_top,
        "wall_mm": w, "floor_mm": prm["floor_mm"], "lid_mm": prm["lid_mm"], "lip_gap_mm": fit, "openings": openings,
    }
    return case


def section_probes(template: str, board: Board, settings: dict[str, Any]) -> list[dict[str, Any]]:
    """The rays each built section of `template`'s case is measured on (rules.py): {rule, part, what, pick, rays}, a
    ray [origin, direction] in the case's frame, `pick` the ray's first or outermost solid stretch through the part.
    The printed shell's own sections are rules.SECTIONS; this gives the other templates' (the DIN rail enclosure's
    in addition to the shell's)."""
    if template == "extruded-box":
        fr = _box_frame(board, settings)
        x0, x1, cy, cz, skirt_h = fr["x0"], fr["x1"], (fr["y0"] + fr["y1"]) / 2, fr["cz"], fr["skirt_h"]
        floor_top, lid_in = fr["floor_top_z"], fr["lid_inner_z"]
        cx = (x0 + x1) / 2
        xs = [x0 + f * (x1 - x0) for f in (0.3, 0.5, 0.7)]
        return [
            {"rule": "tube_wall", "part": "tube", "what": "the tube's side wall", "pick": "outermost",
             "rays": [[[x, cy, cz], [0, s, 0]] for x in xs for s in (-1, 1)]},
            {"rule": "tube_floor", "part": "tube", "what": "the tube's floor", "pick": "outermost",
             "rays": [[[x, cy, floor_top + 0.05], [0, 0, -1]] for x in xs]},
            {"rule": "tube_top", "part": "tube", "what": "the tube's top", "pick": "outermost",
             "rays": [[[x, cy, lid_in - 0.05], [0, 0, 1]] for x in xs]},
            {"rule": "end_wall", "part": "end-west", "what": "the west end plate", "pick": "outermost",
             "rays": [[[cx, cy, cz], [-1, 0, 0]]]},
            {"rule": "end_wall", "part": "end-east", "what": "the east end plate", "pick": "outermost",
             "rays": [[[cx, cy, cz], [1, 0, 0]]]},
            {"rule": "skirt", "part": "end-west", "what": "the west end plate's skirt", "pick": "outermost",
             "rays": [[[x0 + skirt_h / 2, cy, cz], [0, s, 0]] for s in (-1, 1)]},
        ]
    if template == "din-rail":
        r = _rail_frame(board, settings)
        x0, x1, cy = r["x0"], r["x1"], r["cy"]
        return [{"rule": "rail_hook", "part": "base", "what": "the rail clip's hook", "pick": "first",
                 "rays": [[[x, cy + s * (r["half_slot"] - RAIL_HOOK_OVER_MM / 2), r["z_slot"] + 0.05], [0, 0, -1]]
                          for x in (x0 + 0.3 * (x1 - x0), x0 + 0.7 * (x1 - x0)) for s in (-1, 1)]}]
    return []


def _rail_frame(board: Board, settings: dict[str, Any]) -> dict[str, float]:
    """Where the DIN rail foot goes, from the board and the settings alone: under the shell's base (its outside is the
    board outline grown by edge_mm, the lip and its clearance, and the wall)."""
    fit = _fit_clearance(settings)
    prm = settings["params"]
    hz = heights(board, settings)
    grow_by = settings["clearance"]["edge_mm"] + prm["lip_mm"] + fit + prm["wall_mm"]
    bb = board.outline.bounding_box()
    y0, y1 = bb.min.Y - grow_by, bb.max.Y + grow_by
    half_slot = RAIL_WIDTH_MM / 2 + fit  # the rail's edges, with clearance
    z_bot = hz["floor_top_z"] - prm["floor_mm"]
    z_spacer = z_bot - RAIL_SPACER_MM  # the rail's top face bears here
    z_slot = z_spacer - RAIL_FLANGE_MM - 2 * fit  # the flanges sit between here and the spacer
    return {"fit": fit, "x0": bb.min.X - grow_by, "x1": bb.max.X + grow_by, "cy": (y0 + y1) / 2, "half_case": (y1 - y0) / 2,
            "half_slot": half_slot, "half_foot": max(half_slot + RAIL_SIDE_MM, (y1 - y0) / 2), "z_bot": z_bot,
            "z_spacer": z_spacer, "z_slot": z_slot, "z_hook": z_slot - RAIL_HOOK_MM}


def din_rail(board: Board, settings: dict[str, Any]) -> Case:
    case = two_part(board, settings)
    r = _rail_frame(board, settings)
    fit, cy, half_slot, half_foot = r["fit"], r["cy"], r["half_slot"], r["half_foot"]
    z_bot, z_spacer, z_slot, z_hook, x0, x1 = r["z_bot"], r["z_spacer"], r["z_slot"], r["z_hook"], r["x0"], r["x1"]
    base = case.parts["base"]
    foot: Shape = box(x0, cy - half_foot, z_spacer, x1, cy + half_foot, z_bot + 0.01)
    for s in (-1, 1):
        edge, outer = cy + s * half_slot, cy + s * half_foot
        foot = foot + box(x0, edge, z_hook, x1, outer, z_spacer)  # the side wall beside the flange's edge
        inner = cy + s * (half_slot - RAIL_HOOK_OVER_MM)
        foot = foot + box(x0, inner, z_hook, x1, edge, z_slot)  # the hook under the flange
    case.parts["base"] = base + foot
    case.parts["base"].label = "base"
    case.meta.update({
        "template": "din-rail", "mount": f"{RAIL_WIDTH_MM:g} mm top-hat rail (EN 60715), along x",
        "rail_hook_mm": RAIL_HOOK_MM, "rail_slot_mm": round(RAIL_FLANGE_MM + 2 * fit, 3), "foot_bottom_z": z_hook,
    })
    notes = case.notes
    if half_foot > r["half_case"] + 1e-9:
        notes.append(f"the rail foot is {2 * half_foot:g} mm wide, wider than the case, to hold a {RAIL_WIDTH_MM:g} mm rail")
    return case


BUILDERS = {"extruded-box": extruded_box, "din-rail": din_rail}
