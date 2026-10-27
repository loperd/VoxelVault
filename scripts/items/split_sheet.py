# A 2x2 sheet of orthographic views (front, back, left, top; ChatGPT draws them) -> <out>-{front,back,side}.png cut-outs for voxelize_views.py.
# usage: split_sheet.py <sheet.png> <out prefix> [bridge px: close vertical gaps up to this long, for a dark grip nearly the backdrop's colour]
import sys, numpy as np
from PIL import Image
from scipy import ndimage
BRIDGE = int(sys.argv[3]) if len(sys.argv) > 3 else 0
sheet = Image.open(sys.argv[1]).convert('RGB'); out = sys.argv[2]; W, H = sheet.size; w, h = W // 2, H // 2
def cut(im):
    rgb = np.asarray(im).astype(float)
    bg = np.median(np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]]), 0)
    d = np.abs(rgb - bg).max(2)
    m = ndimage.binary_opening((d > 60) | ((d > 16) & (rgb[..., 2] - rgb[..., 0] < 28)))  # bright or blue = the glow itself; the halo is dim and blue, the dark metal is dim and neutral
    lab, _ = ndimage.label(m); sizes = ndimage.sum(m, lab, range(1, lab.max() + 1))
    m = ndimage.binary_closing(np.isin(lab, 1 + np.flatnonzero(sizes > max(150, 0.02 * sizes.max()))), iterations=2)  # the sword's pieces, not stray specks
    if BRIDGE: m = ndimage.binary_closing(m, structure=np.ones((BRIDGE, 1)))  # the dark grip between guard and pommel is nearly the backdrop: bridge it along the sword
    m = ndimage.binary_fill_holes(m)
    return Image.fromarray(np.dstack([rgb.astype(np.uint8), (m * 255).astype(np.uint8)]), 'RGBA')
for name, (cx, cy) in {'front': (0, 0), 'back': (1, 0), 'side': (0, 1)}.items():
    tile = sheet.crop((cx * w + 6, cy * h + 6, (cx + 1) * w - 6, (cy + 1) * h - 30))  # panel line and the caption go
    im = cut(tile); im.save(f'{out}-{name}.png'); print(name, im.size, np.asarray(im)[..., 3].astype(bool).sum())
