"""Manufacturing rules: the case against the chosen process's published limits.

Every limit comes from the capabilities JSON the caller passes (src/tools/mech/capabilities.ts, read from JLC3DP's
and JLCCNC's guideline pages), and every row carries that row's source URL, so nothing here is a number of our own.
A row is

  {"rule", "ok": true | false | null, "detail", "measured", "limit", "source", "basis": "params" | "bbox" | "model"}

where `basis` says what was measured: the case script's parameters, the bounding box of a handed-in file, or the
built model's own numbers (pilot holes, the lip gap, and the built sections below).

Built sections (basis "model", for a script's case, given the board): the thinnest solid stretch that rays through
the model cross, measured in this process on the solids it read, at a few points on each side: `base_wall` (the
base's outer wall, at heights beside the lid's lip and below it), `lip_wall` (the lid's lip, halfway down it),
`lid_wall` (the lid's wall above the split), `base_floor` (the base's floor, under the board) and `lid_top` (the lid's
top over the board). Each must meet the same minimum as the wall parameter. A section a ray does not find (a
script that removed it) is reported with `ok: false`. `ok: null` means the rule could not be checked (said in the
detail), and it does not fail the build.
"""
from __future__ import annotations

from typing import Any

import math

from .probe import first_hit, intervals
from .settings import FALLBACK_ASSEMBLY_CLEARANCE_MM, find_process
from .shell import Case, cavity_edge_mm, cnc_radius, convex_corners, grow, heights, is_cnc

METALS = ("alumin", "steel", "stainless", "brass", "copper", "titanium", "316l", "tc4", "6061", "7075", "magnesium")


def _row(rule: str, ok: bool | None, detail: str, measured: Any, limit: Any, source: str | None,
         basis: str) -> dict[str, Any]:
    return {"rule": rule, "ok": ok, "detail": detail, "measured": measured, "limit": limit, "source": source,
            "basis": basis}


def _dims(case: Case) -> dict[str, list[float]]:
    out = {}
    for name, s in sorted(case.parts.items()):
        sz = s.bounding_box().size
        out[name] = [round(sz.X, 2), round(sz.Y, 2), round(sz.Z, 2)]
    return out


def _min_wall(row: dict[str, Any], size: float) -> float | None:
    """The process's minimum wall for a part whose largest dimension is `size` ([[size up to, wall], ...]; above the
    last bracket, the last wall)."""
    table = sorted(row.get("wall_by_size") or [], key=lambda r: r[0])
    for limit, wall in table:
        if size <= limit:
            return wall
    return table[-1][1] if table else None


_is_cnc = is_cnc

SECTIONS = (("base_wall", "base", "the base's wall"), ("lip_wall", "lid", "the lid's lip"),
            ("lid_wall", "lid", "the lid's wall"), ("base_floor", "base", "the base's floor"),
            ("lid_top", "lid", "the lid's top"))


def built_sections(case: Case, board: Any, settings: dict[str, Any]) -> dict[str, float | None]:
    """The thinnest measured thickness of each built section (see the module docstring), or None when not found."""
    hz = heights(board, settings)
    t, floor_top, lid_in = hz["split_z"], hz["floor_top_z"], hz["lid_inner_z"]
    z_lip = t - settings["params"]["lip_h_mm"]
    bb = board.outline.bounding_box()
    cx, cy = (bb.min.X + bb.max.X) / 2, (bb.min.Y + bb.max.Y) / 2
    fx = [bb.min.X + f * bb.size.X for f in (0.25, 0.5, 0.75)]
    fy = [bb.min.Y + f * bb.size.Y for f in (0.25, 0.5, 0.75)]

    def side_rays(z: float):
        return ([((cx, y, z), (s, 0, 0)) for y in fy for s in (-1, 1)]
                + [((x, cy, z), (0, s, 0)) for x in fx for s in (-1, 1)])

    def outermost(part: str, rays) -> float | None:
        shape = case.parts.get(part)
        ds = [iv[-1][1] - iv[-1][0] for o, d in rays if (iv := intervals(shape, o, d))]
        return round(min(ds), 3) if ds else None

    def first(part: str, rays) -> float | None:
        shape = case.parts.get(part)
        ds = [iv[0][1] - iv[0][0] for o, d in rays if (iv := intervals(shape, o, d))]
        return round(min(ds), 3) if ds else None

    lip_mid = (z_lip + t) / 2
    below_lip = (floor_top + z_lip) / 2 if z_lip - floor_top > 0.2 else None
    base_z = [lip_mid] + ([below_lip] if below_lip is not None else [])
    walls = [outermost("base", side_rays(z)) for z in base_z]
    walls = [w for w in walls if w is not None]
    pts = [(x, y) for x in fx for y in fy]
    return {
        "base_wall": min(walls) if walls else None,
        # From inside the cavity outward, the lip is the lid's first solid stretch halfway down it.
        "lip_wall": first("lid", side_rays(lip_mid)),
        "lid_wall": outermost("lid", side_rays(t + min(1.0, (lid_in - t) / 2))),
        "base_floor": outermost("base", [((x, y, floor_top + 0.05), (0, 0, -1)) for x, y in pts]),
        "lid_top": outermost("lid", [((x, y, lid_in - 0.05), (0, 0, 1)) for x, y in pts]),
    }


