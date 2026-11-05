"""Printing a project's document (tracebridge.docs, docs/scribe.md "Rendering"): what is taken off before printing,
each Mermaid block turned into a numbered figure with its caption, and the problems a person can fix said plainly.
The end-to-end print (pandoc, Mermaid, Typst) is tested from TypeScript (test/tools/docs/docs.test.ts)."""
import pytest

from tracebridge.docs.publish import PublishError, prepare, read_front

DOC = """---
project: test-esp32
document: High level design
revision: A
commit: 0123456789abcdef
updated: 2026-11-05
---

# test-esp32: High level design

<!-- scribe:section id="data-flow" -->
## Data flow

<!-- scribe:figure kind="data-flow" source="ontology:architecture" -->
```mermaid
flowchart LR
  A --> B
```
_How readings reach the display._

<!-- scribe:figure kind="render-top" source="run:r-1" -->
![Top](figures/top.png)

_The top of the board._
<!-- scribe:end id="data-flow" -->
"""


def test_reads_the_front_matter():
    meta, body = read_front(DOC)
    assert meta["project"] == "test-esp32" and meta["commit"] == "0123456789abcdef"
    assert body.lstrip().startswith("# test-esp32")


def test_takes_off_markers_and_title_and_captions_each_figure():
    p = prepare(DOC)
    assert "scribe:" not in p.body
    assert "# test-esp32" not in p.body
    assert p.diagrams == ["flowchart LR\n  A --> B"]
    assert "![How readings reach the display.](diagram-1.svg)" in p.body
    assert "![The top of the board.](figures/top.png)" in p.body


@pytest.mark.parametrize("front,why", [
    ("", "no front matter"),
    ("---\nproject: x\ndocument: y\nrevision: A\n---\n", "no commit"),
    ("---\nproject: x\ndocument: y\nrevision: A\ncommit: not-a-hash\n---\n", "not a commit hash"),
])
def test_refuses_front_matter_it_cannot_print(front, why):
    with pytest.raises(PublishError, match=why):
        prepare(front + "body\n")


# ------------------------------------------------------------------ the browser that draws the diagrams

FAKE_MMDC = r'''#!/usr/bin/env python3
import json, sys
a = sys.argv
src, out, pup = a[a.index("-i") + 1], a[a.index("-o") + 1], a[a.index("-p") + 1]
flags = json.load(open(pup))["args"]
code = open(src).read()
if "BROKEN" in code:
    print("Error: Parse error on line 2:\n    at Object.parseError (mermaid.js:1:1)", file=sys.stderr); sys.exit(1)
if MODE == "crash" or (MODE == "single" and "--single-process" in flags):
    print("[0105/120000.1:FATAL:zygote_host_impl_linux.cc(1)] No usable sandbox!\nError: Protocol error (Target.setDiscoverTargets): Target closed\n    at async cli (index.js:374:3)", file=sys.stderr); sys.exit(1)
open(out, "w").write('<svg xmlns="http://www.w3.org/2000/svg"/>')
'''


def _mmdc(tmp_path, mode):
    p = tmp_path / "mmdc"
    p.write_text(FAKE_MMDC.replace("MODE ==", f"{mode!r} =="))
    p.chmod(0o755)
    return str(p)


def test_a_browser_that_dies_is_tried_again_with_other_flags(tmp_path):
    from tracebridge.docs.publish import draw_diagrams
    drew = draw_diagrams(["flowchart LR\n  A --> B", "flowchart LR\n  C --> D"], tmp_path, mmdc=_mmdc(tmp_path, "single"))
    assert drew["flags"] == 1
    assert "Target closed" in drew["tried"][0] and "No usable sandbox" in drew["tried"][0]
    assert "at async cli" not in drew["tried"][0]
    assert (tmp_path / "diagram-1.svg").exists() and (tmp_path / "diagram-2.svg").exists()


def test_a_browser_that_never_draws_is_said_to_be_the_browser_not_the_diagram(tmp_path):
    from tracebridge.docs.publish import draw_diagrams
    drew = draw_diagrams(["flowchart LR\n  A --> B", "flowchart LR\n  C --> D"], tmp_path, mmdc=_mmdc(tmp_path, "crash"))
    # every diagram from the first failure on is left undrawn, and the browser is not started again for the second
    assert drew["not_drawn"] == [1, 2]
    assert len(drew["tried"]) == 2
    assert drew["why"].startswith("the browser that draws diagrams failed on diagram 1 (flowchart LR), not the diagram: browser flags 1: ")
    assert "Target closed" in drew["why"]


def test_chromiums_container_noise_is_not_given_as_the_reason(tmp_path):
    """Log #94: the run said only "dbus socket /run/dbus/system_bus_socket is missing", which Chromium logs on every
    start without D-Bus; the real reason (the browser closed) was further down."""
    from tracebridge.docs.publish import _reason
    said = "\n".join([
        "[1:2:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Failed to connect to socket /run/dbus/system_bus_socket: No such file or directory",
        "[1:2:ERROR:ui/gl/gl_display.cc:630] eglInitialize SwANGLE failed with error EGL_NOT_INITIALIZED",
        "[1:2:ERROR:third_party/crashpad/crashpad/util/file/file_io_posix.cc:145] open /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq: No such file or directory (2)",
        "TargetCloseError: Protocol error (Target.setDiscoverTargets): Target closed",
        "    at TCP.<anonymous> (node:net:347:12)",
    ])
    why = _reason(said)
    assert "Target closed" in why
    assert "dbus" not in why and "EGL" not in why and "cpufreq" not in why
    # only noise: still says something rather than nothing
    assert "dbus" in _reason(said.splitlines()[0])


