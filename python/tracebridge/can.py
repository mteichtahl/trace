"""CAN through python-can: send frames, receive with id filters, capture to a log, bus statistics, DBC decode/encode.

Why Python: python-can is the one library that drives SocketCAN, PCAN, Kvaser, Vector, IXXAT, gs_usb, slcan and the
rest behind one interface (most are vendor C libraries), offers an in-process `virtual` bus for tests, and writes
candump logs, BLF and ASC. cantools (DBC) is used only when it is installed; it is not a dependency.

A bus opened by `can.open` stays open in this process (the bridge is one process per session) until `can.close`, so
a send followed by a receive see the same bus. The bridge answers one request at a time, so nothing here blocks for
long: each open bus has a reader thread that buffers what arrives (and feeds a capture's log writer), `can.receive`
waits at most `wait_ms` (a short slice) and the TypeScript side polls until its own deadline, and a capture is
`can.capture_start` … `can.capture_stop`. Other calls, on this bus or another, are served in between. A capture returns its log as
base64 bytes; the TypeScript side stores them in the project database and nothing is left on disk.
"""
from __future__ import annotations

import atexit
import base64
import collections
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
            _shutdown(b)
        except Exception:  # noqa: BLE001
            pass
    _BUSES.clear()


class _Reader(threading.Thread):
    """Reads one bus for as long as it is open: frames go to a bounded queue and, while a capture runs, to its log."""

    def __init__(self, entry: dict[str, Any]):
        super().__init__(daemon=True)
        self.entry = entry
        self.queue: collections.deque = collections.deque(maxlen=100_000)
        self.cond = threading.Condition()
        self.stop_flag = threading.Event()
        self.capture: dict[str, Any] | None = None

    def run(self) -> None:
        bus = self.entry["bus"]
        while not self.stop_flag.is_set():
            try:
                m = bus.recv(timeout=0.05)
            except Exception:  # noqa: BLE001 — a bus that fails stops being read; calls report it
                self.entry["failed"] = True
                return
            if m is None:
                continue
            self.entry["rx"] += 1
            if m.is_error_frame:
                self.entry["errors"] += 1
            with self.cond:
                cap = self.capture
                if cap is not None and _match(cap["filters"], m) and cap["n"] < cap["max"]:
                    cap["writer"].on_message_received(m)
                    cap["n"] += 1
                    if cap["t0"] is None:
                        cap["t0"] = m.timestamp
                    if m.is_error_frame:
                        cap["errors"] += 1
                    cap["ids"][m.arbitration_id] = cap["ids"].get(m.arbitration_id, 0) + 1
                    if len(cap["first"]) < cap["preview"]:
                        cap["first"].append(_msg_out(m, cap["t0"]))
                    if cap["db"] is not None and len(cap["decoded"]) < cap["preview"]:
                        d = _decode(cap["db"], m)
                        if d:
                            cap["decoded"].append(d)
                self.queue.append(m)
                self.cond.notify_all()


def _bus(session: str) -> dict[str, Any]:
    b = _BUSES.get(session)
    if b is None:
        raise BridgeError(f"no open CAN session {session!r} (it was closed, or the bridge restarted)")
    if b.get("failed"):
        raise BridgeError(f"CAN {b['interface']} {b['channel']}: the bus stopped responding")
    return b


def _filters(filters: list[dict] | None) -> list[tuple[int, int, bool | None]]:
    out = []
    for f in filters or []:
        cid = int(f["id"])
        ext = f.get("extended")
        ext = bool(ext) if ext is not None else (True if cid > 0x7FF else None)
        mask = int(f.get("mask", 0x1FFFFFFF if cid > 0x7FF else 0x7FF))
        out.append((cid, mask, ext))
    return out


def _match(filters: list[tuple[int, int, bool | None]], m: can.Message) -> bool:
    if not filters:
        return True
    return any((m.arbitration_id & mask) == (cid & mask) and (ext is None or ext == bool(m.is_extended_id))
               for cid, mask, ext in filters)


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
    entry: dict[str, Any] = {"bus": bus, "interface": interface, "channel": channel, "opened": time.time(),
                             "tx": 0, "rx": 0, "errors": 0, "fd": fd}
    entry["reader"] = _Reader(entry)
    entry["reader"].start()
    with _LOCK:
        _BUSES[sid] = entry
    return {"session": sid}


