"""Printing one of a project's documents (docs/scribe.md "Rendering"): markdown in, a PDF out.

    1. the front matter is read (project, document, revision, commit, updated) and taken off
    2. Scribe's markers (<!-- scribe:… -->) are taken off: they are for Scribe, not the reader
    3. each ```mermaid block is drawn as SVG with Mermaid's command line (mmdc), with labels as SVG text so the PDF
       carries them as text; a diagram Mermaid cannot read stops the job, naming it. When the browser behind Mermaid
       cannot start at all, the diagrams it did not draw are printed as their Mermaid source with a short note, so
       the rest of the document still prints (the result names them)
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


# Chromium's flags for Mermaid, tried in order until one draws: the tools function (AWS Lambda) has no /dev/shm, no
# user namespaces and no D-Bus, and some Chromium builds crash there in single-process mode, so a second set leaves
# that out
BROWSER_FLAGS: tuple[tuple[str, ...], ...] = (
    ("--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--single-process", "--no-zygote"),
    ("--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-setuid-sandbox", "--no-first-run",
     "--disable-crash-reporter", "--disable-breakpad", "--disable-extensions", "--use-gl=swiftshader"),
)
# Mermaid's own words for a diagram it cannot read: that is the diagram's fault, and no other browser helps
SYNTAX = re.compile(r"(Parse|Lexical|Syntax) error|No diagram type detected|UnknownDiagramError", re.I)
# What Chromium always says where there is no D-Bus, no GPU and no CPU frequency to read (a container, Lambda): logged
# as errors, but never why it stopped. Left in, they were the only reason a run gave ("dbus socket ... is missing").
NOISE = re.compile(r"dbus|/run/dbus|ANGLE|EGL|eglInitialize|GLDisplay|gl_display|Vulkan|vk_renderer|SwiftShader|"
                   r"crashpad|cpufreq|V8 Proxy resolver|DevTools listening|viz_main|gpu_init|command_buffer|"
                   r"Fontconfig|libva|ui/gl/|inotify|sandbox_linux|Floss", re.I)


def find_browser(env: dict[str, str] | None = None) -> str | None:
    """The Chromium Mermaid uses: TRACE_CHROMIUM, else Playwright's headless shell where it was installed.

    The headless shell is Chromium's build for running without a display (what Lambda's Chromium layers ship): it needs
    no D-Bus, no GPU and no window system, so it starts where the full browser does not."""
    env = dict(os.environ if env is None else env)
    if env.get("TRACE_CHROMIUM"):
        return env["TRACE_CHROMIUM"]
    roots = [env.get("PLAYWRIGHT_BROWSERS_PATH", ""), "/opt/pw-browsers", str(Path(env.get("HOME", "/nonexistent")) / ".cache" / "ms-playwright")]
    for root in filter(None, roots):
        base = Path(root)
        if not base.is_dir():
            continue
        # x64: chrome-headless-shell-linux64/chrome-headless-shell; arm64 (Playwright's own build): chrome-linux/headless_shell
        found = sorted(base.glob("chromium_headless_shell-*/chrome-*/chrome-headless-shell")) + sorted(base.glob("chromium_headless_shell-*/chrome-*/headless_shell"))
        if found:
            return str(found[-1])
    return None


def _launch(flags: tuple[str, ...], browser: str | None) -> dict[str, object]:
    """Puppeteer's launch options for mmdc (its -p file)."""
    opts: dict[str, object] = {"args": list(flags), "dumpio": True}  # dumpio: Chromium's own stderr reaches ours
    if browser:
        opts["executablePath"] = browser
        # the headless shell is driven in its own mode; the full browser in its new headless mode (Puppeteer's default)
        if "headless" in Path(browser).resolve().name:
            opts["headless"] = "shell"
    return opts


def _reason(text: str, limit: int = 900) -> str:
    """The lines that say why: errors and Chromium's own complaints first, then the head; never the stack frames, and
    never what Chromium always logs in a container (no D-Bus, no GPU), which hides the real reason."""
    lines = [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith("at ")]
    lines = [l for l in lines if not NOISE.search(l)] or lines
    told = [l for l in lines if re.search(r"error|fail|fatal|crash|closed|killed|denied|cannot|unable", l, re.I)]
    out = " | ".join(dict.fromkeys(told[:6] or lines[:6]))
    return out[:limit] or "Mermaid gave no reason"


