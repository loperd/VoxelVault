// knight.glb (export_glb.py) -> same GLB with geometry under EXT_meshopt_compression; three decodes it via MeshoptDecoder.
// usage: node meshopt_pack.mjs <in.glb> <out.glb>
import { readFile, writeFile } from 'node:fs/promises';
import { MeshoptEncoder } from 'meshoptimizer';

const [src, out] = process.argv.slice(2);
const glb = await readFile(src);
const jsonLength = glb.readUInt32LE(12), gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString());
const bin = glb.subarray(20 + jsonLength + 8);
await MeshoptEncoder.ready;

const pad4 = b => Buffer.concat([b, Buffer.alloc(-b.length % 4 & 3)]);
const chunks = [];
let offset = 0;
const views = gltf.bufferViews.map((view, i) => {
  const raw = bin.subarray(view.byteOffset, view.byteOffset + view.byteLength);
  const target = view.target;
  let data = raw, ext;
  if (target === 34962 || target === 34963) {  // vertex attributes and indices go compressed into buffer 0; buffer 1 is the empty fallback
    const stride = view.byteStride ?? (i === 1 ? 4 : 2);
    const count = view.byteLength / stride;
    const mode = target === 34963 ? 'TRIANGLES' : 'ATTRIBUTES';
    const encoded = mode === 'TRIANGLES'
      ? MeshoptEncoder.encodeIndexBuffer(new Uint8Array(raw), count, stride)
      : MeshoptEncoder.encodeVertexBuffer(new Uint8Array(raw), count, stride);
    data = Buffer.from(encoded);
    ext = { EXT_meshopt_compression: { buffer: 0, byteOffset: offset, byteLength: data.length, byteStride: stride, count, mode } };
  }
  const placed = { byteOffset: offset, byteLength: data.length };
  chunks.push(pad4(data)); offset += pad4(data).length;
  if (!ext) return { ...view, buffer: 0, ...placed };
  const { byteStride, target: t } = view;
  return { buffer: 1, byteOffset: 0, byteLength: view.byteLength, ...(byteStride && { byteStride }), ...(t && { target: t }), extensions: ext };
});
// Fallback views share one uri-less buffer as big as the largest of them (the spec allows the loader to skip it).
const fallback = Math.max(...views.filter(v => v.buffer === 1).map(v => v.byteLength));
gltf.bufferViews = views;
gltf.buffers = [{ byteLength: offset }, { byteLength: fallback, extensions: { EXT_meshopt_compression: { fallback: true } } }];
for (const key of ['extensionsUsed', 'extensionsRequired']) gltf[key] = [...gltf[key], 'EXT_meshopt_compression'];

const body = Buffer.concat(chunks);
let js = Buffer.from(JSON.stringify(gltf)); js = Buffer.concat([js, Buffer.alloc(-js.length & 3, 0x20)]);
const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + 8 + body.length, 8);
const chunk = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
await writeFile(out, Buffer.concat([header, chunk(js.length, 0x4e4f534a), js, chunk(body.length, 0x004e4942), body]));
console.log(`${glb.length} B -> ${12 + 16 + js.length + body.length} B`);
