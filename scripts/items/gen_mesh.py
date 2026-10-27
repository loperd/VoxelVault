# Image -> untextured mesh with local Hunyuan3D-2mini (colour comes later, from the image itself, in voxelize.py).
# usage: PYTHONPATH=~/projects/tools/Hunyuan3D-2 python gen_mesh.py <out dir> <image.png>...   (writes <out>/<name>.glb)
import os, sys, torch, numpy as np
from PIL import Image
from scipy import ndimage
from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline

TOLERANCE = 28
out, images = sys.argv[1], sys.argv[2:]
CUT_ONLY = os.environ.get('CUT_ONLY')  # preview the cut-outs without loading the model
os.makedirs(out, exist_ok=True)
def cut(path):
    """The generated art sits on a flat blue backdrop with a soft shadow: flood the backdrop from the border, keep the rest."""
    im = Image.open(path).convert('RGB'); rgb = np.asarray(im).astype(float)
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    bg = np.median(border, axis=0)
    # blue-ish and not brighter than the backdrop by much: backdrop and its shadow; item colours leave this box
    near = (np.abs(rgb - bg).max(axis=2) < TOLERANCE) | ((rgb[:, :, 2] > rgb[:, :, 0] + 8) & (rgb.sum(axis=2) < bg.sum() + 30))
    labels, _ = ndimage.label(near)
    edge = set(np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))) - {0}
    mask = ~np.isin(labels, list(edge)) & (np.abs(rgb - bg).max(axis=2) >= 14)  # also the backdrop seen through loops and gaps
    mask = ndimage.binary_opening(mask, iterations=2)
    ys, xs = np.nonzero(mask); pad = 40  # square crop with margin, the pipeline wants the object centred
    cx, cy, half = (xs.min() + xs.max()) // 2, (ys.min() + ys.max()) // 2, max(np.ptp(xs), np.ptp(ys)) // 2 + pad
    rgba = Image.fromarray(np.dstack([rgb.astype(np.uint8), (mask * 255).astype(np.uint8)]), 'RGBA')
    return rgba.crop((cx - half, cy - half, cx + half, cy + half)).resize((1024, 1024), Image.LANCZOS)

pipe = None
for path in images:
    image = cut(path)
    image.save(os.path.join(out, os.path.splitext(os.path.basename(path))[0] + '.cut.png'))
    if CUT_ONLY: continue
    pipe = pipe or Hunyuan3DDiTFlowMatchingPipeline.from_pretrained('tencent/Hunyuan3D-2mini', subfolder='hunyuan3d-dit-v2-mini', variant='fp16', device='mps' if torch.backends.mps.is_available() else 'cpu')
    mesh = pipe(image=image, num_inference_steps=30, generator=torch.manual_seed(1))[0]
    mesh.export(os.path.join(out, os.path.splitext(os.path.basename(path))[0] + '.glb'))
    print('ok', path, flush=True)
