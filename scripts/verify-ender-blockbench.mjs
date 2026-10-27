// Independent runtime loader check. ImageBitmap is a metadata stub here: PNG
// decoding and the actual exported UV appearance are checked by the CPU renderer.
import fs from 'node:fs/promises';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AnimationMixer, Box3 } from 'three';

globalThis.self = globalThis;
globalThis.createImageBitmap = async () => ({ width: 64, height: 64, close() {} });
globalThis.ProgressEvent = class {
  constructor(type, data) {
    this.type = type;
    Object.assign(this, data);
  }
};

for (const variant of ['relic', 'rune']) {
  const folder = `assets/chests/blockbench-ender/${variant}`;
  const raw = await fs.readFile(`${folder}/${variant}-ender-chest.glb`);
  const gltf = await new GLTFLoader().parseAsync(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    '',
  );
  const bb = JSON.parse(await fs.readFile(`${folder}/${variant}-ender-chest.bbmodel`, 'utf8'));
  const elements = new Set(bb.elements.map((part) => part.uuid));
  const children = bb.outliner.flatMap((group) => group.children);
  if (
    children.length !== elements.size ||
    new Set(children).size !== elements.size ||
    children.some((id) => !elements.has(id))
  )
    throw Error('Invalid Blockbench outliner');
  if (!bb.textures[0].source.startsWith('data:image/png;base64,'))
    throw Error('Missing embedded authoring texture');
  const bounds = new Box3().setFromObject(gltf.scene);
  const lid = gltf.scene.getObjectByName('LidAssembly');
  if (!gltf.scene.getObjectByName('Body') || !lid) throw Error('Missing assemblies');
  const clip = gltf.animations.find((clip) => clip.name === 'Vault.Open');
  if (!clip || clip.duration !== 1) throw Error('Missing opening clip');
  const mixer = new AnimationMixer(gltf.scene);
  mixer.clipAction(clip).play();
  mixer.setTime(0.999);
  if (lid.quaternion.x < 0.7) throw Error('Lid fails to open upwards');
  const report = {
    variant,
    threeLoader: 'pass',
    blockbenchStructure: 'pass',
    bounds: { min: bounds.min, max: bounds.max },
    animations: gltf.animations.map((clip) => ({ name: clip.name, duration: clip.duration })),
    lidQuaternion: lid.quaternion.toArray(),
    limitation: 'No GUI/WebGL verification; ImageBitmap metadata stub in Node.',
  };
  await fs.writeFile(
    `artifacts/ender-blockbench/${variant}/three-loader-check.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(`${variant}: GLTFLoader, assemblies, opening animation and bbmodel structure passed`);
}
