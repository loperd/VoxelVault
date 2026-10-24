# Generated mesh -> crisp voxel model; each face is coloured from the turnaround view it faces.
# usage: voxelize.py <in.glb> <views prefix: fal/knight -> fal/knight-{front,back,left,right}.png> <res(voxels tall)> <out.glb> <preview.png>
import os, sys, numpy as np, trimesh
from PIL import Image, ImageDraw
from scipy.spatial import cKDTree
from scipy import ndimage

src, prefix, res, out, preview = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], sys.argv[5]
PALETTE = 32
mesh = trimesh.load(src, force='mesh')
# Proportions: the torso and arms get SX times wider and SZ times deeper than drawn (head and legs stay as drawn),
# ramping over the waist and neck. The views are sampled through the inverse warp, so the art stretches along.
SX, SZ = float(os.environ.get('SX', 1)), float(os.environ.get('SZ', 1))
(mx, my0, mz), (_, my1, _) = mesh.bounds[0], mesh.bounds[1]; mx, mz = mesh.centroid[0], mesh.centroid[2]
def stretch(y, k):  # 1 on legs and head, k on the torso, linear ramps between
    t = (np.asarray(y) - my0) / (my1 - my0)
    return 1 + (k - 1) * np.clip(np.minimum((t - 0.33) / 0.1, (0.8 - t) / 0.06), 0, 1)
def warp(p, inverse=False):
    p = np.array(p, float); y = p[..., 1]
    for ax, c, k in ((0, mx, SX), (2, mz, SZ)):
        f = stretch(y, k); p[..., ax] = c + (p[..., ax] - c) * (1 / f if inverse else f)
    return p
mesh.vertices = warp(mesh.vertices)
grid = mesh.voxelized(pitch=np.ptp(mesh.vertices[:, 1]) / res).fill()

# Each view's opaque box spans the mesh's extent across that view; the model faces +z, the sheet's LEFT is seen from +x.
lo, hi = mesh.bounds
def load(path):
    im = np.asarray(Image.open(path).convert('RGBA')).astype(float)
    ys, xs = np.nonzero(im[:, :, 3] > 128)
    return im, xs.min(), xs.max(), ys.min(), ys.max()
VIEWS = {  # name: (axis the camera looks along, sign of the camera side, screen-right as (axis, flipped))
    'front': (2, +1, (0, False)), 'back': (2, -1, (0, True)),
    'left': (0, +1, (2, True)), 'right': (0, -1, (2, False)),
}
images = {name: load(f'{prefix}-{name}.png') for name in VIEWS}

# The sheet draws every view the same height, so all share one px-per-unit scale; each is centred on the mesh's silhouette.
raw = grid.matrix; raw_idx = np.argwhere(raw); raw_pts = grid.indices_to_points(raw_idx)
place = {}
for name, (_, _, (ax, flip)) in VIEWS.items():
    im, x0, x1, y0, y1 = images[name]
    scale = (y1 - y0) / (hi[1] - lo[1])
    _, cell = np.unique(np.c_[raw_idx[:, 1], raw_idx[:, ax]], axis=0, return_index=True)  # one entry per silhouette cell
    h = warp(raw_pts[cell], inverse=True)[:, ax]; h = -h if flip else h
    ys, xs = np.nonzero(im[..., 3] > 128)
    place[name] = (scale, xs.mean() - h.mean() * scale, y1)

def window(name, p):  # the image pixels under a voxel's centre: its middle half, so neighbouring blocks don't bleed in
    im = images[name][0]
    _, _, (ax, flip) = VIEWS[name]
    scale, ox, y1 = place[name]
    p = warp(p, inverse=True)
    uu = ox + (-p[ax] if flip else p[ax]) * scale
    vv = y1 - (p[1] - lo[1]) * scale
    if not (0 <= uu < im.shape[1] and 0 <= vv < im.shape[0]): return np.zeros((1, 1, 4))  # off the picture: background
    r = max(1, int(scale / res * (hi[1] - lo[1]) / 4))
    return im[max(0, int(vv) - r):int(vv) + r + 1, max(0, int(uu) - r):int(uu) + r + 1]

