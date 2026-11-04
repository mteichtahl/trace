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
