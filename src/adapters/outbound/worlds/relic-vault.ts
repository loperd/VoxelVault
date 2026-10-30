import {
  BoxGeometry,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
} from 'three';
import type { StageBuilder } from '../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../application/ports/chest-handles.ts';

/** A quiet containment chamber: the relic is the focus, no additional downloads or lights per tile. */
export const RELIC_VAULT: StageBuilder<ChestHandles> = {
  id: 'relic-containment-v1',
  build() {
    const root = new Group();
    root.name = 'relic-containment';
    const geometry = new BoxGeometry(1, 1, 1);
    const stone = new MeshStandardMaterial({ color: '#17232d', roughness: 0.68, metalness: 0.15 });
    const trim = new MeshStandardMaterial({ color: '#44616a', roughness: 0.4, metalness: 0.75 });
    const energy = new MeshBasicMaterial({ color: '#4bdac8', toneMapped: false });
    type Box = readonly [number, number, number, number, number, number];
    const batch = (name: string, material: typeof stone | typeof energy, boxes: readonly Box[]) => {
      const mesh = new InstancedMesh(geometry, material, boxes.length);
      mesh.name = name;
      for (const [i, [x, y, z, w, h, d]] of boxes.entries()) {
        const matrix = new Matrix4().makeScale(w, h, d);
        matrix.setPosition(x, y, z);
        mesh.setMatrixAt(i, matrix);
      }
      mesh.castShadow = material !== energy;
      mesh.receiveShadow = material !== energy;
      root.add(mesh);
    };
    const tiles: Box[] = [];
    for (let x = -5; x <= 5; x++)
      for (let z = -8; z <= 4; z++) tiles.push([x * 1.4, -0.2, z * 1.4, 1.36, 0.4, 1.36]);
    batch('containment-floor', stone, tiles);
    batch('relic-plinth', trim, [
      [0, 0.1, 0, 3.2, 0.2, 3.2],
      [0, 0.24, 0, 2.7, 0.08, 2.7],
    ]);
    const frame: Box[] = [],
      strips: Box[] = [];
    for (const side of [-1, 1]) {
      frame.push([side * 4.5, 3, -4, 0.7, 6, 0.9], [side * 3.3, 2.3, -7.5, 0.5, 4.6, 0.8]);
      strips.push(
        [side * 4.5, 3.2, -3.53, 0.09, 4.8, 0.025],
        [side * 3.3, 2.5, -7.08, 0.07, 3.3, 0.025],
        [side * 1.55, 0.205, 0, 0.04, 0.015, 2.8],
        [side * 3.2, 0.008, -0.5, 0.035, 0.015, 10],
      );
    }
    frame.push([0, 6, -4, 9.7, 0.5, 0.9], [0, 4.6, -7.5, 7.1, 0.4, 0.8]);
    strips.push([0, 5.73, -3.53, 8.4, 0.055, 0.025], [0, 0.205, 1.55, 2.8, 0.015, 0.04]);
    batch('containment-frames', trim, frame);
    batch('containment-energy', energy, strips);
    root.add(new HemisphereLight('#a4c9df', '#18232f', 2));
    return {
      root,
      living: [],
      calm: 0,
      sky: { top: '#050d19', horizon: '#102b37', bottom: '#0a1420' },
      fog: { color: '#102332', near: 16, far: 48 },
      camera: {
        position: [0, 2.73, 9],
        target: [0, 1.03, 0],
        fov: 50,
        drift: 0.025,
        focus: [0.5, 0.44],
      },
      anchor: [0, 0.28, 0],
      ground: { floor: 0, boxes: [{ center: [0, 0.14, 0], half: [1.35, 0.14, 1.35] }] },
      light: {
        sky: '#bedce7',
        ground: '#21383e',
        key: '#dafff5',
        from: [-3, 5, 4],
        keyStrength: 3.5,
        fillStrength: 2.3,
      },
      flicker: 0,
    };
  },
};
