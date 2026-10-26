"""Shared helpers for the bpy scripts trace runs inside Blender (render_board.py, render_model.py, probe.py).

These run on Blender's own Python with nothing but bpy and the standard library: no numpy, no pip packages. They are
driven from TypeScript (src/render/), which writes a JSON job, runs

    blender -b --factory-startup --python-exit-code 1 -P <script> -- <job.json> <model> <out1.png> <out2.png> ...

and reads back the one line starting with `TRACE_RESULT ` that the script prints last. Nothing here edits a model
file: imports happen into an empty scene and only PNGs are written, to the paths given on the command line.
"""
import json
import math
import os
import sys
import time
import traceback
from array import array

import bpy
from mathutils import Vector

T0 = time.time()
GPU_ORDER = ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL")


def log(msg):
    print(f"[trace {time.time() - T0:6.1f}s] {msg}", flush=True)


def script_args():
    """Everything after `--` on Blender's command line: <job.json> <result.json> [more...]. The result is also written
    to result.json (a copy of the TRACE_RESULT line), so a job always has one output file."""
    global RESULT_FILE
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(a) >= 2:
        RESULT_FILE = a[1]
    return a


RESULT_FILE = None


def emit(obj):
    line = json.dumps(obj, separators=(",", ":"))
    if RESULT_FILE:
        try:
            with open(RESULT_FILE, "w", encoding="utf-8") as f:
                f.write(line)
        except OSError as e:
            log(f"cannot write {RESULT_FILE}: {e}")
    print("TRACE_RESULT " + line, flush=True)


def run_main(fn):
    """Run fn() and print its result; any exception becomes {ok: false, error} and a non-zero exit."""
    try:
        res = fn()
    except Exception as e:  # noqa: BLE001 - every failure is reported on the result line
        traceback.print_exc()
        emit({"ok": False, "error": f"{type(e).__name__}: {e}"})
        sys.stdout.flush()
        os._exit(2)
    res = dict(res)
    res["ok"] = True
    res["seconds"] = round(time.time() - T0, 2)
    emit(res)


class JobError(Exception):
    pass


# ---------------------------------------------------------------------------------------------------- devices

def cycles_prefs():
    return bpy.context.preferences.addons["cycles"].preferences


def list_devices():
    """Every Cycles compute device, per compute type this build supports: [{type, name, id, gpu}], plus the types."""
    p = cycles_prefs()
    types, out, seen = [], [], set()
    for t in GPU_ORDER:
        try:
            p.compute_device_type = t
        except (TypeError, ValueError):
            continue                                   # this Blender build has no such backend
        types.append(t)
        try:
            p.refresh_devices()
            devs = p.get_devices_for_type(t)
        except Exception as e:  # noqa: BLE001
            log(f"{t}: {e}")
            continue
        for d in devs:
            key = (d.type, d.id)
            if key in seen:
                continue
            seen.add(key)
            out.append({"type": d.type, "name": d.name, "id": d.id, "gpu": d.type != "CPU"})
    try:
        p.compute_device_type = "NONE"
        p.refresh_devices()
        for d in p.devices:
            if (d.type, d.id) not in seen:
                seen.add((d.type, d.id))
                out.append({"type": d.type, "name": d.name, "id": d.id, "gpu": d.type != "CPU"})
    except Exception as e:  # noqa: BLE001
        log(f"CPU devices: {e}")
    return types, out


def select_device(want, devices):
    """'auto' | 'gpu' | 'cpu' -> {type, names}. The same rule as src/render/device.ts selectDevice()."""
    if want not in ("auto", "gpu", "cpu"):
        raise JobError(f"device must be auto, gpu or cpu, not {want!r}")
    cpus = [d for d in devices if d["type"] == "CPU"]
    if want != "cpu":
        for t in GPU_ORDER:
            g = [d for d in devices if d["type"] == t and d["gpu"]]
            if g:
                return {"type": t, "gpu": True, "names": [d["name"] for d in g], "ids": [d["id"] for d in g]}
        if want == "gpu":
            raise JobError("device=gpu was asked for, but Blender finds no GPU (OPTIX, CUDA, HIP, ONEAPI or METAL) here")
    return {"type": "CPU", "gpu": False, "names": [d["name"] for d in cpus] or ["CPU"], "ids": [d["id"] for d in cpus]}


