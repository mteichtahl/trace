"""CAN through python-can: send frames, receive with id filters, capture to a log, bus statistics, DBC decode/encode.

Why Python: python-can is the one library that drives SocketCAN, PCAN, Kvaser, Vector, IXXAT, gs_usb, slcan and the
rest behind one interface (most are vendor C libraries), offers an in-process `virtual` bus for tests, and writes
candump logs, BLF and ASC. cantools (DBC) is used only when it is installed; it is not a dependency.

A bus opened by `can.open` stays open in this process (the bridge is one process per session) until `can.close`, so
a send followed by a receive see the same bus. Every receive and capture has a deadline. A capture returns its log as
base64 bytes; the TypeScript side stores them in the project database and nothing is left on disk.
"""
from __future__ import annotations

import atexit
import base64
import os
import shutil
import tempfile
import threading
import time
import uuid
from typing import Any

from . import BridgeError, method

import can  # noqa: E402  (a missing python-can makes this module unavailable, reported by bridge.status)

_BUSES: dict[str, dict[str, Any]] = {}
_LOCK = threading.Lock()


@atexit.register
def _close_all() -> None:
    """The bridge is exiting: release every bus/instrument it still holds."""
    for b in list(_BUSES.values()):
        try:
            b["bus"].shutdown()
        except Exception:  # noqa: BLE001
            pass
    _BUSES.clear()


def _bus(session: str) -> dict[str, Any]:
    b = _BUSES.get(session)
    if b is None:
        raise BridgeError(f"no open CAN session {session!r} (it was closed, or the bridge restarted)")
    return b


def _filters(filters: list[dict] | None) -> list[dict] | None:
    if not filters:
        return None
    out = []
    for f in filters:
        cid = int(f["id"])
        ext = bool(f.get("extended", cid > 0x7FF))
        mask = int(f.get("mask", 0x1FFFFFFF if ext else 0x7FF))
        out.append({"can_id": cid, "can_mask": mask, "extended": ext})
    return out


def _msg_out(m: can.Message, t0: float | None = None) -> dict:
    d = {
        "t": round(m.timestamp - (t0 or 0.0), 6) if t0 is not None else m.timestamp,
        "id": m.arbitration_id,
        "ext": bool(m.is_extended_id),
        "data": bytes(m.data).hex(),
        "dlc": m.dlc,
    }
    if m.is_fd:
        d["fd"] = True
        if m.bitrate_switch:
            d["brs"] = True
    if m.is_remote_frame:
        d["rtr"] = True
    if m.is_error_frame:
        d["error"] = True
    if m.channel is not None:
        d["channel"] = str(m.channel)
    return d


@method("can.open")
def open_bus(interface: str, channel: str, bitrate: int | None = None, fd: bool = False,
             data_bitrate: int | None = None, receive_own_messages: bool = False) -> dict:
    kwargs: dict[str, Any] = {"interface": interface, "channel": channel}
    if interface != "virtual":
        if bitrate:
            kwargs["bitrate"] = bitrate
        if fd:
            kwargs["fd"] = True
            if data_bitrate:
                kwargs["data_bitrate"] = data_bitrate
    else:
        kwargs["receive_own_messages"] = receive_own_messages
        if fd:
            kwargs["fd"] = True
    try:
        bus = can.Bus(**kwargs)
    except (can.CanError, OSError, ValueError, ImportError) as e:
        hint = {
            "socketcan": " (is the interface up? sudo ip link set can0 up type can bitrate 500000)",
            "pcan": " (install PEAK's PCAN-Basic driver)",
            "kvaser": " (install Kvaser CANlib)",
            "vector": " (install the Vector XL driver library; Windows only)",
            "gs_usb": " (pip install gs_usb pyusb)",
        }.get(interface, "")
        raise BridgeError(f"could not open CAN {interface} {channel}: {e}{hint}") from None
    sid = uuid.uuid4().hex[:12]
    with _LOCK:
        _BUSES[sid] = {"bus": bus, "interface": interface, "channel": channel, "opened": time.time(),
                       "tx": 0, "rx": 0, "errors": 0, "fd": fd}
    return {"session": sid}


