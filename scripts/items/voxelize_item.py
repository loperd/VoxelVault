# One generated mesh + the art it came from -> crisp voxel item, coloured from that single picture.
# The art is drawn from the front (gen_mesh.py treats it so): a voxel's column takes the colour under it, faces behind take the
# nearest seen face's, darker. Writes <out>.faces.npz for export_glb.py and a preview png.
# usage: voxelize_item.py <mesh.glb> <cut.png> <res (voxels, longest side)> <out prefix> <preview.png>
import sys, numpy as np, trimesh
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import cKDTree

src, art, res, out, preview = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], sys.argv[5]
import os
PALETTE, BACK = int(os.environ.get('PALETTE', 32)), float(os.environ.get('BACK', 0.7))
mesh = trimesh.load(src, force='mesh')

# The generator turns an item into its own canonical pose (a diagonal blade comes out horizontal): turn the mesh in the picture's
# plane (about z, optionally with a half turn about y) until its silhouette best covers the drawing's. ROT=<degrees> overrides.
def fit_pose():
    a = np.asarray(Image.open(art).convert('RGBA'))[..., 3] > 128
    ys, xs = np.nonzero(a); a = a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    N = 96; k = (N - 1) / max(a.shape)
    def raster(p):  # points or mask -> NxN mask, longest side fitted, centred
        if p.dtype == bool: m = np.asarray(Image.fromarray(p).resize((max(1, round(p.shape[1] * k)), max(1, round(p.shape[0] * k)))))
        else:
            q = (p - p.min(0)) * (N - 1) / np.ptp(p, 0).max(); w, h = np.ptp(q, 0).astype(int) + 1
            m = np.zeros((h, w), bool); m[(h - 1 - q[:, 1]).astype(int), q[:, 0].astype(int)] = True
            m = ndimage.binary_fill_holes(ndimage.binary_closing(m, iterations=2))
        out = np.zeros((N, N), bool); y, x = (N - m.shape[0]) // 2, (N - m.shape[1]) // 2; out[y:y + m.shape[0], x:x + m.shape[1]] = m
        return out
    target, pts = raster(a), mesh.sample(30000)
    best = (-1, 0, 1)
    for flip in (1, -1):
        for deg in range(0, 360, 3):
            t = np.radians(deg); c, s = np.cos(t), np.sin(t)
            p = np.c_[flip * (pts[:, 0] * c - pts[:, 1] * s), pts[:, 0] * s + pts[:, 1] * c]
            m = raster(p); iou = (m & target).sum() / (m | target).sum()
            if iou > best[0]: best = (iou, deg, flip)
    return best
iou, deg, flip = fit_pose()
if os.environ.get('ROT'): deg, flip = float(os.environ['ROT']), int(os.environ.get('FLIP', 1))
t = np.radians(deg); c, s = np.cos(t), np.sin(t)
mesh.apply_transform(np.array([[flip * c, -flip * s, 0, 0], [s, c, 0, 0], [0, 0, flip, 0], [0, 0, 0, 1]]))
print(f'pose: {deg} deg, flip {flip}, silhouette IoU {iou:.2f}')
lo, hi = mesh.bounds
grid = mesh.voxelized(pitch=np.ptp(mesh.bounds, 0).max() / res).fill()
filled = grid.matrix.copy()  # [x, y, z]
labels, n = ndimage.label(filled)
filled = labels == np.argmax(ndimage.sum(filled, labels, range(1, n + 1))) + 1  # crumbs the generator left floating
idx = np.argwhere(filled)
CARVE = float(os.environ.get('CARVE', 0)) * 255  # >0: drop blocks the drawing does not cover (as the knight's views do), like the generator's lumps

# The art is drawn from slightly above (ELEV degrees), so a point (x, y, z) lands at u = x, v = y cos - z sin; the art's opaque
# box maps onto the mesh's projected box, one scale for both axes, centred.
import os
E = np.radians(float(os.environ.get('ELEV', 25))); cE, sE = np.cos(E), np.sin(E)
im = np.asarray(Image.open(art).convert('RGBA')).astype(float)
ys, xs = np.nonzero(im[..., 3] > 128)
x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
proj = lambda p: np.c_[p[:, 0], p[:, 1] * cE - p[:, 2] * sE]
pts = proj(idx + .5); pl, ph = pts.min(0) - .5, pts.max(0) + .5  # a voxel is one unit wide on screen
scale = min((x1 - x0) / (ph[0] - pl[0]), (y1 - y0) / (ph[1] - pl[1]))
cx, cy = (x0 + x1) / 2, (y0 + y1) / 2; mx, my = (pl + ph) / 2
near_y, near_x = ndimage.distance_transform_edt(im[..., 3] <= 128, return_indices=True)[1]  # nearest drawn pixel, for points the mesh has beyond the silhouette
def sample(p):  # the median of the art under a point (snapped onto the drawing when the mesh sticks out of it)
    u, v = cx + (p[0] - mx) * scale, cy - (p[1] - my) * scale; r = max(1, int(scale / 4))
    u, v = int(np.clip(u, 0, im.shape[1] - 1)), int(np.clip(v, 0, im.shape[0] - 1))
    v, u = near_y[v, u], near_x[v, u]
    a = im[max(0, v - r):v + r + 1, max(0, u - r):u + r + 1].reshape(-1, 4)
    a = a[a[:, 3] > 128]
    return np.median(a[:, :3], 0)

