"""Run OrthoRoute's headless router on a .ORP written by trace (src/tools/pcb/orp.ts) and write the .ORS.

OrthoRoute's own `main.py headless` uses its built-in geometry defaults and lets every layer pair carry a via. This
shim runs that same entry point, but first hands the router the board's rules from the .ORP (track width, clearance,
via size and drill). --blind-buried is recorded in the report only: the via policy is applied by trace on import. A JSON report goes to
--report. Run it with the Python that has OrthoRoute's dependencies (numpy, scipy, psutil; cupy for the GPU).

  python route.py --orthoroute /opt/orthoroute --orp core.ORP --ors core.ORS --report report.json \
      [--max-iterations 200] [--cpu-only] [--blind-buried]
"""
import argparse
import gzip
import json
import os
import sys
import time

p = argparse.ArgumentParser()
p.add_argument('--orthoroute', default=os.environ.get('TRACE_ORTHOROUTE', '/opt/orthoroute'))
p.add_argument('--orp', required=True)
p.add_argument('--ors', required=True)
p.add_argument('--report', required=True)
p.add_argument('--max-iterations', type=int, default=200)
p.add_argument('--cpu-only', action='store_true')
p.add_argument('--blind-buried', action='store_true')
a = p.parse_args()

report = {'ok': False, 'stage': 'start'}


def write_report(**kw):
    report.update(kw)
    with open(a.report, 'w') as f:
        json.dump(report, f)


root = os.path.abspath(a.orthoroute)
if not os.path.exists(os.path.join(root, 'main.py')):
    write_report(error='OrthoRoute is not installed at %s (set TRACE_ORTHOROUTE)' % root)
    sys.exit(3)
sys.path.insert(0, root)

with gzip.open(a.orp, 'rt', encoding='utf-8') as f:
    orp = json.load(f)
rules = orp.get('drc_rules', {}).get('default', {})
layer_count = int(orp.get('board', {}).get('layer_count', 2))
design_rules = {
    'default_track_width': rules.get('track_width', 0.2),
    'default_clearance': rules.get('clearance', 0.2),
    'default_via_diameter': rules.get('via_diameter', 0.6),
    'default_via_drill': rules.get('via_drill', 0.3),
}
for k_orp, k_or in (('min_hole_to_hole', 'min_hole_to_hole'), ('hole_clearance', 'min_hole_clearance')):
    if k_orp in rules:
        design_rules[k_or] = rules[k_orp]

gpu = None
if not a.cpu_only:
    try:
        import cupy  # noqa: F401
        gpu = cupy.cuda.runtime.getDeviceProperties(0)['name'].decode()
    except Exception as e:  # no CUDA here: fail instead of silently routing on the CPU
        write_report(error='no usable CUDA GPU for OrthoRoute (%s); pass --cpu-only to route on the CPU' % str(e)[:300])
        sys.exit(3)

from orthoroute.algorithms.manhattan import unified_pathfinder as up  # noqa: E402

original = up.UnifiedPathFinder.initialize_graph


def initialize_graph(self, board):
    # The lattice needs its layer-pair vias: restricted to whole-stack spans it routes nothing (tried with 1.0.0).
    # So the router keeps them, and trace turns them into through vias on the way back in unless blind/buried vias
    # are allowed (src/tools/pcb/ors.ts), vetting every converted via against the other nets' copper.
    board._design_rules = dict(design_rules)
    # 1.0.0's headless mode sets max_routing_iterations, which the router does not read; it reads max_iterations
    self.config.max_iterations = a.max_iterations
    return original(self, board)


up.UnifiedPathFinder.initialize_graph = initialize_graph

import main as ormain  # noqa: E402  (OrthoRoute's main.py)

report.update(stage='route', layer_count=layer_count, design_rules=design_rules, blind_buried_allowed=a.blind_buried,
              gpu=gpu, cpu_only=a.cpu_only or gpu is None)
write_report()
t0 = time.time()
code = 0
try:
    ormain.run_headless(a.orp, a.ors, max_iterations=a.max_iterations, use_gpu=gpu is not None, cpu_only=gpu is None)
except SystemExit as e:
    code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
report['seconds'] = round(time.time() - t0, 2)
report['exit'] = code
if code != 0 or not os.path.exists(a.ors):
    write_report(error='OrthoRoute failed (exit %s); see its log above' % code)
    sys.exit(3)
with gzip.open(a.ors, 'rt', encoding='utf-8') as f:
    ors = json.load(f)
write_report(ok=True, stage='done', statistics=ors.get('statistics', {}), metadata=ors.get('metadata', {}))