def apply_device(scene, sel):
    """Point Cycles at the selected device: only those devices enabled."""
    p = cycles_prefs()
    if not sel["gpu"]:
        try:
            p.compute_device_type = "NONE"
        except (TypeError, ValueError):
            pass
        scene.cycles.device = "CPU"
        return
    p.compute_device_type = sel["type"]
    p.refresh_devices()
    for d in p.devices:
        d.use = d.type == sel["type"] and d.id in sel["ids"]
    scene.cycles.device = "GPU"


# ---------------------------------------------------------------------------------------------------- scene

def empty_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


def gltf_importer_works():
    """Blender's glTF importer needs numpy; distro builds that use the system Python may not have it."""
    try:
        import numpy  # noqa: F401
        return True
    except ImportError:
        return False


def import_model(path, fmt, up_axis=None):
    """Import a model file into the scene; returns the new mesh objects with transforms applied."""
    before = set(bpy.data.objects)
    fmt = fmt.lower()
    if fmt in ("glb", "gltf"):
        if not gltf_importer_works():
            raise JobError("this Blender's glTF importer needs numpy, which its Python does not have; use VRML/STL/OBJ")
        bpy.ops.import_scene.gltf(filepath=path)
    elif fmt in ("wrl", "vrml", "x3d"):
        # VRML is Y-up by its standard; kicad-cli writes it Z-up (the board's normal is +Z)
        if up_axis == "Z":
            bpy.ops.import_scene.x3d(filepath=path, axis_forward="Y", axis_up="Z")
        else:
            bpy.ops.import_scene.x3d(filepath=path)
    elif fmt == "stl":
        if hasattr(bpy.ops.wm, "stl_import"):
            bpy.ops.wm.stl_import(filepath=path)
        else:
            bpy.ops.import_mesh.stl(filepath=path)
    elif fmt == "obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif fmt == "ply":
        bpy.ops.wm.ply_import(filepath=path)
    elif fmt == "fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    else:
        raise JobError(f"no importer for .{fmt}")
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    if not meshes:
        raise JobError(f"{os.path.basename(path)} holds no mesh geometry")
    return meshes


def world_bbox(objs):
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector((min(lo.x, w.x), min(lo.y, w.y), min(lo.z, w.z)))
            hi = Vector((max(hi.x, w.x), max(hi.y, w.y), max(hi.z, w.z)))
    return lo, hi


def corners(lo, hi):
    return [Vector((x, y, z)) for x in (lo.x, hi.x) for y in (lo.y, hi.y) for z in (lo.z, hi.z)]


def normalise_units(objs, unit_hint=None):
    """Scale so the scene is in metres. STL/OBJ carry no units; a model whose largest side is over 5 'm' is taken to
    be in millimetres (every board and enclosure trace renders)."""
    lo, hi = world_bbox(objs)
    size = max(hi - lo)
    scale = 1.0
    if unit_hint == "mm" or (unit_hint is None and size > 5.0):
        scale = 0.001
    if scale != 1.0:
        for o in objs:
            if o.parent is None or o.parent not in objs:
                o.scale = o.scale * scale
                o.location = o.location * scale
        bpy.context.view_layer.update()
    return scale


# ---------------------------------------------------------------------------------------------------- colour

def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgba(h, alpha=1.0):
    h = h.lstrip("#")
    if len(h) != 6:
        raise JobError(f"colour {h!r} is not #rrggbb")
    return tuple(srgb_to_linear(int(h[i:i + 2], 16) / 255.0) for i in (0, 2, 4)) + (alpha,)


def principled(name, color, rough=0.5, metal=0.0, coat=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = color
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    for k in ("Coat Weight", "Clearcoat"):
        if k in b.inputs and coat:
            b.inputs[k].default_value = coat
    m.diffuse_color = color
    return m


def base_color(mat):
    """A material's base colour (linear RGBA) and metallic value, from its Principled BSDF or its viewport colour."""
    if mat is None:
        return None, 0.0
    if mat.use_nodes and mat.node_tree:
        b = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if b is not None:
            return tuple(b.inputs["Base Color"].default_value), float(b.inputs["Metallic"].default_value)
    return tuple(mat.diffuse_color), float(getattr(mat, "metallic", 0.0))


def set_all_materials(objs, mat):
    for o in objs:
        o.data.materials.clear()
        o.data.materials.append(mat)


# ---------------------------------------------------------------------------------------------------- light & world

def world(scene, background, env_strength=0.35):
    """Neutral environment light; the camera sees `background` (transparent, light, dark or #rrggbb)."""
    wd = bpy.data.worlds.new("trace world")
    scene.world = wd
    wd.use_nodes = True
    nt = wd.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    env = nt.nodes.new("ShaderNodeBackground")
    env.inputs["Color"].default_value = (0.8, 0.8, 0.82, 1)
    env.inputs["Strength"].default_value = env_strength
    scene.render.film_transparent = background == "transparent"
    if background == "transparent":
        nt.links.new(env.outputs[0], out.inputs["Surface"])
        return
    col = {"light": hex_rgba("#eef0f2"), "dark": hex_rgba("#1b1d21")}.get(background) or hex_rgba(background)
    cam_bg = nt.nodes.new("ShaderNodeBackground")
    cam_bg.inputs["Color"].default_value = col
    cam_bg.inputs["Strength"].default_value = 1.0
    lp = nt.nodes.new("ShaderNodeLightPath")
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs["Fac"])
    nt.links.new(env.outputs[0], mix.inputs[1])
    nt.links.new(cam_bg.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])