def _shutdown(b: dict[str, Any]) -> None:
    r: _Reader = b["reader"]
    r.stop_flag.set()
    r.join(timeout=1.0)
    with r.cond:
        cap, r.capture = r.capture, None
    if cap is not None:
        _end_capture(cap)
    try:
        b["bus"].shutdown()
    except Exception:  # noqa: BLE001 — closing a broken bus must not fail the caller
        pass


@method("can.close")
def close_bus(session: str) -> dict:
    with _LOCK:
        b = _BUSES.pop(session, None)
    if b is not None:
        _shutdown(b)
    return {"ok": True}


@method("can.send")
def send(session: str, frames: list[dict], interval_ms: float = 0.0, timeout_ms: float = 1000.0) -> dict:
    b = _bus(session)
    if interval_ms * max(0, len(frames) - 1) > 5000:
        raise BridgeError("frames x interval_ms is over 5 s; send them in smaller batches")
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


@method("can.flush")
def flush(session: str) -> dict:
    """Forget what has been buffered (before a request whose replies are wanted)."""
    r: _Reader = _bus(session)["reader"]
    with r.cond:
        n = len(r.queue)
        r.queue.clear()
    return {"dropped": n}


@method("can.receive")
def receive(session: str, wait_ms: float = 200.0, max_frames: int = 100, filters: list[dict] | None = None) -> dict:
    """Buffered frames matching `filters` (the rest are dropped), waiting at most `wait_ms` (capped at 500 ms) for the
    first. The caller polls until its own deadline, so the bridge is never held."""
    r: _Reader = _bus(session)["reader"]
    flt = _filters(filters)
    out: list[dict] = []
    end = time.monotonic() + min(max(wait_ms, 0.0), 500.0) / 1000
    with r.cond:
        while True:
            while r.queue and len(out) < max_frames:
                m = r.queue.popleft()
                if _match(flt, m):
                    out.append(_msg_out(m))
            left = end - time.monotonic()
            if out or left <= 0 or len(out) >= max_frames:
                break
            r.cond.wait(timeout=left)
    return {"frames": out}


_WRITERS = {"candump": ".log", "asc": ".asc", "blf": ".blf", "csv": ".csv", "trc": ".trc"}


@method("can.capture_start")
def capture_start(session: str, fmt: str = "candump", filters: list[dict] | None = None,
                  max_frames: int = 1_000_000, preview: int = 20, dbc: str | None = None) -> dict:
    """Start recording the bus into a log (candump .log, ASC, BLF, CSV or TRC); `can.capture_stop` returns it."""
    if fmt not in _WRITERS:
        raise BridgeError(f"format {fmt!r}: one of {', '.join(_WRITERS)}")
    b = _bus(session)
    r: _Reader = b["reader"]
    db = _load_dbc(dbc) if dbc else None
    tmp = tempfile.mkdtemp(prefix="trace-can-")
    path = os.path.join(tmp, "capture" + _WRITERS[fmt])
    cap = {"tmp": tmp, "path": path, "writer": can.Logger(path), "filters": _filters(filters), "max": max_frames,
           "preview": preview, "db": db, "n": 0, "errors": 0, "ids": {}, "first": [], "decoded": [], "t0": None,
           "started": time.monotonic(), "name": "capture" + _WRITERS[fmt]}
    with r.cond:
        if r.capture is not None:
            shutil.rmtree(tmp, ignore_errors=True)
            raise BridgeError("a capture is already running on this bus")
        r.capture = cap
    return {"ok": True}


def _end_capture(cap: dict[str, Any]) -> bytes:
    try:
        cap["writer"].stop()
        with open(cap["path"], "rb") as fh:
            return fh.read()
    finally:
        shutil.rmtree(cap["tmp"], ignore_errors=True)


@method("can.capture_stop")
def capture_stop(session: str) -> dict:
    r: _Reader = _bus(session)["reader"]
    with r.cond:
        cap, r.capture = r.capture, None
    if cap is None:
        raise BridgeError("no capture is running on this bus")
    seconds = time.monotonic() - cap["started"]
    blob = _end_capture(cap)
    return {
        "frames": cap["n"],
        "errors": cap["errors"],
        "seconds": round(seconds, 3),
        "rate_fps": round(cap["n"] / seconds, 2) if seconds > 0 else 0.0,
        "ids": [{"id": k, "count": v} for k, v in sorted(cap["ids"].items())],
        "first": cap["first"],
        "decoded": cap["decoded"],
        "log_base64": base64.b64encode(blob).decode("ascii"),
        "log_name": cap["name"],
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