def _corner_radius(shape: Any, v, bis, ang, us, z: float, reach: float) -> float | None:
    """One corner's radius, from where the model's walls are (not where they should be): a ray out to each of the
    corner's two walls, `reach` along the edge from the corner, finds the wall's line; the lines meet at the sharp
    corner; a ray along the bisector toward it stops R (1 / sin(θ/2) - 1) short of it."""
    lines = []
    for u in us:
        d = bis[0] * u[0] + bis[1] * u[1]
        nx, ny = bis[0] - d * u[0], bis[1] - d * u[1]  # inward normal of this edge
        ln = math.hypot(nx, ny)
        nx, ny = nx / ln, ny / ln
        o = (v[0] + u[0] * reach + nx * reach, v[1] + u[1] * reach + ny * reach, z)
        h = first_hit([shape], o, (-nx, -ny, 0), 2 * reach + 5.0)
        if h is None:
            return None
        lines.append(((o[0] - nx * h, o[1] - ny * h), u))
    (p0, u0), (p1, u1) = lines
    den = u0[0] * u1[1] - u0[1] * u1[0]
    if abs(den) < 1e-9:
        return None
    s = ((p1[0] - p0[0]) * u1[1] - (p1[1] - p0[1]) * u1[0]) / den
    cx, cy = p0[0] + u0[0] * s, p0[1] + u0[1] * s
    o = (cx + bis[0] * reach, cy + bis[1] * reach, z)
    h = first_hit([shape], o, (-bis[0], -bis[1], 0), reach + 1.0)
    if h is None:
        return None
    return max(reach - h, 0.0) / (1 / math.sin(ang / 2) - 1)


def inner_radii(case: Case, board: Any, settings: dict[str, Any]) -> dict[str, dict[str, float | None]]:
    """For the base and the lid: the smallest inside vertical corner radius of its cavity, measured on the model by
    a ray along each corner's bisector toward the sharp corner (where it meets a fillet of radius R at an interior
    angle θ, it stops R (1 / sin(θ/2) - 1) short of the corner), with the radius the cavity's depth needs.
    Cavities and depths are the parent's own (from its board and settings), at a height where nothing else stands:
    the base in the board's own thickness, the lid halfway down its lip."""
    clr, prm = settings["clearance"], settings["params"]
    fit = float((settings.get("resolved") or {}).get("assembly_clearance_mm", FALLBACK_ASSEMBLY_CLEARANCE_MM))
    hz = heights(board, settings)
    t, floor_top, lid_in = hz["split_z"], hz["floor_top_z"], hz["lid_inner_z"]
    z_lip = t - prm["lip_h_mm"]
    inner = grow(board.outline, cavity_edge_mm(board, settings))
    spec = {"base": (grow(inner, prm["lip_mm"] + fit), (board.top_z + board.bottom_z) / 2, t - floor_top),
            "lid": (inner, (z_lip + t) / 2, lid_in - z_lip)}
    out: dict[str, dict[str, float | None]] = {}
    for name, (face, z, depth) in spec.items():
        need = cnc_radius(depth)
        shape = case.parts.get(name)
        rs = []
        reach = 3 * need + 2.0
        if shape is not None:
            for v, bis, ang, us in convex_corners(face, with_edges=True):
                r = _corner_radius(shape, v, bis, ang, us, z, reach)
                if r is not None:
                    rs.append(r)
        out[name] = {"measured": round(min(rs), 3) if rs else None, "need": need, "depth": round(depth, 3)}
    return out


