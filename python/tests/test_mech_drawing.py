"""The case's drawings for the project's documents (tracebridge/mech/drawing.py, docs/scribe.md "Mechanical drawings"):
three dimensioned views and an exploded view of a case the engine built, and the sizes they state."""
import json
import subprocess
import sys

import pytest

pytest.importorskip("build123d")

from tracebridge.mech import run  # noqa: E402
from tracebridge.mech.drawing import drawing  # noqa: E402
from test_mech import CAPS, PYTHON_DIR, board_facts, settings  # noqa: E402


@pytest.fixture(scope="module")
def case_step(tmp_path_factory):
    out = tmp_path_factory.mktemp("case")
    run(board_facts(), settings(), CAPS, out, formats=["step"])
    return out / "case.step"


def test_draws_three_views_and_the_parts_apart(case_step, tmp_path):
    facts = drawing(case_step, tmp_path)
    svg = (tmp_path / "drawing.svg").read_text()
    assert svg.lstrip().startswith("<?xml") or svg.lstrip().startswith("<svg")
    # visible edges solid, hidden ones dashed, and the dimensions (their figures drawn as outlines, so they print
    # without fonts) on their own layer
    for layer in ('id="visible"', 'id="hidden"', 'id="dims"'):
        assert layer in svg, layer
    assert facts["width_mm"] > facts["height_mm"] > 0 and facts["depth_mm"] > 0
    assert facts["views"] == ["top", "front", "right"]
    assert sorted(p["name"] for p in facts["parts"]) == ["base", "lid"]
    assert (tmp_path / "exploded.svg").stat().st_size > 1000
    assert json.loads((tmp_path / "drawing.json").read_text()) == facts


def test_the_command_says_when_there_is_no_case(tmp_path):
    r = subprocess.run([sys.executable, "-m", "tracebridge.mech", "drawing", "--step", str(tmp_path / "none.step"), "--out", str(tmp_path)],
                       capture_output=True, text=True, env={"PYTHONPATH": str(PYTHON_DIR), "PATH": "/usr/bin:/bin"})
    assert r.returncode == 2
    assert "build it first" in json.loads(r.stdout)["error"]
