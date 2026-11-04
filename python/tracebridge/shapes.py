"""SHACL shapes behind trace's own gate criteria (docs/ontology.md "Gates as SHACL shapes"): pySHACL, with the
SHACL-SPARQL extension, over a project's graph as trace builds it (src/ontology/graph.ts), given as Turtle.

    shapes.check  {data: Turtle, shapes: [Turtle, ...]} -> {conforms, findings: [{focus, path, value, message,
                  severity, shape}]}, findings sorted so the same graph always gives the same list

The graph and shapes come as text, not paths: the caller builds the graph in memory and the shapes ship with trace
(ontology/shapes/). No inference: trace's records are checked as they are (docs/ontology.md: reasoning is limited to
subclass lookups, which the shapes spell out with rdfs:subClassOf* paths where they need them).
"""
from __future__ import annotations

from typing import Any

from . import BridgeError, method

from pyshacl import validate  # noqa: E402  (a missing pyshacl makes this module unavailable, reported by bridge.status)
from rdflib import Graph, Namespace, URIRef  # noqa: E402

SH = Namespace("http://www.w3.org/ns/shacl#")


def _graph(text: str, what: str) -> Graph:
    g = Graph()
    try:
        g.parse(data=text, format="turtle")
    except Exception as e:  # rdflib raises several kinds
        raise BridgeError(f"the {what} is not valid Turtle: {e}") from e
    return g


def _short(v: Any) -> str | None:
    return None if v is None else str(v)


@method("shapes.check")
def check(data: str, shapes: list[str]) -> dict[str, Any]:
    if not shapes:
        raise BridgeError("no shapes given")
    g = _graph(data, "graph")
    sg = Graph()
    for i, s in enumerate(shapes):
        sg += _graph(s, f"shape file {i + 1}")
    conforms, results, _text = validate(g, shacl_graph=sg, inference="none", advanced=True, allow_warnings=True)
    findings = []
    for r in results.subjects(predicate=URIRef("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"), object=SH.ValidationResult):
        sev = results.value(r, SH.resultSeverity)
        findings.append({
            "focus": _short(results.value(r, SH.focusNode)),
            "path": _short(results.value(r, SH.resultPath)),
            "value": _short(results.value(r, SH.value)),
            "message": _short(results.value(r, SH.resultMessage)) or "a rule of the shape is broken",
            "severity": "violation" if sev is None or sev == SH.Violation else "warning" if sev == SH.Warning else "info",
            "shape": _short(results.value(r, SH.sourceShape)),
        })
    findings.sort(key=lambda f: (f["shape"] or "", f["focus"] or "", f["message"]))
    return {"conforms": bool(conforms), "findings": findings}
