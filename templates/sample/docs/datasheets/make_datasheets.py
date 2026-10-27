"""Write the sample's two datasheets: TRC-OPA1 (an op-amp) and TRC-TMP1 (an I2C temperature sensor).

Both parts are FICTIONAL. They exist so the datasheet tools (datasheets.add/text/tables/params/page_image),
protocol.spec_extract and thermal.envelope from_datasheet have real PDFs to read in the sample project. The text and
figures are written for the trace sample: TRC-OPA1's numbers are the sim/models/TRC_OPA1.lib macromodel's by
construction, and TRC-TMP1's I2C timing is a fast-mode device's. Neither is any manufacturer's part or document.

Run: python3 docs/datasheets/make_datasheets.py   (needs reportlab)
"""
import os
import sys

from reportlab import rl_config
from reportlab.graphics.shapes import Drawing, Line, PolyLine, String
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

rl_config.invariant = 1  # the same bytes on every run (no timestamps), so the library sees no new version
HERE = os.path.dirname(os.path.abspath(__file__))
S = getSampleStyleSheet()
GRID = TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black), ("FONTSIZE", (0, 0), (-1, -1), 8)])
FICTION = ("This is a fictional part, made up for the trace sample project. It is not a real product and no "
           "manufacturer publishes it. Do not order it.")


def table(rows):
    t = Table(rows)
    t.setStyle(GRID)
    return t


def bode():
    """TRC-OPA1 open-loop gain: 100 dB flat to 10 Hz, -20 dB/decade to 1 MHz, -40 dB/decade above 4 MHz."""
    d = Drawing(320, 170)
    d.add(Line(40, 20, 300, 20, strokeColor=colors.black))
    d.add(Line(40, 20, 40, 160, strokeColor=colors.black))
    pts = [40, 150, 79, 150, 196, 50, 220, 30, 240, 14]
    d.add(PolyLine(pts, strokeColor=colors.blue, strokeWidth=1.5))
    d.add(String(150, 4, "Frequency (Hz), 1 to 10M", fontSize=8))
    d.add(String(2, 150, "100 dB", fontSize=7))
    d.add(String(2, 48, "0 dB", fontSize=7))
    return d


def opa1(out):
    story = [
        Paragraph("TRC-OPA1 1 MHz Rail-to-Rail CMOS Operational Amplifier", S["Title"]),
        Paragraph(FICTION, S["Italic"]),
        Paragraph("1 Features", S["Heading2"]),
        Paragraph("Single supply 1.8 V to 5.5 V. Gain-bandwidth product 1.0 MHz. Slew rate 0.6 V/us. Supply current "
                  "100 uA. Rail-to-rail input and output. Unity-gain stable with 76 degrees of phase margin. "
                  "SOT-23-5 package.", S["Normal"]),
        Paragraph("2 Applications", S["Heading2"]),
        Paragraph("ADC drivers and buffers, sensor front ends, battery-powered instruments.", S["Normal"]),
        Paragraph("3 Pin Configuration", S["Heading2"]),
        table([["Pin", "Name", "Type", "Description"], ["1", "OUT", "O", "Output"], ["2", "V-", "P", "Negative supply"],
               ["3", "+IN", "I", "Non-inverting input"], ["4", "-IN", "I", "Inverting input"], ["5", "V+", "P", "Positive supply"]]),
        PageBreak(),
        Paragraph("6 Electrical Characteristics", S["Heading2"]),
        Paragraph("VS = 3.3 V, VCM = VS/2, RL = 1 Mohm to VS/2, TA = 25 C unless noted.", S["Normal"]),
        Spacer(1, 6),
        table([
            ["Parameter", "Symbol", "Conditions", "Min", "Typ", "Max", "Unit"],
            ["Supply voltage", "VS", "", "1.8", "", "5.5", "V"],
            ["Quiescent current", "IQ", "no load", "", "100", "140", "µA"],
            ["Open-loop voltage gain", "AOL", "RL = 1 Mohm", "90", "100", "", "dB"],
            ["Gain-bandwidth product", "GBW", "", "0.8", "1.0", "", "MHz"],
            ["Phase margin", "PM", "G = +1, CL = 10 pF", "", "76", "", "deg"],
            ["Slew rate", "SR", "G = +1", "0.45", "0.6", "", "V/µs"],
            ["Common-mode rejection ratio", "CMRR", "VCM = 0 to VS", "62", "70", "", "dB"],
            ["Power-supply rejection ratio", "PSRR", "VS = 1.8 to 5.5 V", "62", "70", "", "dB"],
            ["Input offset voltage", "VOS", "", "-4.5", "", "4.5", "mV"],
            ["Input voltage noise density", "en", "f = 1 kHz", "", "28", "", "nV/√Hz"],
            ["Output swing from rail", "VO", "RL = 1 Mohm", "", "25", "35", "mV"],
            ["Open-loop output resistance", "RO", "", "", "50", "", "Ω"],
        ]),
        Paragraph("7 Thermal Information", S["Heading2"]),
        table([["Parameter", "Symbol", "Conditions", "Min", "Typ", "Max", "Unit"],
               ["Junction-to-ambient thermal resistance", "θJA", "JEDEC 2s2p", "", "220", "", "°C/W"],
               ["Junction-to-case thermal resistance", "θJC", "", "", "110", "", "°C/W"],
               ["Maximum junction temperature", "TJ(max)", "", "", "", "150", "°C"]]),
        PageBreak(),
        Paragraph("Figure 4. Open-Loop Gain vs Frequency", S["Heading3"]),
        bode(),
        Paragraph("8 Application: ADC Buffer", S["Heading2"]),
        Paragraph("As a voltage follower driving a SAR ADC input, place a 100 nF bypass capacitor within 3 mm of V+. "
                  "The follower settles a 2 V step to 1 % in about 3.5 us.", S["Normal"]),
    ]
    SimpleDocTemplate(out, pagesize=A4, title="TRC-OPA1 (fictional)", author="trace sample").build(story)


