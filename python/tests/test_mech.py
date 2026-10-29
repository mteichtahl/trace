"""tracebridge.mech against synthetic boards: geometry measured, not just files listed.

The board is 50 x 40 mm at KiCad (100, 100)-(150, 140), 1.6 mm thick, with four M3 mounting holes, a USB-C (J1) at
the south edge overhanging it by 1 mm, a 12 mm through-hole electrolytic (C1), and a few small parts on both sides.
"""
from __future__ import annotations

import copy
import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

pytest.importorskip("build123d")

from build123d import Pos  # noqa: E402

from tracebridge import mech  # noqa: E402
from tracebridge.mech import InputError, load_board, run, shell  # noqa: E402

PYTHON_DIR = Path(__file__).resolve().parents[1]
SOURCE = "https://jlc3dp.com/help/article/3d-printing-design-guideline"

CAPS = {
    "checked": "2026-10-29",
    "processes": [{
        "service": "jlc3dp", "process": "MJF", "materials": ["PA12-HP", "PA12S", "PA11-HP"],
        "max_mm": [370, 276, 360], "min_mm": [5, 5, 5],
        "wall_by_size": [[5, 1.0], [10, 1.2], [50, 1.5], [100, 2.0], [200, 2.0]],
        "assembly_clearance_mm": 0.2, "moving_clearance_mm": 0.6,
        "tolerance": "±0.3 mm up to 100 mm, ±0.4% above", "hole_min_d_mm": 1.5, "source": SOURCE,
    }],
    "cnc": {"wall_min_mm": {"metal": 0.5, "plastic": 1.0}, "wall_recommended_mm": {"metal": 0.8, "plastic": 1.5},
            "corner_radius": "R = H / 10 + 0.5 mm for a cavity H deep; R0.5 for H <= 3 mm",
            "tolerance": "±0.1 mm", "source": "https://jlccnc.com/help/article/CNC-Machining-Design-Guideline"},
}


def part(ref, x0, y0, x1, y1, h, side="top", mount="smd", connector=False, edge=None, src="table"):
    return {"ref": ref, "value": ref, "footprint": f"Lib:{ref}", "side": side, "x": (x0 + x1) / 2,
            "y": (y0 + y1) / 2, "rotation_deg": 0, "mount": mount,
            "box": {"min_x": x0, "min_y": y0, "max_x": x1, "max_y": y1}, "box_source": "courtyard",
            "height_mm": h, "height_source": src, "below_mm": 2.0 if mount == "through_hole" else 0.0,
            "connector": connector, "edge": edge}


def board_facts() -> dict:
    holes = [{"x": x, "y": y, "d": 3.2, "kind": "mounting", "ref": f"H{i}"}
             for i, (x, y) in enumerate([(103.5, 103.5), (146.5, 103.5), (103.5, 136.5), (146.5, 136.5)], 1)]
    return {
        "version": 1, "board": "hardware/test.kicad_pcb", "sha256": "0" * 64, "thickness_mm": 1.6,
        "outline": [[100, 100], [150, 100], [150, 140], [100, 140]], "cutouts": [], "holes": holes,
        "parts": [
            part("J1", 120.5, 133.0, 129.5, 141.0, 3.3, connector=True, edge={"side": "south", "distance_mm": 0.0}),
            part("C1", 110.5, 110.5, 119.5, 119.5, 12.0, mount="through_hole", src="field"),
            part("U1", 130.0, 115.0, 140.0, 125.0, 1.6),
            part("U3", 125.0, 104.0, 129.0, 108.0, 5.0, src="default"),
            part("R1", 112.0, 127.0, 113.6, 128.6, 0.5, side="bottom"),
            part("R2", 135.0, 130.0, 136.6, 131.6, 0.5),
        ],
        "warnings": ["U3 has no Height field and no table entry: assumed 5 mm"],
    }


def settings(**over) -> dict:
    s = {"version": 1, "board": "hardware/test.kicad_pcb", "template": "printed-shell", "source": "script",
         "process": {"service": "jlc3dp", "process": "MJF", "material": "PA12-HP"}}
    for k, v in over.items():
        s[k] = v
    return s


