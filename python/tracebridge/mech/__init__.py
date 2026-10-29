"""tracebridge.mech: trace's enclosure engine (build123d), run as `python -m tracebridge.mech run ...`.

The contract is docs/enclosure-build.md; the design is docs/enclosure-cad.md. The TypeScript side
(src/tools/mech/engine.ts) stages board facts, case settings, process capabilities, the case script and any handed-in
STEP, runs this module as a `cad` job, and reads OUTDIR/result.json.

Frames and units: millimetres. Board facts are in KiCad's frame (x right, y down); the engine flips y and puts the
board's bottom face at z = 0. Results name parts by reference and walls by compass side as KiCad shows them: west
(min x), east (max x), north (min y), south (max y), top, bottom.

The case script (mechanical/case.py) is a module with `build(board, settings) -> Case`. It is loaded from its path,
called with the Board and the settings dict (case.json over the defaults, plus settings["resolved"] with the
process's assembly clearance), and may change anything in the Case before returning it:

    from tracebridge.mech import shell

    def build(board, settings):
        case = shell.two_part(board, settings)
        case.parts["lid"] = case.parts["lid"] - ...   # build123d
        return case

Public API:

  load_board(facts) -> Board
      .body        the board solid, cutouts and holes taken out
      .slice       a 0.2 mm slab at mid-thickness: what the board edge gap is measured from
      .parts       {ref: Solid}, each part's envelope box (courtyard x height, on the face it is mounted on)
      .leads       {ref: Solid}, through-hole leads boxes on the far face
      .facts       the facts dict;  .info {ref: part facts};  .top_z, .bottom_z;  .outline (Face at z = 0)
  Case
      .parts       {name: Shape}: "base" and "lid" from the shell, "case" for a handed-in file
      .joints      [{id, type: "fastened" | "press_fit", connects, ...}]
      .fasteners   [{id, ref, size: "M2.5", length_mm, pilot_d_mm, ...}]
      .notes       what the engine changed or could not do, for a person
  shell.two_part(board, settings) -> Case        the printed two-part shell (see tracebridge.mech.shell)
  fit_check(case, board, settings) -> dict       clashes, gaps, openings, assumed heights, summary
  rules_check(case, settings, capabilities)      rule rows against the process's published limits
  export(case, out_dir, formats) -> [names]      case.step, case-<part>.step/.stl/.3mf
  import_case(path) -> Case                      a handed-in STEP as parts["case"]
  run(...) -> dict                               the whole job: what the CLI writes as result.json

Trust: the case script runs in a child process (`python -m tracebridge.mech build-only`, see child.py), never in
this one. The child loads the board and settings, calls build(), and writes one STEP per part and a claims.json
(part names, joints, fasteners, notes, meta) into a private folder this process made; this process reads that
folder strictly (only those names, regular files, size-capped, every value type-checked), loads the solids by their
part names, and runs fit_check and rules_check with its own facts, settings and capabilities. Claims feed records
and notes; pass and fail rest on the geometry measured here and on this process's own settings. Only this process
writes OUTDIR. The built-in template (no --script) is the engine's own code and is built in-process.

build123d needs Python 3.11 or later; it is imported only here, never by tracebridge itself or the bridge's
dispatcher, so the rest of tracebridge keeps working on 3.10 without it.
"""
from __future__ import annotations

import copy
import importlib.util
import json
import sys
import time
import traceback
from pathlib import Path
from typing import Any

from . import child, shell
from .board import Board, load_board
from .export import FORMATS, export, import_case
from .fit import fit_check
from .records import records
from .rules import rules_check
from .settings import InputError, check_facts, normalize_settings, resolve
from .shell import Case

__version__ = "1"  # bumped when the engine's results change for the same inputs (TypeScript's stale check reads it)

__all__ = ["Board", "Case", "InputError", "export", "fit_check", "import_case", "load_board", "records",
           "rules_check", "run", "shell"]

TEMPLATE = Path(__file__).parent / "templates" / "printed-shell.py"


def _read_json(path: str | Path, what: str) -> Any:
    p = Path(path)
    if not p.is_file():
        raise InputError(f"no {what} file {path}")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except ValueError as e:
        raise InputError(f"{what} file {path} is not JSON ({e})") from None


def _tail(exc: BaseException, lines: int = 6) -> str:
    tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)).rstrip().splitlines()
    return "\n".join(tb[-lines:])


def load_script(path: str | Path):
    """The case script as a module, loaded from its file (not by name: a project's case.py must not shadow, or be
    shadowed by, anything on sys.path). Its build() is returned."""
    p = Path(path)
    if not p.is_file():
        raise InputError(f"no case script {path}")
    spec = importlib.util.spec_from_file_location(f"trace_case_{abs(hash(str(p.resolve())))}", p)
    if spec is None or spec.loader is None:
        raise InputError(f"case script {path} cannot be loaded")
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as e:  # noqa: BLE001 - anything the script does on import is the script's problem
        raise InputError(f"case script {p.name} failed to load:\n{_tail(e)}") from None
    build = getattr(mod, "build", None)
    if not callable(build):
        raise InputError(f"case script {p.name} has no build(board, settings) function")
    return build


