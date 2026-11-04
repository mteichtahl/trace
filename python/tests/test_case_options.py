"""Case options (tracebridge.case_options, plan P7.4): every combination tried against the rules on regions and
relations, the feasible ones ranked with why, the pruned ones kept with their rule. No geometry kernel: runs without
build123d."""
from __future__ import annotations

import copy

from tracebridge import METHODS
from tracebridge.case_options import Regions, options

MJF = {"id": "mjf", "label": "MJF PA12-HP at JLC3DP", "service": "jlc3dp", "max_mm": [370, 276, 360], "recommended": True}
CNC = {"id": "cnc", "label": "CNC aluminium 6061 at JLCCNC", "service": "jlccnc"}
SMALL = {"id": "tiny", "label": "a tiny printer", "service": "jlc3dp", "max_mm": [40, 40, 40]}


def part(ref, x0, y0, x1, y1, h, side="top", connector=False, edge=None):
    return {"ref": ref, "side": side, "box": {"min_x": x0, "min_y": y0, "max_x": x1, "max_y": y1}, "height_mm": h,
            "below_mm": 0.0, "connector": connector, "edge": edge}


def facts(holes=True):
    return {
        "outline": [[100, 100], [150, 100], [150, 140], [100, 140]], "thickness_mm": 1.6,
        "holes": [{"x": x, "y": y, "d": 3.2, "kind": "mounting", "ref": f"H{i}"}
                  for i, (x, y) in enumerate([(103.5, 103.5), (146.5, 103.5), (103.5, 136.5), (146.5, 136.5)], 1)] if holes else [],
        "parts": [part("U1", 120, 115, 130, 125, 1.6), part("J1", 100.5, 115, 106, 125, 8.0, connector=True, edge={"side": "west"})],
    }


def by_template(r, process="mjf"):
    return {o["choices"]["template"]: o for o in r["options"] if o["feasible"] and o["choices"]["process"] == process}


def test_registered_on_the_bridge():
    assert "case.options" in METHODS


def test_at_least_two_feasible_designs_with_reasons_and_the_rest_kept_with_their_rule():
    r = options({"facts": facts(), "processes": [MJF, CNC]})
    feasible = [o for o in r["options"] if o["feasible"]]
    assert r["feasible"] == len(feasible) >= 2
    assert r["feasible"] + r["pruned"] == 3 * 3 * 2 * 2
    assert feasible[0]["recommended"] and feasible[0]["key"] == "printed-shell/screws/lid/mjf" == r["recommended"]
    assert [o["rank"] for o in feasible] == list(range(1, len(feasible) + 1))
    for o in feasible:
        assert o["why"] and o["gives_up"] and len(o["size_mm"]) == 3
    for o in r["options"]:
        if not o["feasible"]:
            assert o["pruned_by"]["rule"] and o["pruned_by"]["why"]
    # with mounting holes, the shell screws the board down: rests and posts are pruned, saying why
    rests = next(o for o in r["options"] if o["key"] == "printed-shell/rests/lid/mjf")
    assert rests["pruned_by"] == {"rule": "mounting-of-template", "why": "the board has 4 mounting holes, so the case screws it down"}


def test_requirements_rank_the_designs():
    r = options({"facts": facts(), "processes": [MJF, CNC], "requirements": ["It mounts on a DIN rail in the cabinet."]})
    assert r["recommended"] == "din-rail/screws/lid/mjf"
    top = r["options"][0]
    assert any("DIN rail" in w for w in top["why"])
    r = options({"facts": facts(), "processes": [MJF, CNC], "requirements": ["A rugged aluminium case for the vibration test."]})
    assert r["options"][0]["choices"]["process"] == "cnc"


def test_a_connector_sticking_out_past_a_long_edge_drops_the_extruded_box():
    f = facts()
    f["parts"].append(part("J2", 120, 136, 128, 143, 6.0, connector=True, edge={"side": "south"}))
    r = options({"facts": f, "processes": [MJF]})
    assert "extruded-box" not in by_template(r)
    assert r["not_offered"] == [{"label": "Extruded box with end plates, MJF PA12-HP at JLC3DP", "template": "extruded-box", "process": "mjf",
                                 "rule": "board-slides-in", "why": "J2 sticks out past the board's long edge, so the board cannot slide into the tube"}]


def test_a_part_under_a_guide_drops_the_extruded_box():
    f = facts()
    f["parts"].append(part("U9", 130, 100.2, 134, 104, 2.0))
    r = options({"facts": f, "processes": [MJF]})
    assert r["not_offered"][0]["rule"] == "guides-need-free-edges"
    assert r["not_offered"][0]["why"] == "U9 sits where a guide holds the board's long edge"


def test_without_holes_the_shell_needs_three_free_corners():
    f = facts(holes=False)
    assert Regions(f).free_corners() == 4
    assert "printed-shell" in by_template(options({"facts": f, "processes": [MJF]}))
    # parts filling three corners' reach: only one corner is left for a rest
    f["parts"] += [part("A", 100, 100, 126, 126, 1.0), part("B", 124, 100, 150, 126, 1.0), part("C", 100, 114, 126, 140, 1.0)]
    r = options({"facts": f, "processes": [MJF]})
    shells = [n for n in r["not_offered"] if n["template"] in ("printed-shell", "din-rail")]
    assert {n["rule"] for n in shells} == {"nothing-floats"}
    assert shells[0]["why"].startswith("only 1 of the board's corners are free of parts")


def test_a_case_larger_than_the_process_makes_is_dropped():
    r = options({"facts": facts(), "processes": [SMALL]})
    assert r["feasible"] == 0 and r["recommended"] is None
    assert {n["rule"] for n in r["not_offered"]} == {"fits-the-process"}
    assert "over a tiny printer's largest part, 40 × 40 × 40 mm" in r["not_offered"][0]["why"]


def test_options_do_not_change_the_facts():
    f = facts()
    before = copy.deepcopy(f)
    options({"facts": f, "processes": [MJF]})
    assert f == before