def _aim(ob, target):
    d = (Vector(target) - ob.location).normalized()
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


# light name -> (weights of the camera's direction-to-camera, up, right), size and irradiance (scaled by radius)
RIG = (
    ("key", (1.0, 0.9, -0.8), 2.4, 9.0, (1.0, 0.97, 0.94)),
    ("fill", (1.0, 0.15, 1.0), 3.0, 3.0, (0.90, 0.94, 1.0)),
    ("rim", (-0.7, 0.8, 0.7), 1.6, 4.0, (1.0, 0.95, 0.88)),
    ("top", (0.3, 1.6, 0.1), 3.5, 2.0, (1.0, 1.0, 1.0)),
)


def studio(scene, center, radius, direction, up):
    """Key, fill, rim and top area lights placed relative to the camera (so a bottom view is lit like a top view),
    sized to the subject (radius = half its bounding-box diagonal, metres). Power scales with distance squared so a
    20 mm part and a 400 mm enclosure are lit alike. Replaces any lights from an earlier shot."""
    for ob in [o for o in scene.objects if o.type == "LIGHT"]:
        bpy.data.objects.remove(ob, do_unlink=True)
    r, u, f = basis(direction, up)
    d = -f
    for name, (a, b, c), size, irr, colour in RIG:
        dist = 4.5 * radius
        v = (d * a + u * b + r * c).normalized()
        lt = bpy.data.lights.new(name, "AREA")
        lt.shape = "RECTANGLE"
        lt.size = size * radius
        lt.size_y = size * radius * 0.7
        lt.energy = irr * dist * dist
        lt.color = colour
        ob = bpy.data.objects.new(name, lt)
        scene.collection.objects.link(ob)
        ob.location = Vector(center) + v * dist
        _aim(ob, center)


# ---------------------------------------------------------------------------------------------------- cameras

# view name -> (direction from the subject to the camera, camera up), Z up, -Y is the front
VIEWS = {
    "top": (Vector((0, 0, 1)), Vector((0, 1, 0))),
    "bottom": (Vector((0, 0, -1)), Vector((0, 1, 0))),
    "front": (Vector((0, -1, 0)), Vector((0, 0, 1))),
    "back": (Vector((0, 1, 0)), Vector((0, 0, 1))),
    "left": (Vector((-1, 0, 0)), Vector((0, 0, 1))),
    "right": (Vector((1, 0, 0)), Vector((0, 0, 1))),
}


def orbit_dir(az_deg, el_deg):
    a, e = math.radians(az_deg), math.radians(el_deg)
    return Vector((math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)))


def view_dir(name):
    if name in VIEWS:
        return VIEWS[name]
    if name == "iso":            # front-left, 30 degrees up
        return orbit_dir(-135.0, 30.0), Vector((0, 0, 1))
    raise JobError(f"unknown view {name!r}")


def basis(direction, up):
    f = (-direction).normalized()                        # camera looks along f
    r = f.cross(up)
    if r.length < 1e-6:
        r = f.cross(Vector((0, 1, 0)) if abs(f.y) < 0.9 else Vector((1, 0, 0)))
    r.normalize()
    u = r.cross(f).normalized()
    return r, u, f


def make_camera(scene):
    cd = bpy.data.cameras.new("trace camera")
    cd.sensor_fit = "HORIZONTAL"
    cd.sensor_width = 36.0
    ob = bpy.data.objects.new("trace camera", cd)
    scene.collection.objects.link(ob)
    scene.camera = ob
    return ob