def _summary(case: Case) -> dict[str, Any]:
    parts = []
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    for n in sorted(case.parts):
        bb = case.parts[n].bounding_box()
        parts.append({"name": n, "volume_mm3": round(float(case.parts[n].volume), 1),
                      "bbox_mm": [round(bb.size.X, 2), round(bb.size.Y, 2), round(bb.size.Z, 2)]})
        for i, (a, b) in enumerate(((bb.min.X, bb.max.X), (bb.min.Y, bb.max.Y), (bb.min.Z, bb.max.Z))):
            lo[i], hi[i] = min(lo[i], a), max(hi[i], b)
    return {"parts": parts, "bbox_mm": [round(h - l, 2) for l, h in zip(lo, hi)] if parts else [0, 0, 0]}


def run(facts: dict[str, Any], settings: dict[str, Any], capabilities: dict[str, Any], out_dir: str | Path, *,
        script: str | Path | None = None, case_file: str | Path | None = None,
        formats: list[str] | tuple[str, ...] = FORMATS) -> dict[str, Any]:
    """Build (or import) the case, check its fit and rules, write its files and records into out_dir, and return the
    result (also what the CLI writes as result.json). Raises InputError for bad input."""
    t0 = time.perf_counter()
    facts = check_facts(facts)
    settings = normalize_settings(settings)
    if not isinstance(capabilities, dict):
        raise InputError("capabilities must be a JSON object")
    bad = [f for f in formats if f not in FORMATS]
    if bad:
        raise InputError(f"unknown format(s) {', '.join(bad)} (known: {', '.join(FORMATS)})")
    res = resolve(settings, capabilities)
    board = load_board(facts)

    notes: list[str] = []
    if res["assembly_clearance_source"] is None:
        notes.append(f"no assembly clearance for {settings['process']['process']} {settings['process']['material']} "
                     f"in the capabilities: {res['assembly_clearance_mm']} mm assumed")
    if settings["source"] == "file":
        if case_file is None:
            raise InputError("settings source is 'file' but no --case-file was given")
        case = import_case(case_file)
    elif script is None:
        # The built-in template: the engine's own code, built in-process on copies so nothing it does to them
        # reaches the checks.
        case = shell.two_part(load_board(copy.deepcopy(facts)), copy.deepcopy(settings))
        case.source = "script"
    else:
        if not Path(script).is_file():
            raise InputError(f"no case script {script}")
        case = child.build_in_child(script, facts, settings)

    fit = fit_check(case, board, settings)
    rules = rules_check(case, settings, capabilities, board if case.source == "script" else None)
    out = Path(out_dir)
    files = export(case, out, formats)  # may add a note (3MF skipped)
    notes += case.notes
    (out / "fit.json").write_text(json.dumps(fit, indent=2) + "\n", encoding="utf-8")
    rec = records(case, facts, fit)
    (out / "case.jsonld").write_text(json.dumps(rec, indent=2) + "\n", encoding="utf-8")
    files += ["fit.json", "case.jsonld"]
    return {
        "version": 1,
        "seconds": round(time.perf_counter() - t0, 3),
        "source": case.source,
        "board_sha256": facts.get("sha256"),
        "case": _summary(case),
        "fit": fit,
        "rules": rules,
        "files": files,
        "records": rec,
        "notes": notes,
        "fasteners": [{k: f[k] for k in ("ref", "size", "length_mm", "pilot_d_mm")} for f in case.fasteners],
    }


def main(argv: list[str] | None = None) -> int:
    """The CLI; see __main__.py."""
    import argparse

    ap = argparse.ArgumentParser(prog="python -m tracebridge.mech", description="trace's enclosure engine")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="build (or import) a case, check its fit and rules, write its files")
    r.add_argument("--facts", required=True)
    r.add_argument("--settings", required=True)
    r.add_argument("--capabilities", required=True)
    r.add_argument("--script")
    r.add_argument("--case-file")
    r.add_argument("--out", required=True)
    r.add_argument("--formats", default=",".join(FORMATS))
    b = sub.add_parser("build-only", help="(internal) run a case script and write its parts and claims, no checks")
    b.add_argument("--facts", required=True)
    b.add_argument("--settings", required=True)
    b.add_argument("--script", required=True)
    b.add_argument("--out", required=True)
    args = ap.parse_args(argv)

    if args.cmd == "build-only":
        return child.main(args)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    try:
        result = run(_read_json(args.facts, "facts"), _read_json(args.settings, "settings"),
                     _read_json(args.capabilities, "capabilities"), out, script=args.script,
                     case_file=args.case_file, formats=[f.strip() for f in args.formats.split(",") if f.strip()])
    except InputError as e:
        (out / "result.json").write_text(json.dumps({"error": str(e)}, indent=2) + "\n", encoding="utf-8")
        print(f"error: {e}", file=sys.stderr)
        return 2
    (out / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"{result['fit']['status']}: {result['fit']['summary']} ({result['seconds']} s)")
    return 0
