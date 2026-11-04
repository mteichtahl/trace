"""`python -m tracebridge.docs publish --doc D.md --out D.pdf [--logo L.svg] [--revisions R.json] [--work DIR]`

Writes the PDF and prints {"pdf", "bytes", "diagrams", ...} as JSON. Exit 2 with {"error": "..."} for a problem with
the document a person can fix (no front matter, a diagram that does not draw, an image not beside the document); any
other exit is a crash, with Python's traceback on stderr.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from .publish import PublishError, publish


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="tracebridge.docs")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("publish")
    p.add_argument("--doc", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--logo", type=Path)
    p.add_argument("--revisions", type=Path, help="JSON list of {revision, date, commit, note}")
    p.add_argument("--work", type=Path)
    a = ap.parse_args(argv)
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