def sample(name, p):
    a = window(name, p)
    px = a[a[..., 3] > 128][:, :3]
    return np.median(px, 0) if len(px) else None

# Carve to the drawn silhouettes: the generator fills gaps the art leaves open (between the legs).
filled = grid.matrix.copy()  # [x, y, z] booleans
PAD = 3  # room for the arms to grow past the generator's bounds
filled = np.pad(filled, [(PAD, PAD), (0, 0), (PAD, PAD)])
to_pts = lambda i: grid.indices_to_points(np.asarray(i) - [PAD, 0, PAD])
idx = np.argwhere(filled)
centers = to_pts(idx)
# A block stays when the art covers at least CARVE of it: an edge block half on the drawing is still the drawing.
CARVE = float(os.environ.get('CARVE', 0.5)) * 255
outside = np.array([any(window(n, c)[..., 3].mean() < CARVE for n in VIEWS) for c in centers])
filled[tuple(idx[outside].T)] = False
labels, n = ndimage.label(filled)
filled = labels == np.argmax(ndimage.sum(filled, labels, range(1, n + 1))) + 1  # drop crumbs the carving cut loose
# Stray blocks: drop voxels hanging on by one side, fill one-block dents.
K = ndimage.generate_binary_structure(3, 1); K[1, 1, 1] = False
for _ in range(2):
    nb = ndimage.convolve(filled.astype(int), K.astype(int), mode='constant')
    filled = (filled & (nb >= 2)) | (~filled & (nb >= 5))
labels, n = ndimage.label(filled)
filled = labels == np.argmax(ndimage.sum(filled, labels, range(1, n + 1))) + 1
# Arms: the rows where the front silhouette splits into arm | torso | arm (plus the shoulders above).
def runs(row):
    e = np.flatnonzero(np.diff(np.r_[0, row.astype(int), 0])); return list(zip(e[::2], e[1::2] - 1))
def find_arms(filled):
    sil = filled.any(2)
    split = [y for y in range(int(sil.shape[1] * 0.35), sil.shape[1]) if len(runs(sil[:, y])) >= 3]
    l = max(runs(sil[:, y])[0][1] for y in split); r = min(runs(sil[:, y])[-1][0] for y in split)
    return l, r, min(split), max(split) + int(os.environ.get('SHOULDER', 4))
# The generator's arms are thinner than the legs: grow them ARM blocks all round (block by block, like the legs'
# plates), keeping only new blocks the drawings cover; the torso, head and legs stay as generated.
ARM = int(os.environ.get('ARM', 1))
ARMS = l, r, y0, y1 = find_arms(filled)  # found before growing: grown arms may touch the torso
if ARM:
    region = np.zeros_like(filled); region[:l + 1, y0:y1 + 1] = True; region[r:, y0:y1 + 1] = True
    new = ndimage.binary_dilation(filled & region, np.ones((3, 1, 3), bool), iterations=ARM) & region & ~filled
    ni = np.argwhere(new)
    keep = np.array([all(window(n, c)[..., 3].mean() >= 0.3 * 255 for n in VIEWS) for c in to_pts(ni)])
    filled[tuple(ni[keep].T)] = True
    print(f'arms grown by {keep.sum()} blocks')