@method("can.close")
def close_bus(session: str) -> dict:
    with _LOCK:
        b = _BUSES.pop(session, None)
    if b is not None:
        try:
            b["bus"].shutdown()
        except Exception:  # noqa: BLE001 — closing a broken bus must not fail the caller
            pass
    return {"ok": True}


@method("can.send")
def send(session: str, frames: list[dict], interval_ms: float = 0.0, timeout_ms: float = 1000.0) -> dict:
    b = _bus(session)
    sent = 0
    for i, f in enumerate(frames):
        cid = int(f["id"])
        ext = bool(f.get("extended", cid > 0x7FF))
        if cid < 0 or cid > (0x1FFFFFFF if ext else 0x7FF):
            raise BridgeError(f"frames[{i}].id 0x{cid:X} is out of range for a {'29' if ext else '11'}-bit id")
        try:
            data = bytes.fromhex(str(f.get("data", "")).replace(" ", ""))
        except ValueError:
            raise BridgeError(f"frames[{i}].data is not hex") from None
        is_fd = bool(f.get("fd", False))
        if len(data) > (64 if is_fd else 8):
            raise BridgeError(f"frames[{i}]: {len(data)} bytes is too long for {'CAN FD' if is_fd else 'classic CAN'}")
        msg = can.Message(arbitration_id=cid, is_extended_id=ext, data=data, is_fd=is_fd,
                          bitrate_switch=bool(f.get("brs", is_fd)), is_remote_frame=bool(f.get("rtr", False)))
        try:
            b["bus"].send(msg, timeout=timeout_ms / 1000)
        except can.CanError as e:
            raise BridgeError(f"frames[{i}]: send failed: {e}") from None
        sent += 1
        b["tx"] += 1
        if interval_ms and i < len(frames) - 1:
            time.sleep(interval_ms / 1000)
    return {"sent": sent}


@method("can.receive")
def receive(session: str, timeout_ms: float = 1000.0, max_frames: int = 100, filters: list[dict] | None = None,
            until_id: int | None = None) -> dict:
    """Frames until `max_frames`, `until_id` is seen, or the deadline."""
    b = _bus(session)
    bus = b["bus"]
    bus.set_filters(_filters(filters))
    out: list[dict] = []
    end = time.monotonic() + timeout_ms / 1000
    t0 = None
    try:
        while len(out) < max_frames:
            left = end - time.monotonic()
            if left <= 0:
                break
            m = bus.recv(timeout=min(left, 0.25))
            if m is None:
                continue
            if t0 is None:
                t0 = m.timestamp
            b["rx"] += 1
            if m.is_error_frame:
                b["errors"] += 1
            out.append(_msg_out(m, t0))
            if until_id is not None and m.arbitration_id == until_id:
                break
    finally:
        bus.set_filters(None)
    return {"frames": out, "timed_out": len(out) < max_frames and (until_id is None or not out or out[-1]["id"] != until_id)}


_WRITERS = {"candump": ".log", "asc": ".asc", "blf": ".blf", "csv": ".csv", "trc": ".trc"}