def _boss_row(case: Case, settings: dict[str, Any], wmin: float, who: str, src: str | None) -> list[dict[str, Any]]:
    """The boss around each pilot hole: standoff_d_mm must leave the process's minimum wall on each side."""
    if not case.fasteners:
        return []
    d = settings["params"]["standoff_d_mm"]
    pilot = max(f["pilot_d_mm"] for f in case.fasteners)
    need = round(pilot + 2 * wmin, 3)
    ok = d >= need - 1e-9
    return [_row("standoff", ok, f"boss {_fmt(d)} mm {'leaves' if ok else 'is under'} the {_fmt(need)} mm a "
                 f"{_fmt(pilot)} mm pilot hole needs for {who}'s {_fmt(wmin)} mm wall each side", d, need, src,
                 "params")]


def _section_rows(case: Case, board: Any, settings: dict[str, Any], wmin: float, who: str, src: str | None,
                  kind_note: str) -> list[dict[str, Any]]:
    rows = []
    found = built_sections(case, board, settings)
    for rule, part, what in SECTIONS:
        v = found[rule]
        if v is None:
            rows.append(_row(rule, False, f"{what} was not found in the {part} (a ray through it met no solid)",
                             None, wmin, src, "model"))
            continue
        ok = v >= wmin - 1e-3
        rows.append(_row(rule, ok, f"{what} as built is {_fmt(v)} mm, {'meeting' if ok else 'under'} {who}'s "
                         f"{_fmt(wmin)} mm{kind_note}", v, wmin, src, "model"))
    return rows


def _fmt(v: float) -> str:
    return f"{v:g}"