def gap(result, ref, where):
    return next(g for g in result["fit"]["gaps"] if g["ref"] == ref and g["where"] == where)


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    out = tmp_path_factory.mktemp("built")
    t = time.perf_counter()
    r = run(board_facts(), settings(), CAPS, out)
    r["_wall_seconds"] = time.perf_counter() - t
    return r, out


def test_template_build_passes(built):
    r, _ = built
    fit = r["fit"]
    assert fit["status"] == "pass", fit["summary"]
    assert fit["enclosed"] is True
    assert fit["clashes"] == []
    assert all(g["ok"] for g in fit["gaps"])
    # The board's edge gap is the configured clearance, measured on the solids.
    assert abs(gap(r, "board", "edge")["measured_mm"] - 0.5) <= 0.01
    # The lid's inner face sits above_tallest_mm over the tallest part (C1, 12 mm).
    assert abs(gap(r, "C1", "above")["measured_mm"] - 1.0) <= 0.01
    # The standoff is set by C1's 2 mm leads + below_mm, so the leads clear the floor by exactly below_mm.
    assert abs(gap(r, "C1", "below")["measured_mm"] - 1.0) <= 0.01
    assert gap(r, "R1", "below")["measured_mm"] >= 1.0
    assert fit["openings"] == [{"ref": "J1", "side": "south", "made": True}]
    assert gap(r, "J1", "around")["required_mm"] == 0.0
    assert fit["assumptions"] == [{"ref": "U3", "height_mm": 5.0, "source": "default"}]
    assert "1 height assumed (U3)" in fit["summary"]
    assert r["source"] == "script" and r["board_sha256"] == "0" * 64
    names = [p["name"] for p in r["case"]["parts"]]
    assert names == ["base", "lid"]
    # 50 x 40 board + 2 x (0.5 edge gap + 2.0 lip + 0.2 lip clearance + 2.0 base wall).
    assert r["case"]["bbox_mm"][:2] == [59.4, 49.4]
    assert [f["size"] for f in r["fasteners"]] == ["M3"] * 4
    assert all(row["ok"] for row in r["rules"]), r["rules"]
    assert all(row["source"] == SOURCE for row in r["rules"])
    # The built sections, measured on the model, each meet MJF's 2.0 mm for a part over 50 mm.
    built = {row["rule"]: row for row in r["rules"] if row["basis"] == "model"}
    for k in ("base_wall", "lip_wall", "lid_wall", "base_floor", "lid_top"):
        assert built[k]["limit"] == 2.0 and built[k]["measured"] >= 2.0 - 1e-3, built[k]
    assert built["base_wall"]["measured"] == pytest.approx(2.0, abs=0.01)
    assert built["lip_wall"]["measured"] == pytest.approx(2.0, abs=0.01)
    assert r["_wall_seconds"] < 5.0


def test_shell_heights_and_bosses():
    board = load_board(board_facts())
    s = mech.settings.normalize_settings(settings())
    mech.settings.resolve(s, CAPS)
    case = shell.two_part(board, s)
    assert case.meta["standoff_mm"] == pytest.approx(3.0)  # C1 leads 2 + below 1
    assert case.meta["lid_inner_z"] == pytest.approx(1.6 + 12.0 + 1.0)
    assert case.meta["lip_gap_mm"] == pytest.approx(0.2)
    base_bb = case.parts["base"].bounding_box()
    assert base_bb.min.Z == pytest.approx(-3.0 - 2.0)  # floor below the standoff
    assert base_bb.max.Z == pytest.approx(1.6)  # base walls stop at the board's top face
    # Each boss is solid around a pilot hole at its mounting hole: the hole centre is empty, the boss ring is not.
    for x, y in [(103.5, -103.5), (146.5, -136.5)]:
        assert not case.parts["base"].is_inside((x, y, -1.5))
        assert case.parts["base"].is_inside((x + 2.0, y, -1.5))
    assert {j["id"] for j in case.joints} == {"joint:H1", "joint:H2", "joint:H3", "joint:H4", "joint:lid-base"}


