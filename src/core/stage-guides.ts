/**
 * What each stage is for, in words a person reads in the stage guide and the stage sheet (docs/guided-flow.md "Journey
 * view additions"): its purpose, what the person does, what trace does, what they get at the end and how long it
 * usually takes. The words follow docs/user-journey.md's "Stage by stage" and "After the first board", written for
 * the person rather than for the builder: no tool names, and every acronym explained where it appears.
 *
 * A template that does a stage differently gets its own words for the parts that differ (Prove for Firmware is builds
 * and unit tests, not circuit simulation); the rest falls back to the stage's own. `next` is not here: it depends on
 * the project's stages (src/core/journey.ts fills it in), so it is never wrong for a template that skips a stage.
 *
 * Every stage id has a guide, the later stages (Certify, Produce, Sustain) too, so a project that chooses them is
 * never shown an empty sheet. The test (test/core/stage-guides.test.ts) holds that, and the plain-words rule.
 */
import type { StageId, Template } from './journey.js'

export interface StageGuide {
  /** what the stage is for, starting with what to do ("Choose how …"): it reads after "to" in the stage before's `next` */
  purpose: string; you_do: string; trace_does: string; you_get: string; typical_time: string
  /** what comes after this stage, in one sentence; null for the last stage of the project */
  next: string | null
}

type GuideText = Omit<StageGuide, 'next'>

const GUIDES: Readonly<Record<StageId, GuideText>> = {
  define: {
    purpose: 'Agree what the product must do, as requirements that can each be measured.',
    you_do: 'Write the intent in plain words (what it does, where it lives, its power, interfaces, size, cost and quantity), then accept or strike each requirement trace proposes.',
    trace_does: 'The Verification specialist turns the intent into requirements, each with a measurable criterion and the line it came from, and asks about gaps: missing limits, numbers that conflict, wording that cannot be tested.',
    you_get: 'A requirements list you accepted, every requirement with a number and a unit to check it against.',
    typical_time: 'An hour or two of your time, spread over a day.',
  },
  architect: {
    purpose: 'Choose how the product is built: its blocks, its key parts, and which block serves each requirement.',
    you_do: 'Compare the options trace proposes and choose one, or sketch your own.',
    trace_does: 'The Implementation specialist proposes two or three block diagrams, sizes the key circuits, picks key parts that are in stock for the build quantity, pulls their datasheets, and scores each option.',
    you_get: 'An approved block diagram, a key parts list with price, stock and lifecycle, and every requirement mapped to a block.',
    typical_time: 'A day or two, most of it trace\'s work.',
  },
  capture: {
    purpose: 'Draw the schematic: every part and every connection, checked against the parts\' datasheets.',
    you_do: 'Finish and correct the sheets trace drafts in KiCad (the schematic editor), and agree the pin plan.',
    trace_does: 'The Implementation specialist draws one sheet per block with every part\'s fields filled, then checks each change: the electrical rule check (wiring mistakes such as an unconnected pin), every part against its datasheet limits, and stock for the build quantity.',
    you_get: 'A checked schematic and a parts list ready for layout.',
    typical_time: 'Two to five days.',
  },
  prove: {
    purpose: 'Show the design meets its requirements before any board is drawn.',
    you_do: 'Read the results, and waive what cannot be checked before there is a board, with a reason.',
    trace_does: 'The Verification specialist writes the test plan and runs it: circuit simulation across temperature and part tolerances, the stability and noise of the amplifiers, and checks of any logic.',
    you_get: 'A coverage matrix: each requirement verified, failing, untested or waived, linked to the run that shows it.',
    typical_time: 'One to three days, most of it trace\'s work.',
  },
  layout: {
    purpose: 'Place and route the board so it can be made, and so it fits its enclosure.',
    you_do: 'Set the outline, the layer stack and the fixed parts (connectors, mounting holes), adjust trace\'s placement, and approve the renders.',
    trace_does: 'trace proposes a placement, routes every connection, matches the lengths of signals that need it, runs the design rule check (spacing and widths the fab can make), checks the fit in the enclosure, and renders the board.',
    you_get: 'A routed board with clean checks, and renders you approved.',
    typical_time: 'Two to five days.',
  },
  signoff: {
    purpose: 'Decide the design is ready to be made. This is the last point where a change is cheap.',
    you_do: 'Read the release report, then approve it or send it back with what has to change.',
    trace_does: 'trace runs the radio interference prechecks, runs the whole test plan again on the final files, and checks the parts list\'s cost and stock for the build quantity.',
    you_get: 'One release report: coverage, interference estimates, parts cost and stock, and the waivers still open.',
    typical_time: 'About a day.',
  },
  release: {
    purpose: 'Freeze the approved design as a package that can be made.',
    you_do: 'Nothing beyond the approval you already gave.',
    trace_does: 'trace builds the fabrication and assembly files (copper layers, drill file, parts list, placement), freezes the parts list with today\'s prices, tags the release and stores it all together.',
    you_get: 'The release: its files, its revision, and the report that approved it.',
    typical_time: 'Minutes.',
  },
  fabricate: {
    purpose: 'Have the boards made, and get ready to test them while they are.',
    you_do: 'Sign the order, upload the package and pay on the fab\'s site, and record the order number. When the boards arrive, inspect them.',
    trace_does: 'trace prepares everything the fab needs, checks stock and prices again on the day, follows the order, and uses the wait to finish the bring-up plan, the test scripts and the bench setup.',
    you_get: 'Inspected boards on your bench, with the firmware and the bench ready for them.',
    typical_time: 'One to three weeks, mostly the fab\'s.',
  },
  bringup: {
    purpose: 'Prove the real board meets its requirements.',
    you_do: 'Put the board on the bench and wire the instruments the way the bench view shows.',
    trace_does: 'trace steps through the bring-up checklist with current-limited supplies, loads the firmware, runs the hardware tests, and records each result against its requirement. A failure becomes an issue for a specialist.',
    you_get: 'The coverage matrix with bench results: an accepted revision.',
    typical_time: 'A few days.',
  },
  certify: {
    purpose: 'Pass the regulatory tests (radio emissions, safety) at an accredited lab.',
    you_do: 'Book the lab, take the product and its test pack there, and record the results.',
    trace_does: 'trace builds the lab\'s test pack from the compliance requirements: the standards, the test setups, the firmware\'s test modes and trace\'s earlier estimates.',
    you_get: 'Lab results for every compliance requirement, or a change request for each that failed.',
    typical_time: 'Weeks, set by the lab\'s calendar.',
  },
  produce: {
    purpose: 'Make the product repeatable at volume.',
    you_do: 'Close the manufacture and test reviews, record the volume quote, and sign the production release.',
    trace_does: 'trace reviews the design for manufacture and for test, writes the factory\'s test and programming procedure, runs it on the golden board (the reference every unit is compared with), and gathers volume quotes.',
    you_get: 'A production release: the files, the test procedure and the programming image for volume.',
    typical_time: 'Two to four weeks.',
  },
  sustain: {
    purpose: 'Keep the product buildable for as long as it is made.',
    you_do: 'Decide on the change requests trace raises.',
    trace_does: 'trace checks every part\'s stock and lifecycle each week. A part running short or going out of production raises a change request with in-stock alternatives.',
    you_get: 'Warning before a part runs out, with an alternative ready.',
    typical_time: 'Every week, until the product is retired.',
  },
}

