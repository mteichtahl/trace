"""What this Blender can do, for render.status: version, engines, every Cycles compute device per backend, whether
the glTF importer works (it needs numpy), denoisers, and whether EEVEE renders headless (a tiny test frame).

    blender -b --factory-startup --python-exit-code 1 -P probe.py -- [eevee] [eevee.png]
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

import bpy  # noqa: E402


def eevee_check(path):
    """Render an 8x8 EEVEE frame: in background mode Blender needs an offscreen (EGL) GPU context for it."""
    ids = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    engine = next((i for i in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE") if i in ids), None)
    if engine is None:
        return {"engine": None, "renders_headless": False, "error": "no EEVEE engine"}
    t = time.time()
    try:
        sc = C.empty_scene()
        sc.render.engine = engine
        sc.eevee.taa_render_samples = 1
        sc.render.resolution_x = sc.render.resolution_y = 8
        sc.render.filepath = path
        C.make_camera(sc)
        bpy.ops.render.render(write_still=True)
        ok = os.path.exists(path)
        return {"engine": engine, "renders_headless": ok, "seconds": round(time.time() - t, 2), "error": None if ok else "no image written"}
    except Exception as e:  # noqa: BLE001
        return {"engine": engine, "renders_headless": False, "seconds": round(time.time() - t, 2), "error": str(e)}


def denoisers():
    try:
        import _cycles
        out = []
        if getattr(_cycles, "with_openimagedenoise", False):
            out.append("OPENIMAGEDENOISE")
        return out
    except ImportError:
        return []


def main():
    a = C.script_args()
    types, devices = C.list_devices()
    ids = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    res = {
        "blender": bpy.app.version_string,
        "engines": ids,
        "compute_types": types,
        "devices": devices,
        "gltf_import": C.gltf_importer_works(),
        "denoisers": denoisers() + (["OPTIX"] if any(d["type"] == "OPTIX" for d in devices) else []),
        "python": sys.version.split()[0],
    }
    if a and a[0] == "eevee":
        res["eevee"] = eevee_check(a[1] if len(a) > 1 else os.path.join(bpy.app.tempdir or "/tmp", "trace-eevee.png"))
    return res


if __name__ == "__main__":
    C.run_main(main)
