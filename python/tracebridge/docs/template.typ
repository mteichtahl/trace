// trace's printed document (docs/scribe.md "Rendering"): pandoc's Typst writer fills this template
// (python/tracebridge/docs/publish.py). A cover with the project's logo, the document, its revision and commit; a
// revision table; contents; then the body, with a small logo and the document's title in the page header and
// "page n of m" in the footer. Plain and print-friendly: one accent colour, Liberation fonts (always installed).

#let accent = rgb("#0b5cad")
#let muted = rgb("#57606a")

#let horizontalrule = line(start: (25%, 0%), end: (75%, 0%), stroke: 0.5pt + muted)
#let blockquote(body) = block(inset: (left: 10pt, y: 4pt), stroke: (left: 2pt + accent), body)

#show terms: it => {
  it.children.map(child => [
    #strong[#child.term]
    #block(inset: (left: 1.5em, top: -0.4em))[#child.description]
  ]).join()
}

#let logo-mark(height) = {
$if(logo)$
  image("$logo$", height: height)
$else$
  box(width: height, height: height, radius: 20%, fill: accent)
$endif$
}

#set document(title: [$project$: $document$], author: "trace")
#set text(font: ("Liberation Sans", "DejaVu Sans"), size: 10pt, lang: "en")
#set par(justify: false, leading: 0.65em)
#set heading(numbering: "1.1")
#show heading: set text(fill: accent)
#show heading.where(level: 1): set block(above: 1.6em, below: 0.8em)
#show raw: set text(font: ("Liberation Mono", "DejaVu Sans Mono"), size: 9pt)
#show link: set text(fill: accent)
#set table(stroke: 0.5pt + rgb("#d0d7de"), inset: 5pt)
#show table.cell.where(y: 0): set text(weight: "bold")
#show figure.caption: set text(size: 9pt, fill: muted)

// ------------------------------------------------------------------ cover

#page(margin: (x: 2.5cm, y: 3cm), header: none, footer: none)[
  #logo-mark(1.6cm)
  #v(1fr)
  #text(size: 11pt, fill: muted, upper([$document$]))
  #v(2pt)
  #text(size: 26pt, weight: "bold")[$project$]
  #v(10pt)
  #text(size: 11pt)[Revision $revision$ · $date$]
  #v(4pt)
  #text(size: 9pt, fill: muted)[Made by trace from the project's records at commit #raw("$commit$")]
  #v(2cm)
  #line(length: 100%, stroke: 0.5pt + muted)
  #text(size: 8pt, fill: muted)[Every figure and value in this document names the record it came from. A value marked pending has not been worked out yet.]
]

// ------------------------------------------------------------------ the rest

#set page(
  paper: "a4",
  margin: (x: 2.2cm, top: 2.6cm, bottom: 2.4cm),
  header: context {
    set text(size: 8pt, fill: muted)
    grid(columns: (auto, 1fr), gutter: 8pt, align: (left + horizon, right + horizon),
      logo-mark(0.55cm), [$project$ · $document$ · Revision $revision$])
    v(-4pt)
    line(length: 100%, stroke: 0.4pt + rgb("#d0d7de"))
  },
  footer: context {
    set text(size: 8pt, fill: muted)
    grid(columns: (1fr, auto), [Commit #raw("$commit$")], [Page #counter(page).display() of #counter(page).final().first()])
  },
)
#counter(page).update(1)

#heading(numbering: none, outlined: false)[Revisions]
#table(columns: (auto, auto, auto, 1fr),
  [Revision], [Date], [Commit], [What changed],
$for(revisions)$
  [$revisions.revision$], [$revisions.date$], [#raw("$revisions.commit$")], [$revisions.note$],
$endfor$
)

#outline(title: [Contents], depth: 2)

$body$