/** Where a template does a stage differently: only the parts that differ. */
const BY_TEMPLATE: Partial<Record<Template, Partial<Record<StageId, Partial<GuideText>>>>> = {
  firmware: {
    define: {
      you_do: 'Write the intent in plain words (what it does, where it runs, its power states, interfaces, timing and how it is updated), then accept or strike each requirement trace proposes.',
    },
    architect: {
      purpose: 'Choose how the firmware is built: its blocks, the microcontroller, and which block serves each requirement.',
      trace_does: 'The Implementation specialist proposes the toolchain, whether to use a real-time operating system or run without one, and a budget of the microcontroller\'s peripherals (timers, serial ports, converters) per block.',
      you_get: 'An approved block diagram, every requirement mapped to a block, and every interface given its own peripheral.',
    },
    prove: {
      purpose: 'Show the firmware builds, passes its tests and fits the chip, before it runs on hardware.',
      you_do: 'Read the results, and waive what cannot be tested before it runs on hardware, with a reason.',
      trace_does: 'trace builds the firmware, runs its unit tests on a computer (and simulates the microcontroller where a model exists), and measures its size against the chip\'s flash and memory.',
      you_get: 'A clean build, passing unit tests, a size report, and the coverage matrix.',
    },
    release: {
      trace_does: 'trace builds the firmware release, tags it with its version, and stores the image with the report that approved it.',
      you_get: 'The firmware release: its image, its version, and the report that approved it.',
    },
    bringup: {
      purpose: 'Prove the firmware meets its requirements on the real hardware.',
      you_do: 'Connect the hardware to the bench the way the bench view shows.',
      trace_does: 'trace loads the firmware, runs the hardware tests, and records each result against its requirement. A failure becomes an issue for a specialist.',
    },
  },
  fpga: {
    architect: {
      trace_does: 'The Implementation specialist proposes two or three block diagrams for the logic and the board, picks the FPGA (the programmable logic chip) and the other key parts in stock for the build quantity, pulls their datasheets, and scores each option.',
    },
    prove: {
      purpose: 'Show the logic builds for the chip, meets its timing and does what the requirements ask.',
      trace_does: 'trace builds the logic for the chip and checks its timing (that every signal arrives in time at the clock speed), and runs the logic\'s simulations and formal checks against the requirements.',
    },
    signoff: {
      trace_does: 'trace runs the whole test plan again on the final files, and checks the parts list\'s cost and stock for the build quantity.',
      you_get: 'One release report: coverage, parts cost and stock, and the waivers still open.',
    },
    release: {
      trace_does: 'trace builds the bitstream (the file that configures the FPGA) and the board\'s fabrication files, freezes the parts list with today\'s prices, tags the release and stores it all together.',
    },
  },
  mixed: {
    capture: {
      trace_does: 'The Implementation specialist draws one sheet per block with every part\'s fields filled, then checks each change: the electrical rule check (wiring mistakes such as an unconnected pin), every part against its datasheet limits, stock for the build quantity, and that no two functions claim the same pin.',
    },
    prove: {
      trace_does: 'trace writes the test plan and runs it: circuit simulation across temperature and part tolerances, the logic built for its chip and checked for timing, and the firmware built, unit-tested and measured against the chip\'s flash and memory.',
    },
  },
}

/** A stage's guide for a template, without `next` (journey.ts adds it from the project's own stages). */
export function stageGuideText(stage: StageId, template: Template): GuideText {
  return { ...GUIDES[stage], ...(BY_TEMPLATE[template]?.[stage] ?? {}) }
}
