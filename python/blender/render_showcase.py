"""A revision's photorealistic renders (docs/revision-renders.md): the board, the case, the board in the case and an
exploded view, lit and backed with colours taken from the project's logo (or a neutral studio look without one).

    blender -b --factory-startup --python-exit-code 1 -P render_showcase.py -- job.json result.json \\
        board.glb [base.stl lid.stl] [logo.png] <one output per shot> ...

The job says which inputs are there (`case`, `logo`) and lists the shots in output order. Shots:

    board          the populated board, three-quarter view from the front left
    board-top      the board from straight above (orthographic)
    board-bottom   the underside from straight below (orthographic)
    case           the closed case
    board-in-case  the board in the base, lid off
    exploded       base, board and lid pulled apart along the assembly axis

Frames: the case files are in the case frame of docs/enclosure-build.md (millimetres, y flipped from KiCad, the board's
bottom face at z = 0). The board model is placed in that frame by its own board body: its outline's bounds are moved
onto `board_xy_mm` (the outline's bounds in the case frame, from the board's facts) and its bottom face onto z = 0, so
where kicad-cli puts the model's origin does not matter. Nothing here edits a model file.
"""
import colorsys
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import render_board as RB  # noqa: E402

import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

SHOTS = ("board", "board-top", "board-bottom", "case", "board-in-case", "exploded")
CASE_SHOTS = ("case", "board-in-case", "exploded")

# trace's neutral studio look, used when a project has no logo (or its colours cannot be read)
NEUTRAL = {"source": "neutral", "base": "#eceef1", "accent": "#ffffff", "neutral": "#c8ccd2",
           "background": ["#eceef1", "#c8ccd2"]}

# the case's surface by what it is made of (the process's material from case.json)
CASE_LOOKS = {
    "nylon": ("#8d9096", 0.82, 0.0),          # MJF/SLS PA12: matte grey
    "resin": ("#e9e6df", 0.35, 0.0),          # SLA resin: smooth off-white
    "pla": ("#d9dbde", 0.55, 0.0),
    "aluminium": ("#c7c9cc", 0.32, 1.0),      # CNC aluminium: satin metal
    "black": ("#1d1e21", 0.6, 0.0),
}

# camera per shot: (azimuth, elevation) for perspective shots; plan views use common's top/bottom
ANGLES = {"board": (-135.0, 30.0), "case": (-130.0, 24.0), "board-in-case": (-135.0, 42.0), "exploded": (-128.0, 13.0)}


# ---------------------------------------------------------------------------------------------------- colour

def to_hex(rgb):
    return "#" + "".join(f"{max(0, min(255, round(c * 255))):02x}" for c in rgb)


