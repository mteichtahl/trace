"""The case script's own process: `python -m tracebridge.mech build-only`, and the parent's side of it.

The parent (run() in tracebridge.mech) never imports the case script. It makes a private folder (mkdtemp, 0700,
outside OUTDIR), writes the facts and settings it has checked into it, and starts this module's main() in a child
Python with the same environment and that folder as its working directory. The child loads the board, calls the
script's build(board, settings), and writes into the folder only

  part-<n>.step   one per case part
  claims.json     {"parts": [{"name", "file"}], "joints", "fasteners", "notes", "meta"}, or {"error": "..."}

and exits 0 (or 2 for the script's own failure). The parent then reads the folder strictly: only those names,
regular files (no symbolic links), under a size cap, and every claim type-checked; part names are short lowercase
words. What the script did to the board or settings objects, to tracebridge's functions or to sys.modules stays in
the child; the parent loads the solids and measures them with its own board, settings and capabilities.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from .settings import InputError

CLAIMS = "claims.json"
NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
FILE_RE = re.compile(r"^part-[0-9]{1,3}\.step$")
MAX_PARTS = 16
MAX_CLAIMS_BYTES = 1 << 20
MAX_STEP_BYTES = 256 << 20
MAX_NOTES = 50
MAX_NOTE_CHARS = 2000
PACKAGE_ROOT = Path(__file__).resolve().parents[2]  # the folder holding tracebridge/


# --- the child -------------------------------------------------------------------------------------------------------

def main(args: Any) -> int:
    """build-only: run the script, write its parts and claims into args.out (the private folder)."""
    from build123d import export_step

    from . import _read_json, _tail, load_script
    from .board import load_board
    from .shell import Case

    out = Path(args.out)

    def fail(msg: str) -> int:
        (out / CLAIMS).write_text(json.dumps({"error": msg}) + "\n", encoding="utf-8")
        return 2

    try:
        facts = _read_json(args.facts, "facts")
        settings = _read_json(args.settings, "settings")
        build = load_script(args.script)
        board = load_board(facts)
        try:
            case = build(board, settings)
        except InputError:
            raise
        except Exception as e:  # noqa: BLE001
            raise InputError(f"case script build() raised:\n{_tail(e)}") from None
        if not isinstance(case, Case) or not case.parts:
            raise InputError(f"case script build() must return a Case with parts, got {type(case).__name__}")
        parts = []
        for i, (name, shape) in enumerate(sorted(case.parts.items())):
            f = f"part-{i}.step"
            export_step(shape, out / f)
            parts.append({"name": str(name), "file": f})
        claims = {"parts": parts, "joints": case.joints, "fasteners": case.fasteners, "notes": case.notes,
                  "meta": case.meta}
        (out / CLAIMS).write_text(json.dumps(claims, default=str) + "\n", encoding="utf-8")
    except InputError as e:
        return fail(str(e))
    return 0


# --- the parent ------------------------------------------------------------------------------------------------------

def _scalar(v: Any) -> bool:
    return v is None or isinstance(v, (str, int, float, bool))


def _clean_list(v: Any, what: str, notes: list[str]) -> list[dict[str, Any]]:
    if not isinstance(v, list):
        if v is not None:
            notes.append(f"case script's {what} were not a list: ignored")
        return []
    out = []
    for item in v[:64]:
        if isinstance(item, dict) and all(isinstance(k, str) and (_scalar(x) or (isinstance(x, list) and all(
                _scalar(y) for y in x))) for k, x in item.items()):
            out.append(item)
        else:
            notes.append(f"a {what[:-1]} claimed by the case script is malformed: ignored")
    return out


def _fasteners(v: list[dict[str, Any]], notes: list[str]) -> list[dict[str, Any]]:
    out = []
    for f in v:
        ok = (isinstance(f.get("id"), str) and isinstance(f.get("ref"), str) and isinstance(f.get("size"), str)
              and all(isinstance(f.get(k), (int, float)) and not isinstance(f.get(k), bool)
                      for k in ("length_mm", "pilot_d_mm")))
        if ok:
            out.append(f)
        else:
            notes.append("a fastener claimed by the case script lacks id, ref, size, length_mm or pilot_d_mm: ignored")
    return out


def _joints(v: list[dict[str, Any]], notes: list[str]) -> list[dict[str, Any]]:
    out = []
    for j in v:
        if not isinstance(j.get("id"), str):
            notes.append("a joint claimed by the case script has no id: ignored")
        elif j.get("type") == "fastened" and isinstance(j.get("fastener"), str):
            out.append(j)
        elif j.get("type") == "press_fit" and (j.get("clearance_mm") is None or (
                isinstance(j["clearance_mm"], (int, float)) and not isinstance(j["clearance_mm"], bool))):
            out.append(j)
        else:
            notes.append(f"joint {j['id']} claimed by the case script is not a known kind: ignored")
    return out


def _regular(path: Path, cap: int) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return False
    import stat
    return stat.S_ISREG(st.st_mode) and st.st_size <= cap


def read_private(folder: Path):
    """The case from the child's private folder, read strictly (see the module docstring)."""
    from build123d import Compound, import_step

    from .shell import Case

    cp = folder / CLAIMS
    if not _regular(cp, MAX_CLAIMS_BYTES):
        raise InputError("the case script's process wrote no readable claims (it exited without building a case)")
    try:
        claims = json.loads(cp.read_text(encoding="utf-8"))
    except ValueError:
        raise InputError("the case script's process wrote malformed claims") from None
    if not isinstance(claims, dict):
        raise InputError("the case script's process wrote malformed claims")
    if "error" in claims:
        raise InputError(str(claims["error"])[:8000])
    plist = claims.get("parts")
    if not isinstance(plist, list) or not plist or len(plist) > MAX_PARTS:
        raise InputError(f"case script build() must return a Case with 1 to {MAX_PARTS} parts")
    case = Case(source="script")
    notes = case.notes
    seen = set()
    for p in plist:
        name, f = (p.get("name"), p.get("file")) if isinstance(p, dict) else (None, None)
        if not (isinstance(name, str) and NAME_RE.match(name)) or name in seen:
            raise InputError(f"case part name {name!r} is not a short lowercase name (a-z, 0-9, _ and -), or repeats")
        if not (isinstance(f, str) and FILE_RE.match(f)) or not _regular(folder / f, MAX_STEP_BYTES):
            raise InputError(f"case part {name}: its file is missing or not a plain file")
        seen.add(name)
        try:
            solids = import_step(folder / f).solids()
        except Exception as e:  # noqa: BLE001
            raise InputError(f"case part {name}: its STEP could not be read ({e})") from None
        if not solids:
            raise InputError(f"case part {name} holds no solids")
        shape = solids[0] if len(solids) == 1 else Compound(children=list(solids))
        shape.label = name
        case.parts[name] = shape
    case.fasteners = _fasteners(_clean_list(claims.get("fasteners"), "fasteners", notes), notes)
    case.joints = _joints(_clean_list(claims.get("joints"), "joints", notes), notes)
    raw_notes = claims.get("notes")
    if isinstance(raw_notes, list):
        notes.extend(str(n)[:MAX_NOTE_CHARS] for n in raw_notes[:MAX_NOTES] if isinstance(n, str))
    meta = claims.get("meta")
    case.meta = meta if isinstance(meta, dict) else {}
    return case


def build_in_child(script: str | Path, facts: dict[str, Any], settings: dict[str, Any]):
    """Run the case script in a child process and return its Case, read from the child's private folder."""
    folder = Path(tempfile.mkdtemp(prefix="trace-case-"))
    try:
        (folder / "in-facts.json").write_text(json.dumps(facts), encoding="utf-8")
        (folder / "in-settings.json").write_text(json.dumps(settings), encoding="utf-8")
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join([str(PACKAGE_ROOT)] + [p for p in env.get("PYTHONPATH", "").split(
            os.pathsep) if p])
        args = [sys.executable, "-P", "-m", "tracebridge.mech", "build-only", "--facts", str(folder / "in-facts.json"),
                "--settings", str(folder / "in-settings.json"), "--script", str(Path(script).resolve()),
                "--out", str(folder)]
        p = subprocess.run(args, cwd=folder, env=env, capture_output=True, text=True)
        if p.returncode not in (0, 2):
            tail = "\n".join((p.stderr or "").rstrip().splitlines()[-6:])
            raise InputError(f"the case script's process exited with {p.returncode}" + (f":\n{tail}" if tail else ""))
        return read_private(folder)
    finally:
        shutil.rmtree(folder, ignore_errors=True)
