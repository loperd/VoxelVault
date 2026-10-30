# World packs

Status: experimental format 1, implemented under `packages/blockworld/src/pack/`. Packs are declarative scene data, independent of Voxel Vault. They contain no executable JavaScript, user behaviors or application-specific chest logic.

## Public boundary

`readWorldPack(files, {signal, limits?})` validates bytes in Node or a browser without Three.js/GPU. `PackFiles` maps a relative path and AbortSignal to an ArrayBuffer. `packFilesAt(baseUrl)` provides same-origin, base-confined fetching. `loadPackAssets(pack, {signal})` decodes browser resources, and `packStage(assets, {camera, anchor?})` creates a `StageBuilder` for a view.

Errors aggregate validation problems in `PackError.problems`. A pack must resolve every named block, texture, model, camera and marker; no silent replacement with a stone tile is permitted. Unknown keys are rejected.

## Manifest and coordinates

`pack.json` declares `format: 1`, `requires.blockworld: 1`, ID, author version, optional credits, texture paths, block definitions, structure, models, placed objects, markers, cameras and environment. `version` is an author label, not a loader compatibility test. See `packs/sample-ruin/pack.json` and `packs/color-calibration/pack.json` for complete examples.

Block faces support north/south/east/west/up/down with all/top/bottom/side fallbacks. Custom `parts` use boxes in sixteenths, with optional per-face texture and UV rectangles in 0..16 texels. The engine retains compatibility with its existing box tuples. Arbitrary box rotation is unsupported; the offline importer bakes quarter-turns into geometry and tile orientation.

Free scene objects reference GLB models with position, YXZ rotation in degrees and scalar/xyz scale. They are world-owned, unlike application guests. GLB animation clips are ignored with a warning in format 1. Guest content is not in the pack; a marker only declares its placement.

Manifest object/marker/camera coordinates are relative to the structure; the loader adds `structure.origin`. Markers may include front direction and tags. Cameras select an eye, look target, optional FOV, screen focus and drift. `environment` controls sky, fog, baked block light and shared object/guest light colors with separately calibrated strengths.

`structure.sides` defaults to `open`, allowing side skylight; `closed` represents a dark boundary. This does not change the built-in BlockWorld default.

## Structure encoding

Exactly one of `cells` or `layers` is required:

- `cells` names a headerless little-endian `.u16` file of exactly `2 × sx × sy × sz` bytes. Index order is `x + sx × (y + sy × z)`. Zero is air; value n selects `blocks[n−1]`. Out-of-range IDs are errors. Read with an explicit little-endian DataView rather than host byte order.
- `layers[y][z]` is a row containing exactly `sx` characters. There must be `sy` layers of `sz` rows. `legend` maps characters to block names; `.` is air. This representation is intended for small hand-authored scenes.

Both decode to the same cell buffer contract.

## Data and resource ownership

| Object | Owner and lifetime |
|---|---|
| `WorldPack` | Immutable validated data. Deep-frozen values and protected maps; binary accessors return copies. Normal garbage collection; no release method. |
| `PackAssets` | Caller-owned atlas and decoded GLB templates. Shared read-only by scene instances. Release after all instances are disposed. |
| Pack `Stage` | One mutable root per build/view, world geometry/materials, object clones and lights. Disposed by that view. |

Pack builders use `cache: false`; two views can share PackAssets but never Stage roots. A scene borrows template geometry/materials/textures. Any material it needs to modify is cloned and becomes scene-owned. Scene disposal releases only its own resources and decrements the instance count. `assets.release()` rejects while instances remain alive; building from released assets rejects. Successful repeated disposal/release is harmless.

A failed build releases partial scene allocations before returning an error. Asset loading is all-or-nothing, including cancellation after the last decode step. There are no module-global pack caches. Shared decoded assets reduce JS/decode work, but separate WebGL renderers still have their own GPU allocations.

An asynchronous application adapter registers cleanup before its first await. On route change, abort reading/loading, dispose the view, then release assets. Check cancellation again after awaiting resources; release a late result instead of activating it. If view construction fails, release the loaded assets. A→B→C switches must not allow late A/B to replace C.

## Content hash

`pack.hash` is SHA-256 of canonical file data, including `pack.json`. Sort normalized paths by UTF-8 bytes. For each file, hash `u32LE(pathByteLength)`, UTF-8 path bytes, `u64LE(fileByteLength)` and file bytes. Order of file reads and transport do not change the hash; one changed byte does.

The reader requires `crypto.subtle`. Use HTTPS or a secure localhost context in browsers; missing hashing support is an error, not permission to skip integrity checks.

## Validation limits

The source of truth is `PACK_LIMITS` in `src/pack/read.ts`. These defaults are loader limits, not permanent engine or product limits.

