"""The bridge's SHACL runner (tracebridge.shapes): trace's own shapes, with the SPARQL extension, over a graph given as
Turtle. A graph that keeps to the shape conforms; each break is one finding naming its node, in a stable order."""
from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("pyshacl")

from tracebridge import METHODS, BridgeError  # noqa: E402
import tracebridge.shapes  # noqa: E402,F401  (registers shapes.*)

SHAPE = (Path(__file__).resolve().parents[2] / "ontology" / "shapes" / "architect.mapped.ttl").read_text()
P = "@prefix trace: <https://trace-eda.com/ns/trace#> .\n@prefix x: <urn:x:> .\n"
BASE = P + """
x:j a trace:Journey .
x:a a trace:ArchitectureOption ; trace:isCurrentOption true .
x:b a trace:ArchitectureOption ; trace:isCurrentOption false .
x:r1 a trace:Requirement ; trace:isLive true ; trace:text "Runs a year on two cells." .
x:k1 a trace:FunctionalBlock ; trace:forOption x:a ; trace:servesRequirement x:r1 .
"""


def check(data: str) -> dict:
    return METHODS["shapes.check"](data=data, shapes=[SHAPE])


def test_conforms_when_every_live_requirement_is_served():
    assert check(BASE) == {"conforms": True, "findings": []}


def test_each_unserved_requirement_is_one_finding_in_a_stable_order():
    data = BASE + """
x:r3 a trace:Requirement ; trace:isLive true ; trace:text "Survives rain." .
x:r2 a trace:Requirement ; trace:isLive true ; trace:text "Reads soil moisture." .
x:r4 a trace:Requirement ; trace:isLive false ; trace:text "Struck." .
x:k2 a trace:FunctionalBlock ; trace:forOption x:b ; trace:servesRequirement x:r2 .
x:k3 a trace:FunctionalBlock ; trace:forOption x:a ; trace:servesRequirement x:r3 ; trace:status "withdrawn" .
"""
    r = check(data)
    assert r["conforms"] is False
    assert [(f["focus"], f["severity"]) for f in r["findings"]] == [("urn:x:r2", "violation"), ("urn:x:r3", "violation")]
    assert r["findings"][0]["message"] == 'No block of the chosen architecture serves "Reads soil moisture.". Add it to a block, or strike it with a reason.'


def test_nothing_to_map_is_not_met():
    r = check(P + "x:j a trace:Journey .\n")
    assert sorted(f["message"].split(":")[0] for f in r["findings"]) == ["No architecture is proposed yet", "No requirements are recorded yet"]


def test_refuses_what_is_not_turtle():
    with pytest.raises(BridgeError, match="graph is not valid Turtle"):
        check("this is not turtle")
    with pytest.raises(BridgeError, match="no shapes given"):
        METHODS["shapes.check"](data=BASE, shapes=[])