def place_camera(cam, scene, pts, direction, up, ortho, margin=0.06, lens=50.0):
    """Frame the points (the subject's bbox corners) from `direction`: orthographic for plan views, else a perspective
    lens with the distance solved so every point is inside the frame."""
    w, h = scene.render.resolution_x, scene.render.resolution_y
    center = sum(pts, Vector()) / len(pts)
    r, u, f = basis(direction, up)
    rel = [p - center for p in pts]
    xs = [p.dot(r) for p in rel]
    ys = [p.dot(u) for p in rel]
    zs = [p.dot(f) for p in rel]
    cd = cam.data
    span = max(max(map(abs, zs)), 1e-6)
    if ortho:
        cd.type = "ORTHO"
        need_x = 2 * max(map(abs, xs))
        need_y = 2 * max(map(abs, ys)) * w / h
        cd.ortho_scale = max(need_x, need_y, 1e-6) * (1 + 2 * margin)
        dist = span * 4 + max(need_x, need_y)
    else:
        cd.type = "PERSP"
        cd.lens = lens
        tx = (cd.sensor_width / 2) / lens * (1 - 2 * margin)
        ty = tx * h / w
        dist = max(max(abs(x) / tx - z for x, z in zip(xs, zs)), max(abs(y) / ty - z for y, z in zip(ys, zs)))
        dist = max(dist, span * 1.5)
    cd.clip_start = max(dist / 1000.0, 1e-5)
    cd.clip_end = dist * 10 + span * 10
    cam.location = center - f * dist
    m = cam.matrix_world.copy()
    rot = m.to_3x3()
    rot.col[0], rot.col[1], rot.col[2] = r, u, -f
    cam.rotation_euler = rot.to_euler()
    bpy.context.view_layer.update()
    return dist


# ---------------------------------------------------------------------------------------------------- render