def rules_check(case: Case, settings: dict[str, Any], capabilities: dict[str, Any],
                board: Any = None) -> list[dict[str, Any]]:
    """The rule rows for the case (see the module docstring); with the board, a script's built sections too."""
    proc = settings["process"]
    label = f"{proc['process']} {proc['material']}"
    dims = _dims(case)
    largest = max((max(d) for d in dims.values()), default=0.0)
    from_file = case.source == "file"
    basis = "bbox" if from_file else "params"
    prm = settings["params"]
    rows: list[dict[str, Any]] = []

    if _is_cnc(settings):
        cnc = capabilities.get("cnc") or {}
        src = cnc.get("source")
        kind = "metal" if any(m in proc["material"].lower() for m in METALS) else "plastic"
        wmin = (cnc.get("wall_min_mm") or {}).get(kind)
        if from_file:
            rows.append(_row("wall", None, "wall thickness of a handed-in file is not measured", None, wmin, src,
                             basis))
        elif wmin is None:
            rows.append(_row("wall", None, f"the capabilities give no CNC minimum wall for {kind}", None, None, src,
                             basis))
        else:
            for k in ("wall", "floor", "lid"):
                v = prm[f"{k}_mm"]
                rows.append(_row(k, v >= wmin, f"{k} {_fmt(v)} mm {'meets' if v >= wmin else 'is under'} CNC's "
                                 f"{_fmt(wmin)} mm minimum for {kind}", v, wmin, src, basis))
            if board is not None:
                rows += _section_rows(case, board, settings, wmin, "CNC", src, f" minimum for {kind}")
            rows += _boss_row(case, settings, wmin, "CNC", src)
        if not from_file and cnc.get("corner_radius"):
            if board is None:
                rows.append(_row("corner_radius", None, "inside corner radius not measured (no board given)", None,
                                 None, src, "model"))
            else:
                for name, m in inner_radii(case, board, settings).items():
                    v, need = m["measured"], m["need"]
                    if v is None:
                        rows.append(_row("corner_radius", False, f"the {name}'s inside corners were not found to "
                                         f"measure; a {_fmt(m['depth'])} mm deep cavity needs R{_fmt(need)} mm "
                                         f"({cnc['corner_radius']})", None, need, src, "model"))
                        continue
                    ok = v >= need - 0.02
                    rows.append(_row("corner_radius", ok, f"the {name}'s inside corners are R{_fmt(v)} mm as built, "
                                     f"{'meeting' if ok else 'under'} the R{_fmt(need)} mm a {_fmt(m['depth'])} mm "
                                     f"deep cavity needs ({cnc['corner_radius']})", v, need, src, "model"))
        return rows

    row = find_process(settings, capabilities)
    if row is None:
        rows.append(_row("process", False, f"no capabilities row for {proc['service']} {label}: limits unknown",
                         None, None, None, basis))
        return rows
    src = row.get("source")

    wmin = _min_wall(row, largest)
    if from_file:
        rows.append(_row("wall", None, "wall thickness of a handed-in file is not measured", None, wmin, src, basis))
    elif wmin is None:
        rows.append(_row("wall", None, f"{label} gives no minimum wall for a {_fmt(round(largest))} mm part", None,
                         None, src, basis))
    else:
        for k in ("wall", "floor", "lid"):
            v = prm[f"{k}_mm"]
            ok = v >= wmin
            rows.append(_row(k, ok, f"{k} {_fmt(v)} mm {'meets' if ok else 'is under'} {proc['process']}'s "
                             f"{_fmt(wmin)} mm for a {_fmt(round(largest))} mm part", v, wmin, src, basis))
        if board is not None:
            rows += _section_rows(case, board, settings, wmin, proc["process"], src,
                                  f" for a {_fmt(round(largest))} mm part")
        rows += _boss_row(case, settings, wmin, proc["process"], src)

    mx = row.get("max_mm")
    mn = row.get("min_mm")
    for name, d in dims.items():
        sd = sorted(d, reverse=True)
        if mx:
            lim = sorted(mx, reverse=True)
            ok = all(a <= b for a, b in zip(sd, lim))
            rows.append(_row("size", ok, f"{name} {' × '.join(_fmt(v) for v in d)} mm "
                             f"{'fits' if ok else 'is over'} {proc['process']}'s "
                             f"{' × '.join(_fmt(v) for v in mx)} mm", d, mx, src, "bbox"))
        if mn and proc["process"].upper() == "FDM":
            lim = sorted(mn, reverse=True)
            ok = all(a >= b for a, b in zip(sd, lim))
            rows.append(_row("min_size", ok, f"{name} {' × '.join(_fmt(v) for v in d)} mm "
                             f"{'meets' if ok else 'is under'} FDM's smallest part "
                             f"{' × '.join(_fmt(v) for v in mn)} mm", d, mn, src, "bbox"))

    hmin = row.get("hole_min_d_mm")
    if case.fasteners and hmin is not None:
        smallest = min(case.fasteners, key=lambda f: f["pilot_d_mm"])
        v = smallest["pilot_d_mm"]
        ok = v >= hmin
        rows.append(_row("hole", ok, f"pilot hole {_fmt(v)} mm ({smallest['ref']}, {smallest['size']}) "
                         f"{'meets' if ok else 'is under'} {proc['process']}'s {_fmt(hmin)} mm smallest hole",
                         v, hmin, src, "model"))

    aclr = row.get("assembly_clearance_mm")
    gap = case.meta.get("lip_gap_mm")
    if not from_file and aclr is not None:
        if gap is None:
            rows.append(_row("lip", None, "the lid has no lip, so there is no lip gap to check", None, aclr, src,
                             "model"))
        else:
            ok = gap >= aclr - 1e-9
            rows.append(_row("lip", ok, f"lip gap {_fmt(gap)} mm {'meets' if ok else 'is under'} "
                             f"{proc['process']}'s {_fmt(aclr)} mm assembly clearance", gap, aclr, src, "model"))
    return rows
