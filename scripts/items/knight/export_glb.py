# Voxel faces (voxelize.py's .faces.npz) -> compact item GLB for phones.
# Faces merge into rectangles whatever their colour; colours (with corner shade averaged per face) live in a
# nearest-filtered texture atlas. KHR_mesh_quantization: int8 positions, uint16 UVs; no normals, so three
# shades it flat. A unit cube centred on the origin, facing +z; Idle (sway) and Inspect (turn) on the root.
# usage: export_glb.py <faces.npz> <out.glb> <atlas preview.png> [node name (knight)] [material kind (cloth)]
import sys, io, json, struct, numpy as np
from PIL import Image

src, out, atlas_png = sys.argv[1:4]
node, kind = (sys.argv[4:6] + ['knight', 'cloth'][len(sys.argv[4:6]):])
f = np.load(src); keys, col, shade = f['keys'], f['col'].astype(float), f['shade']
texel = {tuple(k): np.clip(c * s.mean(), 0, 255) for k, c, s in zip(keys, col, shade)}

rects = []  # (d, sign, layer, i, j, w, h): cells (i.., j..) along axes u=(d+1)%3, v=(d+2)%3
for d in range(3):
    u, v = (d + 1) % 3, (d + 2) % 3
    for s in (1, -1):
        sel = keys[:, 3 + d] == s
        for layer in np.unique(keys[sel, d]):
            cells = set(map(tuple, keys[sel & (keys[:, d] == layer)][:, [u, v]]))
            while cells:
                i, j = min(cells, key=lambda c: (c[1], c[0])); w = 1
                while (i + w, j) in cells: w += 1
                h = 1
                while all((i + x, j + h) in cells for x in range(w)): h += 1
                for x in range(w):
                    for y in range(h): cells.discard((i + x, j + y))
                rects.append((d, s, layer, i, j, w, h))

# Shelf-pack each rectangle's texels into the atlas.
W = 256; place = {}; x = y = shelf = 0
for r in sorted(range(len(rects)), key=lambda r: -rects[r][6]):
    w, h = rects[r][5:]
    if x + w > W: x, y, shelf = 0, y + shelf, 0
    place[r] = (x, y); x += w; shelf = max(shelf, h)
H = 1 << int(np.ceil(np.log2(y + shelf)))
atlas = np.zeros((H, W, 3))
for r, (d, s, layer, i, j, w, h) in enumerate(rects):
    ax, ay = place[r]
    for a in range(w):
        for b in range(h):
            p = [0, 0, 0]; p[d] = layer; p[(d + 1) % 3] = i + a; p[(d + 2) % 3] = j + b
            atlas[ay + b, ax + a] = texel[tuple(p) + tuple(int(q) for q in np.eye(3, dtype=int)[d] * s)]
