"""Tables and vector figures out of datasheet PDFs, with pdfplumber: the part Node has no maintained equivalent for.

Methods (called from src/datasheets through src/core/bridge.ts):

  pdf.tables   {path, page}                  every table pdfplumber finds on a page, as rows of cells
  pdf.params   {path, query, pages?}         electrical-characteristics rows whose parameter name or symbol matches
                                             `query`: each with its min / typ / max / unit cells, the page, and the
                                             raw row text. A row whose columns cannot be told apart comes back with
                                             `parsed: false` and only its raw text: a value is never guessed.
  pdf.rows     {path, query, pages?}         any table row matching `query` (pin tables, package/ordering tables)
  pdf.figure   {path, page, bbox?}           the vector strokes on a page (lines and curve points, with stroke colour
                                             and width) and the words with their positions, so a caller can read a
                                             plotted curve against its own axis labels. Raw geometry only.

Every result carries the document's sha256, so the caller can cite exactly what it read.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

from . import BridgeError, method

try:
    import pdfplumber
except ModuleNotFoundError as e:  # the bridge reports this area as unavailable
    raise ModuleNotFoundError("pdfplumber", name="pdfplumber") from e

HEADS = {
    "min": ("min", "minimum", "min."),
    "typ": ("typ", "typical", "typ.", "nom", "nominal"),
    "max": ("max", "maximum", "max."),
    "unit": ("unit", "units"),
    "symbol": ("symbol", "sym", "sym."),
    "parameter": ("parameter", "parameters", "characteristic", "description", "item"),
    "conditions": ("conditions", "test conditions", "condition", "test condition"),
}
NUM = re.compile(r"^[-+±]?\s*(?:\d+(?:\.\d*)?|\.\d+)(?:\s*[eE][-+]?\d+)?$")


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _open(path: str):
    p = Path(path)
    if not p.is_file():
        raise BridgeError(f"no file {path}")
    try:
        return p, pdfplumber.open(p)
    except Exception as e:  # noqa: BLE001 - pdfminer raises many kinds
        raise BridgeError(f"{path}: not a readable PDF ({e})") from None


def _cell(c: Any) -> str:
    return re.sub(r"\s+", " ", str(c)).strip() if c is not None else ""


def _tables(page) -> list[list[list[str]]]:
    out = []
    for t in page.extract_tables() or []:
        rows = [[_cell(c) for c in r] for r in t if any(_cell(c) for c in r)]
        if rows:
            out.append(rows)
    return out


def _pages(pdf, pages: list[int] | None) -> list[int]:
    n = len(pdf.pages)
    if not pages:
        return list(range(1, n + 1))
    bad = [p for p in pages if p < 1 or p > n]
    if bad:
        raise BridgeError(f"page(s) {bad} out of range (the document has {n})")
    return pages


@method("pdf.tables")
def tables(path: str, page: int) -> dict:
    p, pdf = _open(path)
    with pdf:
        _pages(pdf, [page])
        ts = _tables(pdf.pages[page - 1])
    return {"sha256": _sha(p), "page": page, "tables": [{"rows": t[:200], "row_count": len(t)} for t in ts]}


def _columns(header: list[str]) -> dict[str, int]:
    cols: dict[str, int] = {}
    for i, h in enumerate(header):
        k = h.lower().strip().rstrip(":")
        for name, words in HEADS.items():
            if name not in cols and (k in words or any(k.startswith(w + " ") for w in words if len(w) > 3)):
                cols[name] = i
    return cols


def _matches(query: str, cells: list[str], regex: bool) -> bool:
    if regex:
        rx = re.compile(query, re.IGNORECASE)
        return any(rx.search(c) for c in cells)
    q = query.lower()
    return any(q in c.lower() for c in cells)


def _row_record(row: list[str], cols: dict[str, int], page: int, inherited: str | None) -> dict:
    get = lambda k: row[cols[k]] if k in cols and cols[k] < len(row) else ""  # noqa: E731
    rec: dict[str, Any] = {"page": page, "raw": " | ".join(c for c in row if c)}
    have_values = any(k in cols for k in ("min", "typ", "max"))
    if not have_values:
        rec["parsed"] = False
        return rec
    vals = {k: get(k) for k in ("min", "typ", "max")}
    # A cell that is not a number (a footnote, "see Figure 3", text bleeding across columns) is kept as text, and
    # the row is marked unparsed so the caller reads the raw text rather than trusting a column.
    numeric = {k: v for k, v in vals.items() if v}
    ok = bool(numeric) and all(NUM.match(v.replace("−", "-").replace(" ", "")) for v in numeric.values())
    rec.update({
        "parameter": get("parameter") or inherited or "",
        "symbol": get("symbol"),
        "conditions": get("conditions"),
        "min": vals["min"] or None, "typ": vals["typ"] or None, "max": vals["max"] or None,
        "unit": get("unit") or None,
        "parsed": ok,
    })
    return rec


def _search_rows(path: str, query: str, pages: list[int] | None, regex: bool, ec_only: bool, limit: int) -> dict:
    if not query.strip():
        raise BridgeError("an empty query")
    if regex:
        try:
            re.compile(query)
        except re.error as e:
            raise BridgeError(f"bad regex: {e}") from None
    p, pdf = _open(path)
    hits: list[dict] = []
    total = 0
    with pdf:
        for n in _pages(pdf, pages):
            for t in _tables(pdf.pages[n - 1]):
                cols = _columns(t[0])
                body = t[1:] if cols else t
                if ec_only and not (any(k in cols for k in ("min", "typ", "max"))):
                    continue
                inherited = None
                for row in body:
                    pcol = cols.get("parameter")
                    if pcol is not None and pcol < len(row) and row[pcol]:
                        inherited = row[pcol]  # merged parameter cells span the rows below them
                    cells = row + ([inherited] if inherited else [])
                    if not _matches(query, cells, regex):
                        continue
                    total += 1
                    if len(hits) < limit:
                        rec = _row_record(row, cols, n, inherited) if ec_only else {
                            "page": n, "raw": " | ".join(c for c in row if c),
                            "cells": dict(zip([h or f"col{i}" for i, h in enumerate(t[0])], row)) if cols else None,
                        }
                        hits.append(rec)
    return {"sha256": _sha(p), "query": query, "total": total, "rows": hits}


@method("pdf.params")
def params(path: str, query: str, pages: list[int] | None = None, regex: bool = False, limit: int = 20) -> dict:
    return _search_rows(path, query, pages, regex, True, limit)


@method("pdf.rows")
def rows(path: str, query: str, pages: list[int] | None = None, regex: bool = False, limit: int = 40) -> dict:
    return _search_rows(path, query, pages, regex, False, limit)


def _colour(c: Any) -> list[float] | None:
    if c is None:
        return None
    if isinstance(c, (int, float)):
        return [float(c)] * 3
    vals = [float(x) for x in c] if isinstance(c, (list, tuple)) else []
    if len(vals) == 1:
        return vals * 3
    if len(vals) == 4:  # CMYK -> RGB
        cc, m, y, k = vals
        return [round((1 - cc) * (1 - k), 4), round((1 - m) * (1 - k), 4), round((1 - y) * (1 - k), 4)]
    return [round(v, 4) for v in vals[:3]] if len(vals) >= 3 else None


@method("pdf.figure")
def figure(path: str, page: int, bbox: list[float] | None = None, limit: int = 4000) -> dict:
    """Raw strokes and words on a page (PDF points, origin top-left as pdfplumber gives them)."""
    p, pdf = _open(path)
    with pdf:
        _pages(pdf, [page])
        pg = pdf.pages[page - 1]
        if bbox:
            if len(bbox) != 4:
                raise BridgeError("bbox is [x0, top, x1, bottom]")
            pg = pg.crop(tuple(bbox))
        strokes = []
        for kind, objs in (("line", pg.lines), ("curve", pg.curves), ("rect", pg.rects)):
            for o in objs:
                pts = o.get("pts") or [(o["x0"], o["top"]), (o["x1"], o["bottom"])]
                strokes.append({
                    "kind": kind,
                    "points": [[round(float(x), 2), round(float(y), 2)] for x, y in pts],
                    "colour": _colour(o.get("stroking_color")),
                    "width": round(float(o.get("linewidth") or 0), 3),
                })
        words = [{"text": w["text"], "x0": round(w["x0"], 2), "top": round(w["top"], 2), "x1": round(w["x1"], 2),
                  "bottom": round(w["bottom"], 2)} for w in pg.extract_words()]
        size = [round(float(pg.width), 2), round(float(pg.height), 2)]
    return {"sha256": _sha(p), "page": page, "size": size, "stroke_count": len(strokes), "strokes": strokes[:limit],
            "words": words[:limit]}