| Resource | Default bound |
|---|---|
| Manifest / whole pack | 256 KiB / 16 MiB |
| Tile PNG | 64 KiB, exactly 16 × 16 pixels |
| Textures / block definitions | 256 / 1,024 |
| Structure | 128 × 64 × 128 cells |
| Models / placed objects | 16 / 256 |
| Markers / cameras | 64 each |
| Triangles | 50,000 per model; 150,000 across placed objects |
| Nodes | 2,000 per model; 20,000 across placed objects |
| Embedded GLB images | At most 8 per model, at most 1,024 × 1,024 |

Paths are normalized relative paths confined to the pack: no traversal, leading slash, backslash or URL scheme. Only declared files with permitted PNG/GLB/U16 roles are read.

PNG loading validates signature, IHDR dimensions/depth/color model, legal chunk order, CRC, palette/transparency rules, contiguous IDAT and final IEND. It supports the bounded 8-bit noninterlaced subset and row filters 0..4. Decompression stops at the expected output length, rejecting both excess and missing data. Unknown critical chunks reject; ancillary color metadata does not change authored tile bytes. Cancellation remains supported.

GLB must be version 2 with exact declared length, one JSON chunk and at most one BIN chunk, aligned lengths, one embedded buffer and no external buffer/image URI. Accessors and views must stay inside BIN. Sparse accessors, skins, morph targets and unsupported primitive modes reject. One scene must own every node exactly once. PNG/JPEG signatures and dimensions are checked.

Allowed glTF extensions are `KHR_materials_unlit`, `KHR_materials_emissive_strength` and `KHR_texture_transform`. Extension checks apply wherever extensions occur, not only `extensionsUsed`. Draco, meshopt, GPU instancing and compressed/external texture plugins are not supported by this pack subset, even though application chest assets may use a different loader contract.

Complexity counts scene node instances, not only unique mesh definitions. A mesh referenced ten times counts ten times; a model placed forty times counts forty times against pack totals.

## Lighting and known transparency limitation

Blocks retain their existing baked color pipeline. Standard GLB material factors remain linear, color textures remain sRGB as assigned by GLTFLoader, and objects render in a separate sRGB-output pass with shared depth. Do not compensate for a color-space bug by altering asset factors or manually applying gamma.

### PBR maps for blocks

A pack may add `<tile>_n` (normal map, OpenGL: green up) and `<tile>_s` (MER: R metalness, G emissive, B roughness) to `textures`, 16×16 like every tile. They are not block tiles: they fill parallel atlases laid out like the main one, and the solid-block shader reads them at the tile's own UV. A tile without a companion gets a flat normal and a dull, unlit material. Relief shades against the stage's sun, metal and smooth tiles take a sun highlight where the baked light reaches, emissive tiles glow on their own. Plants and liquids ignore the maps. A pack with no `_n`/`_s` tiles renders as before.

`environment.light` supplies common key/sky/ground colors; object and guest strengths are distinct because guests use their own look. Objects receive hemisphere/key lights, while baked block light is not affected by those Three.js lights. Unlit/emissive material behavior follows glTF. Cell-light sampling, object shadows and local object lights are not established format-1 features.

The calibration pack compares the same orange tile (`#c86432`) on a block and unlit factor/textured GLB plates. The recorded corrected sample matched `(200,100,50)` for all three. Lit PBR values differ legitimately under lighting; this is not a color-identity assertion for lit surfaces.

Known limitation: liquids are blended in the earlier block pass without writing depth. A GLB object behind water can appear over it without the expected blend. GLB BLEND materials also do not share global sorting with blocks. A separate later liquid pass or changed depth policy needs independent visual/regression review.

## Review and acceptance

```sh
node scripts/world-review.mjs artifacts/world-pack/review sample="pack=sample-ruin&chest=ender"
node scripts/world-review.mjs artifacts/world-pack/lifecycle pair="pack=sample-ruin&views=2&close=1"
```

`/world-review.html` exposes pack diagnostics and repeated load/release checks. `packs/sample-ruin` demonstrates data-driven geometry, objects, markers and cameras; `packs/color-calibration` demonstrates color handling. `scripts/packs/make-sample-ruin.mjs` generates their binary resources and supports variants for data-only comparisons.

Validate independent views, disposal of one while another renders, material/atlas isolation, late cancellation, errors at each construction step, repeated load/release and unchanged built-in world geometry. Replace PNG/GLB/JSON data without TypeScript edits to demonstrate portability. Pixel comparison and actual rendering need browser capture, not only object-level tests.

Credits are author declarations, not proof of licensing. The repository policy accepts original resources and CC0; review provenance separately. Mojang textures remain user-provided local inputs rather than redistributable pack assets.
