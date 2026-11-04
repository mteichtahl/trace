"""A stand-in for kicad-cli's GLB of the sample board, from its facts: body, mask, silk, pads and part boxes in KiCad's
colours, offset from the case frame on purpose (the showcase must place it by its outline)."""
import json, sys, bpy, bmesh
from mathutils import Vector
facts = json.load(open(sys.argv[1])); out = sys.argv[2]
bpy.ops.wm.read_factory_settings(use_empty=True)
def mat(name, rgb, metal=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']; b.inputs['Base Color'].default_value = (*rgb, 1); b.inputs['Metallic'].default_value = metal
    return m
OFF = Vector((0.0123, -0.0456, 0.0))   # a made-up export origin
def slab(name, pts, z0, z1, m):
    bm = bmesh.new()
    vs = [bm.verts.new((x / 1000 + OFF.x, -y / 1000 + OFF.y, z0)) for x, y in pts]
    f = bm.faces.new(vs); bm.normal_update()
    if f.normal.z < 0: f.normal_flip()
    r = bmesh.ops.extrude_face_region(bm, geom=[f])
    for v in [e for e in r['geom'] if isinstance(e, bmesh.types.BMVert)]: v.co.z = z1
    me = bpy.data.meshes.new(name); bm.to_mesh(me)
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o); me.materials.append(m); return o
def box(name, x0, y0, x1, y1, z0, z1, m):
    return slab(name, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)], z0, z1, m)
t = facts['thickness_mm'] / 1000
outline = facts['outline']
slab('board', outline, 0, t, mat('board', (0.43, 0.45, 0.30)))
slab('mask_top', outline, t, t + 0.00003, mat('mask', (0.078, 0.2, 0.141)))
slab('mask_bot', outline, -0.00003, 0, mat('mask', (0.078, 0.2, 0.141)))
gold = mat('pads', (0.85, 0.6, 0.25), 1.0); black = mat('ic', (0.02, 0.02, 0.022)); grey = mat('metal', (0.75, 0.75, 0.74), 1.0); silk = mat('silk', (0.95, 0.95, 0.95))
for p in facts['parts']:
    b = p['box']; h = p['height_mm'] / 1000
    top = p['side'] == 'top'
    z0, z1 = (t + 0.00004, t + 0.00004 + h) if top else (-0.00004 - h, -0.00004)
    m = grey if p.get('connector') else black
    box(p['ref'], b['min_x'] + .3, b['min_y'] + .3, b['max_x'] - .3, b['max_y'] - .3, z0, z1, m)
    zp = t + 0.00003 if top else -0.00006
    box(p['ref'] + '_pad1', b['min_x'], b['min_y'], b['min_x'] + .6, b['max_y'], zp, zp + 0.00003, gold)
    box(p['ref'] + '_pad2', b['max_x'] - .6, b['min_y'], b['max_x'], b['max_y'], zp, zp + 0.00003, gold)
    zs = t + 0.00006 if top else -0.00009
    box(p['ref'] + '_silk', b['min_x'] - .4, b['min_y'] - .4, b['max_x'] + .4, b['min_y'] - .25, zs, zs + 0.00001, silk)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=True)
print('wrote', out)
