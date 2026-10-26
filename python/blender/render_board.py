"""Render a PCB exported by kicad-cli (GLB from `pcb export glb`, or VRML from `pcb export vrml --units m`).

    blender -b --factory-startup --python-exit-code 1 -P render_board.py -- job.json board.glb top.png iso.png ...

The exporter's own colours say what each surface is (KiCad writes the board body, copper, mask and silkscreen as
separate shapes with conventional colours); each is re-made as a clean physical surface: the solder mask in
`mask_color`, matte silkscreen, metallic pads, an FR4 edge. Component bodies keep their colours with sensible
roughness. Geometry is never changed: the renders show the board KiCad exports, nothing more.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

from mathutils import Euler  # noqa: E402
import bpy  # noqa: E402


def lum(c):
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def sat(c):
    mx, mn = max(c[:3]), min(c[:3])
    return (mx - mn) / (mx + 1e-6)


def surfaces(job):
    P = C.principled
    return {
        "mask": P("Solder mask", C.hex_rgba(job.get("mask_color", "#1f6b3a")), rough=0.38),
        "silk": P("Silkscreen", C.hex_rgba(job.get("silk_color", "#f2f2ec")), rough=0.85),
        "pad": P("ENIG pads", (1.0, 0.76, 0.42, 1), rough=0.22, metal=1.0),
        "tin": P("Tin", (0.80, 0.80, 0.78, 1), rough=0.28, metal=1.0),
        "fr4": P("FR4", C.hex_rgba("#a89c62"), rough=0.6),
        "black": P("Black plastic", C.hex_rgba("#141416"), rough=0.45),
    }


def orient(objs):
    """KiCad's exports are Y-up; Blender's importers convert, but make sure the board's thin axis is Z (top up)."""
    lo, hi = C.world_bbox(objs)
    size = hi - lo
    thin = min(range(3), key=lambda i: size[i])
    if thin == 2:
        return
    rot = Euler((1.5708, 0, 0)) if thin == 1 else Euler((0, -1.5708, 0))
    for o in objs:
        if o.parent is None or o.parent not in objs:
            o.rotation_euler.rotate(rot)
            o.location.rotate(rot)
    bpy.context.view_layer.update()


def dress(objs, S):
    """Re-make each material as the surface its colour and shape stand for. Returns counts per surface."""
    lo, hi = C.world_bbox(objs)
    bw, bh = hi.x - lo.x, hi.y - lo.y
    counts = {}
    made = {}
    for o in objs:
        olo, ohi = C.world_bbox([o])
        sx, sy, sz = ohi.x - olo.x, ohi.y - olo.y, ohi.z - olo.z
        flat = sz < 0.0002
        large = sx >= 0.8 * bw and sy >= 0.8 * bh
        for i, slot in enumerate(o.material_slots):
            col, metal = C.base_color(slot.material)
            key = None
            if col is not None:
                L, s = lum(col), sat(col)
                gold = col[0] > 0.45 and col[1] > 0.3 and col[2] < 0.35 and col[0] > col[2] * 1.6
                if large and not flat and 0.0003 < sz < 0.005:
                    key = "fr4"                                         # the board body
                elif flat and large and not gold and L < 0.5:
                    key = "mask"
                elif flat and L > 0.55 and s < 0.2:
                    key = "silk"
                elif gold:
                    key = "pad"
                elif flat and s < 0.2 and 0.15 < L <= 0.55:
                    key = "tin"
                elif col[1] > col[0] * 1.3 and col[1] >= col[2] and L < 0.3 and (flat or large):
                    key = "mask"                                        # KiCad's default mask green
                elif metal > 0.5 and s < 0.2:
                    key = "tin"
                elif L < 0.02:
                    key = "black"
            if key is None:                                             # a component body: keep its colour
                ck = ("keep", tuple(round(x, 3) for x in (col or (0.5, 0.5, 0.5, 1))[:3]))
                if ck not in made:
                    made[ck] = C.principled(f"part {ck[1]}", tuple(ck[1]) + (1.0,), rough=0.45)
                slot.material = made[ck]
                counts["part"] = counts.get("part", 0) + 1
            else:
                slot.material = S[key]
                counts[key] = counts.get(key, 0) + 1
    return counts


def main():
    job, rest = C.load_job()
    if not rest:
        raise C.JobError("no board model given")
    model, outs = rest[0], rest[1:]
    scene = C.empty_scene()
    sel = C.device_for(job)
    fmt = job.get("format") or os.path.splitext(model)[1].lstrip(".")
    C.log(f"import {os.path.basename(model)} ({fmt})")
    objs = C.import_model(model, fmt, job.get("up_axis", "Z"))
    C.normalise_units(objs, job.get("units"))
    orient(objs)
    counts = dress(objs, surfaces(job))
    res = C.shoot(scene, job, objs, outs, sel)
    res["surfaces"] = counts
    return res


if __name__ == "__main__":
    C.run_main(main)