def test_no_mounting_holes_uses_rests_and_posts(tmp_path):
    facts = board_facts()
    facts["holes"] = []
    r = run(facts, settings(), CAPS, tmp_path, formats=["step"])
    assert r["fit"]["status"] == "pass", r["fit"]["summary"]
    assert any("4 rests" in n and "4 lid posts" in n for n in r["notes"])
    assert r["fasteners"] == []


def test_supports_move_off_a_part_in_a_corner(tmp_path):
    # A tall header in the north-east corner, where a fixed corner post would land on it (the sample board's J2).
    facts = board_facts()
    facts["holes"] = []
    facts["parts"].append(part("J2", 144.0, 101.0, 148.0, 111.0, 11.0, mount="through_hole"))
    r = run(facts, settings(), CAPS, tmp_path, formats=["step"])
    assert r["fit"]["status"] == "pass", r["fit"]["summary"]
    assert not [c for c in r["fit"]["clashes"] if c["ref"] == "J2"]
    assert any("4 rests" in n for n in r["notes"])


def test_too_tight_lid_clashes_and_names_part(tmp_path):
    script = tmp_path / "case.py"
    script.write_text(
        "from build123d import Pos\n"
        "from tracebridge.mech import shell\n\n"
        "def build(board, settings):\n"
        "    case = shell.two_part(board, settings)\n"
        "    case.parts['lid'] = Pos(0, 0, -2) * case.parts['lid']\n"
        "    return case\n")
    r = run(board_facts(), settings(), CAPS, tmp_path / "out", script=script, formats=["step"])
    fit = r["fit"]
    assert fit["status"] == "fail"
    c1 = [c for c in fit["clashes"] if c["ref"] == "C1" and c["case_part"] == "lid"]
    # C1's 9 x 9 mm top pushed 1 mm into the lid (2 mm down, 1 mm clearance).
    assert c1 and c1[0]["volume_mm3"] == pytest.approx(81.0, abs=0.5)
    assert "C1 with lid" in fit["summary"]


def test_part_clearance_override_fails_the_gap(tmp_path):
    facts = board_facts()
    # A tall part 1 mm from the east edge needs 2 mm all round: it gets 1 mm + the 0.5 mm edge gap.
    facts["parts"].append(part("U2", 140.0, 120.0, 149.0, 128.0, 4.0))
    s = settings(clearance={"parts": {"U2": {"mm": 2.0, "reason": "heatsink airflow"}}})
    r = run(facts, s, CAPS, tmp_path, formats=["step"])
    g = gap(r, "U2", "around")
    assert g["ok"] is False and g["required_mm"] == 2.0
    assert g["measured_mm"] == pytest.approx(1.5, abs=0.01)
    assert r["fit"]["status"] == "fail"
    assert "U2 around 1.50 mm, needs 2.00 mm" in r["fit"]["summary"]


def test_edge_clearance_is_what_is_built(tmp_path):
    r = run(board_facts(), settings(clearance={"edge_mm": 1.25}), CAPS, tmp_path, formats=["step"])
    assert gap(r, "board", "edge")["measured_mm"] == pytest.approx(1.25, abs=0.01)
    assert r["fit"]["status"] == "pass"


def test_skipped_opening_clashes_with_the_wall(tmp_path):
    r = run(board_facts(), settings(openings={"skip": ["J1"]}), CAPS, tmp_path, formats=["step"])
    fit = r["fit"]
    assert fit["status"] == "fail"
    assert {"ref": "J1", "side": "south", "made": False} in fit["openings"]
    j1 = [c for c in fit["clashes"] if c["ref"] == "J1"]
    assert j1 and all(c["volume_mm3"] > 1.0 for c in j1)
    assert {c["ref"] for c in fit["clashes"]} == {"J1"}
    assert "no opening for J1" in fit["summary"]


def test_rules_flag_thin_mjf_wall(tmp_path):
    r = run(board_facts(), settings(params={"wall_mm": 1.0}), CAPS, tmp_path, formats=["step"])
    wall = next(row for row in r["rules"] if row["rule"] == "wall")
    assert wall["ok"] is False
    assert wall["measured"] == 1.0 and wall["limit"] == 2.0  # MJF: 2.0 mm for a part over 50 mm
    assert wall["source"] == SOURCE and wall["basis"] == "params"
    assert "1 mm is under MJF's 2 mm" in wall["detail"]


