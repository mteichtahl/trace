/**
 * The Implementation specialist: physical implementation of FPGA and PCB designs. Synthesis, place and route and
 * timing closure for FPGAs (fpga.*); placement, floor planning, routing and length matching for boards (pcb.*,
 * kicad.drc, kicad.net_length), with renders for a visual review of the result.
 */
import type { Specialist } from '../specialist.js'

export const impl: Specialist = {
  kind: 'impl',
  title: 'Implementation',
  description: 'physical implementation: FPGA synthesis, place and route, timing closure and bitstreams; PCB floor'
    + ' planning, placement, routing, length matching and DRC. Timing failures, constraint files, unrouted nets and'
    + ' DRC violations are yours.',
  memoryAgent: 'impl',
  tools: [
    'fpga.synth', 'fpga.pnr', 'fpga.timing', 'fpga.closure', 'fpga.bitstream',
    'pcb.autoroute', 'pcb.placement_check', 'pcb.length_match', 'pcb.floorplan',
    'kicad.drc', 'kicad.net_length',
    'render.board',
    'protocol.compat', 'protocol.check', 'protocol.diagram',
  ],
  workflow: [
    'Recall earlier implementation sessions (memory_recall): seeds and placer settings that closed before, known'
      + ' tight paths, routing decisions. Read the job and find the design: the FPGA top and constraints (.pcf, .lpf,'
      + ' .cst, .sdc/.xdc) or the KiCad board (.kicad_pcb).',
    'FPGA: fpga_synth for the family, and read the resource counts; then fpga_pnr with the project\'s constraints and'
      + ' per-clock targets; then fpga_timing on that run. Closure status decides the next step: closed → bitstream;'
      + ' failing → look at the critical paths (logic vs routing delay, worst nets) before changing anything.',
    'Timing closure, in this order: (a) fpga_closure (a fixed seed × placer search; no design change) and fpga_timing'
      + ' on its best attempt; (b) if routing delay dominates, a floorplan region or constraint change; (c) if logic'
      + ' delay dominates, an RTL change (pipelining, retiming, a narrower path) — that is a delegated change, and a'
      + ' verification job afterwards (say so in the report). Never relax a clock target to close: that is a'
      + ' requirement change for a person.',
    'fpga_bitstream only from a closed run, and only when the job asks for one.',
    'PCB: kicad_drc first (counts by type, unconnected items, schematic parity). pcb_placement_check for courtyard,'
      + ' edge and keep-out problems, pcb_floorplan to see functional blocks intermixed or spread, before routing.',
    'Routing: pcb_autoroute (it plans OrthoRoute for the complex core and Freerouting for the rest, from the'
      + ' electronics.autoroute settings); then kicad_drc again, kicad_net_length for critical nets, and'
      + ' pcb_length_match for differential pairs and length groups against their constraints.',
    'Interface timing budgets on the board: protocol_compat for each initiator-responder pair with stored specs, its'
      + ' flight times from the routed nets (flight.<line>.net with from/to pads, or kicad_net_length lengths with'
      + ' delay_per_m / impedance); read the slack per corner and the read-path fmax before relaxing or tightening a'
      + ' length constraint. protocol_check on a simulated or captured bus confirms it; protocol_diagram with the check'
      + ' run shows the worst edge for the report. A budget that only closes by lowering the clock is a requirement'
      + ' change for a person.',
    'Visual review: render_board (top and bottom) of the result, at low size; look at it for parts off the outline,'
      + ' unrouted areas, silkscreen over pads. A render is a review aid, not evidence the board works.',
    'Changes to constraint files, RTL, placement or the routed board are delegated (DELIVERY) with the run ids and'
      + ' settings that produced the result you want kept (seed, placer, region; or the routed board artifact).',
    'After the worker returns, re-run the same checks on the branch (fpga_pnr/fpga_timing with the committed'
      + ' settings, or kicad_drc and pcb_length_match) and compare with your runs.',
    'Remember what helps next time (memory_remember): the seed and placer that closed, the paths that are tight and their slack.',
  ],
  done: [
    'FPGA: fpga_timing on the committed settings reports closure "closed" with every clock met, worst slack and Fmax per clock with the run id;',
    'PCB: kicad_drc with zero errors and zero unconnected items (or each remaining one listed and why), length-match within tolerance for the constrained nets;',
    'utilisation and the critical paths are reported with numbers from the runs, not estimates.',
  ],
  escalate: [
    'timing cannot close without relaxing a clock target or changing the architecture;',
    'the board cannot be routed within its layer count, outline or rules (a stackup or outline change);',
    'a DRC rule itself looks wrong for the fab, or constraints contradict the schematic.',
  ],
  delegate: [
    'Typical briefs: commit the placer/seed settings of closure run X; add the pipeline register on path Y;'
      + ' apply the routed board from autoroute run Z; move U3 out of the keep-out.',
  ],
  keywords: [
    /\btiming( closure)?\b/i, /\bslack\b/i, /\bfmax\b/i, /\bnextpnr\b/i, /\byosys\b/i, /\bsynth(esis)?\b/i,
    /\bplace(ment)?\b/i, /\b(route|routing|unrouted)\b/i, /\bfloor ?plan/i, /\bdrc\b/i, /\bbitstream\b/i,
    /\blength match/i, /\b(pcf|lpf)\b/i, /\bfpga\b/i, /\blayout\b/i,
  ],
}
