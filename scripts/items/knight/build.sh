#!/bin/sh
# Rebuilds public/models/items/knight.glb from assets/items/knight (the generated mesh + the four turnaround views).
# Python needs numpy, scipy, trimesh, pillow: PYTHON=path/to/venv/bin/python scripts/items/knight/build.sh
# After a rebuild, bump the knight's revision in src/config/item-visuals.ts.
set -e
cd "$(dirname "$0")/../../.."
SRC=assets/items/knight
TMP=$(mktemp -d "${TMPDIR:-/tmp}/knight.XXXXXX")
ARM=2 RIDGE=1 "${PYTHON:-python3}" scripts/items/knight/voxelize.py $SRC/knight.glb $SRC/knight 72 "$TMP/vox.glb" "$TMP/preview.png"
"${PYTHON:-python3}" scripts/items/knight/export_glb.py "$TMP/vox.faces.npz" "$TMP/knight.glb" "$TMP/atlas.png"
node scripts/items/knight/meshopt_pack.mjs "$TMP/knight.glb" public/models/items/knight.glb
echo "preview: $TMP/preview.png"
