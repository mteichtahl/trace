"""Manufacturing rules: the case against the chosen process's published limits.

Every limit comes from the capabilities JSON the caller passes (src/tools/mech/capabilities.ts, read from JLC3DP's
and JLCCNC's guideline pages), and every row carries that row's source URL, so nothing here is a number of our own.
A row is

  {"rule", "ok": true | false | null, "detail", "measured", "limit", "source", "basis": "params" | "bbox" | "model"}

where `basis` says what was measured: the case script's parameters, the bounding box of a handed-in file, or the
built model's own numbers (pilot holes, the lip gap). `ok: null` means the rule could not be checked (said in the
detail), and it does not fail the build.
"""
from __future__ import annotations

from typing import Any

from .settings import find_process
from .shell import Case

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


def _is_cnc(settings: dict[str, Any]) -> bool:
    p = settings["process"]
    return p["service"].lower() == "jlccnc" or p["process"].lower().startswith("cnc")


def _fmt(v: float) -> str:
    return f"{v:g}"


def rules_check(case: Case, settings: dict[str, Any], capabilities: dict[str, Any]) -> list[dict[str, Any]]:
    """The rule rows for the case (see the module docstring)."""
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
