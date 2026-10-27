#!/bin/sh
# The same front end simulated straight from the schematic, with no hand-written netlist: sim.kicad_spice exports
# hardware/sensor-node.kicad_sch with kicad-cli, then applies overrides before running ngspice.
#
# What KiCad's export gives: R1-R4, C1 and C2 come out with their values (KiCad's Device library R and C carry
# simulation models). J1, J2, D1 and D2 come out as "__J1"-style placeholders: connectors have no model, and the
# Diode:BAT54S and Device:LED symbols carry none. So:
#   J1 -> V1, the sensor: 6 V DC (mid-scale) plus 1 V AC for the sweep
#   J2 -> V2, the MCU's 3.3 V rail (its ADC_IN and LED pins are inputs and outputs, not sources)
#   D1 -> XD1, the BAT54S subcircuit from sim/models/BAT54S.lib (included through electronics.models)
#   D2 and R4 (the status LED) are removed: they are not part of the analog path.
# Run from examples/sensor-node.
set -e
tracectl tool sim.kicad_spice schematic=hardware/sensor-node.kicad_sch --args '{
  "analyses": [".op", ".ac dec 50 1 1meg"],
  "replace": {
    "J1": "V1 /VIN 0 DC 6 AC 1",
    "J2": "V2 +3V3 0 DC 3.3",
    "D1": "XD1 GND +3V3 /ADC_IN BAT54S",
    "D2": null,
    "R4": null
  },
  "measurements": [
    {"name": "vadc", "kind": "value_at", "vector": "v(/adc_in)", "analysis": "op"},
    {"name": "f3db", "kind": "bandwidth", "vector": "v(/adc_in)"}
  ]
}'
