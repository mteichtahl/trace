"""The fit check: does the board, with its parts, fit the case, and by how much.

Two kinds of finding, each named by part reference so a person can waive them one at a time:

  clash  any intersection over 0.001 mm³ between a part envelope (body or through-hole leads) or the board body and
         a case part, with its volume
  gap    a measured distance against the clearance it needs:
           board / edge   the board's mid-thickness slab to the case's walls (the case minus the column over the
                          board outline, so bosses, rests and posts that hold the board's faces do not count)
           <ref> / above  a top-side part to the case in the column over it (its own clearance, else
                          above_tallest_mm)
           <ref> / below  a bottom-side part, or a top-side part's through-hole leads, to the case in the column
                          under it (below_mm, or the part's own clearance when larger)
           <ref> / around a part to the case in every direction: for a part with its own clearance (it needs that
                          much room all round), and for a connector with an opening (its own clearance, default 0:
                          it may touch its opening)

Measured with OpenCascade's exact distance query on the solids; every number is in millimetres, rounded to 0.001.
"""
from __future__ import annotations

from typing import Any

from build123d import Shape

from .board import Board, box, extrude, kicad_box
from .settings import part_clearance
from .shell import FAR, Case

CLASH_MIN_MM3 = 0.001
GAP_TOL_MM = 1e-3


def _vol(s: Shape | None) -> float:
    if s is None:
        return 0.0
    try:
        return float(s.volume)
    except Exception:  # noqa: BLE001 - an empty compound has no volume
        return 0.0


def _overlap(a: Shape, b: Shape) -> bool:
    """Bounding boxes overlap (or touch): the cheap test before a boolean."""
    p, q = a.bounding_box(), b.bounding_box()
    return (p.min.X <= q.max.X and q.min.X <= p.max.X and p.min.Y <= q.max.Y and q.min.Y <= p.max.Y
            and p.min.Z <= q.max.Z and q.min.Z <= p.max.Z)


def clash_volume(a: Shape, b: Shape) -> float:
    if not _overlap(a, b):
        return 0.0
    return _vol(a & b)


def distance(a: Shape, parts: list[Shape]) -> float | None:
    """The smallest distance from a to any of the shapes, or None when there is nothing to measure to."""
    ds = [a.distance_to(p) for p in parts if p is not None and _vol(p) > 0]
    return min(ds) if ds else None


def _gap(ref: str, where: str, measured: float | None, required: float) -> dict[str, Any]:
    m = None if measured is None else round(measured, 3)
    # Nothing in that direction at all (an open column) is room enough.
    ok = True if measured is None else measured >= required - GAP_TOL_MM
    return {"ref": ref, "where": where, "measured_mm": m, "required_mm": round(required, 3), "ok": ok}


def _column(board: Board, p: dict[str, Any], up: bool) -> Shape:
    """The column straight over (up) or under a part's box, from the board face it starts at."""
    z0, z1 = (board.top_z, FAR) if up else (-FAR, board.bottom_z)
    return kicad_box(p["box"], z0, z1)


def _detect_opening(case_parts: list[Shape], board: Board, p: dict[str, Any]) -> bool:
    """For a handed-in case: is there a way out through the wall at the part's box (nothing of the case between the
    board edge and the outside)?"""
    z0, z1 = board.part_span(p["ref"])
    bb = kicad_box(p["box"], z0, z1).bounding_box()
    x0, y0, x1, y1 = bb.min.X, bb.min.Y, bb.max.X, bb.max.Y
    side = p["edge"]["side"]
    if side == "west":
        x1, x0 = x0, -FAR
    elif side == "east":
        x0, x1 = x1, FAR
    elif side == "north":
        y0, y1 = y1, FAR
    else:
        y1, y0 = y0, -FAR
    tunnel = box(x0, y0, bb.min.Z, x1, y1, bb.max.Z)
    return all(clash_volume(tunnel, c) <= CLASH_MIN_MM3 for c in case_parts)


