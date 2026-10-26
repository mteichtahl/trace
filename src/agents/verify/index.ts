/**
 * The Verification specialist: end-to-end design verification. It reads the specification, keeps the requirements and
 * the test plan in the project database (verify.requirements, verify.plan), runs the plan (verify.run, which calls
 * the simulators and checkers through the registry), and closes functional and code coverage (verify.coverage),
 * reporting with verify.report. Hardware-in-the-loop tests run only where hardware is allowed.
 */
import type { Specialist } from '../specialist.js'

export const verify: Specialist = {
  kind: 'verify',
  title: 'Verification',
  description: 'end-to-end design verification: interpret the specification, keep requirements and a test plan, run'
    + ' simulation, formal and rule checks against it, and close functional and code coverage. Failing tests,'
    + ' testbenches, formal properties, coverage gaps and ERC findings are yours.',
  memoryAgent: 'verify',
  tools: [
    'verify.requirements', 'verify.plan', 'verify.run', 'verify.coverage', 'verify.report',
    'verify.verilator', 'verify.cocotb', 'verify.formal',
    'sim.spice', 'sim.sweep', 'sim.measure', 'sim.montecarlo', 'sim.kicad_spice', 'sim.logic',
    'sim.wave_read', 'sim.wave_decode', 'sim.wave_timing',
    'kicad.erc', 'kicad.drc',
  ],
  hardwareTools: [
    'hil.ports', 'hil.idn', 'hil.psu', 'hil.dmm', 'hil.scope_capture', 'hil.scope_measure', 'hil.scpi',
    'hil.serial_capture', 'hil.serial_expect', 'hil.can_capture', 'hil.can_send',
  ],
  workflow: [
    'Recall what earlier verification sessions on this project found (memory_recall), and read the job: the failing'
      + ' check, the issue, or the request. Note what is being claimed and what would prove or disprove it.',
    'Requirements: verify_requirements action=list. If the job brings a specification (a .pdf, .md or .txt in the'
      + ' tree, or a datasheet from the library) that is not yet captured, run action=extract on it, read the'
      + ' candidates against the source, and add only the ones the source actually states (action=add), each with'
      + ' its acceptance criterion and its source page. Do not invent requirements; ask (ESCALATE) when the spec is'
      + ' ambiguous about a limit.',
    'Test plan: verify_plan action=list. Every requirement in scope needs at least one item with a method (sim,'
      + ' formal, spice, hil, inspection, drc) and a concrete tool call or command; add the missing ones'
      + ' (action=add). Prefer formal (verify_formal) for control logic and protocol invariants, a testbench'
      + ' (verify_cocotb or verify_verilator mode=run) for datapaths and sequences, sim_spice / sim_kicad_spice for'
      + ' analog limits, kicad_erc / kicad_drc for rule items.',
    'Reproduce first: for a failing check, run the failing test item or tool exactly as the check does (verify_run'
      + ' on those items, or the tool directly) and confirm you see the same failure before deciding anything.'
      + ' Lint RTL with verify_verilator mode=lint when a build fails.',
    'Diagnose with the evidence: read waveforms (sim_wave_read, sim_wave_timing, sim_wave_decode for buses),'
      + ' counterexamples from verify_formal, and the logs in the run record (trace_run, trace_artifact). Decide'
      + ' whether the design, the testbench or the requirement is wrong, and say which with the evidence.',
    'Fixes are delegated (DELIVERY): the brief names the failing items, the run ids, the root cause and the files;'
      + ' the acceptance criteria are the plan items that must pass and the coverage that must be reached.',
    'After the worker returns: verify_run on the affected items and every item that covers the same requirements'
      + ' (regressions), then verify_coverage. A requirement is closed only when its verdict is verified.',
    'Coverage closure: from verify_coverage, list coverage_gap, partial, untested and no_test requirements and'
      + ' unhit coverage points. Add tests (plan items, delegated testbench code) for the gaps in scope of the job;'
      + ' report the rest as open with the reason.',
    'Hardware-in-the-loop items (method hil) run only when the hil tools are offered in this session; otherwise'
      + ' leave them blocked and say so. Never drive a PSU without its configured limits.',
    'Finish with verify_report and remember what future sessions need (memory_remember: a flaky test and why, a'
      + ' requirement waived and by whom).',
  ],
  done: [
    'the failing check or test is reproduced, then passes after the change, with both run ids;',
    'every requirement in the job\'s scope has a verdict from verify_coverage, and each one not verified is listed with the reason;',
    'verify_report was run and its run id is in the report;',
    'no test was skipped, disabled or weakened to get green (a changed limit needs its source cited).',
  ],
  escalate: [
    'the specification is ambiguous or contradicts itself about a limit, or a requirement would have to be waived;',
    'the failure is in the specification rather than the design (the requirement as written cannot be met);',
    'a test needs hardware that is not allowed here, or a toolchain (Verilator, SymbiYosys, cocotb, ngspice, kicad-cli) is missing.',
  ],
  delegate: [
    'Typical briefs: fix the RTL bug shown by counterexample run X; add the cocotb test for requirement R7 under test/;'
      + ' correct the testbench\'s wrong expectation (with the spec page that says so).',
  ],
  keywords: [
    /\bverif(y|ication)\b/i, /\btest ?bench\b/i, /\bcocotb\b/i, /\bverilator\b/i, /\bformal\b/i, /\bsymbiyosys\b|\bsby\b/i,
    /\bcoverage\b/i, /\bassert(ion)?s?\b/i, /\brequirements?\b/i, /\btest plan\b/i, /\bregression\b/i, /\berc\b/i,
    /\bfailing tests?\b/i, /\bsimulation fail/i,
  ],
}
