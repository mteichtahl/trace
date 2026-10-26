"""A small, real datasheet PDF for tests, built with reportlab: a text layer, an electrical-characteristics table,
a pin table and a vector plot. Run as a script to write one: `python fixture_pdf.py out.pdf [revision]`
(the revision changes the bytes and one figure, for version-change tests). `python fixture_pdf.py out.pdf timing`
writes a different fixture instead: TPX7705, a made-up ADC with I2C and SPI timing tables in the symbol styles real
datasheets use (tSU;DAT, t HD:STA, tCSS, ...), a row whose cell is a footnote, and a row in a unit given as text."""
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


def build_timing(out: str) -> None:
    """TPX7705: not a real part. Its numbers are made up for the extraction tests."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Table, TableStyle

    s = getSampleStyleSheet()
    grid = TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)])
    i2c = Table([
        ["Parameter", "Symbol", "Conditions", "Min", "Typ", "Max", "Unit"],
        ["SCL clock frequency", "fSCL", "Fast mode", "0", "", "400", "kHz"],
        ["Hold time (repeated) START condition", "tHD;STA", "", "0.6", "", "", "µs"],
        ["Low period of the SCL clock", "tLOW", "", "1.3", "", "", "µs"],
        ["High period of the SCL clock", "tHIGH", "", "0.6", "", "", "µs"],
        ["Set-up time for a repeated START condition", "t SU:STA", "", "0.6", "", "", "µs"],
        ["Data hold time", "tHD(DAT)", "", "0", "", "0.9", "µs"],
        ["Data set-up time", "tSU;DAT", "", "100", "", "", "ns"],
        ["Set-up time for STOP condition", "tSU;STO", "", "0.6", "", "", "µs"],
        ["Bus free time between a STOP and START condition", "tBUF", "", "1.3", "", "", "µs"],
        ["Capacitive load for each bus line", "Cb", "", "", "", "400", "pF"],
        ["Pulse width of spikes suppressed", "tSP", "", "", "", "see note 2", "ns"],
    ])
    i2c.setStyle(grid)
    spi = Table([
        ["Parameter", "Symbol", "Conditions", "Min", "Typ", "Max", "Unit"],
        ["Serial clock frequency", "fSCLK", "VDD = 3.3 V", "", "", "20", "MHz"],
        ["CS falling to SCLK rising", "tCSS", "", "10", "", "", "ns"],
        ["SCLK falling to CS rising", "tCSH", "", "10", "", "", "ns"],
        ["CS high time between transfers", "tCSD", "", "50", "", "", "ns"],
        ["Data input set-up time", "tSU", "", "5", "", "", "ns"],
        ["Data input hold time", "tH", "", "5", "", "", "ns"],
        ["Output valid from SCLK falling", "tV", "CL = 30 pF", "", "", "20", "ns"],
        ["Output hold time", "tHO", "", "2", "", "", "ns"],
        ["Output disable time", "tDIS", "", "", "", "15", "furlongs"],
    ])
    spi.setStyle(grid)
    story = [
        Paragraph("TPX7705 12-bit ADC with I2C and SPI interfaces (test fixture, not a real part)", s["Title"]),
        Paragraph("The figures in this document are made up for tests.", s["Normal"]),
        PageBreak(),
        Paragraph("8.6 I2C Timing Requirements", s["Heading2"]), i2c,
        Paragraph("Note 2: the input filter is described in section 9.", s["Normal"]),
        PageBreak(),
        Paragraph("8.7 SPI Timing Requirements", s["Heading2"]), spi,
    ]
    SimpleDocTemplate(out, pagesize=A4, title="TPX7705").build(story)


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[2] == "timing":
        build_timing(sys.argv[1])
    else:
        build(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "A")