def fit_check(case: Case, board: Board, settings: dict[str, Any]) -> dict[str, Any]:
    """Clashes and gaps (see the module docstring), the openings and the assumed heights, with a one-line summary."""
    clr = settings["clearance"]
    names = sorted(case.parts)
    solids = [case.parts[n] for n in names]

    clashes = []
    things: list[tuple[str, Shape]] = [("board", board.body)]
    for ref in sorted(board.parts):
        things.append((ref, board.parts[ref]))
        if ref in board.leads:
            things.append((ref, board.leads[ref]))
    found: dict[tuple[str, str], float] = {}
    for ref, solid in things:
        for n, c in zip(names, solids):
            v = clash_volume(solid, c)
            if v > CLASH_MIN_MM3:
                found[(ref, n)] = found.get((ref, n), 0.0) + v
    for (ref, n), v in found.items():
        clashes.append({"ref": ref, "case_part": n, "volume_mm3": round(v, 3)})

    # Openings: what the shell made, or for a handed-in case, what the geometry shows.
    if case.source == "script" and "openings" in case.meta:
        openings = [{"ref": o["ref"], "side": o["side"], "made": o["made"]} for o in case.meta["openings"]]
    else:
        openings = [{"ref": ref, "side": p["edge"]["side"], "made": _detect_opening(solids, board, p)}
                    for ref, p in sorted(board.info.items()) if p.get("connector") and p.get("edge")]
    opened = {o["ref"] for o in openings if o["made"]}

    gaps = []
    footprint = extrude(board.outline, -FAR, FAR)
    walls = [c - footprint for c in solids]
    gaps.append(_gap("board", "edge", distance(board.slice, walls), clr["edge_mm"]))
    for ref in sorted(board.parts):
        p = board.info[ref]
        env = board.parts[ref]
        own = part_clearance(settings, ref)
        if ref in opened:
            gaps.append(_gap(ref, "around", distance(env, solids), own or 0.0))
            continue
        if p["side"] == "top":
            column = _column(board, p, up=True)
            gaps.append(_gap(ref, "above", distance(env, [c & column for c in solids if _overlap(c, column)]),
                             own if own is not None else clr["above_tallest_mm"]))
        else:
            column = _column(board, p, up=False)
            gaps.append(_gap(ref, "below", distance(env, [c & column for c in solids if _overlap(c, column)]),
                             max(clr["below_mm"], own or 0.0)))
        if ref in board.leads:
            leads = board.leads[ref]
            column = _column(board, p, up=(p["side"] == "bottom"))
            gaps.append(_gap(ref, "below" if p["side"] == "top" else "above",
                             distance(leads, [c & column for c in solids if _overlap(c, column)]), clr["below_mm"]))
        if own is not None:
            gaps.append(_gap(ref, "around", distance(env, solids), own))

    assumptions = [{"ref": p["ref"], "height_mm": p.get("height_mm"), "source": p.get("height_source")}
                   for p in board.facts.get("parts") or [] if p.get("height_source") == "default"]
    bad = [g for g in gaps if not g["ok"]]
    status = "fail" if clashes or bad else "pass"
    return {"status": status, "clashes": clashes, "gaps": gaps, "openings": openings,
            "assumptions": assumptions, "summary": summarize(clashes, gaps, openings, assumptions)}


def _n(k: int, word: str) -> str:
    return f"{k} {word}{'' if k == 1 else 'es' if word.endswith('sh') else 's'}"


def summarize(clashes: list[dict], gaps: list[dict], openings: list[dict], assumptions: list[dict]) -> str:
    """One line a person can act on: what clashes with what, which gaps are short and by how much."""
    parts = []
    if clashes:
        each = "; ".join(f"{c['ref']} with {c['case_part']} {c['volume_mm3']:.2f} mm³" for c in clashes)
        parts.append(f"{_n(len(clashes), 'clash')} ({each})")
    bad = [g for g in gaps if not g["ok"]]
    if bad:
        each = "; ".join(f"{g['ref']} {g['where']} {g['measured_mm']:.2f} mm, needs {g['required_mm']:.2f} mm"
                         for g in bad)
        parts.append(f"{_n(len(bad), 'gap')} under {'its' if len(bad) == 1 else 'their'} clearance ({each})")
    if not parts:
        edge = next((g for g in gaps if g["ref"] == "board"), None)
        tail = f" (board edge {edge['measured_mm']:.2f} mm)" if edge and edge["measured_mm"] is not None else ""
        parts.append(f"fits: no clashes, every gap within its clearance{tail}")
    skipped = [o["ref"] for o in openings if not o["made"]]
    if skipped:
        parts.append(f"no opening for {', '.join(skipped)}")
    if assumptions:
        parts.append(f"{len(assumptions)} height{'' if len(assumptions) == 1 else 's'} assumed "
                     f"({', '.join(a['ref'] for a in assumptions)})")
    return "; ".join(parts)
