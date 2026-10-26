"""Render any model file (GLB/glTF, VRML/X3D, STL, OBJ, PLY, FBX): an enclosure, an assembly, a part.

    blender -b --factory-startup --python-exit-code 1 -P render_model.py -- job.json result.json model.stl front.png iso.png ...

materials: 'auto' keeps the model's own materials and gives a clay surface to anything without one; 'clay' puts one
clay surface (clay_color) on everything; 'keep' changes nothing. STEP is not imported here (Blender has no STEP
importer): the TypeScript side tessellates it with kicad-cli first.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402


# kicad-cli's VRML of a STEP placed on an empty board carries a small stand-in board in KiCad's default body and mask
# colours (exactly these values); the STEP's own surfaces come from its file and do not match them.
KICAD_BOARD_COLOURS = ((0.43, 0.45, 0.30), (0.078, 0.2, 0.141))


def drop_kicad_board(objs):
    keep = []
    for o in objs:
        cols = [C.base_color(s.material)[0] for s in o.material_slots]
        if cols and all(c is not None and any(all(abs(c[i] - k[i]) < 0.006 for i in range(3)) for k in KICAD_BOARD_COLOURS) for c in cols):
            C.bpy.data.objects.remove(o, do_unlink=True)
        else:
            keep.append(o)
    if not keep:
        raise C.JobError("the model has no geometry besides KiCad's stand-in board")
    return keep


def main():
    job, rest = C.load_job()
    if not rest:
        raise C.JobError("no model given")
    model, outs = rest[0], rest[1:]
    scene = C.empty_scene()
    sel = C.device_for(job)
    fmt = job.get("format") or os.path.splitext(model)[1].lstrip(".")
    C.log(f"import {os.path.basename(model)} ({fmt})")
    objs = C.import_model(model, fmt, job.get("up_axis"))
    if job.get("drop_kicad_board"):
        objs = drop_kicad_board(objs)
    C.normalise_units(objs, job.get("units"))
    mode = job.get("materials", "auto")
    clay = C.principled("Clay", C.hex_rgba(job.get("clay_color", "#c9ccd1")), rough=0.55)
    painted = 0
    for o in objs:
        if mode == "clay" or (mode == "auto" and not any(s.material for s in o.material_slots)):
            C.set_all_materials([o], clay)
            painted += 1
    res = C.shoot(scene, job, objs, outs, sel, plan_views_ortho=job.get("ortho_plan", False))
    res["clay_objects"] = painted
    return res


if __name__ == "__main__":
    C.run_main(main)
