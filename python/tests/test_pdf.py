"""tracebridge.pdf against a real PDF made with reportlab."""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

pytest.importorskip("pdfplumber")
pytest.importorskip("reportlab")

from fixture_pdf import build  # noqa: E402
from tracebridge import BridgeError, METHODS  # noqa: E402
import tracebridge.pdf  # noqa: E402,F401


@pytest.fixture(scope="module")
def pdf(tmp_path_factory) -> str:
    p = tmp_path_factory.mktemp("pdf") / "tpx123.pdf"
    build(str(p))
    return str(p)


def sha(p: str) -> str:
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def test_tables(pdf):
    r = METHODS["pdf.tables"](path=pdf, page=2)
    assert r["sha256"] == sha(pdf) and r["page"] == 2
    heads = [t["rows"][0] for t in r["tables"]]
    assert ["Pin", "Name", "Type", "Description"] in heads
    assert ["Parameter", "Symbol", "Conditions", "Min", "Typ", "Max", "Unit"] in heads


def test_params_by_symbol_and_name(pdf):
    r = METHODS["pdf.params"](path=pdf, query="IQ")
    row = next(x for x in r["rows"] if x.get("symbol") == "IQ")
    assert row == {**row, "page": 2, "typ": "45", "max": "70", "unit": "µA", "min": None, "parsed": True}
    r = METHODS["pdf.params"](path=pdf, query="switching frequency")
    assert r["rows"][0]["min"] == "1.8" and r["rows"][0]["unit"] == "MHz"


def test_params_never_guesses(pdf):
    row = METHODS["pdf.params"](path=pdf, query="TSD")["rows"][0]
    assert row["parsed"] is False and "see note 1" in row["raw"]


def test_regex_and_pin_rows(pdf):
    r = METHODS["pdf.rows"](path=pdf, query=r"^FB$", regex=True)
    assert r["total"] == 1 and "Feedback input" in r["rows"][0]["raw"]
    with pytest.raises(BridgeError):
        METHODS["pdf.rows"](path=pdf, query="(", regex=True)


def test_figure_strokes(pdf):
    r = METHODS["pdf.figure"](path=pdf, page=3)
    blue = [s for s in r["strokes"] if s["colour"] and s["colour"][2] > 0.9 and s["colour"][0] < 0.1]
    assert blue and len(blue[0]["points"]) == 5
    assert any(w["text"] == "IOUT" for w in r["words"])


def test_bad_page(pdf):
    with pytest.raises(BridgeError):
        METHODS["pdf.tables"](path=pdf, page=9)
