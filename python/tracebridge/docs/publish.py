"""Printing one of a project's documents (docs/scribe.md "Rendering"): markdown in, a PDF out.

    1. the front matter is read (project, document, revision, commit, updated) and taken off
    2. Scribe's markers (<!-- scribe:… -->) are taken off: they are for Scribe, not the reader
    3. each ```mermaid block is drawn as SVG with Mermaid's command line (mmdc), with labels as SVG text so the PDF
       carries them as text; a diagram that does not draw stops the job, naming it
    4. pandoc writes the result as Typst through template.typ (cover with the logo, revisions, contents, header, footer)
    5. Typst compiles the PDF

The images a document names (renders, drawings, traces) are found relative to the document, as in the repository.
Nothing here reaches the network: Mermaid's browser is told to load nothing from outside.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

TEMPLATE = Path(__file__).with_name("template.typ")
FRONT = re.compile(r"^---\n(.*?)\n---\n", re.S)
MARKER = re.compile(r"^[ \t]*<!--\s*scribe:[^>]*-->[ \t]*\n?", re.M)
MERMAID = re.compile(r"^```mermaid[ \t]*\n(.*?)\n```[ \t]*$", re.S | re.M)
CAPTIONED = re.compile(r"^!\[[^\]]*\]\(([^)\s]+)\)[ \t]*\n(?:[ \t]*\n)?_([^_\n]+)_[ \t]*$", re.M)
COMMIT = re.compile(r"^[0-9a-f]{4,40}$")

# Mermaid draws text as SVG text (not HTML inside foreignObject, which Typst's SVG reader leaves out), in the fonts the
# PDF uses, and never loads anything.
MERMAID_CONFIG = {
    "theme": "neutral",
    "fontFamily": "Liberation Sans, DejaVu Sans, sans-serif",
    "htmlLabels": False,
    "flowchart": {"htmlLabels": False, "useMaxWidth": False},
    "sequence": {"useMaxWidth": False},
    "securityLevel": "strict",
}


class PublishError(Exception):
    """A problem with the document a person can fix, in their words."""


@dataclass
class Prepared:
    meta: dict[str, str]
    body: str
    diagrams: list[str] = field(default_factory=list)


def read_front(text: str) -> tuple[dict[str, str], str]:
    m = FRONT.match(text)
    if not m:
        raise PublishError("the document has no front matter (project, document, revision, commit, updated)")
    meta: dict[str, str] = {}
    for line in m.group(1).splitlines():
        k, sep, v = line.partition(":")
        if sep and k.strip():
            meta[k.strip()] = v.strip()
    for k in ("project", "document", "revision", "commit"):
        if not meta.get(k):
            raise PublishError(f"the front matter has no {k}")
    if not COMMIT.match(meta["commit"]):
        raise PublishError(f"the front matter's commit is not a commit hash: {meta['commit']!r}")
    return meta, text[m.end():]


def prepare(text: str) -> Prepared:
    """The document without front matter and markers, each Mermaid block replaced by an image to be drawn."""
    meta, body = read_front(text)
    body = MARKER.sub("", body)
    # the document's own title line: the cover carries it
    body = re.sub(r"\A\s*#\s[^\n]*\n", "", body)
    diagrams: list[str] = []

    def swap(m: re.Match[str]) -> str:
        diagrams.append(m.group(1))
        return f"![](diagram-{len(diagrams)}.svg)"

    body = MERMAID.sub(swap, body)
    # a figure's italic caption line becomes its caption, so the PDF numbers it ("Figure 3: …")
    body = CAPTIONED.sub(lambda m: f"![{m.group(2)}]({m.group(1)})", body)
    return Prepared(meta, body, diagrams)


def draw_diagrams(diagrams: list[str], work: Path, mmdc: str = "mmdc") -> None:
    if not diagrams:
        return
    cfg = work / "mermaid.json"
    cfg.write_text(json.dumps(MERMAID_CONFIG))
    pup = work / "puppeteer.json"
    pup.write_text(json.dumps({
        "args": ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--single-process", "--no-zygote"],
        **({"executablePath": os.environ["TRACE_CHROMIUM"]} if os.environ.get("TRACE_CHROMIUM") else {}),
    }))
    for i, code in enumerate(diagrams, 1):
        src = work / f"diagram-{i}.mmd"
        src.write_text(code)
        r = subprocess.run([mmdc, "-q", "-i", str(src), "-o", str(work / f"diagram-{i}.svg"), "-c", str(cfg), "-p", str(pup), "-b", "white"],
                           capture_output=True, text=True, timeout=120)
        if r.returncode != 0 or not (work / f"diagram-{i}.svg").exists():
            first = (code.strip().splitlines() or [""])[0]
            why = (r.stderr or r.stdout).strip().splitlines()
            raise PublishError(f"diagram {i} ({first}) does not draw: {why[-1] if why else 'Mermaid gave no reason'}")


def pandoc_typst(body: str, meta: dict[str, str], work: Path, logo: str | None, revisions: list[dict[str, str]], pandoc: str = "pandoc") -> Path:
    md = work / "document.md"
    md.write_text(body)
    data = {
        "project": meta["project"], "document": meta["document"], "revision": meta["revision"], "commit": meta["commit"][:12],
        "date": meta.get("updated", ""),
        "revisions": [{**r, "commit": r["commit"][:12]} for r in revisions if COMMIT.match(r.get("commit", ""))] or
                     [{"revision": meta["revision"], "date": meta.get("updated", ""), "commit": meta["commit"][:12], "note": "This revision."}],
    }
    mfile = work / "meta.json"
    mfile.write_text(json.dumps(data))
    out = work / "document.typ"
    # Scribe's sections are level-2 headings under the document's title (which the cover carries): they become chapters
    args = [pandoc, "-f", "markdown+pipe_tables+implicit_figures-tex_math_dollars-raw_tex", "--shift-heading-level-by=-1", "-t", "typst", "--template", str(TEMPLATE), "--metadata-file", str(mfile), "-o", str(out), str(md)]
    if logo:
        args[1:1] = ["-V", f"logo={logo}"]
    r = subprocess.run(args, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise PublishError(f"pandoc could not read the document: {r.stderr.strip()}")
    return out


def compile_pdf(typ: Path, out: Path) -> None:
    import typst  # the Typst compiler, bundled (pip typst)

    try:
        typst.compile(str(typ), output=str(out), root=str(typ.parent))
    except Exception as e:  # noqa: BLE001 - Typst's errors are one class, and the message is what a person needs
        raise PublishError(f"the PDF could not be made: {e}") from e


def publish(doc: Path, out: Path, work: Path, logo: Path | None = None, revisions: list[dict[str, str]] | None = None) -> dict[str, object]:
    """Print `doc` to `out`. Images the document names are copied in from beside it. Returns what was made."""
    work.mkdir(parents=True, exist_ok=True)
    p = prepare(doc.read_text())
    for ref in re.findall(r"!\[[^\]]*\]\(([^)\s]+)", p.body):
        if ref.startswith("diagram-") or re.match(r"^[a-z]+:", ref):
            continue
        src = (doc.parent / ref).resolve()
        if doc.parent.resolve() not in src.parents or not src.exists():
            raise PublishError(f"the image {ref} is not beside the document")
        dst = work / ref
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
    draw_diagrams(p.diagrams, work)
    logo_name = None
    if logo:
        logo_name = "logo" + logo.suffix.lower()
        shutil.copyfile(logo, work / logo_name)
    typ = pandoc_typst(p.body, p.meta, work, logo_name, revisions or [])
    compile_pdf(typ, out)
    return {"pdf": str(out), "bytes": out.stat().st_size, "diagrams": len(p.diagrams), "project": p.meta["project"], "document": p.meta["document"], "revision": p.meta["revision"], "commit": p.meta["commit"]}
