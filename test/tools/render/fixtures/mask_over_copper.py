"""Does copper under the solder mask show in render_board's top view? (test/tools/render/blender.test.ts) A 20 mm board: FR4 body, a copper track and a
pad (KiCad's gold copper colour), and a mask layer (KiCad's mask green) over the track with the pad left open."""
import sys
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
sys.path.insert(0, ARGS[0])  # python/blender
import bpy
import render_board as RB

def box(name, x, y, z, sx, sy, sz, col):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, z))
    o = bpy.context.active_object
    o.name = name
    o.scale = (sx, sy, sz)
    bpy.ops.object.transform_apply(scale=True)
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = col
    o.data.materials.append(m)
    return o

for o in list(bpy.data.objects): bpy.data.objects.remove(o)
mm = 0.001
objs = [
    box("board", 0, 0, 0, 20*mm, 20*mm, 1.6*mm, (0.3, 0.25, 0.1, 1)),
    box("copper_track", 0, 2*mm, 0.8*mm + 0.0175*mm, 12*mm, 0.4*mm, 0.035*mm, (0.75, 0.6, 0.2, 1)),
    box("copper_pad", 0, -4*mm, 0.8*mm + 0.0175*mm, 2*mm, 2*mm, 0.035*mm, (0.75, 0.6, 0.2, 1)),
    # the mask: covers the track, not the pad (two strips around the pad opening)
    box("mask_a", 0, 3.5*mm, 0.8*mm + 0.05*mm, 20*mm, 13*mm, 0.01*mm, (0.05, 0.25, 0.08, 1)),
    box("mask_b", 0, -7*mm, 0.8*mm + 0.05*mm, 20*mm, 6*mm, 0.01*mm, (0.05, 0.25, 0.08, 1)),
]
S = RB.surfaces({"mask_color": "#1f6b3a"})
print("COUNTS", RB.dress(objs, S))
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 16
scene.render.resolution_x = scene.render.resolution_y = 200
cam = bpy.data.cameras.new("cam"); cam.type = "ORTHO"; cam.ortho_scale = 22*mm
co = bpy.data.objects.new("cam", cam); scene.collection.objects.link(co); co.location = (0, 0, 0.05); cam.clip_start = 0.001; cam.clip_end = 1; scene.camera = co
light = bpy.data.lights.new("sun", "SUN"); light.energy = 1
lo = bpy.data.objects.new("sun", light); scene.collection.objects.link(lo)
scene.world = bpy.data.worlds.new("w"); scene.world.color = (0.8, 0.8, 0.8)
out = ARGS[1]
scene.render.filepath = out
bpy.ops.render.render(write_still=True)
img = bpy.data.images.load(out)
px = list(img.pixels)
W = img.size[0]
def at(xmm, ymm):
    u = int((xmm / 22 + 0.5) * W); v = int((ymm / 22 + 0.5) * W)
    i = (v * W + u) * 4
    return tuple(round(c, 3) for c in px[i:i+3])
track, plain = at(0, 2), at(0, 6)
print("TRACK", track, "PLAIN MASK", plain, "PAD", at(0, -4))
diff = sum(abs(a - b) for a, b in zip(track, plain))
print("TRACK_VISIBLE", diff > 0.03, round(diff, 3))