def test_rules_unknown_process(tmp_path):
    s = settings(process={"service": "jlc3dp", "process": "MJF", "material": "Unobtainium"})
    r = run(board_facts(), s, CAPS, tmp_path, formats=["step"])
    assert r["rules"][0]["rule"] == "process" and r["rules"][0]["ok"] is False
    assert any("0.2 mm assumed" in n for n in r["notes"])


def test_handed_in_step_round_trip(built, tmp_path):
    _, out = built
    r = run(board_facts(), settings(source="file", file="mechanical/case.step"), CAPS, tmp_path,
            case_file=out / "case.step")
    assert r["source"] == "file"
    assert [p["name"] for p in r["case"]["parts"]] == ["case"]
    assert r["fit"]["status"] == "pass", r["fit"]["summary"]
    assert gap(r, "board", "edge")["measured_mm"] == pytest.approx(0.5, abs=0.01)
    assert r["fit"]["openings"] == [{"ref": "J1", "side": "south", "made": True}]
    wall = next(row for row in r["rules"] if row["rule"] == "wall")
    assert wall["ok"] is None and wall["basis"] == "bbox"
    assert "case-case.step" in r["files"]


def test_exports_exist_and_are_named(built):
    r, out = built
    want = ["case.step", "case-base.step", "case-base.stl", "case-base.3mf", "case-lid.step", "case-lid.stl",
            "case-lid.3mf", "fit.json", "case.jsonld"]
    assert r["files"] == want
    for name in want:
        assert (out / name).stat().st_size > 0, name
    from build123d import import_step
    asm = import_step(out / "case.step")
    assert sorted(c.label for c in asm.children) == ["base", "lid"]
    assert json.loads((out / "fit.json").read_text()) == r["fit"]


def test_records_have_expected_nodes(built):
    r, out = built
    rec = json.loads((out / "case.jsonld").read_text())
    assert rec == r["records"]
    assert rec["@context"]["trace"] == "https://trace-eda.com/ns/trace#"
    by_id = {n["@id"]: n for n in rec["@graph"]}
    types = {n["@type"] for n in rec["@graph"]}
    assert {"Enclosure", "CasePart", "Board", "FastenedJoint", "Fastener", "PressFitJoint", "FitCheck"} <= types
    assert {"case:base", "case:lid", "joint:H1", "fastener:H1", "joint:lid-base", "check:fit"} <= set(by_id)
    assert by_id["fastener:H1"]["size"] == "M3"
    assert by_id["joint:lid-base"]["clearance_mm"] == 0.2
    assert by_id["check:fit"]["status"] == "pass" and by_id["check:fit"]["clashCount"] == 0
    assert by_id["check:fit"]["boardSha256"] == "0" * 64


def test_bad_input():
    with pytest.raises(InputError, match="params.wall_mm"):
        run(board_facts(), settings(params={"wall_mm": -1}), CAPS, "unused")
    with pytest.raises(InputError, match="outline"):
        run({"version": 1, "outline": [[0, 0]]}, settings(), CAPS, "unused")


def test_template_matches_contract():
    text = mech.TEMPLATE.read_text()
    assert text.startswith("from tracebridge.mech import shell\n\ndef build(board, settings):\n")
    assert "case = shell.two_part(board, settings)" in text and "return case" in text


def _cli(tmp_path, *extra, script=None, settings_obj=None):
    tmp_path.mkdir(parents=True, exist_ok=True)
    (tmp_path / "facts.json").write_text(json.dumps(board_facts()))
    (tmp_path / "case.json").write_text(json.dumps(settings_obj if settings_obj is not None else settings()))
    (tmp_path / "caps.json").write_text(json.dumps(CAPS))
    args = [sys.executable, "-m", "tracebridge.mech", "run", "--facts", str(tmp_path / "facts.json"),
            "--settings", str(tmp_path / "case.json"), "--capabilities", str(tmp_path / "caps.json"),
            "--out", str(tmp_path / "out"), *extra]
    if script:
        args += ["--script", str(script)]
    env = {"PYTHONPATH": str(PYTHON_DIR), "PATH": "/usr/bin:/bin"}
    p = subprocess.run(args, capture_output=True, text=True, env=env, timeout=120)
    return p, json.loads((tmp_path / "out" / "result.json").read_text())