def draw_diagrams(diagrams: list[str], work: Path, mmdc: str = "mmdc", browser: str | None = None) -> dict[str, object]:
    """Draw each diagram as SVG. Returns which browser flags drew them (0 the first set), why earlier sets failed, and
    the diagrams not drawn because the browser never started (`not_drawn`, numbered from 1, with `why`).

    A diagram Mermaid cannot read raises PublishError: that is the document's to fix. A browser that fails with every
    set of flags is the installation's fault, not the document's, so it does not stop the print: once it has failed,
    no later diagram is tried either."""
    if not diagrams:
        return {"flags": None, "tried": [], "not_drawn": []}
    cfg = work / "mermaid.json"
    cfg.write_text(json.dumps(MERMAID_CONFIG))
    browser = browser or find_browser()
    # Chromium looks for a session bus on start; "disabled:" tells it there is none instead of it trying and logging
    env = {**os.environ, "DBUS_SESSION_BUS_ADDRESS": "disabled:"}
    tried: list[str] = []
    k = 0
    for i, code in enumerate(diagrams, 1):
        src = work / f"diagram-{i}.mmd"
        src.write_text(code)
        out = work / f"diagram-{i}.svg"
        first = (code.strip().splitlines() or [""])[0]
        while True:
            pup = work / f"puppeteer-{k}.json"
            pup.write_text(json.dumps(_launch(BROWSER_FLAGS[k], browser)))
            try:
                r = subprocess.run([mmdc, "-q", "-i", str(src), "-o", str(out), "-c", str(cfg), "-p", str(pup), "-b", "white"],
                                   capture_output=True, text=True, timeout=120, env=env)
                said, ok = f"{r.stderr}\n{r.stdout}", r.returncode == 0 and out.exists()
            except subprocess.TimeoutExpired:
                said, ok = "Error: the browser did not answer within 120 s", False
            except OSError as e:  # mmdc itself missing
                said, ok = f"Error: Mermaid's command line could not run: {e}", False
            if ok:
                break
            why = _reason(said)
            if SYNTAX.search(said):
                raise PublishError(f"diagram {i} ({first}) does not draw: {why}")
            tried.append(f"browser flags {k + 1}: {why}")
            if k + 1 >= len(BROWSER_FLAGS):
                return {"flags": None, "tried": tried, "not_drawn": list(range(i, len(diagrams) + 1)),
                        "why": f"the browser that draws diagrams failed on diagram {i} ({first}), not the diagram: " + " / ".join(tried)}
            k += 1
    return {"flags": k, "tried": tried, "not_drawn": []}


def as_source(body: str, diagrams: list[str], not_drawn: list[int]) -> str:
    """The document with each diagram not drawn printed as its Mermaid source, after a short note, keeping its caption."""
    for i in not_drawn:
        pat = re.compile(r"^!\[([^\]]*)\]\(diagram-" + str(i) + r"\.svg\)[ \t]*$", re.M)
        code = diagrams[i - 1].replace("```", "` ` `")

        def block(m: re.Match[str], code: str = code) -> str:
            caption = m.group(1).strip()
            return ("> *This diagram could not be drawn when this copy was printed; its Mermaid source is shown "
                    "instead. Print the document again to draw it.*\n\n```\n" + code + "\n```" + (f"\n\n_{caption}_" if caption else ""))

        body = pat.sub(block, body, count=1)
    return body


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
    drew = draw_diagrams(p.diagrams, work)
    not_drawn: list[int] = list(drew.get("not_drawn") or [])  # type: ignore[arg-type]
    body = as_source(p.body, p.diagrams, not_drawn) if not_drawn else p.body
    logo_name = None
    if logo:
        logo_name = "logo" + logo.suffix.lower()
        shutil.copyfile(logo, work / logo_name)
    typ = pandoc_typst(body, p.meta, work, logo_name, revisions or [])
    compile_pdf(typ, out)
    return {"pdf": str(out), "bytes": out.stat().st_size, "diagrams": len(p.diagrams), "project": p.meta["project"], "document": p.meta["document"], "revision": p.meta["revision"], "commit": p.meta["commit"],
            **({"browser": drew} if drew.get("tried") else {}),
            **({"not_drawn": not_drawn, "not_drawn_why": drew.get("why", "")} if not_drawn else {})}
