"""trace emc: build, run and post-process an openEMS FDTD model of a PCB region.

trace's emc.setup writes a self-contained model.py: this file, rf.py, and the MODEL description (generated from the
KiCad board: geometry, stackup, mesh lines, boundaries, ports, excitation). Every choice is made in TypeScript and is
in MODEL; this script only turns MODEL into CSXCAD/openEMS calls.

  python3 model.py build OUT_DIR      write the CSX geometry (model.xml) and stop
  python3 model.py run OUT_DIR        simulate (once per excited port) and post-process

The last line printed is `TRACE_RESULT {json}`. Outputs in OUT_DIR: model.xml, sparams.s<N>p (when every port was
excited), and nothing else (simulation folders are removed unless MODEL['keep'] is set).

Physics as modelled: copper is a conducting sheet (zero-thickness, with the copper's conductivity and thickness for
its surface loss), via barrels are solid PEC cylinders of the drill diameter, dielectrics are boxes with the
stackup's permittivity and a conductivity giving its loss tangent at MODEL['f_loss'] (a constant conductivity: the
loss tangent is exact at that frequency only). Solder mask and silkscreen are not modelled. Ports are openEMS lumped
ports (a resistor and a voltage source between the trace and its reference plane) or MSL ports.
"""
import json
import math
import os
import shutil
import sys
import time

RESULT = 'TRACE_RESULT '


def emit(obj):
    print(RESULT + json.dumps(obj), flush=True)


def build(M, sim_path, excite):
    from CSXCAD import ContinuousStructure
    from openEMS import openEMS
    from openEMS.physical_constants import EPS0

    fd = openEMS(NrTS=int(M['nr_ts']), EndCriteria=float(M['end_criteria']))
    fd.SetGaussExcite(float(M['f0']), float(M['fc']))
    fd.SetBoundaryCond(list(M['boundary']))
    csx = ContinuousStructure()
    fd.SetCSX(csx)
    grid = csx.GetGrid()
    grid.SetDeltaUnit(1e-3)
    for d in ('x', 'y', 'z'):
        grid.SetLines(d, M['mesh'][d])
    x0, y0, x1, y1 = M['board_box']
    for i, d in enumerate(M['dielectrics']):
        kappa = 2 * math.pi * float(M['f_loss']) * EPS0 * d['er'] * d['tand']
        m = csx.AddMaterial('dielectric_%d' % i, epsilon=d['er'], kappa=kappa)
        m.AddBox([x0, y0, d['z0']], [x1, y1, d['z1']], priority=0)
    for L in M['layers']:
        if not L['polygons']:
            continue
        sheet = csx.AddConductingSheet('cu_' + L['name'].replace('.', '_'), conductivity=float(M['sigma']), thickness=float(L['t_m']))
        for poly in L['polygons']:
            sheet.AddPolygon([poly[0], poly[1]], 'z', L['z'], priority=10)
    if M['vias']:
        pec = csx.AddMetal('via_barrels')
        for v in M['vias']:
            pec.AddCylinder([v[0], v[1], v[2]], [v[0], v[1], v[3]], v[4], priority=20)
    ports = []
    msl_metal = None
    for k, p in enumerate(M['ports']):
        ex = 1.0 if k == excite else 0
        if p['type'] == 'lumped':
            ports.append(fd.AddLumpedPort(k + 1, p['z0'], p['start'], p['stop'], 'z', excite=ex, priority=30))
        else:
            if msl_metal is None:
                msl_metal = csx.AddMetal('msl_ports')
            ports.append(fd.AddMSLPort(k + 1, msl_metal, p['start'], p['stop'], p['dir'], 'z', excite=-ex,
                                       FeedShift=p['feed_shift'], MeasPlaneShift=p['meas_shift'], Feed_R=p['z0'], priority=30))
    nf2ff = fd.CreateNF2FFBox() if M.get('nf2ff') else None
    return fd, csx, ports, nf2ff


