"""Write emc/adc_in-line.s2p: the ADC_IN trace from U2's output to J2 pin 7 as a two-port, from a physical model.

The model is scikit-rf's microstrip line (media.MLine: Hammerstad-Jensen impedance and effective permittivity with
Kirschning-Jansen dispersion, conductor and dielectric loss) on the board's stackup: 0.25 mm wide, 35 um copper on
1.51 mm FR-4 (er 4.5, tan d 0.02, the .kicad_pcb's stackup), 38.9 mm long (kicad.net_length on /ADC_IN). Ports are
50 ohm, so the line's ~128 ohm shows as a mismatch in emc.si's TDR, which is the point of the exercise.

Run: python3 emc/make_s2p.py   (needs scikit-rf and numpy)
"""
import os

import skrf as rf
from skrf.media import MLine

HERE = os.path.dirname(os.path.abspath(__file__))

freq = rf.Frequency(10, 3000, 300, unit="MHz")
line = MLine(frequency=freq, z0_port=50, w=0.25e-3, h=1.51e-3, t=35e-6, ep_r=4.5, tand=0.02, rho=1.72e-8,
             model="hammerstadjensen", disp="kirschningjansen")
ntw = line.line(38.9e-3, unit="m", name="adc_in-line")
ntw.comments = ("trace-sample ADC_IN trace, U2.1 to J2.7: scikit-rf MLine, w 0.25 mm, t 35 um, h 1.51 mm FR-4 "
                "er 4.5 tand 0.02, length 38.9 mm, 50 ohm ports (emc/make_s2p.py)")
ntw.write_touchstone(os.path.join(HERE, "adc_in-line"), skrf_comment=False)
print("Z0 at 100 MHz: %.1f ohm" % abs(line.z0[freq.f.searchsorted(100e6)]))
