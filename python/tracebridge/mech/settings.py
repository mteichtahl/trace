"""Case settings and board facts, checked again on the Python side.

TypeScript's zod schema (src/tools/mech/settings.ts) is the source of truth for case.json; this module re-checks what
the engine relies on, so a hand-edited file or a direct CLI run fails with a readable message (exit 2) instead of a
traceback deep in the geometry. Defaults here are the same recommendations the TypeScript side writes.
"""
from __future__ import annotations

import copy
from typing import Any

# The recommendation for every value a case.json may leave out (docs/enclosure-build.md, "Case settings").
DEFAULTS: dict[str, Any] = {
    "version": 1,
    "template": "printed-shell",
    "source": "script",
    "process": {"service": "jlc3dp", "process": "MJF", "material": "PA12-HP"},
    "params": {
        "wall_mm": 2.0, "floor_mm": 2.0, "lid_mm": 2.0,
        "corner_radius_mm": 3.0,
        "standoff_d_mm": 7.0,
        "lip_mm": 2.0, "lip_h_mm": 3.0,
    },
    "clearance": {"edge_mm": 0.5, "above_tallest_mm": 1.0, "below_mm": 1.0, "parts": {}},
    "openings": {"skip": [], "extra_mm": 0.5},
    "quantity": 5,
    "reasons": {},
}

# The assembly clearance used when the capabilities have no row for the chosen process (the engine says so in a note).
FALLBACK_ASSEMBLY_CLEARANCE_MM = 0.2

SIDES = ("west", "east", "north", "south")


class InputError(Exception):
    """Bad input the caller should fix: reported as {"error": ...} with exit code 2."""


def _num(v: Any, path: str, *, minimum: float = 0.0, strict: bool = False) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise InputError(f"settings {path} must be a number, got {v!r}")
    if v < minimum or (strict and v <= minimum):
        raise InputError(f"settings {path} must be {'>' if strict else '>='} {minimum} mm, got {v}")
    return float(v)


def normalize_settings(raw: Any) -> dict[str, Any]:
    """case.json merged over the defaults, with every value the engine reads checked. Unknown keys are kept."""
    if not isinstance(raw, dict):
        raise InputError("settings must be a JSON object")
    s = copy.deepcopy(DEFAULTS)
    for k, v in raw.items():
        if k in ("params", "clearance", "openings", "process"):
            if not isinstance(v, dict):
                raise InputError(f"settings {k} must be an object, got {v!r}")
            s[k] = {**s[k], **v}
        else:
            s[k] = v
    if s.get("version") != 1:
        raise InputError(f"settings version must be 1, got {s.get('version')!r}")
    if s["template"] != "printed-shell":
        raise InputError(f"settings template {s['template']!r} is not known (this build has 'printed-shell')")
    if s["source"] not in ("script", "file"):
        raise InputError(f"settings source must be 'script' or 'file', got {s['source']!r}")
    p = s["process"]
    for k in ("service", "process", "material"):
        if not isinstance(p.get(k), str) or not p[k]:
            raise InputError(f"settings process.{k} must be a non-empty string")
    for k in ("wall_mm", "floor_mm", "lid_mm", "standoff_d_mm", "lip_mm", "lip_h_mm"):
        s["params"][k] = _num(s["params"][k], f"params.{k}", strict=True)
    s["params"]["corner_radius_mm"] = _num(s["params"]["corner_radius_mm"], "params.corner_radius_mm")
    c = s["clearance"]
    for k in ("edge_mm", "above_tallest_mm", "below_mm"):
        c[k] = _num(c[k], f"clearance.{k}")
    if not isinstance(c["parts"], dict):
        raise InputError("settings clearance.parts must be an object of ref -> {mm, reason}")
    for ref, v in c["parts"].items():
        if not isinstance(v, dict) or "mm" not in v or not (v.get("reason") is None or isinstance(v["reason"], str)):
            raise InputError(f"settings clearance.parts.{ref} must be {{mm, reason}}")
        v["mm"] = _num(v["mm"], f"clearance.parts.{ref}.mm")
    o = s["openings"]
    if not isinstance(o["skip"], list) or not all(isinstance(r, str) for r in o["skip"]):
        raise InputError("settings openings.skip must be a list of part references")
    o["extra_mm"] = _num(o["extra_mm"], "openings.extra_mm")
    q = s.get("quantity")
    if isinstance(q, bool) or not isinstance(q, int) or q < 1:
        raise InputError(f"settings quantity must be a whole number of at least 1, got {q!r}")
    if not isinstance(s.get("reasons"), dict):
        raise InputError("settings reasons must be an object of path -> reason")
    for k in ("board", "file"):
        if k in s and s[k] is not None and not isinstance(s[k], str):
            raise InputError(f"settings {k} must be a repository path, got {s[k]!r}")
    return s


