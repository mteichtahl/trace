"""Instruments over VISA: VXI-11 and HiSLIP (TCPIP::host::INSTR, TCPIP::host::hislip0), USBTMC (USB0::…::INSTR) and
GPIB, through pyvisa with whichever backend is present (NI-VISA / Keysight IO Libraries, else the pure-Python
pyvisa-py).

Why Python: Node has no maintained implementation of VXI-11 (ONC-RPC), HiSLIP or USBTMC, and the vendor VISA
libraries are C with Python bindings. Raw SCPI sockets and serial instruments are handled in TypeScript and never come
here.

A session opened by `visa.open` stays open until `visa.close`, with the timeout given; every read is bounded by it.
Binary blocks come back base64-encoded.
"""
from __future__ import annotations

import atexit
import base64
import threading
import uuid
from typing import Any

from . import BridgeError, method

import pyvisa  # noqa: E402  (missing pyvisa makes this module unavailable, reported by bridge.status)

_RM: Any = None
_SESSIONS: dict[str, Any] = {}
_LOCK = threading.Lock()


@atexit.register
def _close_all() -> None:
    """The bridge is exiting: release every bus/instrument it still holds."""
    for b in list(_SESSIONS.values()):
        try:
            b.close()
        except Exception:  # noqa: BLE001
            pass
    _SESSIONS.clear()


def _rm():
    global _RM
    if _RM is None:
        try:
            _RM = pyvisa.ResourceManager()
        except (OSError, ValueError):
            try:
                _RM = pyvisa.ResourceManager("@py")
            except (OSError, ValueError, ImportError) as e:
                raise BridgeError(f"no VISA backend: install pyvisa-py (pip install pyvisa-py) or NI-VISA ({e})") from None
    return _RM


def _inst(session: str):
    s = _SESSIONS.get(session)
    if s is None:
        raise BridgeError(f"no open VISA session {session!r}")
    return s


def _err(e: Exception, resource: str) -> BridgeError:
    msg = str(e)
    if "VI_ERROR_TMO" in msg or "Timeout" in type(e).__name__:
        return BridgeError(f"{resource}: timed out")
    if "VI_ERROR_RSRC_NFOUND" in msg:
        return BridgeError(f"{resource}: not found (check the address; for USB, the udev rules and that no other program has it)")
    return BridgeError(f"{resource}: {msg}")


@method("visa.list")
def list_resources(query: str = "?*::INSTR") -> dict:
    try:
        return {"resources": list(_rm().list_resources(query))}
    except Exception as e:  # noqa: BLE001 — listing is best effort (no USB access, no GPIB card)
        return {"resources": [], "error": str(e)}


@method("visa.open")
def open_resource(resource: str, timeout_ms: int = 5000) -> dict:
    try:
        inst = _rm().open_resource(resource, open_timeout=timeout_ms)
    except Exception as e:  # noqa: BLE001
        raise _err(e, resource) from None
    inst.timeout = timeout_ms
    inst.read_termination = "\n"
    inst.write_termination = "\n"
    sid = uuid.uuid4().hex[:12]
    with _LOCK:
        _SESSIONS[sid] = inst
    return {"session": sid}


@method("visa.close")
def close_resource(session: str) -> dict:
    with _LOCK:
        inst = _SESSIONS.pop(session, None)
    if inst is not None:
        try:
            inst.close()
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True}


@method("visa.write")
def write(session: str, command: str) -> dict:
    inst = _inst(session)
    try:
        inst.write(command)
    except Exception as e:  # noqa: BLE001
        raise _err(e, inst.resource_name) from None
    return {"ok": True}


@method("visa.query")
def query(session: str, command: str, timeout_ms: int | None = None) -> dict:
    inst = _inst(session)
    old = inst.timeout
    try:
        if timeout_ms:
            inst.timeout = timeout_ms
        return {"text": inst.query(command).rstrip("\r\n")}
    except Exception as e:  # noqa: BLE001
        raise _err(e, inst.resource_name) from None
    finally:
        inst.timeout = old


@method("visa.query_binary")
def query_binary(session: str, command: str, timeout_ms: int | None = None) -> dict:
    """An IEEE 488.2 definite-length block's payload."""
    inst = _inst(session)
    old = inst.timeout
    try:
        if timeout_ms:
            inst.timeout = timeout_ms
        # expect_termination: pyvisa also consumes the newline after the block
        data = inst.query_binary_values(command, datatype="B", container=bytes, header_fmt="ieee", expect_termination=True)
        return {"base64": base64.b64encode(bytes(data)).decode("ascii")}
    except Exception as e:  # noqa: BLE001
        raise _err(e, inst.resource_name) from None
    finally:
        inst.timeout = old
