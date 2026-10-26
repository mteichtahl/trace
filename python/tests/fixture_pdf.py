"""A small, real datasheet PDF for tests, built with reportlab: a text layer, an electrical-characteristics table,
a pin table and a vector plot. Run as a script to write one: `python fixture_pdf.py out.pdf [revision]`
(the revision changes the bytes and one figure, for version-change tests)."""
from __future__ import annotations

import sys


def build(out: str, revision: str = "A") -> None:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    from reportlab.graphics.shapes import Drawing, Line, PolyLine, String

    s = getSampleStyleSheet()
    grid = TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)])
    iq_max = "70" if revision == "A" else "75"
    ec = Table([
        ["Parameter", "Symbol", "Conditions", "Min", "Typ", "Max", "Unit"],
        ["Input voltage range", "VIN", "", "2.7", "", "5.5", "V"],
        ["Quiescent current", "IQ", "VIN = 5 V, no load", "", "45", iq_max, "µA"],
        ["Switching frequency", "fSW", "", "1.8", "2.0", "2.2", "MHz"],
        ["Thermal shutdown", "TSD", "", "", "see note 1", "", "°C"],
    ])
    ec.setStyle(grid)
    pins = Table([["Pin", "Name", "Type", "Description"], ["1", "VIN", "P", "Input supply"],
                  ["2", "GND", "G", "Ground"], ["3", "SW", "O", "Switch node"], ["4", "FB", "I", "Feedback input"]])
    pins.setStyle(grid)

    d = Drawing(300, 160)
    d.add(Line(40, 20, 280, 20, strokeColor=colors.black, strokeWidth=1))
    d.add(Line(40, 20, 40, 150, strokeColor=colors.black, strokeWidth=1))
    d.add(PolyLine([40, 30, 100, 60, 160, 90, 220, 110, 280, 120], strokeColor=colors.blue, strokeWidth=1.5))
    d.add(String(150, 4, "IOUT (A)", fontSize=8))

    story = [
        Paragraph(f"TPX123 2 MHz Step-Down Converter (revision {revision})", s["Title"]),
        Paragraph("The TPX123 is a synchronous buck converter for battery-powered systems.", s["Normal"]),
        PageBreak(),
        Paragraph("6 Pin Configuration and Functions", s["Heading2"]), pins, Spacer(1, 20),
        Paragraph("7 Electrical Characteristics", s["Heading2"]), ec,
        Paragraph("Note 1: guaranteed by design.", s["Normal"]),
        PageBreak(),
        Paragraph("Figure 3. Efficiency vs Output Current", s["Heading3"]), d,
    ]
    SimpleDocTemplate(out, pagesize=A4, title="TPX123").build(story)


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "A")