@method("can.capture")
def capture(session: str, seconds: float, fmt: str = "candump", filters: list[dict] | None = None,
            max_frames: int = 1_000_000, preview: int = 20, dbc: str | None = None) -> dict:
    """Record the bus for `seconds` into a log (candump .log, ASC, BLF, CSV or TRC) and return it with statistics."""
    if fmt not in _WRITERS:
        raise BridgeError(f"format {fmt!r}: one of {', '.join(_WRITERS)}")
    if not (0 < seconds <= 3600):
        raise BridgeError("seconds must be between 0 and 3600")
    b = _bus(session)
    bus = b["bus"]
    tmp = tempfile.mkdtemp(prefix="trace-can-")
    path = os.path.join(tmp, "capture" + _WRITERS[fmt])
    db = _load_dbc(dbc) if dbc else None
    ids: dict[int, int] = {}
    first: list[dict] = []
    decoded: list[dict] = []
    n = errors = 0
    t0 = None
    bus.set_filters(_filters(filters))
    writer = can.Logger(path)
    try:
        end = time.monotonic() + seconds
        while n < max_frames:
            left = end - time.monotonic()
            if left <= 0:
                break
            m = bus.recv(timeout=min(left, 0.25))
            if m is None:
                continue
            if t0 is None:
                t0 = m.timestamp
            writer.on_message_received(m)
            n += 1
            b["rx"] += 1
            if m.is_error_frame:
                errors += 1
                b["errors"] += 1
            ids[m.arbitration_id] = ids.get(m.arbitration_id, 0) + 1
            if len(first) < preview:
                first.append(_msg_out(m, t0))
            if db is not None and len(decoded) < preview:
                d = _decode(db, m)
                if d:
                    decoded.append(d)
    finally:
        try:
            writer.stop()
        finally:
            bus.set_filters(None)
    try:
        with open(path, "rb") as fh:
            blob = fh.read()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    span = (time.monotonic() - (end - seconds))
    return {
        "frames": n,
        "errors": errors,
        "seconds": round(min(span, seconds), 3),
        "rate_fps": round(n / seconds, 2),
        "ids": [{"id": k, "count": v} for k, v in sorted(ids.items())],
        "first": first,
        "decoded": decoded,
        "log_base64": base64.b64encode(blob).decode("ascii"),
        "log_name": "capture" + _WRITERS[fmt],
    }


@method("can.stats")
def stats(session: str) -> dict:
    b = _bus(session)
    out = {"interface": b["interface"], "channel": b["channel"], "tx": b["tx"], "rx": b["rx"], "error_frames": b["errors"],
           "open_s": round(time.time() - b["opened"], 3)}
    state = getattr(b["bus"], "state", None)
    if state is not None:
        out["state"] = getattr(state, "name", str(state)).lower()
    return out


# ------------------------------------------------------------------ DBC (optional)

def _load_dbc(path: str):
    try:
        import cantools  # type: ignore[import-not-found]
    except ModuleNotFoundError:
        raise BridgeError("DBC decoding needs cantools: pip install cantools") from None
    try:
        return cantools.database.load_file(path)
    except Exception as e:  # noqa: BLE001 — a malformed DBC is the caller's to fix
        raise BridgeError(f"could not read DBC {path}: {e}") from None


def _decode(db, m: can.Message) -> dict | None:
    try:
        msg = db.get_message_by_frame_id(m.arbitration_id)
    except KeyError:
        return None
    try:
        sig = msg.decode(bytes(m.data), decode_choices=True)
    except Exception as e:  # noqa: BLE001
        return {"id": m.arbitration_id, "message": msg.name, "error": str(e)}
    return {"id": m.arbitration_id, "message": msg.name, "signals": {k: (v if isinstance(v, (int, float)) else str(v)) for k, v in sig.items()}}


@method("can.dbc_available")
def dbc_available() -> dict:
    try:
        import cantools  # type: ignore[import-not-found]  # noqa: F401
        return {"available": True}
    except ModuleNotFoundError:
        return {"available": False}


@method("can.encode")
def encode(dbc: str, message: str, signals: dict) -> dict:
    db = _load_dbc(dbc)
    try:
        msg = db.get_message_by_name(message)
    except KeyError:
        raise BridgeError(f"{dbc} has no message {message!r}") from None
    try:
        data = msg.encode(signals)
    except Exception as e:  # noqa: BLE001
        raise BridgeError(f"encoding {message}: {e}") from None
    return {"id": msg.frame_id, "extended": bool(msg.is_extended_frame), "data": bytes(data).hex(), "fd": bool(getattr(msg, "is_fd", False))}
