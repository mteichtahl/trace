"""The bridge's CAN and VISA handlers, offline: python-can's virtual bus, and pyvisa-py talking to a tiny threaded
SCPI socket server (TCPIP::127.0.0.1::<port>::SOCKET), which exercises the same pyvisa session code a VXI-11 or
USBTMC instrument would."""
from __future__ import annotations

import base64
import socket
import threading
import time

import pytest

from tracebridge import METHODS, BridgeError
import tracebridge.can  # noqa: F401  (registers can.*)
import tracebridge.visa  # noqa: F401  (registers visa.*)


def m(name, **kw):
    return METHODS[name](**kw)


# ------------------------------------------------------------------ CAN

def test_can_send_receive_filter_and_capture():
    a = m("can.open", interface="virtual", channel="pytest-bus")["session"]
    b = m("can.open", interface="virtual", channel="pytest-bus")["session"]
    try:
        assert m("can.send", session=a, frames=[{"id": 0x123, "data": "de ad"}, {"id": 0x18FF00AA, "data": "01"}])["sent"] == 2
        got = []
        end = time.monotonic() + 2
        while len(got) < 2 and time.monotonic() < end:
            got += m("can.receive", session=b, wait_ms=200)["frames"]
        assert [(f["id"], f["ext"], f["data"]) for f in got] == [(0x123, False, "dead"), (0x18FF00AA, True, "01")]

        m("can.send", session=a, frames=[{"id": 0x200, "data": ""}, {"id": 0x201, "data": "bb"}])
        time.sleep(0.2)
        assert [f["id"] for f in m("can.receive", session=b, wait_ms=100, filters=[{"id": 0x201}])["frames"]] == [0x201]

        m("can.capture_start", session=b, fmt="asc")
        m("can.send", session=a, frames=[{"id": 5, "data": "11"}] * 3)
        time.sleep(0.3)
        cap = m("can.capture_stop", session=b)
        assert cap["frames"] == 3 and cap["ids"] == [{"id": 5, "count": 3}]
        assert b"Rx" in base64.b64decode(cap["log_base64"])
        assert m("can.stats", session=b)["rx"] >= 7
    finally:
        m("can.close", session=a)
        m("can.close", session=b)


def test_can_refusals():
    a = m("can.open", interface="virtual", channel="pytest-bad")["session"]
    try:
        with pytest.raises(BridgeError, match="out of range"):
            m("can.send", session=a, frames=[{"id": 0x800, "data": "", "extended": False}])
        with pytest.raises(BridgeError, match="too long"):
            m("can.send", session=a, frames=[{"id": 1, "data": "00" * 9}])
        with pytest.raises(BridgeError, match="format"):
            m("can.capture_start", session=a, fmt="pcap")
        with pytest.raises(BridgeError, match="no capture"):
            m("can.capture_stop", session=a)
    finally:
        m("can.close", session=a)
    with pytest.raises(BridgeError, match="no open CAN session"):
        m("can.stats", session=a)
    with pytest.raises(BridgeError, match="could not open CAN"):
        m("can.open", interface="socketcan", channel="does-not-exist0", bitrate=500000)


# ------------------------------------------------------------------ VISA (pyvisa-py, SOCKET resource)

class Instrument(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.srv = socket.socket()
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(1)
        self.port = self.srv.getsockname()[1]
        self.errors = ['-113,"Undefined header"']

    def run(self):
        conn, _ = self.srv.accept()
        buf = b""
        with conn:
            while True:
                d = conn.recv(4096)
                if not d:
                    return
                buf += d
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    cmd = line.decode().strip()
                    if cmd == "*IDN?":
                        conn.sendall(b"ACME,PSU-1,SN1,1.0\n")
                    elif cmd == "SYST:ERR?":
                        conn.sendall((self.errors.pop(0) if self.errors else '0,"No error"').encode() + b"\n")
                    elif cmd == "WAV:DATA?":
                        payload = bytes([0, 10, 255, 128])
                        conn.sendall(b"#14" + payload + b"\n")
                    elif cmd == "SLOW?":
                        pass  # never answers


def test_visa_session_over_pyvisa_py():
    inst = Instrument()
    inst.start()
    res = f"TCPIP::127.0.0.1::{inst.port}::SOCKET"
    s = m("visa.open", resource=res, timeout_ms=1000)["session"]
    try:
        assert m("visa.query", session=s, command="*IDN?")["text"] == "ACME,PSU-1,SN1,1.0"
        assert m("visa.query", session=s, command="SYST:ERR?")["text"].startswith("-113")
        assert base64.b64decode(m("visa.query_binary", session=s, command="WAV:DATA?")["base64"]) == bytes([0, 10, 255, 128])
        assert m("visa.write", session=s, command="VOLT 1")["ok"] is True
        t0 = time.monotonic()
        with pytest.raises(BridgeError, match="timed out"):
            m("visa.query", session=s, command="SLOW?", timeout_ms=300)
        assert time.monotonic() - t0 < 3
    finally:
        m("visa.close", session=s)
    with pytest.raises(BridgeError, match="no open VISA session"):
        m("visa.query", session=s, command="*IDN?")
