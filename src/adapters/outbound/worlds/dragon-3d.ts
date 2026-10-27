import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  Vector3,
} from 'three';
import {
  BlockRegistry,
  BlockWorld,
  blockAtlas,
  computeLight,
  meshWorld,
  worldMeshes,
  type Living,
  type Stage,
  type StageBuilder,
} from '../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../application/ports/chest-handles.ts';
import { driftingMotes, fbm } from './end-3d.ts';
import { dragonFlight, dragonModel } from './dragon-actor.ts';

type DragonActor = Living<ChestHandles>;

/**
 * The dragon's reach ("Предел Дракона"): the end of the End — the chest stands in the exit portal's
 * bedrock frame on the main island, a ring of obsidian towers around it with crystals on top, pink
 * healing beams reaching from them to the dragon circling overhead. Now and then the dragon sweeps
 * low over the chest: a heavy shake, a blast of air, violet light.
 */
const BLOCKS = new BlockRegistry([
  { name: 'end_stone', textures: { all: 'end_stone' } },
  { name: 'obsidian', textures: { all: 'obsidian' } },
  { name: 'bedrock', textures: { all: 'bedrock' } },
  // The bedrock a crystal burns on: it lights the tower top as the crystal would.
  { name: 'crystal_base', textures: { all: 'bedrock' }, light: 13 },
]);
const B = {
  Stone: BLOCKS.id('end_stone'),
  Obsidian: BLOCKS.id('obsidian'),
  Bedrock: BLOCKS.id('bedrock'),
  Base: BLOCKS.id('crystal_base'),
};
const SX = 144,
  SY = 48,
  SZ = 144,
  OX = -72,
  OZ = -72,
  FLOOR = 12;
const CHEST = [0.5, FLOOR + 1, 0.5] as const;
const EYE = [CHEST[0], CHEST[1] + 2.45, CHEST[2] + 9] as const;

function build(seed: number): Stage<ChestHandles> {
  let state = seed * 7919 + 13;
  const rand = () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
  const grid = new BlockWorld(SX, SY, SZ, [OX, 0, OZ]);
  // The main island: a broad, gently domed top over a hanging underside.
  for (let gx = 0; gx < SX; gx++)
    for (let gz = 0; gz < SZ; gz++) {
      const x = gx + OX,
        z = gz + OZ,
        d = Math.hypot(x, z) / 64 + (fbm(x / 11, z / 11, seed) - 0.5) * 0.25;
      if (d >= 1) continue;
      const top = FLOOR - Math.round(Math.max(0, d - 0.3) * 7);
      for (let y = Math.max(0, Math.floor(top - 3 - Math.pow(1 - d, 0.7) * 26)); y <= top; y++)
        grid.set(gx, y, gz, B.Stone);
    }
  // The exit portal: a bedrock disc under the chest, its rim raised only behind it so the chest stays in full view.
  for (let x = -4; x <= 4; x++)
    for (let z = -4; z <= 4; z++) {
      const r = Math.hypot(x, z),
        gx = x - OX,
        gz = z - OZ;
      if (r > 3.8) continue;
      grid.set(gx, FLOOR, gz, B.Bedrock);
      if (r > 2.6 && z < 0) grid.set(gx, FLOOR + 1, gz, B.Bedrock);
    }
  // The tower ring; none stands between the camera and the chest (camera on +z).
  const towers: { x: number; z: number; top: number }[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.3,
      x = Math.round(Math.sin(a) * 46),
      z = Math.round(-Math.cos(a) * 46);
    if (z > 6 && Math.abs(x) < 20) continue;
    const radius = 2 + (i % 3),
      top = FLOOR + 7 + Math.floor(rand() * 8);
    for (let y = FLOOR - 4; y < top; y++)
      for (let dx = -radius; dx <= radius; dx++)
        for (let dz = -radius; dz <= radius; dz++) {
          if (dx * dx + dz * dz <= radius * radius + 1)
            grid.set(x + dx - OX, y, z + dz - OZ, B.Obsidian);
        }
    grid.set(x - OX, top, z - OZ, B.Base);
    towers.push({ x: x + 0.5, z: z + 0.5, top: top + 1 });
  }
  computeLight(grid, BLOCKS);
  const { texture, uv } = blockAtlas();
  const root = new Group();
  root.add(
    ...worldMeshes(
      meshWorld(grid, BLOCKS, {
        uv,
        sky: [0.55, 0.5, 0.68],
        glow: [1, 0.55, 0.9],
        minimum: 0.08,
        sun: { direction: [-0.4, 0.75, 0.5], color: [0.7, 0.62, 0.85], strength: 0.25, reach: 24 },
      }),
      texture,
    ),
  );
  const dragon = dragonModel(root);
  return {
    root,
    calm: 0.06,
    living: [
      crystals(root, towers, dragon),
      dragonFlight(dragon, { floor: FLOOR }),
      driftingMotes(root, rand),
    ],
    sky: { top: '#06070f', horizon: '#2a1d3a', bottom: '#0e0b18' },
    fog: { color: '#1e1730', near: 50, far: 200 },
    camera: {
      position: EYE,
      target: [CHEST[0], CHEST[1] + 0.75, CHEST[2]],
      fov: 50,
      drift: 0.1,
      focus: [0.5, 0.44],
    },
    anchor: CHEST,
    light: { sky: '#d8c8f0', ground: '#352c48', key: '#f4e4ff', from: [0.4, 0.7, 1] },
    ground: { blocks: { world: grid, registry: BLOCKS, around: [CHEST[0], CHEST[2]], radius: 6 } },
  };
}

/** End crystals over the tower tops: they bob and turn; a pink beam from each reaches the dragon. */
function crystals(
  root: Group,
  towers: readonly { x: number; z: number; top: number }[],
  dragon: ReturnType<typeof dragonModel>,
): DragonActor {
  const core = new MeshBasicMaterial({ color: '#f07bd4' }),
    cage = new MeshBasicMaterial({ color: '#3a1d4f', wireframe: true });
  const beam = new LineBasicMaterial({
    color: '#ff8fe0',
    transparent: true,
    opacity: 0.55,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const items = towers.map((t) => {
    const group = new Group();
    group.position.set(t.x, t.top + 1.2, t.z);
    group.add(
      new Mesh(new BoxGeometry(0.8, 0.8, 0.8), core),
      new Mesh(new BoxGeometry(1.5, 1.5, 1.5), cage),
    );
    const geometry = new BufferGeometry().setFromPoints([new Vector3(), new Vector3()]);
    const line = new Line(geometry, beam);
    root.add(group, line);
    return { group, line, y: t.top + 1.2, phase: t.x * 0.37 };
  });
  return {
    update(context) {
      const target = dragon.group.position;
      for (const c of items) {
        c.group.position.y = c.y + Math.sin(context.time * 2 + c.phase) * 0.3;
        c.group.rotation.set(context.time * 0.9 + c.phase, context.time * 1.3, 0);
        const at = c.line.geometry.attributes.position!;
        at.setXYZ(0, c.group.position.x, c.group.position.y, c.group.position.z);
        at.setXYZ(1, target.x, target.y, target.z);
        at.needsUpdate = true;
        c.line.geometry.computeBoundingSphere();
      }
    },
  };
}

export const DRAGON_3D: StageBuilder<ChestHandles> = { id: 'dragon-3d', build };
