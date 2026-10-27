#!/bin/sh
# Generated meshes (gen_mesh.py: <dir>/<id>.glb + <id>.cut.png) -> public/models/items/<id>.glb, coloured from the art.
# usage: PYTHON=venv/bin/python scripts/items/build-voxel-items.sh <mesh dir> <id>... ; then add the ids to src/config/item-visuals.ts.
set -e
cd "$(dirname "$0")/../.."
DIR=$1; shift
TMP=$(mktemp -d "${TMPDIR:-/tmp}/items.XXXXXX")
for id in "$@"; do
  "${PYTHON:-python3}" scripts/items/voxelize_item.py "$DIR/$id.glb" "$DIR/$id.cut.png" "${RES:-48}" "$TMP/$id" "$TMP/$id.png" >/dev/null
  "${PYTHON:-python3}" scripts/items/knight/export_glb.py "$TMP/$id.faces.npz" "$TMP/$id.raw.glb" "$TMP/$id.atlas.png" "$id" cloth >/dev/null
  node scripts/items/knight/meshopt_pack.mjs "$TMP/$id.raw.glb" "public/models/items/$id.glb"
done
echo "previews: $TMP"