def unknown_refs(settings: dict[str, Any], facts: dict[str, Any]) -> list[str]:
    """Notes for per-part clearances and openings.skip entries naming a reference that is not on the board."""
    refs = {p["ref"] for p in facts.get("parts") or []}
    notes = []
    for ref in sorted(settings["clearance"]["parts"]):
        if ref not in refs:
            notes.append(f"clearance.parts names {ref}, which is not on the board: ignored")
    for ref in sorted(set(settings["openings"]["skip"])):
        if ref not in refs:
            notes.append(f"openings.skip names {ref}, which is not on the board: ignored")
    return notes


def part_clearance(settings: dict[str, Any], ref: str) -> float | None:
    """The per-part clearance from clearance.parts, or None when the part has none of its own."""
    v = settings["clearance"]["parts"].get(ref)
    return float(v["mm"]) if v else None


def check_facts(facts: Any) -> dict[str, Any]:
    """The board facts the engine reads, checked: a malformed facts.json is bad input, not a crash."""
    if not isinstance(facts, dict):
        raise InputError("facts must be a JSON object")
    if facts.get("version") != 1:
        raise InputError(f"facts version must be 1, got {facts.get('version')!r}")
    t = facts.get("thickness_mm", 1.6)
    if isinstance(t, bool) or not isinstance(t, (int, float)) or t <= 0:
        raise InputError(f"facts thickness_mm must be a positive number, got {t!r}")
    outline = facts.get("outline")
    if not isinstance(outline, list) or len(outline) < 3:
        raise InputError("facts outline must be a list of at least three [x, y] points")
    for pt in outline:
        if not (isinstance(pt, (list, tuple)) and len(pt) == 2 and all(isinstance(c, (int, float)) for c in pt)):
            raise InputError(f"facts outline point {pt!r} is not [x, y]")
    for h in facts.get("holes") or []:
        if not all(isinstance(h.get(k), (int, float)) for k in ("x", "y", "d")):
            raise InputError(f"facts hole {h!r} needs numeric x, y and d")
    for part in facts.get("parts") or []:
        if not isinstance(part.get("ref"), str):
            raise InputError(f"facts part {part!r} has no ref")
        b = part.get("box") or {}
        if not all(isinstance(b.get(k), (int, float)) for k in ("min_x", "min_y", "max_x", "max_y")):
            raise InputError(f"facts part {part['ref']} needs a box with min_x, min_y, max_x and max_y")
        if part.get("side") not in ("top", "bottom"):
            raise InputError(f"facts part {part['ref']} side must be 'top' or 'bottom'")
        edge = part.get("edge")
        if edge is not None and edge.get("side") not in SIDES:
            raise InputError(f"facts part {part['ref']} edge side must be one of {', '.join(SIDES)}")
    return facts


def find_process(settings: dict[str, Any], capabilities: dict[str, Any]) -> dict[str, Any] | None:
    """The capabilities row for settings.process (service, process and material), or None when there is none."""
    want = settings["process"]
    for row in capabilities.get("processes") or []:
        if (str(row.get("service", "")).lower() == want["service"].lower()
                and str(row.get("process", "")).lower() == want["process"].lower()
                and want["material"].lower() in [str(m).lower() for m in row.get("materials") or []]):
            return row
    return None


def resolve(settings: dict[str, Any], capabilities: dict[str, Any]) -> dict[str, Any]:
    """What the shell needs from the capabilities, put in settings["resolved"] so a case script (which receives only
    the board and the settings) builds with the process's own assembly clearance."""
    row = find_process(settings, capabilities)
    clr = row.get("assembly_clearance_mm") if row else None
    out = {
        "assembly_clearance_mm": float(clr) if isinstance(clr, (int, float)) else FALLBACK_ASSEMBLY_CLEARANCE_MM,
        "assembly_clearance_source": row.get("source") if row and clr is not None else None,
    }
    settings["resolved"] = out
    return out
