"""`python -m tracebridge.mech run --facts F --settings S --capabilities C [--script case.py] [--case-file X.step]
--out OUTDIR [--formats step,stl,3mf]`

Exit 0 with OUTDIR/result.json whenever a result was produced (a failing fit is a result); exit 2 with
{"error": "..."} in OUTDIR/result.json for bad input (a missing or malformed file, invalid settings, a script without
build() or one that raises); any other exit is a crash, with Python's traceback on stderr.
"""
from __future__ import annotations

import sys

from . import main

sys.exit(main())
