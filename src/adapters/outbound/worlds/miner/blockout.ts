import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  InstancedMesh,
  MeshLambertMaterial,
  Object3D,
  PointLight,
} from 'three';
import type { StageBuilder } from '../../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../../application/ports/chest-handles.ts';
import { MINE_COMPOSITION as C } from './composition.ts';

type Solid = {
  at: readonly [number, number, number];
  size: readonly [number, number, number];
  color: string;
};
/** Deliberately macro only: no lanterns, ore or decorative noise before camera approval. */
export const MINER_BLOCKOUT: StageBuilder<ChestHandles> = {
  id: 'miner-cinematic-blockout-v2',
  build() {
    const root = new Group();
    root.name = 'miner-cinematic-blockout';
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshLambertMaterial({ color: '#ffffff' });
    function volume(name: string, solids: Solid[]): void {
      const group = new Group();
      group.name = name;
      const mesh = new InstancedMesh(geometry, material, solids.length);
      mesh.name = `${name}-structural-volumes`;
      const dummy = new Object3D();
      solids.forEach((s, i) => {
        dummy.position.set(...s.at);
        dummy.scale.set(...s.size);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(i, new Color(s.color));
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      root.add(group);
    }
    const stone = '#626573',
      cliff = '#505b70',
      wood = '#765740';
    const solid = (
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      color = stone,
    ): Solid => ({ at: [x, y, z], size: [w, h, d], color });
    // Towers have real backing masses; the flanking shoulders step into the surrounding cliff.
    volume('hero-fortress', [
      solid(-12, 10, -25, 12, 20, 12),
      solid(12, 11, -25, 12, 22, 12),
      solid(-17, 8, -25, 5, 16, 16),
      solid(17, 9, -26, 5, 18, 16),
      solid(-11, 21, -26, 10, 4, 10),
      solid(11, 23, -27, 9, 4, 10),
      solid(-6, 24, -26, 4, 6, 9),
      solid(2, 24, -27, 9, 5, 10),
      solid(7, 25, -27, 3, 5, 8),
      solid(-17, 19, -26, 3, 3, 8),
      solid(16, 23, -27, 4, 3, 9),
    ]);
    // Corbelled arch: each narrowing level carries the one above. No rectangular fake hole.
    const portal: Solid[] = [];
    for (const side of [-1, 1]) {
      portal.push(solid(side * 6, 4, -23, 2, 8, 12));
      for (let step = 0; step < 4; step++)
        portal.push(solid(side * (5.5 - step * 0.75), 8.5 + step, -23, 2.5, 1, 12));
      portal.push(solid(side * 8.5, 4, -16.5, 3, 8, 6));
      portal.push(solid(side * 8.5, 9.5, -18, 2.5, 3, 5));
      portal.push(solid(side * 8.5, 12, -19, 2, 2, 4));
    }
    portal.push(solid(0, 15.5, -25, 12, 9, 12));
    volume('deep-corbelled-portal-and-buttresses', portal);
    // A real railway viaduct: interrupted parapets, a continuous supported deck and piers to bedrock.
    const bridge: Solid[] = [solid(0, -0.75, -9.5, 68, 1.5, 5)];
    for (const x of [-30, -20, -10, 0, 10, 20, 30]) {
      bridge.push(solid(x, -10, -9.5, 3, 17, 5));
      bridge.push(solid(x, -3, -9.5, 6, 3, 5));
      bridge.push(solid(x, -17.5, -9.5, 5, 1, 7));
    }
    for (const x of [-32, -24, -16, -8, 8, 16, 24, 32]) bridge.push(solid(x, 0.5, -7.2, 5, 1, 0.6));
    volume('railway-viaduct-with-foundations', bridge);
    const tunnel: Solid[] = [
      solid(-6.5, 5, -82, 2, 10, 102),
      solid(6.5, 5, -82, 2, 10, 102),
      solid(0, 11.5, -82, 15, 2, 102),
      solid(0, -0.8, -82, 13, 1.6, 102),
    ];
    for (let z = C.tunnel.mouth; z > C.tunnel.end; z -= C.tunnel.bay) {
      for (const side of [-1, 1]) tunnel.push(solid(side * 5.3, 4, z, 0.7, 8, 0.7, wood));
      tunnel.push(solid(0, 8.4, z, 11.3, 0.8, 0.8, wood));
    }
    volume('continuous-deep-mine-tunnel', tunnel);
    // Manually placed landforms; asymmetry comes from architecture, never seeded random columns.
    volume('left-terraced-cavern', [
      solid(-31, 4, -31, 17, 43, 47, cliff),
      solid(-26, 1, -7, 12, 30, 20, cliff),
      solid(-30, 10, 10, 15, 38, 16, cliff),
      solid(-22, -5, -16, 8, 22, 15, cliff),
      solid(-24, 7, -29, 8, 5, 17),
      solid(-25, 18, -18, 10, 4, 14),
      solid(-23, 27, -38, 9, 6, 17, cliff),
      solid(-36, 31, -22, 10, 17, 34, cliff),
    ]);
    volume('right-waterfall-cavern', [
      solid(33, 7, -37, 20, 50, 60, cliff),
      solid(28, 3, -7, 13, 37, 19, cliff),
      solid(33, 11, 12, 18, 40, 20, cliff),
      solid(22, -8, -16, 8, 20, 15),
      solid(25, 3, -25, 9, 5, 16),
      solid(28, 18, -31, 12, 5, 18),
      solid(30, 32, -47, 14, 8, 20, cliff),
      solid(23, 22, -53, 9, 20, 16, cliff),
    ]);
    volume('foreground-framing-ledges', [
      solid(-17, -6, 19, 13, 12, 11),
      solid(-24, 0, 25, 13, 12, 7),
      solid(-12, -11, 24, 8, 8, 8),
      solid(20, -6, 20, 15, 13, 11),
      solid(28, 1, 25, 14, 14, 8),
      solid(14, -12, 25, 8, 9, 6),
      // The anchor is a shallow landing; no high black cube on the central sightline.
      solid(0, -1.05, -1, 6, 1.1, 5),
      solid(0, -19, -2, 80, 2, 90, cliff),
    ]);
    volume('overhanging-cavern-vault', [
      solid(-23, 34, 8, 22, 12, 28, cliff),
      solid(25, 35, 9, 24, 14, 26, cliff),
      solid(-12, 38, -9, 15, 8, 30, cliff),
      solid(13, 39, -18, 16, 9, 35, cliff),
      solid(-8, 34, 5, 5, 8, 6),
      solid(17, 32, 2, 6, 10, 8),
      solid(-28, 28, 19, 8, 15, 7),
    ]);
    volume('background-and-distant-cavern', [
      solid(-21, 19, -68, 14, 60, 29, cliff),
      solid(24, 22, -78, 17, 64, 31, cliff),
      solid(-12, 31, -109, 14, 45, 27, cliff),
      solid(16, 35, -127, 18, 50, 35, cliff),
      solid(0, 51, -112, 62, 12, 60, cliff),
      solid(-17, 12, -57, 14, 2, 5),
      solid(19, 18, -70, 16, 2, 5),
    ]);
    volume('lava-channel-blockout', [
      solid(-22, -2, -4, 13, 0.15, 8, '#ff7816'),
      solid(-19, -4, 3, 13, 0.15, 8, '#ff7816'),
      solid(-15, -7, 11, 12, 0.15, 9, '#ff7816'),
    ]);
    // Readable neutral illumination for silhouette review; artistic lighting is a later gate.
    root.add(new AmbientLight('#b4c6e2', 1.2));
    const key = new DirectionalLight('#c3d8ff', 2.5);
    key.position.set(-20, 35, 18);
    root.add(key);
    const fill = new PointLight('#ff9c50', 150, 70, 1.4);
    fill.position.set(-10, 9, -8);
    root.add(fill);
    return {
      root,
      living: [],
      sky: { top: '#182438', horizon: '#344158', bottom: '#202734' },
      fog: { color: '#344158', near: 65, far: 170 },
      camera: C.camera,
      anchor: C.anchor,
      ground: { floor: -0.5 },
      calm: 0,
    };
  },
};
