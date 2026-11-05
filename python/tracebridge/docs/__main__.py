"""`python -m tracebridge.docs publish --doc D.md --out D.pdf [--logo L.svg] [--revisions R.json] [--work DIR]`

`python -m tracebridge.docs smoke`: draws one small diagram with Mermaid as publish does; exit 1 if it cannot (the
tools image runs it when it is built).

Writes the PDF and prints {"pdf", "bytes", "diagrams", ...} as JSON. Exit 2 with {"error": "..."} for a problem with
the document a person can fix (no front matter, a diagram Mermaid cannot read, an image not beside the document); any
other exit is a crash, with Python's traceback on stderr. A browser that cannot start is not one: the PDF is made with
those diagrams as their source, and the JSON names them (not_drawn, not_drawn_why).
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from .publish import PublishError, draw_diagrams, find_browser, publish


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="tracebridge.docs")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("publish")
    p.add_argument("--doc", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--logo", type=Path)
    p.add_argument("--revisions", type=Path, help="JSON list of {revision, date, commit, note}")
    p.add_argument("--work", type=Path)
    sub.add_parser("smoke", help="draw one small diagram with Mermaid, as publish does")
    a = ap.parse_args(argv)
    if a.cmd == "smoke":
        with tempfile.TemporaryDirectory() as tmp:
            drew = draw_diagrams(["flowchart LR\n  A[Mermaid] --> B[draws]"], Path(tmp))
            ok = not drew["not_drawn"] and (Path(tmp) / "diagram-1.svg").exists()
        print(json.dumps({"drawn": ok, "browser": find_browser(), **drew}))
        return 0 if ok else 1
    revisions = json.loads(a.revisions.read_text()) if a.revisions else []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            r = publish(a.doc, a.out, a.work or Path(tmp), a.logo, revisions)
    except PublishError as e:
        print(json.dumps({"error": str(e)}))
        return 2
    print(json.dumps(r))
    return 0


if __name__ == "__main__":
    sys.exit(main())