def run(M, out_dir):
    import numpy as np
    f = np.array(M['freqs'], dtype=float)
    nports = len(M['ports'])
    excite_list = list(range(nports)) if M['excite'] == 'all' else [0]
    S = np.full((len(f), nports, nports), np.nan + 0j)
    speeds = []
    timesteps = []
    far = None
    t0 = time.time()
    for k in excite_list:
        sim_path = os.path.join(out_dir, 'sim_p%d' % (k + 1))
        fd, csx, ports, nf2ff = build(M, sim_path, k)
        if k == excite_list[0]:
            csx.Write2XML(os.path.join(out_dir, 'model.xml'))
        ts = time.time()
        fd.Run(sim_path, cleanup=True, verbose=1, numThreads=int(M.get('threads', 0)))
        speeds.append(time.time() - ts)
        for i, p in enumerate(ports):
            p.CalcPort(sim_path, f, ref_impedance=M['ports'][i]['z0'])
        inc = ports[k].uf_inc
        for i, p in enumerate(ports):
            S[:, i, k] = p.uf_ref / inc
        if nf2ff is not None and k == 0 and M.get('ff_freqs'):
            ff = np.array(M['ff_freqs'], dtype=float)
            theta = np.arange(0, 181, 5.0)
            phi = np.arange(0, 360, 5.0)
            res = nf2ff.CalcNF2FF(sim_path, ff, theta, phi, radius=float(M['ff_radius_m']), center=M['ff_center_m'])
            ports[0].CalcPort(sim_path, ff, ref_impedance=M['ports'][0]['z0'])
            pinc = np.abs(ports[0].P_inc)
            far = []
            for j, fr in enumerate(ff):
                emax = float(np.max(res.E_norm[j]))
                far.append({
                    'f': float(fr), 'dmax': float(np.real(res.Dmax[j])), 'prad_over_pinc': float(np.real(res.Prad[j]) / pinc[j]) if pinc[j] > 0 else None,
                    'e_peak_per_sqrt_w_inc': emax / math.sqrt(pinc[j]) if pinc[j] > 0 else None, 'radius_m': float(M['ff_radius_m']),
                })
        if not M.get('keep'):
            shutil.rmtree(sim_path, ignore_errors=True)
    out = {'ok': True, 'excited': [k + 1 for k in excite_list], 'seconds': time.time() - t0, 'run_seconds': speeds}
    out['freqs'] = f.tolist()
    cols = {}
    for k in excite_list:
        for i in range(nports):
            cols['S%d%d' % (i + 1, k + 1)] = {'re': S[:, i, k].real.tolist(), 'im': S[:, i, k].imag.tolist()}
    out['s'] = cols
    if M['excite'] == 'all':
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        fn = os.path.join(out_dir, 'sparams.s%dp' % nports)
        write_touchstone(fn, f, S, M['ports'][0]['z0'], comment='trace emc.run (openEMS FDTD)\n' + M.get('title', ''))
        out['touchstone'] = os.path.basename(fn)
    tdr_out = []
    for k in excite_list:
        try:
            r = tdr(f, S[:, k, k], M['ports'][k]['z0'], M.get('er_eff'))
            tdr_out.append({'port': k + 1, **r})
        except Exception as e:  # noqa: BLE001 - reported, not fatal
            tdr_out.append({'port': k + 1, 'error': str(e)})
    out['tdr'] = tdr_out
    if far is not None:
        out['far_field'] = far
    return out


def main(M, argv):
    if len(argv) < 3 or argv[1] not in ('build', 'run'):
        emit({'ok': False, 'error': 'usage: model.py build|run OUT_DIR'})
        return 2
    out_dir = argv[2]
    os.makedirs(out_dir, exist_ok=True)
    try:
        if argv[1] == 'build':
            fd, csx, ports, nf2ff = build(M, os.path.join(out_dir, 'sim'), 0)
            csx.Write2XML(os.path.join(out_dir, 'model.xml'))
            emit({'ok': True, 'built': True, 'ports': len(ports)})
            return 0
        emit(run(M, out_dir))
        return 0
    except ImportError as e:
        emit({'ok': False, 'error': 'openEMS/CSXCAD Python modules not importable: %s' % e})
        return 3
    except Exception as e:  # noqa: BLE001
        emit({'ok': False, 'error': '%s: %s' % (type(e).__name__, e)})
        return 1