if CARVE:
    def covered(p):
        u, v = cx + (p[0] - mx) * scale, cy - (p[1] - my) * scale; r = max(1, int(scale / 3))
        if not (0 <= u < im.shape[1] and 0 <= v < im.shape[0]): return 0
        return im[max(0, int(v) - r):int(v) + r + 1, max(0, int(u) - r):int(u) + r + 1, 3].mean()
    for (x, y, z), p in zip(idx, proj(idx + .5)):
        if covered(p) < CARVE: filled[x, y, z] = False
    labels, n = ndimage.label(filled)
    filled = labels == np.argmax(ndimage.sum(filled, labels, range(1, n + 1))) + 1
    idx = np.argwhere(filled)

# A face is seen when it looks towards the camera (the up-front side) and nothing filled lies between it and the camera.
toward = np.array([0, sE, cE]); pad = np.pad(filled, 1)
def clear(cell):
    for t in range(1, 4 * res):
        q = np.round(cell + t * toward * 0.5).astype(int) + 1
        if not (0 <= q[0] < pad.shape[0] and 0 <= q[1] < pad.shape[1] and 0 <= q[2] < pad.shape[2]): return True
        if pad[tuple(q)]: return False
    return True
DIRS = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
keys, cols = [], []
for (x, y, z) in idx:
    for d in DIRS:
        if pad[x + 1 + d[0], y + 1 + d[1], z + 1 + d[2]]: continue
        c = None
        if np.dot(d, toward) >= 0 and clear(np.array([x, y, z]) + d):
            c = sample(proj(np.array([[x + .5 + d[0] * .5, y + .5 + d[1] * .5, z + .5 + d[2] * .5]]))[0])
        keys.append((x, y, z) + d); cols.append(c)
mid = np.array([[k[0] + .5 + k[3] * .5, k[1] + .5 + k[4] * .5, k[2] + .5 + k[5] * .5] for k in keys])
known = np.array([c is not None for c in cols])
near = np.flatnonzero(known)[cKDTree(mid[known]).query(mid[~known])[1]]  # faces the camera does not see: nearest seen face, darker
for j, k in zip(np.flatnonzero(~known), near): cols[j] = cols[k] * BACK
col = np.array(cols, np.uint8)
col = np.asarray(Image.fromarray(col[None]).quantize(PALETTE, method=Image.Quantize.MEDIANCUT, kmeans=1).convert('RGB'))[0]

# Corner shade like the art's: a corner darkens with each filled voxel touching it in front of the face.
AO = np.array([1.0, 0.82, 0.68, 0.55]); shade = []
for (x, y, z, *d) in keys:
    n = np.array(d); a = np.roll(n, 1); b = np.roll(n, 2)
    if n.sum() < 0: a, b = b, a
    front = np.array([x + 1, y + 1, z + 1]) + n
    for sa, sb in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        s1 = pad[tuple(front + sa * a)]; s2 = pad[tuple(front + sb * b)]; c = pad[tuple(front + sa * a + sb * b)]
        shade.append(AO[3 if s1 and s2 else int(s1) + int(s2) + int(c)])
np.savez(out + '.faces.npz', keys=np.array(keys), col=col, shade=np.array(shade).reshape(-1, 4))

# Preview: painter's algorithm, three views.
W = 360; light = np.array([-0.4, 0.6, 0.7]); light /= np.linalg.norm(light)
size = np.array(filled.shape); scl = W * 0.8 / size.max()
sheet = Image.new('RGB', (W * 3, W), (30, 32, 38))
for t_i, yaw in enumerate((0, 35, 150)):
    t = np.radians(yaw); r = np.array([[np.cos(t), 0, np.sin(t)], [0, 1, 0], [-np.sin(t), 0, np.cos(t)]])
    pt = np.radians(float(os.environ.get('PITCH', 25))); r = np.array([[1, 0, 0], [0, np.cos(pt), -np.sin(pt)], [0, np.sin(pt), np.cos(pt)]]) @ r  # looking down
    draw = ImageDraw.Draw(tile := Image.new('RGB', (W, W), (30, 32, 38))); items = []
    for (x, y, z, *d), c in zip(keys, col):
        n = np.array(d, float); rn = r @ n
        if rn[2] <= 0: continue
        a = np.roll(n, 1); b = np.roll(n, 2)
        if n.sum() < 0: a, b = b, a
        centre = np.array([x + .5, y + .5, z + .5]) + n * .5
        p = np.array([(centre + .5 * (sa * a + sb * b) - size / 2) @ r.T for sa, sb in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
        items.append((p[:, 2].mean(), p, c * (0.45 + 0.55 * max(0, rn @ light))))
    for _, p, c in sorted(items, key=lambda it: it[0]):
        draw.polygon([(W / 2 + q[0] * scl, W / 2 - q[1] * scl) for q in p], fill=tuple(np.clip(c, 0, 255).astype(int)))
    sheet.paste(tile, (t_i * W, 0))
sheet.save(preview)
print(f'{filled.shape} grid, {len(idx)} voxels, {len(keys)} faces')