img = Image.fromarray(atlas.astype(np.uint8)).quantize(128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
png = io.BytesIO(); img.save(png, 'PNG', optimize=True); png = png.getvalue()
img.convert('RGB').resize((W * 3, H * 3), Image.NEAREST).save(atlas_png)

pos, uv, idx = [], [], []
for r, (d, s, layer, i, j, w, h) in enumerate(rects):
    ax, ay = place[r]; base = len(pos)
    for a, b in ((0, 0), (w, 0), (w, h), (0, h)):
        p = [0, 0, 0]; p[d] = layer + (s > 0); p[(d + 1) % 3] = i + a; p[(d + 2) % 3] = j + b
        pos.append(p); uv.append(((ax + a) / W, (ay + b) / H))
    # u x v points along +d, so the corner order above faces +d; flip it for faces looking along -d
    idx += [base, base + 1, base + 2, base, base + 2, base + 3] if s > 0 else [base, base + 2, base + 1, base, base + 3, base + 2]
pos = np.array(pos); lo, hi = pos.min(0), pos.max(0)
shift = np.floor((lo + hi) / 2).astype(int); q = pos - shift
assert q.min() >= -128 and q.max() <= 127 and len(pos) < 65536
size = (hi - lo).max(); centre = (lo + hi) / 2 - shift

def pad4(b): return b + b'\0' * (-len(b) % 4)
bpos = np.zeros((len(q), 4), np.int8); bpos[:, :3] = q; bpos = bpos.tobytes()
buv = np.round(np.array(uv) * 65535).astype(np.uint16).tobytes()
bidx = np.array(idx, np.uint16).tobytes()

def quat_y(deg): t = np.radians(deg) / 2; return [0, float(np.sin(t)), 0, float(np.cos(t))]
clips = {'Idle': ([0, 1.5, 3, 4.5, 6], [0, 6, 0, -6, 0]), 'Inspect': ([0, .6, 1.2, 1.8, 2.4], [0, 90, 180, 270, 360])}
views = []; accessors = []; animations = []
def add_view(data, **kw):
    views.append({'buffer': 0, 'byteOffset': None, 'byteLength': len(data), **kw}); return len(views) - 1
chunks = [pad4(bpos), pad4(buv), pad4(bidx), pad4(png)]
add_view(bpos, byteStride=4, target=34962); add_view(buv, target=34962); add_view(bidx, target=34963); add_view(png)
accessors += [
    {'bufferView': 0, 'componentType': 5120, 'count': len(q), 'type': 'VEC3', 'min': q.min(0).tolist(), 'max': q.max(0).tolist()},
    {'bufferView': 1, 'componentType': 5123, 'normalized': True, 'count': len(q), 'type': 'VEC2'},
    {'bufferView': 2, 'componentType': 5123, 'count': len(idx), 'type': 'SCALAR'},
]
for name, (times, degs) in clips.items():
    t = np.array(times, np.float32).tobytes(); r = np.array([quat_y(a) for a in degs], np.float32).tobytes()
    add_view(t); chunks.append(pad4(t)); accessors.append({'bufferView': len(views) - 1, 'componentType': 5126, 'count': len(times), 'type': 'SCALAR', 'min': [times[0]], 'max': [times[-1]]})
    add_view(r); chunks.append(pad4(r)); accessors.append({'bufferView': len(views) - 1, 'componentType': 5126, 'count': len(times), 'type': 'VEC4'})
    animations.append({'name': name, 'samplers': [{'input': len(accessors) - 2, 'output': len(accessors) - 1, 'interpolation': 'LINEAR'}],
                       'channels': [{'sampler': 0, 'target': {'node': 0, 'path': 'rotation'}}]})
offset = 0
for view, chunk in zip(views, chunks): view['byteOffset'] = offset; offset += len(chunk)
binary = b''.join(chunks)

gltf = {
    'asset': {'version': '2.0', 'generator': 'export_glb.py'},
    'extensionsUsed': ['KHR_mesh_quantization'], 'extensionsRequired': ['KHR_mesh_quantization'],
    'scene': 0, 'scenes': [{'nodes': [0]}],
    'nodes': [{'name': node, 'children': [1]},
              {'name': node + '_voxels', 'mesh': 0, 'scale': [1 / size] * 3, 'translation': (-centre / size).tolist()}],
    'meshes': [{'primitives': [{'attributes': {'POSITION': 0, 'TEXCOORD_0': 1}, 'indices': 2, 'material': 0}]}],
    'materials': [{'name': kind, 'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}, 'metallicFactor': 0, 'roughnessFactor': 0.9}}],
    'textures': [{'source': 0, 'sampler': 0}], 'images': [{'bufferView': 3, 'mimeType': 'image/png'}],
    'samplers': [{'magFilter': 9728, 'minFilter': 9728, 'wrapS': 33071, 'wrapT': 33071}],
    'accessors': accessors, 'bufferViews': views, 'buffers': [{'byteLength': len(binary)}], 'animations': animations,
}
js = json.dumps(gltf, separators=(',', ':')).encode(); js += b' ' * (-len(js) % 4)
glb = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binary)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(binary), 0x004E4942) + binary
open(out, 'wb').write(glb)
print(f'{len(rects)} rects, {len(idx) // 3} tris, atlas {W}x{H}, png {len(png)} B, glb {len(glb)} B')