def test_cli_exit_codes(tmp_path):
    p, res = _cli(tmp_path / "ok", "--formats", "step")
    assert p.returncode == 0, p.stderr
    assert res["fit"]["status"] == "pass" and res["files"][0] == "case.step"

    bad = tmp_path / "bad.py"
    bad.write_text("def build(board, settings):\n    raise ValueError('lid too thin to cut')\n")
    p, res = _cli(tmp_path / "raises", script=bad)
    assert p.returncode == 2
    assert "build() raised" in res["error"] and "ValueError: lid too thin to cut" in res["error"]

    nobuild = tmp_path / "nobuild.py"
    nobuild.write_text("X = 1\n")
    p, res = _cli(tmp_path / "nobuild", script=nobuild)
    assert p.returncode == 2 and "no build(board, settings)" in res["error"]

    p, res = _cli(tmp_path / "invalid", settings_obj=settings(params={"floor_mm": "thick"}))
    assert p.returncode == 2 and "params.floor_mm" in res["error"]

    p, res = _cli(tmp_path / "missing", script=tmp_path / "nope.py")
    assert p.returncode == 2 and "no case script" in res["error"]


def _foreign_step(built_out: Path, tmp_path: Path, name: str, move) -> Path:
    from build123d import Compound, export_step, import_step
    shape = import_step(built_out / "case.step")
    moved = Compound(children=[move * s for s in shape.solids()])
    path = tmp_path / f"{name}.step"
    export_step(moved, path)
    return path


@pytest.mark.parametrize("name,move", [("offset", Pos(500, 0, 0)), ("unflipped", Pos(0, 240, 0))])
def test_foreign_frame_step_fails_not_around(built, tmp_path, name, move):
    # 500 mm away, or in KiCad's y-down frame (y 100..140 instead of -140..-100): every gap would measure nothing.
    _, out = built
    path = _foreign_step(out, tmp_path, name, move)
    r = run(board_facts(), settings(source="file", file=f"mechanical/{name}.step"), CAPS, tmp_path / "out",
            case_file=path, formats=["step"])
    fit = r["fit"]
    assert fit["status"] == "fail" and fit["enclosed"] is False
    assert "the case is not around the board" in fit["summary"] and "KiCad's y is down" in fit["summary"]
    assert gap(r, "board", "edge")["ok"] is False
    assert gap(r, "U1", "above")["ok"] is False


def test_script_deleting_the_lid_fails(tmp_path):
    script = tmp_path / "case.py"
    script.write_text("from tracebridge.mech import shell\n\ndef build(board, settings):\n"
                      "    case = shell.two_part(board, settings)\n    del case.parts['lid']\n    return case\n")
    r = run(board_facts(), settings(), CAPS, tmp_path / "out", script=script, formats=["step"])
    fit = r["fit"]
    assert fit["status"] == "fail" and fit["enclosed"] is False
    assert "the case is not around the board" in fit["summary"]
    u1 = gap(r, "U1", "above")
    assert u1["ok"] is False and u1["measured_mm"] is None and u1["detail"] == "nothing covers U1 from above"


