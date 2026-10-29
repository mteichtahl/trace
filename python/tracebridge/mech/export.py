"""Files out of a case, and a handed-in STEP in.

Names are fixed by the contract (docs/enclosure-build.md, "What a project holds"): `case.step` is the assembly with
each part named, `case-<part>.step|.stl|.3mf` one file per part, so a person uploads exactly the part to print.
3MF goes through build123d's Mesher (lib3mf); if lib3mf will not load or write here, that format is skipped with a
note rather than failing the build, since STL carries the same mesh.
"""
from __future__ import annotations

import copy
from pathlib import Path

from build123d import Compound, Mesher, export_step, export_stl, import_step

from .settings import InputError
from .shell import Case

FORMATS = ("step", "stl", "3mf")
STL_TOLERANCE_MM = 0.01  # chord deviation: fine enough for a print, small enough to keep files light


def export(case: Case, out_dir: str | Path, formats: list[str] | tuple[str, ...] = FORMATS) -> list[str]:
    """Write the case's files into out_dir; return their names (relative to out_dir) in the order written."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    written: list[str] = []
    names = sorted(case.parts)
    if "step" in formats:
        # Copies: making a shape a Compound's child re-parents it, and a parented shape no longer exports alone.
        children = []
        for n in names:
            c = copy.copy(case.parts[n])
            c.label = n
            children.append(c)
        asm = Compound(children=children)
        asm.label = "case"
        export_step(asm, out / "case.step")
        written.append("case.step")
    for n in names:
        s = case.parts[n]
        if "step" in formats:
            export_step(s, out / f"case-{n}.step")
            written.append(f"case-{n}.step")
        if "stl" in formats:
            export_stl(s, out / f"case-{n}.stl", tolerance=STL_TOLERANCE_MM)
            written.append(f"case-{n}.stl")
        if "3mf" in formats:
            try:
                m = Mesher()
                m.add_shape(s, linear_deflection=STL_TOLERANCE_MM, part_number=n)
                m.write(str(out / f"case-{n}.3mf"))
                written.append(f"case-{n}.3mf")
            except Exception as e:  # noqa: BLE001 - lib3mf's failures are not one type
                (out / f"case-{n}.3mf").unlink(missing_ok=True)
                case.notes.append(f"3MF not written for {n} ({type(e).__name__}: {e}); use the STL")
    return written


def import_case(path: str | Path) -> Case:
    """A handed-in STEP as one case part, "case". Its solids are kept together: a file may hold a base and lid, or one
    body, and the fit check treats it all as the case."""
    p = Path(path)
    if not p.is_file():
        raise InputError(f"no case file {path}")
    try:
        shape = import_step(p)
    except Exception as e:  # noqa: BLE001
        raise InputError(f"{path}: not a readable STEP file ({e})") from None
    solids = shape.solids()
    if not solids:
        raise InputError(f"{path}: the STEP file holds no solids")
    body = solids[0] if len(solids) == 1 else Compound(children=list(solids))
    body.label = "case"
    case = Case(parts={"case": body}, source="file")
    case.notes.append(f"case body from {p.name} ({len(solids)} solid{'' if len(solids) == 1 else 's'}); it does not "
                      "follow board changes until rebuilt from the script")
    return case