def from_hex(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def hls(rgb):
    return colorsys.rgb_to_hls(*rgb)


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def dist(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def logo_pixels(path, limit=6000):
    """The logo's opaque pixels (sRGB 0..1), sampled on a grid, without near-white and near-black ones: a logo's
    paper and its outline say nothing about its colours."""
    img = bpy.data.images.load(path, check_existing=False)
    try:
        w, h = img.size
        if not w or not h:
            raise C.JobError(f"{os.path.basename(path)} is an empty image")
        img.colorspace_settings.name = "sRGB"
        px = list(img.pixels[:])
        step = max(1, int(math.sqrt(w * h / limit)))
        out = []
        for y in range(0, h, step):
            for x in range(0, w, step):
                i = (y * w + x) * 4
                r, g, b, a = px[i:i + 4]
                if a < 0.5:
                    continue
                L, S = hls((r, g, b))[1], hls((r, g, b))[2]
                if L > 0.94 or L < 0.05:
                    continue
                out.append((r, g, b))
        return out
    finally:
        bpy.data.images.remove(img)


def kmeans(pixels, k=5, rounds=12):
    """Deterministic k-means: seeds are the first pixel and then each pixel farthest from the seeds so far."""
    seeds = [pixels[0]]
    while len(seeds) < min(k, len(pixels)):
        far = max(pixels, key=lambda p: min(dist(p, s) for s in seeds))
        if min(dist(far, s) for s in seeds) < 0.04:
            break
        seeds.append(far)
    centres = list(seeds)
    groups = []
    for _ in range(rounds):
        groups = [[] for _ in centres]
        for p in pixels:
            groups[min(range(len(centres)), key=lambda i: dist(p, centres[i]))].append(p)
        centres = [tuple(sum(c) / len(g) for c in zip(*g)) if g else centres[i] for i, g in enumerate(groups)]
    return sorted(((c, len(g)) for c, g in zip(centres, groups) if g), key=lambda x: -x[1])


def palette_from_logo(path):
    """{source, base, accent, neutral, background: [top, bottom]} from the logo's dominant colours (hex), or None when
    the logo has too few coloured pixels to say."""
    px = logo_pixels(path)
    if len(px) < 20:
        return None
    clusters = kmeans(px)
    base = clusters[0][0]
    sat = lambda c: hls(c)[2]  # noqa: E731
    far = [c for c, _ in clusters if dist(c, base) > 0.25]
    accent = max(far, key=sat) if far else base
    greys = [c for c, _ in clusters if sat(c) < 0.2]
    neutral = greys[0] if greys else colorsys.hls_to_rgb(hls(base)[0], 0.62, 0.08)
    # a strong colour fights a green board: back it with the neutral instead
    back = neutral if sat(base) > 0.6 and hls(base)[1] > 0.3 else base
    hue, light, s = hls(back)
    s = min(s, 0.55)
    # a soft gradient around the colour: light enough at the foot that a contact shadow still reads
    top = colorsys.hls_to_rgb(hue, min(0.9, max(light, 0.3) + 0.2), s)
    bottom = colorsys.hls_to_rgb(hue, max(0.16, light - 0.1), s)
    return {"source": "logo", "base": to_hex(base), "accent": to_hex(accent), "neutral": to_hex(neutral),
            "background": [to_hex(top), to_hex(bottom)]}


def gradient_world(scene, top, bottom, env_strength=0.35):
    """The camera sees a vertical gradient (screen space, top colour to bottom colour); everything else is lit by a
    soft neutral environment so the board keeps its own colours."""
    wd = bpy.data.worlds.new("trace showcase world")
    scene.world = wd
    wd.use_nodes = True
    nt = wd.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    env = nt.nodes.new("ShaderNodeBackground")
    env.inputs["Color"].default_value = (0.8, 0.8, 0.82, 1)
    env.inputs["Strength"].default_value = env_strength
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "EASE"
    ramp.color_ramp.elements[0].color = C.hex_rgba(bottom)
    ramp.color_ramp.elements[1].color = C.hex_rgba(top)
    cam_bg = nt.nodes.new("ShaderNodeBackground")
    cam_bg.inputs["Strength"].default_value = 1.0
    lp = nt.nodes.new("ShaderNodeLightPath")
    mixn = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(coord.outputs["Window"], sep.inputs[0])
    nt.links.new(sep.outputs["Y"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], cam_bg.inputs["Color"])
    nt.links.new(lp.outputs["Is Camera Ray"], mixn.inputs["Fac"])
    nt.links.new(env.outputs[0], mixn.inputs[1])
    nt.links.new(cam_bg.outputs[0], mixn.inputs[2])
    nt.links.new(mixn.outputs[0], out.inputs["Surface"])
    scene.render.film_transparent = False


# ---------------------------------------------------------------------------------------------------- the subject

def roots(objs):
    """The top-level objects above `objs` (an importer's empties and the meshes without a parent)."""
    out = []
    for o in objs:
        r = o
        while r.parent is not None:
            r = r.parent
        if r not in out:
            out.append(r)
    return out


def group(name, objs):
    """An empty holding `objs`' top-level objects, so the whole model moves as one."""
    g = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(g)
    for r in roots(objs):
        mw = r.matrix_world.copy()
        r.parent = g
        r.matrix_parent_inverse = Matrix.Identity(4)
        r.matrix_world = mw
    bpy.context.view_layer.update()
    return g


def place_board(objs, job):
    """Move the board so its body's outline bounds are `board_xy_mm` and its bottom face is at z = 0."""
    g = group("board", objs)
    fr4 = [o for o in objs if any(s.material and s.material.name.startswith("FR4") for s in o.material_slots)]
    body = fr4 or objs
    lo, hi = C.world_bbox(body)
    want = job.get("board_xy_mm")
    if want:
        x0, y0, x1, y1 = (v / 1000.0 for v in want)
        # the board's own bounds may differ a little from the outline's (KiCad's arcs, the mask): match the centres
        target = Vector(((x0 + x1) / 2, (y0 + y1) / 2, 0.0))
        off = target - Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    else:
        off = Vector((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z))
    g.location = g.location + off
    bpy.context.view_layer.update()
    return g


def case_material(look):
    colour, rough, metal = CASE_LOOKS.get(look or "nylon", CASE_LOOKS["nylon"])
    m = C.principled(f"Case ({look or 'nylon'})", C.hex_rgba(colour), rough=rough, metal=metal)
    if look in (None, "nylon"):
        # a printed part's fine grain: a little bump so it does not read as moulded plastic
        nt = m.node_tree
        b = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
        noise = nt.nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = 900.0
        bump = nt.nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = 0.08
        nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
        nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    return m


def import_part(path, name, mat):
    objs = C.import_model(path, "stl")
    C.normalise_units(objs, "mm")
    C.set_all_materials(objs, mat)
    for o in objs:
        for p in o.data.polygons:
            p.use_smooth = False
    g = group(name, objs)
    return g, objs


def floor(scene, lo, hi):
    """A shadow catcher under the subject: a soft contact shadow, the background seen through it."""
    size = max(hi.x - lo.x, hi.y - lo.y) * 12
    bpy.ops.mesh.primitive_plane_add(size=size, location=((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z - 1e-5))
    f = bpy.context.active_object
    f.name = "trace floor"
    f.is_shadow_catcher = True
    return f


def show(objs, on):
    for o in objs:
        o.hide_render = not on


def mesh_children(g):
    return [o for o in g.children_recursive if o.type == "MESH"]


def explode(board, bobjs, bparts, lid, lparts, ex):
    """Pull the parts apart along z with a clear gap between each: the board's lowest point above the base's top, the
    lid's lowest point above the board's tallest part. The gap is a share of the case's height (`gap`, default 0.5)."""
    blo, bhi = C.world_bbox(bparts)
    llo, lhi = C.world_bbox(lparts)
    height = max(lhi.z, bhi.z) - min(llo.z, blo.z)
    gap = float(ex.get("gap", 0.5)) * height
    lo, hi = C.world_bbox(bobjs)
    board.location.z = (bhi.z - lo.z) + gap
    bpy.context.view_layer.update()
    lo, hi = C.world_bbox(bobjs)
    llo, _ = C.world_bbox(lparts)
    lid.location.z = (hi.z - llo.z) + gap
    bpy.context.view_layer.update()


# ---------------------------------------------------------------------------------------------------- shots

def tint_rim(scene, accent, strength):
    """The rim light leans to the accent colour; key and fill stay neutral."""
    rgb = C.hex_rgba(accent)[:3]
    for ob in scene.objects:
        if ob.type == "LIGHT" and ob.name.startswith("rim"):
            ob.data.color = mix((1.0, 1.0, 1.0), rgb, strength)
            ob.data.energy *= 1.4


def shoot_one(scene, cam, job, shot, subject, center, radius, palette, path):
    lo, hi = C.world_bbox(subject)
    pts = C.corners(lo, hi)
    if shot in ("board-top", "board-bottom"):
        d, up = C.view_dir("top" if shot == "board-top" else "bottom")
        C.place_camera(cam, scene, pts, d, up, ortho=True, margin=0.1)
    else:
        az, el = ANGLES[shot]
        d, up = C.orbit_dir(az, el), Vector((0, 0, 1))
        C.place_camera(cam, scene, pts, d, up, ortho=False, margin=0.09, lens=float(job.get("lens", 65.0)))
    C.studio(scene, (lo + hi) / 2, max((hi - lo).length / 2, 1e-4), d, up)
    if palette["source"] == "logo":
        tint_rim(scene, palette["accent"], 0.55)
    st = C.render_to(scene, path)
    st["view"] = shot
    return st


def main():
    job, rest = C.load_job()
    shots = list(job.get("shots") or [])
    bad = [s for s in shots if s not in SHOTS]
    if bad or not shots:
        raise C.JobError(f"shots must be some of {', '.join(SHOTS)}; got {shots}")
    has_case = bool(job.get("case"))
    has_logo = bool(job.get("logo"))
    if not has_case and any(s in CASE_SHOTS for s in shots):
        raise C.JobError("a case shot was asked for, but no case was given")
    n_in = 1 + (2 if has_case else 0) + (1 if has_logo else 0)
    if len(rest) != n_in + len(shots):
        raise C.JobError(f"{n_in} input(s) and {len(shots)} shot(s) need {n_in + len(shots)} paths, got {len(rest)}")
    board_path = rest[0]
    base_path, lid_path = (rest[1], rest[2]) if has_case else (None, None)
    logo_path = rest[n_in - 1] if has_logo else None
    outs = rest[n_in:]

    notes = []
    palette = dict(NEUTRAL)
    if job.get("palette"):
        palette = dict(job["palette"])
    elif logo_path:
        try:
            p = palette_from_logo(logo_path)
        except Exception as e:  # noqa: BLE001 - an unreadable logo falls back to the neutral look, said in the notes
            p = None
            notes.append(f"the logo could not be read ({e}): neutral colours used")
        if p:
            palette = p
        elif not notes:
            notes.append("the logo has too few coloured pixels to take colours from: neutral colours used")

    scene = C.empty_scene()
    sel = C.device_for(job)
    used, cnotes = C.configure(scene, job, sel)
    notes += cnotes
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
    except (TypeError, ValueError):
        try:
            scene.view_settings.view_transform = "Filmic"
        except (TypeError, ValueError):
            pass
    # deeper light paths than a quick render: glossy pads, a translucent mask, a case seen through its openings
    if scene.render.engine == "CYCLES":
        scene.cycles.max_bounces = 12
        scene.cycles.glossy_bounces = 6
        scene.cycles.blur_glossy = 0.2

    fmt = job.get("format") or os.path.splitext(board_path)[1].lstrip(".")
    C.log(f"import board {os.path.basename(board_path)} ({fmt})")
    bobjs = C.import_model(board_path, fmt, job.get("up_axis", "Z"))
    C.normalise_units(bobjs, job.get("units"))
    RB.orient(bobjs)
    surfaces = RB.dress(bobjs, RB.surfaces(job))
    board = place_board(bobjs, job)

    base = lid = None
    bparts = lparts = []
    if has_case:
        mat = case_material(job["case"].get("look"))
        base, bparts = import_part(base_path, "base", mat)
        lid, lparts = import_part(lid_path, "lid", mat)

    gradient_world(scene, palette["background"][0], palette["background"][1])
    cam = C.make_camera(scene)
    images = []
    every = bobjs + bparts + lparts
    lo_all, hi_all = C.world_bbox(every)
    fl = floor(scene, lo_all, hi_all)

    for shot, path in zip(shots, outs):
        board.location.z = 0.0
        if lid:
            lid.location.z = 0.0
        show(bobjs, True)
        show(bparts, shot in CASE_SHOTS)
        show(lparts, shot in ("case", "exploded"))
        if shot == "exploded":
            explode(board, bobjs, bparts, lid, lparts, job.get("explode") or {})
        bpy.context.view_layer.update()
        subject = [o for o in every if not o.hide_render]
        lo, hi = C.world_bbox(subject)
        # the floor sits under what is shown; a view from below sees no floor
        fl.location.z = lo.z - 1e-5
        fl.hide_render = shot == "board-bottom"
        bpy.context.view_layer.update()
        C.log(f"render {shot} {used['width']}x{used['height']} {used['samples']} samples on {used['device']['type']}")
        images.append(shoot_one(scene, cam, job, shot, subject, (lo + hi) / 2, (hi - lo).length / 2, palette, path))

    lo, hi = C.world_bbox(bobjs)
    size = hi - lo
    return {"images": images, "render": used, "notes": notes, "palette": palette, "surfaces": surfaces,
            "bbox_mm": [round(size.x * 1000, 3), round(size.y * 1000, 3), round(size.z * 1000, 3)],
            "objects": len(every), "blender": bpy.app.version_string}


if __name__ == "__main__":
    C.run_main(main)
