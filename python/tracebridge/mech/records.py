"""The case as JSON-LD records (case.jsonld), for the mechanical module.

Node types follow the Autodesk assembly ontology's joint terms (fastened, press fit), under trace's own namespace
until the ontology work maps them; the SHACL shape the layout gate will check waits for that. Ids are deterministic
("case:base", "joint:H1", "fastener:H1"), so two builds of the same board and settings write the same graph.
"""
from __future__ import annotations

from typing import Any

from .shell import Case

CONTEXT = {"trace": "https://trace-eda.com/ns/trace#", "@vocab": "https://trace-eda.com/ns/trace#"}


def records(case: Case, facts: dict[str, Any], fit: dict[str, Any]) -> dict[str, Any]:
    board_id = "board:" + str(facts.get("board") or "board")
    graph: list[dict[str, Any]] = [
        {"@id": "case:enclosure", "@type": "Enclosure", "source": case.source,
         "hasPart": [{"@id": f"case:{n}"} for n in sorted(case.parts)], "encloses": {"@id": board_id}},
        {"@id": board_id, "@type": "Board", "path": facts.get("board"), "sha256": facts.get("sha256"),
         "thickness_mm": facts.get("thickness_mm")},
    ]
    for n in sorted(case.parts):
        sz = case.parts[n].bounding_box().size
        graph.append({"@id": f"case:{n}", "@type": "CasePart", "name": n,
                      "bbox_mm": [round(sz.X, 3), round(sz.Y, 3), round(sz.Z, 3)]})
    for f in case.fasteners:
        graph.append({"@id": f["id"], "@type": "Fastener", "size": f["size"], "length_mm": f["length_mm"],
                      "pilot_d_mm": f["pilot_d_mm"]})
    for j in case.joints:
        if j["type"] == "fastened":
            graph.append({"@id": j["id"], "@type": "FastenedJoint",
                          "connects": [{"@id": board_id}, {"@id": "case:base"}], "fastener": {"@id": j["fastener"]}})
        elif j["type"] == "press_fit":
            graph.append({"@id": j["id"], "@type": "PressFitJoint",
                          "connects": [{"@id": "case:lid"}, {"@id": "case:base"}], "clearance_mm": j["clearance_mm"]})
    graph.append({"@id": "check:fit", "@type": "FitCheck", "status": fit["status"],
                  "clashCount": len(fit["clashes"]), "gapViolations": sum(1 for g in fit["gaps"] if not g["ok"]),
                  "boardSha256": facts.get("sha256"), "checks": {"@id": "case:enclosure"}})
    return {"@context": CONTEXT, "@graph": graph}
