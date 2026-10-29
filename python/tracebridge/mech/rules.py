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

from .probe import intervals
from .settings import find_process
from .shell import Case, heights, is_cnc

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
        if not from_file and cnc.get("corner_radius"):
            depth = max(case.meta.get("base_cavity_depth_mm", 0.0), case.meta.get("lid_cavity_depth_mm", 0.0))
            need = 0.5 if depth <= 3 else round(depth / 10 + 0.5, 2)
            # The printed shell's cavity has sharp inside vertical corners: a cutter cannot make them.
            rows.append(_row("corner_radius", False, f"inside corners are sharp; a {_fmt(round(depth, 2))} mm deep "
                             f"cavity needs R{_fmt(need)} mm ({cnc['corner_radius']})", 0.0, need, src, "model"))
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
