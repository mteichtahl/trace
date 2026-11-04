"""The parts list shapes (capture.stock, signoff.bom, fabricate.order.stock, architect.stock) on the bridge's SHACL
runner: the newest check of the parts list, at the build quantity, with every line available."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

pytest.importorskip("pyshacl")

from tracebridge import METHODS  # noqa: E402
import tracebridge.shapes  # noqa: E402,F401

SHAPES = Path(__file__).resolve().parents[2] / "ontology" / "shapes"
P = "@prefix trace: <https://trace-eda.com/ns/trace#> .\n@prefix x: <urn:x:part:> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n"
NOW = datetime.now(timezone.utc)


def at(days: float = 0) -> str:
    return f'"{(NOW - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}"^^xsd:dateTime'


def run(name: str, boards: int, days: float = 0, subject: str = "hw/bom.csv", status: str = "pass") -> str:
    return f'''
x:{name} a trace:Run ; trace:runKind "parts.bom_check" ; trace:subject "{subject}" ; trace:startedAt {at(days)} ; trace:status "{status}" .
x:{name}-boards a trace:Measurement ; trace:ofRun x:{name} ; trace:name "boards" ; trace:value "{boards}"^^xsd:decimal .
'''


def line(run_: str, n: int, mpn: str, status: str = "ok", need: int = 10, stock: int = 1000, price: bool = True, flags: tuple = ()) -> str:
    extra = (f' ; trace:unitPrice "0.5"^^xsd:decimal' if price else "") + "".join(f' ; trace:flag "{f}"' for f in flags)
    return f'''
x:{run_}-{n} a trace:PartsListLine ; trace:ofRun x:{run_} ; trace:lineNumber {n} ; trace:mpn "{mpn}" ; trace:refersToPart x:{mpn} ;
    trace:status "{status}" ; trace:quantityNeeded "{need}"^^xsd:decimal ; trace:stock {stock}{extra} .
'''


JOURNEY = P + 'x:journey a trace:Journey ; trace:buildQuantity 10 .\n'


def check(crit: str, data: str) -> list[str]:
    r = METHODS["shapes.check"](data=data, shapes=[(SHAPES / f"{crit}.ttl").read_text()])
    assert r["conforms"] == (not r["findings"])
    return [f["message"] for f in r["findings"]]


@pytest.mark.parametrize("crit", ["capture.stock", "signoff.bom", "fabricate.order.stock"])
def test_the_newest_list_check_at_the_build_quantity_with_every_line_available(crit):
    assert check(crit, JOURNEY) == ["No parts list is checked for stock yet: run parts.bom_check on the parts list at the build quantity."]
    good = JOURNEY + run("r1", 10) + line("r1", 1, "TPS7A02") + line("r1", 2, "STM32L031")
    assert check(crit, good) == []
    # a newer check that is short counts; an older good one does not save it; a check of inline rows is not the list's
    short = good + run("r2", 10, days=-0.001) + line("r2", 1, "TPS7A02", status="short", need=10, stock=4) + run("r3", 10, days=-0.002, subject="rows")
    assert check(crit, short) == ["TPS7A02 is short: 10 needed, 4 in stock. Propose an in-stock alternative, or sign an exception for it."]
    # a newer check that failed does not count
    assert check(crit, good + run("r4", 10, days=-0.003, status="error")) == []
    assert check(crit, JOURNEY + run("r1", 5) + line("r1", 1, "TPS7A02")) == ["The newest parts list check is for 5 boards, fewer than the 10 the project builds: check it again at 10."]


def test_signoff_needs_a_price_on_every_line_fitted():
    data = JOURNEY + run("r1", 10) + line("r1", 1, "TPS7A02", price=False) + line("r1", 2, "R0402", price=False, flags=("not-fitted",))
    assert check("signoff.bom", data) == ["TPS7A02 has no price at the build quantity: check it again, or find an offer with a price."]
    assert check("capture.stock", data) == []


def test_order_needs_a_check_from_today():
    data = JOURNEY + run("r1", 10, days=2) + line("r1", 1, "TPS7A02")
    day = (NOW - timedelta(days=2)).strftime("%Y-%m-%d")
    assert check("fabricate.order.stock", data) == [f"The newest parts list check is from {day}: check stock and prices again today, before the order."]
    assert check("capture.stock", data) == []


def test_architect_stock_reads_the_key_parts_of_the_current_option():
    arch = JOURNEY + '''
x:A a trace:ArchitectureOption ; trace:isCurrentOption true .
x:B a trace:ArchitectureOption ; trace:isCurrentOption false .
x:blk a trace:FunctionalBlock ; trace:forOption x:A ; trace:usesPart x:kp1 , x:kp2 .
x:old a trace:FunctionalBlock ; trace:forOption x:A ; trace:status "withdrawn" ; trace:usesPart x:kp3 .
x:other a trace:FunctionalBlock ; trace:forOption x:B ; trace:usesPart x:kp4 .
x:kp1 a trace:KeyPart ; trace:refersToPart x:TPS7A02 .
x:kp2 a trace:KeyPart ; trace:refersToPart x:STM32L031 .
x:kp3 a trace:KeyPart ; trace:refersToPart x:GONE .
x:kp4 a trace:KeyPart ; trace:refersToPart x:ELSEWHERE .
'''
    assert sorted(check("architect.stock", arch)) == [
        "The key part STM32L031 is not checked for stock yet: run parts.bom_check with it at the build quantity.",
        "The key part TPS7A02 is not checked for stock yet: run parts.bom_check with it at the build quantity.",
    ]
    # inline rows count here; the newest line for each part stands
    data = arch + run("r1", 10, subject="rows") + line("r1", 1, "TPS7A02", status="out", stock=0) + line("r1", 2, "STM32L031")
    assert check("architect.stock", data) == ["The key part TPS7A02 is out of stock: 10 needed. Propose an in-stock alternative, or sign an exception for it."]
    data += run("r2", 4, days=-0.001, subject="rows") + line("r2", 1, "TPS7A02")
    assert check("architect.stock", data) == ["The key part TPS7A02 was last checked for 4 boards, fewer than the 10 the project builds: check it again at 10."]
    data += run("r3", 12, days=-0.002, subject="rows") + line("r3", 1, "TPS7A02")
    assert check("architect.stock", data) == []