def tmp1(out):
    story = [
        Paragraph("TRC-TMP1 Digital Temperature Sensor with I2C Interface", S["Title"]),
        Paragraph(FICTION, S["Italic"]),
        Paragraph("1 Description", S["Heading2"]),
        Paragraph("A +/-0.5 C temperature sensor with a 13-bit result (1/128 C per LSB in a 16-bit register, two's "
                  "complement, left-justified), on a 400 kHz I2C bus at address 0x48 to 0x4B. The temperature register "
                  "is register 0x00: write its address, then read two bytes, MSB first. 25.0 C reads 0x0C80.", S["Normal"]),
        table([["Pin", "Name", "Description"], ["1", "SDA", "I2C data"], ["2", "GND", "Ground"], ["3", "A0", "Address select"],
               ["4", "SCL", "I2C clock"], ["5", "VDD", "Supply, 1.8 to 3.6 V"]]),
        PageBreak(),
        Paragraph("7.5 I2C Timing Requirements", S["Heading2"]),
        Paragraph("VDD = 3.3 V, TA = -40 C to 85 C, fast mode.", S["Normal"]),
        Spacer(1, 6),
        table([
            ["Parameter", "Symbol", "Conditions", "Min", "Typ", "Max", "Unit"],
            ["SCL clock frequency", "fSCL", "", "", "", "400", "kHz"],
            ["Hold time (repeated) START condition", "tHD;STA", "", "0.6", "", "", "µs"],
            ["Low period of the SCL clock", "tLOW", "", "1.3", "", "", "µs"],
            ["High period of the SCL clock", "tHIGH", "", "0.6", "", "", "µs"],
            ["Set-up time for a repeated START condition", "tSU;STA", "", "0.6", "", "", "µs"],
            ["Data hold time", "tHD;DAT", "", "0", "", "0.9", "µs"],
            ["Data set-up time", "tSU;DAT", "", "100", "", "", "ns"],
            ["Set-up time for STOP condition", "tSU;STO", "", "0.6", "", "", "µs"],
            ["Bus free time between a STOP and START condition", "tBUF", "", "1.3", "", "", "µs"],
            ["Capacitive load for each bus line", "Cb", "", "", "", "400", "pF"],
        ]),
        Paragraph("7.6 Electrical Characteristics", S["Heading2"]),
        table([["Parameter", "Symbol", "Conditions", "Min", "Typ", "Max", "Unit"],
               ["Supply current", "IDD", "converting", "", "45", "75", "µA"],
               ["Temperature accuracy", "TERR", "0 to 70 C", "-0.5", "", "0.5", "°C"],
               ["Conversion time", "tCONV", "", "", "26", "35", "ms"]]),
    ]
    SimpleDocTemplate(out, pagesize=A4, title="TRC-TMP1 (fictional)", author="trace sample").build(story)


if __name__ == "__main__":
    opa1(os.path.join(HERE, "TRC-OPA1.pdf"))
    tmp1(os.path.join(HERE, "TRC-TMP1.pdf"))
    print("wrote", ", ".join(sorted(f for f in os.listdir(HERE) if f.endswith(".pdf"))), file=sys.stderr)