def test_script_cannot_mutate_the_checks(tmp_path):
    # r1_mutate / r3: a script that drops C1 from the board, rewrites the settings and replaces fit_check, all in
    # its own process; the parent measures with its own board and settings, so the sunk lid still clashes with C1.
    script = tmp_path / "case.py"
    script.write_text(
        "import tracebridge.mech as m\n"
        "from build123d import Pos\n"
        "from tracebridge.mech import shell\n\n"
        "def build(board, settings):\n"
        "    case = shell.two_part(board, settings)\n"
        "    case.parts['lid'] = Pos(0, 0, -2) * case.parts['lid']\n"
        "    board.parts.pop('C1'); board.leads.pop('C1', None)\n"
        "    settings['clearance']['above_tallest_mm'] = 0.0\n"
        "    m.fit_check = lambda c, b, s: {'status': 'pass', 'clashes': [], 'gaps': [], 'openings': [],\n"
        "                                   'assumptions': [], 'summary': 'fits'}\n"
        "    m.rules_check = lambda c, s, k: []\n"
        "    case.meta['openings'] = [{'ref': 'J1', 'side': 'south', 'made': True}]\n"
        "    return case\n")
    r = run(board_facts(), settings(), CAPS, tmp_path / "out", script=script, formats=["step"])
    fit = r["fit"]
    assert fit["status"] == "fail"
    assert any(c["ref"] == "C1" and c["case_part"] == "lid" for c in fit["clashes"])
    assert gap(r, "U1", "above")["required_mm"] == 1.0
    assert r["rules"] and r["records"]["@graph"][-1]["status"] == "fail"


def test_script_settings_change_is_measured_against_the_parents(tmp_path):
    script = tmp_path / "case.py"
    script.write_text(
        "from tracebridge.mech import shell\n\n"
        "def build(board, settings):\n"
        "    settings['clearance']['edge_mm'] = 0.1\n"
        "    return shell.two_part(board, settings)\n")
    r = run(board_facts(), settings(), CAPS, tmp_path / "out", script=script, formats=["step"])
    g = gap(r, "board", "edge")
    assert g["required_mm"] == 0.5 and g["measured_mm"] == pytest.approx(0.1, abs=0.01) and g["ok"] is False


def test_child_cannot_write_result_json(tmp_path):
    # The child runs in a private folder and is not told OUTDIR; whatever it writes, the parent writes result.json.
    script = tmp_path / "case.py"
    script.write_text(
        "import json, os\n"
        "from tracebridge.mech import shell\n\n"
        "def build(board, settings):\n"
        "    open('result.json', 'w').write('{\"fit\": {\"status\": \"pass\"}}')\n"
        "    open('claims.json.extra', 'w').write('x')\n"
        "    case = shell.two_part(board, settings)\n"
        "    del case.parts['lid']\n"
        "    return case\n")
    p, res = _cli(tmp_path, "--formats", "step", script=script)
    assert p.returncode == 0, p.stderr
    assert res["fit"]["status"] == "fail" and res["version"] == 1
    assert not (tmp_path / "result.json").exists()


def test_bad_part_name_from_script(tmp_path):
    script = tmp_path / "case.py"
    script.write_text(
        "from tracebridge.mech import shell\n\n"
        "def build(board, settings):\n"
        "    case = shell.two_part(board, settings)\n"
        "    case.parts['../result'] = case.parts.pop('lid')\n"
        "    return case\n")
    with pytest.raises(InputError, match="short lowercase name"):
        run(board_facts(), settings(), CAPS, tmp_path / "out", script=script, formats=["step"])


def test_version_is_a_string():
    assert isinstance(mech.__version__, str) and mech.__version__ == "1"


def test_built_sections_are_measured(tmp_path):
    # The old default lip (1.2 mm) is under MJF's 2.0 mm; the built row says so even though wall_mm meets it.
    r = run(board_facts(), settings(params={"lip_mm": 1.2}), CAPS, tmp_path / "a", formats=["step"])
    rows = {row["rule"]: row for row in r["rules"]}
    assert rows["wall"]["ok"] is True
    assert rows["lip_wall"]["ok"] is False and rows["lip_wall"]["measured"] == pytest.approx(1.2, abs=0.01)
    assert rows["lip_wall"]["basis"] == "model"
    # A script that thins the base's wall from outside: the parameter still says 2 mm, the model does not.
    script = tmp_path / "case.py"
    script.write_text(
        "from build123d import Pos, Solid\n"
        "from tracebridge.mech import shell\n\n"
        "def build(board, settings):\n"
        "    case = shell.two_part(board, settings)\n"
        "    bb = case.parts['base'].bounding_box()\n"
        "    case.parts['base'] = case.parts['base'] - Pos(bb.min.X - 1, bb.min.Y - 1, bb.min.Z - 1) * "
        "Solid.make_box(2.0, bb.size.Y + 2, bb.size.Z + 2)\n"
        "    return case\n")
    r = run(board_facts(), settings(), CAPS, tmp_path / "b", script=script, formats=["step"])
    rows = {row["rule"]: row for row in r["rules"]}
    assert rows["wall"]["ok"] is True and rows["base_wall"]["ok"] is False
    assert rows["base_wall"]["measured"] == pytest.approx(1.0, abs=0.01)