def configure(scene, job, sel):
    """Engine, samples, resolution and colour management from the job; returns what was actually used."""
    tier = job["defaults"]["gpu" if sel["gpu"] else "cpu"]
    width = job.get("width") or tier["width"]
    height = job.get("height") or tier["height"]
    samples = job.get("samples") or tier["samples"]
    engine = job.get("engine", "cycles")
    notes = []
    sc = scene
    sc.render.resolution_x, sc.render.resolution_y = int(width), int(height)
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA" if job.get("background") == "transparent" else "RGB"
    sc.render.image_settings.color_depth = "8"
    sc.render.image_settings.compression = 40
    denoised = False
    if engine == "eevee":
        ids = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
        eevee = next((i for i in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE") if i in ids), None)
        if eevee is None:
            raise JobError("EEVEE is not available in this Blender")
        sc.render.engine = eevee
        sc.eevee.taa_render_samples = int(samples)
        sel = {"type": "OPENGL", "gpu": True, "names": ["EEVEE (OpenGL)"], "ids": []}
    else:
        sc.render.engine = "CYCLES"
        apply_device(sc, sel)
        sc.cycles.samples = int(samples)
        sc.cycles.use_adaptive_sampling = True
        sc.cycles.adaptive_threshold = 0.02
        sc.cycles.max_bounces = 8
        sc.cycles.glossy_bounces = 4
        sc.cycles.transparent_max_bounces = 8
        sc.cycles.sample_clamp_indirect = 10.0
        sc.cycles.blur_glossy = 0.5
        if job.get("denoise", True):
            for dn in (("OPTIX",) if sel["type"] == "OPTIX" else ()) + ("OPENIMAGEDENOISE",):
                try:
                    sc.cycles.denoiser = dn
                    sc.cycles.use_denoising = True
                    denoised = dn
                    break
                except (TypeError, ValueError):
                    continue
            if not denoised:
                sc.cycles.use_denoising = False
                notes.append("this Blender build has no denoiser (OpenImageDenoise/OptiX); raise samples for less noise")
        else:
            sc.cycles.use_denoising = False
    try:
        sc.view_settings.view_transform = "Standard"
        sc.view_settings.look = "None"
    except (TypeError, ValueError):
        pass
    sc.view_settings.exposure = float(job.get("exposure", 0.0))
    return {"width": int(width), "height": int(height), "samples": int(samples), "engine": sc.render.engine,
            "denoiser": denoised or None, "device": {"type": sel["type"], "gpu": sel["gpu"], "names": sel["names"]}}, notes


def image_stats(path):
    """Mean and standard deviation of luminance (0..1, alpha-weighted) and the share of pixels with any coverage,
    sampled on a grid of at most ~250k pixels: enough to tell a blank frame from a picture."""
    img = bpy.data.images.load(path, check_existing=False)
    try:
        w, h = img.size
        n = w * h
        px = array("f", [0.0]) * (n * 4)
        img.pixels.foreach_get(px)
        step = max(1, int(math.sqrt(n / 250_000)))
        s = s2 = cov = cnt = 0.0
        for y in range(0, h, step):
            row = y * w
            for x in range(0, w, step):
                i = (row + x) * 4
                a = px[i + 3]
                lum = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) * a
                s += lum
                s2 += lum * lum
                cov += 1.0 if a > 0.01 else 0.0
                cnt += 1.0
        mean = s / cnt
        std = math.sqrt(max(0.0, s2 / cnt - mean * mean))
        return {"width": w, "height": h, "mean": round(mean, 4), "std": round(std, 4), "coverage": round(cov / cnt, 4)}
    finally:
        bpy.data.images.remove(img)


def render_to(scene, path):
    t = time.time()
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    if not os.path.exists(path):
        raise JobError(f"Blender wrote no image to {path}")
    st = image_stats(path)
    st["seconds"] = round(time.time() - t, 2)
    return st


def shoot(scene, job, subject, outs, sel, plan_views_ortho=True):
    """Render every view in job['views'] and, when job['turntable'] is set, the turntable frames. Output paths come
    from the command line in order: one per view, then one per frame."""
    used, notes = configure(scene, job, sel)
    lo, hi = world_bbox(subject)
    pts = corners(lo, hi)
    center = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 1e-4)
    world(scene, job.get("background", "light"))
    cam = make_camera(scene)
    views = list(job.get("views") or [])
    tt = job.get("turntable")
    frames = int(tt["frames"]) if tt else 0
    if len(outs) != len(views) + frames:
        raise JobError(f"{len(views)} view(s) and {frames} frame(s) need {len(views) + frames} output paths, got {len(outs)}")
    images = []
    for name, path in zip(views, outs):
        d, up = view_dir(name)
        place_camera(cam, scene, pts, d, up, ortho=plan_views_ortho and name in ("top", "bottom"), margin=job.get("margin", 0.06))
        studio(scene, center, radius, d, up)
        log(f"render {name} {used['width']}x{used['height']} {used['samples']} samples on {used['device']['type']}")
        st = render_to(scene, path)
        st["view"] = name
        images.append(st)
    if frames:
        el = float(tt.get("elevation", 30.0))
        start = float(tt.get("start_azimuth", -135.0))
        # one distance for every frame: frame the bounding sphere so nothing leaves the shot as it turns
        cd = cam.data
        cd.type = "PERSP"
        cd.lens = 50.0
        h_over_w = scene.render.resolution_y / scene.render.resolution_x
        half = math.atan((cd.sensor_width / 2) / cd.lens * min(1.0, h_over_w))
        dist = radius / math.sin(half) * (1 + job.get("margin", 0.06))
        cd.clip_start = max(dist / 1000.0, 1e-5)
        cd.clip_end = dist * 20
        for i, path in enumerate(outs[len(views):]):
            d = orbit_dir(start + 360.0 * i / frames, el)
            r, u, f = basis(d, Vector((0, 0, 1)))
            studio(scene, center, radius, d, Vector((0, 0, 1)))
            cam.location = center - f * dist
            rot = cam.matrix_world.to_3x3()
            rot.col[0], rot.col[1], rot.col[2] = r, u, -f
            cam.rotation_euler = rot.to_euler()
            bpy.context.view_layer.update()
            log(f"turntable frame {i + 1}/{frames}")
            st = render_to(scene, path)
            st["view"] = f"frame_{i + 1:04d}"
            images.append(st)
    size = hi - lo
    return {"images": images, "render": used, "notes": notes,
            "bbox_mm": [round(size.x * 1000, 3), round(size.y * 1000, 3), round(size.z * 1000, 3)],
            "objects": len(subject), "blender": bpy.app.version_string}


def load_job():
    a = script_args()
    if len(a) < 2:
        raise JobError("usage: blender -b -P <script> -- <job.json> <result.json> [model] [outputs...]")
    with open(a[0], encoding="utf-8") as f:
        job = json.load(f)
    return job, a[2:]


def device_for(job):
    _, devices = list_devices() if job.get("device", "auto") != "cpu" else ([], [])
    return select_device(job.get("device", "auto"), devices)
