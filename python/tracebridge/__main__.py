"""The Python bridge's server: one request per line on stdin, one response per line on stdout.

    request   {"id": 1, "method": "pdf.tables", "params": {...}}
    response  {"id": 1, "ok": true, "result": {...}}  |  {"id": 1, "ok": false, "error": "...", "kind": "BridgeError"}

The TypeScript side (src/core/bridge.ts) starts one process per session and keeps it, so a CAN bus or an instrument
session opened by one call is still open for the next. Handlers live in tracebridge.pdf, tracebridge.visa and
tracebridge.can; each registers its methods with `@method("area.name")`. A handler raises BridgeError for a problem
the caller should read; any other exception is reported with its traceback. Nothing here writes files unless the
request names a path to write.
"""
from __future__ import annotations

import contextlib
import importlib
import json
import sys
import traceback

from . import BridgeError, METHODS

AREAS = ("tracebridge.pdf", "tracebridge.visa", "tracebridge.can")


def load() -> dict[str, str]:
    status = {}
    for mod in AREAS:
        try:
            importlib.import_module(mod)
            status[mod] = "ok"
        except ModuleNotFoundError as e:
            if e.name == mod:
                status[mod] = "not present"
                continue
            if (e.name or "").startswith("tracebridge"):
                raise
            status[mod] = f"unavailable: needs {e.name}"
    return status


def main() -> int:
    status = load()
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            rid, method, params = req.get("id"), req.get("method", ""), req.get("params") or {}
        except ValueError:
            out.write(json.dumps({"id": None, "ok": False, "error": "not JSON", "kind": "ProtocolError"}) + "\n")
            out.flush()
            continue
        if method == "bridge.status":
            resp = {"id": rid, "ok": True, "result": {"areas": status, "methods": sorted(METHODS)}}
        elif method not in METHODS:
            resp = {"id": rid, "ok": False, "error": f"no method {method!r}", "kind": "ProtocolError"}
        else:
            try:
                with contextlib.redirect_stdout(sys.stderr):  # a handler's prints never reach the protocol
                    result = METHODS[method](**params)
                resp = {"id": rid, "ok": True, "result": result}
            except BridgeError as e:
                resp = {"id": rid, "ok": False, "error": str(e), "kind": "BridgeError"}
            except TypeError as e:
                resp = {"id": rid, "ok": False, "error": f"{method}: {e}", "kind": "BridgeError"}
            except Exception:  # noqa: BLE001 — a bug: say so and keep serving
                resp = {"id": rid, "ok": False, "error": traceback.format_exc(limit=6), "kind": "InternalError"}
        out.write(json.dumps(resp, default=str) + "\n")
        out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