# Ridges: arm rows that the front view draws mostly gold (pauldron rims, cuffs) stick out RIDGE more blocks all round.
RIDGE = int(os.environ.get('RIDGE', 1))
ridge = {}  # (x, y, z) -> the row's gold
if RIDGE:
    region = np.zeros_like(filled); region[:l + 1, y0:y1 + 1] = True; region[r:, y0:y1 + 1] = True
    for y in range(y0, y1 + 1):
        row = np.argwhere(filled[:, y] & region[:, y])
        if not len(row): continue
        px = [c for c in (sample('front', q) for q in to_pts(np.c_[row[:, 0], np.full(len(row), y), row[:, 1]])) if c is not None]
        gold = [c for c in px if c[0] > 140 and c[1] > 95 and c[2] < 0.6 * c[0]]
        if len(gold) < 0.4 * len(px): continue
        layer = filled[:, y] & region[:, y]
        grown = ndimage.binary_dilation(layer, np.ones((3, 3), bool), iterations=RIDGE) & region[:, y] & ~filled[:, y]
        for x, z in np.argwhere(grown): ridge[x, y, z] = np.median(gold, 0)
        filled[:, y] |= grown
    print(f'ridges on {len({k[1] for k in ridge})} rows, {len(ridge)} blocks')
idx = np.argwhere(filled)
centers = to_pts(idx)
print(f'carved {outside.sum()} voxels')
if os.environ.get('DUMP'): np.save('filled.npy', filled); sys.exit()

# A voxel is seen by a view when nothing filled lies between it and that camera.
seen = {}
for name, (ax, sign, _) in VIEWS.items():
    f = np.flip(filled, ax) if sign > 0 else filled  # make "towards the camera" the low end of the axis
    ahead = np.cumsum(f, axis=ax) - f  # filled voxels strictly between voxel and camera
    ahead = np.flip(ahead, ax) if sign > 0 else ahead
    seen[name] = ahead[tuple(idx.T)] == 0
NORMAL_VIEW = {(0, 0, 1): 'front', (0, 0, -1): 'back', (1, 0, 0): 'left', (-1, 0, 0): 'right'}
NEUTRAL = np.array([90, 90, 100.])
# The sheet's side views are turned a little towards the camera, so they draw the eye on the side of the head:
# head sides within HEAD_BAND blocks of the face take the front view's colour instead (no second face at 3/4).
front_z = np.where(filled.any(2), filled.shape[2] - 1 - np.argmax(filled[:, :, ::-1], 2), -1)
head_y = idx[:, 1].max() - 0.24 * np.ptp(idx[:, 1])
HEAD_BAND = 4
# Like a Minecraft skin, a step's side shows the colour of the face it steps from: +-x faces within BAND blocks
# of the front (back) surface take the front (back) view's colour; side views only paint the deep middle.
import os
BAND = int(os.environ.get('BAND', 2))
pitch = float(np.atleast_1d(grid.pitch)[0])
back_z = np.where(filled.any(2), np.argmax(filled, 2), -1)
arm_l, arm_r, arm_y0, arm_y1 = ARMS
def arm_side(x, y):
    if not arm_y0 <= y <= arm_y1: return 0
    return -1 if x <= arm_l else 1 if x >= arm_r else 0
print(f'arms: x<={arm_l}, x>={arm_r}, y {arm_y0}..{arm_y1}')
def face_color(i, d):
    x, y, z = idx[i]
    side = arm_side(x, y)
    if (x, y, z) in ridge: return ridge[x, y, z]
    if side and d[0]:  # wrap the front (back) view round the arm: deeper into the side, further in on the picture
        for name, depth in sorted((('front', front_z[x, y] - z), ('back', z - back_z[x, y])), key=lambda t: t[1]):
            p = centers[i].copy(); p[0] -= d[0] * depth * pitch
            c = sample(name, p)
            if c is not None and c[2] < c[0] + 30: return c  # not the cape hanging beside it
    band = HEAD_BAND if y >= head_y else BAND
    for name, depth in (('front', front_z[x, y] - z), ('back', z - back_z[x, y])):
        if d[0] and depth < band and seen[name][i]:
            c = sample(name, centers[i])
            if c is not None: return c
    if d[0] and y >= head_y:  # the sheet's turned side views draw an eye there: hair from the back view instead
        p = centers[i].copy(); p[0] -= d[0] * (z - back_z[x, y]) * 0.5 * pitch  # wrap: deeper in the side, further in on the back
        c = sample('back', p)
        if c is not None: return c
    prefer = [NORMAL_VIEW[d]] if d in NORMAL_VIEW else []
    for name in prefer + ['front', 'back', 'left', 'right']:
        if seen[name][i]:
            c = sample(name, centers[i])
            if c is not None: return c
    return None  # hidden from every view: filled in from neighbours below