def test_lip_deeper_than_the_base_is_refused(tmp_path):
    # The base has 1.6 + 3.0 (standoff) - 0.5 (margin) = 4.1 mm of room for the lip.
    with pytest.raises(InputError, match=r"lip_h_mm 6 mm is deeper than the base has room for: 4.1 mm"):
        run(board_facts(), settings(params={"lip_h_mm": 6.0}), CAPS, tmp_path / "a", formats=["step"])
    board = load_board(board_facts())
    s = mech.settings.normalize_settings(settings(params={"lip_h_mm": 4.1}))
    mech.settings.resolve(s, CAPS)
    case = shell.two_part(board, s)
    base, lid = case.parts["base"], case.parts["lid"]
    assert base.is_valid and lid.is_valid
    assert lid.bounding_box().min.Z == pytest.approx(1.6 - 4.1)
    # The floor is whole at the limit: solid under the board's centre and in the band the lip drops into.
    for x, y in [(125, -120), (98.6, -120), (125, -140.6)]:
        assert base.is_inside((x, y, -4.0)), (x, y)
    rows = {row["rule"]: row for row in mech.rules_check(case, s, CAPS, board)}
    assert rows["base_floor"]["measured"] == pytest.approx(2.0, abs=0.01)
    assert rows["base_wall"]["ok"] is True


def test_cli_rejects_a_deep_lip(tmp_path):
    p, res = _cli(tmp_path, "--formats", "step", settings_obj=settings(params={"lip_h_mm": 10.0}))
    assert p.returncode == 2 and "lip_h_mm 10 mm" in res["error"]


CNC_ALU = {"service": "jlccnc", "process": "CNC", "material": "Aluminum 6061"}


def test_cnc_aluminium_template_passes_the_corner_rule(tmp_path):
    r = run(board_facts(), settings(process=CNC_ALU), CAPS, tmp_path, formats=["step"])
    corners = [row for row in r["rules"] if row["rule"] == "corner_radius"]
    assert len(corners) == 2 and all(row["ok"] for row in corners), corners
    # Base cavity 1.6 + 3.0 = 4.6 mm deep: R0.96; the lid's from the lip's foot (-1.4) to 14.6: R2.1.
    by = {row["detail"].split("'s")[0].split()[-1]: row for row in corners}
    assert by["base"]["limit"] == pytest.approx(0.96) and by["base"]["measured"] == pytest.approx(0.96, abs=0.03)
    assert by["lid"]["limit"] == pytest.approx(2.1) and by["lid"]["measured"] == pytest.approx(2.1, abs=0.03)
    assert all(row["ok"] for row in r["rules"]), r["rules"]
    assert r["fit"]["status"] == "pass", r["fit"]["summary"]


def test_cnc_sharp_corners_fail(tmp_path):
    # A handed-in-style script that rebuilds the shell as if printed: sharp inside corners fail the rule.
    script = tmp_path / "case.py"
    script.write_text(
        "from tracebridge.mech import shell\n\n"
        "def build(board, settings):\n"
        "    s = dict(settings, process={'service': 'jlc3dp', 'process': 'MJF', 'material': 'PA12-HP'})\n"
        "    return shell.two_part(board, s)\n")
    r = run(board_facts(), settings(process=CNC_ALU), CAPS, tmp_path / "out", script=script, formats=["step"])
    corners = [row for row in r["rules"] if row["rule"] == "corner_radius"]
    assert corners and all(row["ok"] is False for row in corners)
    assert all(row["measured"] == pytest.approx(0.0, abs=0.02) for row in corners)
