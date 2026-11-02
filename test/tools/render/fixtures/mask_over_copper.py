"""Does copper under the solder mask show in render_board's top view, shot with its own camera and lights (C.shoot)?
(test/tools/render/blender.test.ts) A 20 mm board as kicad-cli 10 exports it (testyyyu's GLB): an FR4 body, two copper
tracks (KiCad's gold copper, metallic 1, and its grey F.Cu, metallic 1) and an exposed pad, and a mask layer over the
tracks with the pad left open; and a part as a glTF import gives it: a black plastic body and a metal lead, both
metallic 1 (glTF's default)."""
import sys
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
sys.path.insert(0, ARGS[0])  # python/blender
import bpy
import render_board as RB

def box(name, x, y, z, sx, sy, sz, col, metal=0.0):
    if sz:
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, z))
    else:                                   # one face, as kicad-cli exports a mask layer
        bpy.ops.mesh.primitive_plane_add(size=1, location=(x, y, z))
        sz = 1
    o = bpy.context.active_object
    o.name = name
    o.scale = (sx, sy, sz)
    bpy.ops.object.transform_apply(scale=True)
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = col
    b.inputs["Metallic"].default_value = metal
    o.data.materials.append(m)
    return o

for o in list(bpy.data.objects): bpy.data.objects.remove(o)
mm = 0.001
objs = [
    box("board", 0, 0, 0, 20*mm, 20*mm, 1.6*mm, (0.42, 0.45, 0.29, 1)),
    box("copper_gold", 0, 2*mm, 0.8*mm + 0.0175*mm, 12*mm, 0.4*mm, 0.035*mm, (0.7, 0.61, 0.0, 1), metal=1.0),
    box("copper_grey", 0, 5*mm, 0.8*mm + 0.0175*mm, 12*mm, 0.4*mm, 0.035*mm, (0.5, 0.5, 0.5, 1), metal=1.0),
    # an exposed pad written twice, coincident (testyyyu's J1: overlapping pads), in KiCad's grey pad copper
    box("pad_a", 0, -3.5*mm, 0.8*mm + 0.0175*mm, 2*mm, 0.8*mm, 0.035*mm, (0.5, 0.5, 0.5, 1), metal=1.0),
    box("pad_b", 0, -3.5*mm, 0.8*mm + 0.0175*mm, 2*mm, 0.8*mm, 0.035*mm, (0.5, 0.5, 0.5, 1), metal=1.0),
    # the mask: covers the tracks, not the pad (two strips around the pad opening)
    box("mask_a", 0, 3.5*mm, 0.8*mm + 0.05*mm, 20*mm, 13*mm, 0, (0.08, 0.2, 0.14, 1)),
    box("mask_b", 0, -7*mm, 0.8*mm + 0.05*mm, 20*mm, 6*mm, 0, (0.08, 0.2, 0.14, 1)),
    box("body", 6*mm, -6*mm, 0.8*mm + 0.6*mm, 3*mm, 2*mm, 1*mm, (0.019, 0.018, 0.018, 1), metal=1.0),
    box("lead", 8*mm, -6*mm, 0.8*mm + 0.3*mm, 1*mm, 1*mm, 0.5*mm, (0.64, 0.63, 0.57, 1), metal=1.0),
]
S = RB.surfaces({"mask_color": "#1f6b3a"})
print("COUNTS", RB.dress(objs, S))
import common as C
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector
scene = bpy.context.scene
job = {"views": ["top"], "width": 240, "height": 240, "samples": 24, "device": "cpu", "background": "light",
       "defaults": {"cpu": {"width": 240, "height": 240, "samples": 24}, "gpu": {}}}
out = ARGS[1]
C.shoot(scene, job, objs, [out], C.device_for(job))
img = bpy.data.images.load(out)
px = list(img.pixels)
W, H = img.size
def at(xmm, ymm, r=0.12):
    """The mean colour of a small patch along x around a point on the board's top, through render_board's own camera."""
    acc, n = [0.0, 0.0, 0.0], 0
    for dx in range(-3, 4):
        p = world_to_camera_view(scene, scene.camera, Vector(((xmm + dx * r / 3) * mm, ymm * mm, 0.86 * mm)))
        u, v = int(p.x * W), int(p.y * H)
        i = (v * W + u) * 4
        for k in range(3):
            acc[k] += px[i + k]
        n += 1
    return tuple(c / n for c in acc)
lum = lambda c: 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
plain = at(0, 7.5)
for name, y in (("gold", 2), ("grey", 5)):
    c = at(0, y)
    # seen through the mask a track is lighter mask (never darker, as polished copper made it), and still green
    d = lum(c) - lum(plain)
    print(name.upper(), [round(x, 3) for x in c], "PLAIN", [round(x, 3) for x in plain], round(d, 3),
          f"{name.upper()}_LIGHTER", d > 0.025, f"{name.upper()}_GREEN", c[1] > c[0] and c[1] > c[2])
pad = at(0, -3.5)
# the doubled pad is bright copper, not black (each face shadowed the other)
print("PAD", [round(x, 3) for x in pad], "PAD_BRIGHT", lum(pad) > 0.4)
