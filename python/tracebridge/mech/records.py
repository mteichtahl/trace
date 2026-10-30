"""The case as JSON-LD records (case.jsonld), in the ontology's mechanical module (docs/ontology.md: prefix `tm:`,
namespace https://trace-eda.com/ns/trace/mech#).

Nodes: the `Enclosure` with its `EnclosurePart`s (partKind base, lid, or case for a handed-in file), its `Material`
(name and process), one `Fastener` and one `MountingPoint` per screw, an `Opening` per connector cut (face = the
compass side), a `Joint` per fastened or press-fit pair (jointKind from the ontology's closed list), the board's
`BoardOutline`, and a `FitCheck` with what the fit measured. Ids are deterministic ("case:base", "joint:H1",
"fastener:H1"), so two builds of the same board and settings write the same graph. The SHACL shape behind the
layout gate's fit criterion is the ontology work's; these records are what it will read.
"""
from __future__ import annotations

from typing import Any

from .shell import Case

MECH = "https://trace-eda.com/ns/trace/mech#"
CONTEXT = {"tm": MECH, "@vocab": MECH}
# the ontology's closed list of joint kinds, from the shell's own names
JOINT_KINDS = {"fastened": "fastened", "press_fit": "press-fit"}


def records(case: Case, facts: dict[str, Any], fit: dict[str, Any], settings: dict[str, Any] | None = None) -> dict[str, Any]:
    board_id = "board:" + str(facts.get("board") or "board")
    process = (settings or {}).get("process") or {}
    graph: list[dict[str, Any]] = [
        {"@id": "case:enclosure", "@type": "Enclosure", "source": case.source,
         "hasPart": [{"@id": f"case:{n}"} for n in sorted(case.parts)],
         "material": {"@id": "material:case"}, "encloses": {"@id": board_id}},
        {"@id": "material:case", "@type": "Material", "name": process.get("material"), "process": process.get("process"),
         "service": process.get("service")},
        {"@id": board_id, "@type": "BoardOutline", "path": facts.get("board"), "sha256": facts.get("sha256"),
         "thickness": facts.get("thickness_mm"), "unit": "mm"},
    ]
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    for n in sorted(case.parts):
        bb = case.parts[n].bounding_box()
        for i, (a, b) in enumerate(((bb.min.X, bb.max.X), (bb.min.Y, bb.max.Y), (bb.min.Z, bb.max.Z))):
            lo[i], hi[i] = min(lo[i], a), max(hi[i], b)
        sz = bb.size
        node: dict[str, Any] = {"@id": f"case:{n}", "@type": "EnclosurePart", "partKind": n,
                                "boundingBox": [round(sz.X, 3), round(sz.Y, 3), round(sz.Z, 3)], "unit": "mm"}
        wall = (case.meta or {}).get("wall_mm")
        if isinstance(wall, (int, float)) and n in ("base", "lid"):
            node["wallThickness"] = wall
        if n == "base" and case.fasteners:
            node["hasStandoff"] = [{"@id": f"standoff:{f['ref']}"} for f in case.fasteners]
        graph.append(node)
    graph[0]["outerSize"] = [round(h - l, 3) for l, h in zip(lo, hi)] if case.parts else None
    for f in case.fasteners:
        graph.append({"@id": f["id"], "@type": "Fastener", "kind": "screw", "size": f["size"], "length": f["length_mm"],
                      "pilotDiameter": f["pilot_d_mm"], "unit": "mm"})
        graph.append({"@id": f"mount:{f['ref']}", "@type": "MountingPoint", "ref": f["ref"], "x": f.get("x"), "y": f.get("y"),
                      "diameter": f.get("hole_d_mm"), "fastener": {"@id": f["id"]}, "unit": "mm"})
    for o in fit.get("openings") or []:
        if o.get("made"):
            graph.append({"@id": f"opening:{o['ref']}", "@type": "Opening", "forComponent": o["ref"], "face": o.get("side"),
                          "inPart": [{"@id": "case:base"}, {"@id": "case:lid"}]})
    for j in case.joints:
        kind = JOINT_KINDS.get(j["type"])
        if kind is None:
            continue
        joins = [{"@id": board_id}, {"@id": "case:base"}] if j["type"] == "fastened" else [{"@id": "case:lid"}, {"@id": "case:base"}]
        node = {"@id": j["id"], "@type": "Joint", "jointKind": kind, "joins": joins}
        if j["type"] == "fastened":
            node["usesFastener"] = {"@id": j["fastener"]}
        else:
            node["clearance"] = j.get("clearance_mm")
            node["unit"] = "mm"
        graph.append(node)
    graph.append({"@id": "check:fit", "@type": "FitCheck", "status": fit["status"], "enclosed": fit.get("enclosed"),
                  "clashCount": len(fit["clashes"]), "clashes": [c["ref"] for c in fit["clashes"]],
                  "gapViolations": sum(1 for g in fit["gaps"] if not g["ok"]),
                  "boardSha256": facts.get("sha256"), "checks": {"@id": "case:enclosure"}})
    return {"@context": CONTEXT, "@graph": graph}
