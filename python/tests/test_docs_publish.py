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
    with pytest.raises(PublishError, match=r"the browser that draws diagrams failed on diagram 1 \(flowchart LR\), not the diagram: browser flags 1: .*Target closed"):
        draw_diagrams(["flowchart LR\n  A --> B"], tmp_path, mmdc=_mmdc(tmp_path, "crash"))


def test_a_diagram_mermaid_cannot_read_is_the_diagram(tmp_path):
    from tracebridge.docs.publish import draw_diagrams
    with pytest.raises(PublishError, match=r"diagram 1 \(flowchart LR\) does not draw: Error: Parse error on line 2"):
        draw_diagrams(["flowchart LR\n  BROKEN -->"], tmp_path, mmdc=_mmdc(tmp_path, "crash"))
