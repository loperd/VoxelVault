# Orthographic views of an item (cut-outs, upright) -> crisp voxel item: the volume is the intersection of the silhouettes, each face
# takes the colour from the view it faces. No generated mesh: the drawn outlines are the truth.
# views: <prefix>-front.png, -back.png, -side.png (seen from +x, left/right mirrored); the item faces +z and stands on y.
# usage: voxelize_views.py <views prefix> <res (voxels tall)> <out prefix> <preview.png>
# the blade: COVER=0.3 AOK=0.4 voxelize_views.py assets/items/_in/views/relic-phase-blade 192 <out> <preview.png>; then export_glb.py + meshopt_pack.mjs as build-voxel-items.sh does.
# AOK<1 softens the corner shade (glowing art stays bright); COVER<0.5 keeps thin tips.
import os, sys, numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import cKDTree

prefix, res, out, preview = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
PALETTE, BACK = int(os.environ.get('PALETTE', 96)), float(os.environ.get('BACK', 0.85))
COVER = float(os.environ.get('COVER', 0.5))  # share of a voxel's patch the drawing must fill
V = {}
for name in ('front', 'back', 'side'):
    im = np.asarray(Image.open(f'{prefix}-{name}.png').convert('RGBA')).astype(float)
    ys, xs = np.nonzero(im[..., 3] > 128)
    V[name] = dict(im=im, cx=(xs.min() + xs.max()) / 2, y1=ys.max() + 1, h=ys.max() + 1 - ys.min(), w=xs.max() + 1 - xs.min())
for v in V.values(): v['s'] = v['h'] / res  # every view draws the item the same height: px per voxel
nx = int(np.ceil(max(V['front']['w'] / V['front']['s'], V['back']['w'] / V['back']['s']))) + 2
nz = int(np.ceil(V['side']['w'] / V['side']['s'])) + 2

def px(name, h, y):  # image coordinates of a voxel's centre on the view's horizontal axis h (voxel units, from the middle) and row y
    v = V[name]; return v['cx'] + h * v['s'], v['y1'] - (y + .5) * v['s']
def patch(name, h, y):
    v = V[name]; u, r = px(name, h, y); half = max(1, v['s'] / 2)
    a = v['im'][max(0, int(r - half)):int(r + half) + 1, max(0, int(u - half)):int(u + half) + 1].reshape(-1, 4)
    return a
def covered(name, h, y):
    a = patch(name, h, y); return len(a) and (a[:, 3] > 128).mean() >= COVER
def colour(name, h, y):
    a = patch(name, h, y); a = a[a[:, 3] > 128]
    return np.median(a[:, :3], 0) if len(a) else None

filled = np.zeros((nx, res, nz), bool)
for x in range(nx):
    for y in range(res):
        for z in range(nz):
            xc, zc = x - nx / 2 + .5, z - nz / 2 + .5
            filled[x, y, z] = covered('front', xc, y) and covered('back', -xc, y) and covered('side', -zc, y)
labels, n = ndimage.label(filled)
filled = labels == np.argmax(ndimage.sum(filled, labels, range(1, n + 1))) + 1
pad = np.pad(filled, 1)
DIRS = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
keys, cols = [], []
for x, y, z in np.argwhere(filled):
    xc, zc = x - nx / 2 + .5, z - nz / 2 + .5
    for d in DIRS:
        if pad[x + 1 + d[0], y + 1 + d[1], z + 1 + d[2]]: continue
        c = None
        if d[2] > 0: c = colour('front', xc, y)
        elif d[2] < 0: c = colour('back', -xc, y)
        elif d[0] != 0: c = colour('side', -zc, y)  # -x shares +x's pixels: left and right are mirrors
        keys.append((x, y, z) + d); cols.append(c)
mid = np.array([[k[0] + .5 + k[3] * .5, k[1] + .5 + k[4] * .5, k[2] + .5 + k[5] * .5] for k in keys])
known = np.array([c is not None for c in cols])
for j, k in zip(np.flatnonzero(~known), np.flatnonzero(known)[cKDTree(mid[known]).query(mid[~known])[1]]): cols[j] = cols[k] * BACK  # tops and bottoms: the nearest seen face
col = np.array(cols, np.uint8)
col = np.asarray(Image.fromarray(col[None]).quantize(PALETTE, method=Image.Quantize.MEDIANCUT, kmeans=1).convert('RGB'))[0]

AO = np.array([1.0, 0.82, 0.68, 0.55]) ** float(os.environ.get("AOK", 1)); shade = []  # corner shade as voxelize_item.py
for (x, y, z, *d) in keys:
    n_ = np.array(d); a = np.roll(n_, 1); b = np.roll(n_, 2)
    if n_.sum() < 0: a, b = b, a
    front = np.array([x + 1, y + 1, z + 1]) + n_
    for sa, sb in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        s1 = pad[tuple(front + sa * a)]; s2 = pad[tuple(front + sb * b)]; c = pad[tuple(front + sa * a + sb * b)]
        shade.append(AO[3 if s1 and s2 else int(s1) + int(s2) + int(c)])
np.savez(out + '.faces.npz', keys=np.array(keys), col=col, shade=np.array(shade).reshape(-1, 4))

W = 360; light = np.array([-0.4, 0.6, 0.7]); light /= np.linalg.norm(light)  # preview: painter's algorithm, three views
size = np.array(filled.shape); scl = W * 0.85 / size.max()
sheet = Image.new('RGB', (W * 3, W), (30, 32, 38))
for t_i, yaw in enumerate((0, 35, 150)):
    t = np.radians(yaw); r = np.array([[np.cos(t), 0, np.sin(t)], [0, 1, 0], [-np.sin(t), 0, np.cos(t)]])
    pt = np.radians(float(os.environ.get('PITCH', 12))); r = np.array([[1, 0, 0], [0, np.cos(pt), -np.sin(pt)], [0, np.sin(pt), np.cos(pt)]]) @ r
    draw = ImageDraw.Draw(tile := Image.new('RGB', (W, W), (30, 32, 38))); items = []
    for (x, y, z, *d), c in zip(keys, col):
        n_ = np.array(d, float); rn = r @ n_
        if rn[2] <= 0: continue
        a = np.roll(n_, 1); b = np.roll(n_, 2)
        if n_.sum() < 0: a, b = b, a
        centre = np.array([x + .5, y + .5, z + .5]) + n_ * .5
        p = np.array([(centre + .5 * (sa * a + sb * b) - size / 2) @ r.T for sa, sb in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
        items.append((p[:, 2].mean(), p, c * (0.45 + 0.55 * max(0, rn @ light))))
    for _, p, c in sorted(items, key=lambda it: it[0]):
        draw.polygon([(W / 2 + q[0] * scl, W / 2 - q[1] * scl) for q in p], fill=tuple(np.clip(c, 0, 255).astype(int)))
    sheet.paste(tile, (t_i * W, 0))
sheet.save(preview)
print(f'{filled.shape} grid, {int(filled.sum())} voxels, {len(keys)} faces')