def test_the_headless_shell_is_found_and_driven_in_its_own_mode(tmp_path):
    from tracebridge.docs.publish import _launch, find_browser
    shell = tmp_path / "chromium_headless_shell-1243" / "chrome-linux" / "headless_shell"
    shell.parent.mkdir(parents=True)
    shell.write_text("")
    assert find_browser({"PLAYWRIGHT_BROWSERS_PATH": str(tmp_path), "HOME": str(tmp_path)}) == str(shell)
    assert find_browser({"TRACE_CHROMIUM": "/usr/bin/chrome", "PLAYWRIGHT_BROWSERS_PATH": str(tmp_path)}) == "/usr/bin/chrome"
    assert _launch(("--no-sandbox",), str(shell))["headless"] == "shell"
    # the tools image names it through a link (TRACE_CHROMIUM=/usr/local/bin/trace-chromium)
    link = tmp_path / "trace-chromium"
    link.symlink_to(shell)
    assert _launch(("--no-sandbox",), str(link))["headless"] == "shell"
    assert "headless" not in _launch(("--no-sandbox",), "/opt/pw-browsers/chromium-1/chrome-linux64/chrome")
    assert "executablePath" not in _launch(("--no-sandbox",), None)


def test_a_diagram_not_drawn_is_printed_as_its_source_with_its_caption():
    from tracebridge.docs.publish import as_source
    p = prepare(DOC)
    body = as_source(p.body, p.diagrams, [1])
    assert "diagram-1.svg" not in body
    assert "could not be drawn when this copy was printed" in body
    assert "```\nflowchart LR\n  A --> B\n```\n\n_How readings reach the display._" in body
    # the other figures are left as they were
    assert "![The top of the board.](figures/top.png)" in body


def _programs() -> bool:
    import shutil
    try:
        import typst  # noqa: F401
    except ImportError:
        return False
    return bool(shutil.which("pandoc"))


def _png() -> bytes:
    """A one-pixel PNG."""
    import struct
    import zlib

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff")) + chunk(b"IEND", b""))


@pytest.mark.skipif(not _programs(), reason="pandoc and Typst are not here")
def test_a_document_still_prints_when_the_browser_never_starts(tmp_path, monkeypatch):
    """Log #34, #94: no diagram could be drawn on the tools function, so no PDF was made at all."""
    from tracebridge.docs import publish as pub
    real = pub.draw_diagrams
    monkeypatch.setattr(pub, "draw_diagrams", lambda d, w: real(d, w, mmdc=_mmdc(tmp_path, "crash")))
    doc = tmp_path / "doc" / "high-level-design.md"
    (doc.parent / "figures").mkdir(parents=True)
    (doc.parent / "figures" / "top.png").write_bytes(_png())
    doc.write_text(DOC)
    out = tmp_path / "doc.pdf"
    r = pub.publish(doc, out, tmp_path / "work")
    assert out.read_bytes()[:5] == b"%PDF-"
    assert r["not_drawn"] == [1] and "not the diagram" in r["not_drawn_why"]


# ------------------------------------------------------------------ the real Mermaid and Chromium, where they are

def _real_mermaid():
    import shutil
    from tracebridge.docs.publish import find_browser
    return shutil.which("mmdc"), find_browser()


@pytest.mark.skipif(not all(_real_mermaid()), reason="Mermaid's command line or a Chromium is not here")
def test_mermaid_draws_a_diagram_without_d_bus_or_a_display(tmp_path, monkeypatch):
    """The same path the tools function takes: mmdc with the first set of flags, no D-Bus, no display."""
    from tracebridge.docs.publish import draw_diagrams
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.setenv("DBUS_SYSTEM_BUS_ADDRESS", "unix:path=/nonexistent/system_bus_socket")
    mmdc, browser = _real_mermaid()
    drew = draw_diagrams(["flowchart LR\n  A[USB] --> B[ESP32] --> C[Display]"], tmp_path, mmdc=mmdc, browser=browser)
    assert drew["not_drawn"] == [], drew
    assert drew["flags"] == 0, drew
    svg = (tmp_path / "diagram-1.svg").read_text()
    assert "<svg" in svg and "ESP32" in svg


def test_a_diagram_mermaid_cannot_read_is_the_diagram(tmp_path):
    from tracebridge.docs.publish import draw_diagrams
    with pytest.raises(PublishError, match=r"diagram 1 \(flowchart LR\) does not draw: Error: Parse error on line 2"):
        draw_diagrams(["flowchart LR\n  BROKEN -->"], tmp_path, mmdc=_mmdc(tmp_path, "crash"))