# Only faces between a filled and an empty voxel; unshared vertices keep every face flat and sharp.
pad = np.pad(filled, 1)
DIRS = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
verts, faces, vcols, quads, keys = [], [], [], [], []
half = grid.pitch[0] / 2 if np.ndim(grid.pitch) else grid.pitch / 2
hidden = []
for i, ((x, y, z), c) in enumerate(zip(idx, centers)):
    for d in DIRS:
        if pad[x + 1 + d[0], y + 1 + d[1], z + 1 + d[2]]: continue
        col = face_color(i, d)
        if col is None: hidden.append(len(quads)); col = NEUTRAL
        col = np.clip(col, 0, 255).astype(np.uint8)
        n = np.array(d, float); a = np.roll(n, 1); b = np.roll(n, 2)
        if n.sum() < 0: a, b = b, a  # keep winding outward
        corners = [c + half * (n + sa * a + sb * b) for sa, sb in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        base = len(verts); verts += corners; vcols += [col] * 4
        faces += [[base, base + 1, base + 2], [base, base + 2, base + 3]]
        quads.append((corners, n, col)); keys.append((x, y, z) + d)
# Faces no camera sees (deep creases) take the nearest seen face's colour.
if hidden:
    mids = np.array([np.mean(q[0], 0) for q in quads]); ok = np.setdiff1d(np.arange(len(quads)), hidden)
    near = ok[cKDTree(mids[ok]).query(mids[hidden])[1]]
    for h, n in zip(hidden, near):
        quads[h] = (quads[h][0], quads[h][1], quads[n][2]); vcols[h * 4:h * 4 + 4] = [quads[n][2]] * 4
print(f'{len(hidden)} hidden faces recoloured')
# A small palette, like the art's: kills the speckle left by sampling noise.
per_quad = Image.fromarray(np.array(vcols[::4], np.uint8)[None])  # one pixel per face, so big areas weigh more
per_quad = np.asarray(per_quad.quantize(PALETTE, method=Image.Quantize.MEDIANCUT, kmeans=1).convert('RGB'))[0]
vcols = list(np.repeat(per_quad, 4, 0))
# Speckle: a face unlike all its same-plane neighbours takes their majority colour, unless it stands out
# strongly (gold on blue, the cross, the emblem: real detail, which plain majority recolouring killed).
at = {k: j for j, k in enumerate(keys)}
lum = per_quad @ np.array([0.299, 0.587, 0.114])
fixed = per_quad.copy()
for j, (x, y, z, *d) in enumerate(keys):
    n = np.array(d); a = np.roll(np.abs(n), 1); b = np.roll(np.abs(n), 2)
    nbs = [at.get(tuple(np.array([x, y, z]) + o) + tuple(d)) for o in (a, -a, b, -b)]
    nbs = [m for m in nbs if m is not None]
    if len(nbs) < 3 or any((per_quad[m] == per_quad[j]).all() for m in nbs): continue
    cols, counts = np.unique(per_quad[nbs], axis=0, return_counts=True)
    major = cols[np.argmax(counts)]
    if counts.max() >= 2 and abs(major @ np.array([0.299, 0.587, 0.114]) - lum[j]) < 40: fixed[j] = major
# Side and top faces carry no fine detail on the sheet: there plain 3x3 majority wins, whatever the contrast.
for _ in range(int(os.environ.get('SIDE_PASSES', 2))):
    src_cols = fixed.copy()
    for j, (x, y, z, *d) in enumerate(keys):
        if d[2]: continue
        n = np.abs(np.array(d)); a = np.roll(n, 1); b = np.roll(n, 2)
        nbs = [at.get(tuple(np.array([x, y, z]) + sa * a + sb * b) + tuple(d)) for sa in (-1, 0, 1) for sb in (-1, 0, 1) if sa or sb]
        nbs = [m for m in nbs if m is not None]
        if len(nbs) < 4: continue
        cols, counts = np.unique(src_cols[nbs], axis=0, return_counts=True)
        if counts.max() >= 4: fixed[j] = cols[np.argmax(counts)]
print(f'{(fixed != per_quad).any(1).sum()} speckled faces cleaned')
per_quad = fixed; vcols = list(np.repeat(per_quad, 4, 0))
quads = [(q[0], q[1], per_quad[k]) for k, q in enumerate(quads)]
# Bake corner shade like the art's: a corner darkens with each filled voxel touching it in front of the face.
pad = np.pad(filled, 1)
AO = np.array([1.0, 0.82, 0.68, 0.55])
shade = []
for (x, y, z) in idx:
    for d in DIRS:
        if pad[x + 1 + d[0], y + 1 + d[1], z + 1 + d[2]]: continue
        n = np.array(d); a = np.roll(n, 1); b = np.roll(n, 2)
        if n.sum() < 0: a, b = b, a
        front = np.array([x + 1, y + 1, z + 1]) + n
        for sa, sb in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            s1 = pad[tuple(front + sa * a)]; s2 = pad[tuple(front + sb * b)]; c = pad[tuple(front + sa * a + sb * b)]
            shade.append(AO[3 if s1 and s2 else int(s1) + int(s2) + int(c)])
vcols = list(np.clip(np.array(vcols, float) * np.array(shade)[:, None], 0, 255).astype(np.uint8))
# glTF COLOR_0 is linear; the image (and the preview below) are sRGB.
srgb = np.array(vcols) / 255
linear = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
voxels = trimesh.Trimesh(np.array(verts), np.array(faces), vertex_colors=np.c_[np.round(linear * 255), np.full(len(vcols), 255)].astype(np.uint8), process=False)
voxels.fix_normals()
voxels.export(out)
print(f'{grid.shape} grid, {len(idx)} voxels, {len(quads)} quads, {len(faces)} tris')

# Preview: painter's algorithm over the quads, orthographic, front / 3-4 / side / back.
W = 420; light = np.array([-0.4, 0.6, 0.7]); light /= np.linalg.norm(light)
center = np.array(verts).mean(0); scale = W * 0.85 / np.ptp(np.array(verts), 0).max()
sheet = Image.new('RGB', (W * 4, W), (30, 32, 38))
for i, yaw in enumerate((0, 35, 90, 180)):
    t = np.radians(yaw); r = np.array([[np.cos(t), 0, np.sin(t)], [0, 1, 0], [-np.sin(t), 0, np.cos(t)]])
    tile = Image.new('RGB', (W, W), (30, 32, 38)); draw = ImageDraw.Draw(tile)
    items = []
    for corners, n, col in quads:
        rn = r @ n
        if rn[2] <= 0: continue
        p = (np.array(corners) - center) @ r.T
        items.append((p[:, 2].mean(), p, col * (0.45 + 0.55 * max(0, rn @ light)) + 0 * rn))
    for _, p, col in sorted(items, key=lambda it: it[0]):
        draw.polygon([(W / 2 + q[0] * scale, W / 2 - q[1] * scale) for q in p], fill=tuple(np.clip(col, 0, 255).astype(int)))
    sheet.paste(tile, (i * W, 0))
sheet.save(preview)
# Faces for the compact exporter (export_glb.py): voxel + direction, palette colour, corner shade.
np.savez(out.replace('.glb', '.faces.npz'), keys=np.array(keys), col=per_quad, shade=np.array(shade).reshape(-1, 4))
