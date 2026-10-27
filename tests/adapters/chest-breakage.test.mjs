import assert from 'node:assert/strict';
import test from 'node:test';
import { physicsReady } from '../../packages/blockworld/src/physics.ts';
import {
  Box3,
  BoxGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
  Vector3,
} from 'three';
import {
  buildFragment,
  fractureCells,
} from '../../src/adapters/outbound/chest/chest-fracture-geometry.ts';
import { random } from '../../src/adapters/outbound/chest/chest-surface-patterns.ts';
import {
  BURST_AT,
  ChestBreakageEffects,
} from '../../src/adapters/outbound/chest/chest-breakage-effects.ts';
import { destroyedBreakage } from '../../src/adapters/outbound/chest/destroyed-breakage.ts';
import { copyChestBreakage } from '../../src/domain/chest-breakage.ts';
import { changeChestAppearance, createChestAppearance } from '../../src/domain/chest-appearance.ts';
import { ENDER_CASE } from '../../src/config/cases.ts';

await physicsReady();
const profile = ENDER_CASE.model.modifications;
const box = new Box3(new Vector3(-1, 0, -1), new Vector3(1, 1, 1));

test('fracture cells partition the part into convex pieces, differently per seed and identically per seed', () => {
  const cells = fractureCells(box, 6, random(3));
  assert.equal(cells.length, 6);
  // Every sample belongs to exactly one cell: each cell keeps what all its planes keep.
  const probe = Array.from(
    { length: 200 },
    (_, index) =>
      new Vector3(Math.sin(index) * 0.99, (index % 10) / 10 + 0.05, Math.cos(index * 1.7) * 0.99),
  );
  for (const point of probe) {
    const owners = cells.filter((cell) =>
      cell.planes.every((plane) => plane.distanceToPoint(point) >= 0),
    );
    assert.equal(owners.length, 1);
  }
  const same = fractureCells(box, 6, random(3)).map((cell) => cell.centre.toArray());
  assert.deepEqual(
    same,
    cells.map((cell) => cell.centre.toArray()),
  );
  assert.notDeepEqual(
    fractureCells(box, 6, random(4)).map((cell) => cell.centre.toArray()),
    same,
  );
  assert.equal(fractureCells(box, 1, random(3)).length, 1);
});

test('fragments are closed solids whose volumes add up to the part, outside textured and inside broken', () => {
  const geometry = new BoxGeometry(2, 1, 2);
  geometry.translate(0, 0.5, 0);
  const cells = fractureCells(box, 5, random(11));
  const fragments = cells
    .map((cell) => buildFragment(geometry, cell, new Matrix4(), 1 / 16))
    .filter(Boolean);
  assert.equal(fragments.length, cells.length);
  const total = fragments.reduce((sum, fragment) => sum + fragment.volume, 0);
  assert.ok(Math.abs(total - 4) < 1e-3, `volumes sum to the box: ${total}`);
  for (const fragment of fragments) {
    assert.equal(fragment.geometry.groups.length, 2);
    assert.ok(fragment.geometry.groups[1].count > 0, 'every chunk has a broken face');
    assert.ok(
      fragment.geometry.getAttribute('sourcePosition'),
      'overlays can project from the source surface',
    );
  }
  // A weak spot pulls a cut through it.
  const weak = [new Vector3(0.7, 0.5, -0.3)];
  const near = fractureCells(box, 2, random(5), 0.25, 0.5, weak);
  assert.ok(
    Math.abs(near[0].planes[0].distanceToPoint(weak[0])) < 1e-9,
    'the cut runs through the rust',
  );
  geometry.dispose();
  for (const fragment of fragments) fragment.geometry.dispose();
});

function chest() {
  const world = new Scene(),
    root = new Group(),
    geometry = new BoxGeometry(),
    material = new MeshStandardMaterial();
  const meshes = Object.fromEntries(
    profile.parts.map((part, index) => {
      const mesh = new Mesh(geometry, material);
      mesh.name = part.nodes[0];
      mesh.position.y = 0.5 + index;
      root.add(mesh);
      return [part.id, mesh];
    }),
  );
  world.add(root);
  return {
    world,
    root,
    meshes,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
const extras = (world) => world.children.filter((child) => child.userData.chestOverlay);

test('impact breakage happens on the hit, mechanically, and hides detached parts until reset', () => {
  const { world, root, meshes, dispose } = chest();
  const breakage = copyChestBreakage(
    {
      seed: 9,
      moment: 'impact',
      parts: [{ part: 'body', severity: 0.8, detached: true, pattern: 'crumble' }],
    },
    profile,
  );
  const effects = new ChestBreakageEffects(
    world,
    root,
    profile,
    createChestAppearance(),
    breakage,
    '#35905f',
    0,
  );
  effects.start(false);
  effects.update(1 / 60, 0.5);
  assert.equal(effects.broken, false, 'an impact break never fires from the opening timeline');
  effects.impact();
  assert.equal(effects.broken, true);
  assert.equal(meshes.body.visible, false);
  assert.equal(meshes.lid.visible, false, 'the lid falls with the destroyed body');
  assert.ok(extras(world).length > 5);
  for (let step = 0; step < 240; step++) effects.update(1 / 60);
  for (const fragment of extras(world)) {
    fragment.updateMatrixWorld(true);
    assert.ok(fragment.position.y > -1, 'nothing falls through the floor');
  }
  effects.reset();
  assert.equal(meshes.body.visible, true);
  assert.equal(meshes.lid.visible, true);
  assert.equal(extras(world).length, 0);
  effects.dispose();
  dispose();
});

test('opening breakage charges, then bursts at its moment; a fallen part keeps its modifications', () => {
  const { world, root, meshes, dispose } = chest();
  const overlay = new Mesh(meshes.lid.geometry, new MeshStandardMaterial());
  overlay.userData.chestOverlay = true;
  meshes.lid.add(overlay);
  const breakage = copyChestBreakage(
    {
      seed: 2,
      moment: 'opening',
      parts: [{ part: 'lid', severity: 0.5, detached: true, pattern: 'fall' }],
    },
    profile,
  );
  const appearance = changeChestAppearance(createChestAppearance(), {
    modifications: [{ id: 'moss', intensity: 0.8 }],
  });
  const effects = new ChestBreakageEffects(
    world,
    root,
    profile,
    appearance,
    breakage,
    '#35905f',
    0,
  );
  effects.start(false);
  effects.impact();
  assert.equal(effects.broken, false, 'an opening break ignores the impact');
  effects.update(1 / 60, BURST_AT * 0.9);
  assert.equal(effects.broken, false);
  assert.deepEqual(
    root.scale.toArray(),
    [1, 1, 1],
    'the chest is solid: it trembles with energy, it never swells',
  );
  assert.ok(root.position.x !== 0 || root.position.z !== 0, 'the energy makes it tremble');
  effects.update(1 / 60, BURST_AT);
  assert.equal(effects.broken, true);
  assert.equal(meshes.lid.visible, false);
  assert.equal(meshes.body.visible, true);
  const fallen = extras(world).find((child) =>
    child.children.some((grand) => grand.userData.chestOverlay),
  );
  assert.ok(fallen, 'the fallen lid carries its overlays');
  effects.dispose();
  overlay.material.dispose();
  dispose();
});

test("a destroyed chest is drawn coming apart at the server's moment, the same chest always the same way", () => {
  const pristine = {
    id: 'a',
    caseId: 'ender',
    status: 'destroyed',
    appearance: createChestAppearance(),
  };
  for (const moment of ['impact', 'opening']) {
    const wreck = destroyedBreakage(pristine, profile, moment);
    assert.equal(wreck.moment, moment);
    assert.equal(wreck.destroyed, true);
    assert.ok(
      wreck.parts.some((item) => item.part === 'body' && item.detached),
      'even a sound chest the server broke loses its body',
    );
    assert.deepEqual(destroyedBreakage(pristine, profile, moment), wreck);
  }
  const worn = {
    ...pristine,
    id: 'b',
    appearance: changeChestAppearance(createChestAppearance(), {
      modifications: [
        { id: 'body-cracks', intensity: 0.95 },
        { id: 'lid-cracks', intensity: 0.9 },
        { id: 'latch-rust', intensity: 0.9 },
      ],
    }),
  };
  const wreck = destroyedBreakage(worn, profile, 'opening');
  assert.equal(wreck.parts.length, profile.parts.length);
  assert.ok(
    wreck.parts.every((item) => item.detached),
    'a decrepit chest comes apart entirely',
  );
  assert.ok(
    wreck.parts.every((item) => item.part !== 'body' || item.pattern !== 'fall'),
    'the carrier never falls off whole',
  );
  assert.ok(
    destroyedBreakage(worn, profile, 'impact').parts.every(
      (item) => item.pattern !== 'shatter' || !item.detached || item.part !== 'body',
    ),
    'an impact breaks the body mechanically',
  );
});

test('the beam tears loose growth off the top and throws it up; the chest itself stays put', () => {
  const { world, root, meshes, dispose } = chest();
  // Every standing part is a solid body now: the latch hangs on the front, not on top of the snow.
  meshes.latch.position.set(0, 1, -1);
  const snow = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  snow.userData.loose = true;
  snow.userData.chestOverlay = true;
  snow.scale.set(0.2, 0.1, 0.2);
  snow.position.y = 0.6;
  meshes.lid.add(snow);
  const low = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  low.userData.loose = true;
  low.position.y = -0.9;
  meshes.body.add(low);
  const effects = new ChestBreakageEffects(
    world,
    root,
    profile,
    createChestAppearance(),
    copyChestBreakage({ seed: 3, moment: 'opening', parts: [] }, profile),
    '#35905f',
    0,
  );
  effects.start(false);
  const before = new Vector3();
  snow.getWorldPosition(before);
  effects.beam(1);
  assert.equal(snow.parent, world, 'torn off the lid into the world');
  assert.equal(low.parent, meshes.body, 'below the top of the body nothing is blown away');
  for (let step = 0; step < 20; step++) effects.update(1 / 60);
  assert.ok(snow.matrix.elements[13] > before.y + 0.2, 'it flies up');
  effects.beam(1); // fires once per opening
  effects.reset();
  assert.equal(snow.parent, meshes.lid, 'reset puts it back');
  assert.equal(meshes.lid.visible && meshes.body.visible, true);
  effects.dispose();
  snow.geometry.dispose();
  low.geometry.dispose();
  dispose();
});

test('the landing tears vines off as falling bodies; cobweb sticks; the latch swings only outwards', () => {
  const { world, root, meshes, dispose } = chest();
  // The test chest's parts are stacked: move the latch to the front so it hangs off the body.
  meshes.latch.position.set(0, 0.5, -1.4); // clear of the vines: the fixture's parts are unit boxes
  const leaf = (growth) => {
    const mesh = new Mesh(new PlaneGeometry(1, 1), new MeshStandardMaterial());
    mesh.userData.loose = true;
    mesh.userData.chestOverlay = true;
    mesh.userData.growth = growth;
    mesh.scale.set(0.4, 0.4, 1);
    mesh.position.set(0.2, 0, -0.52);
    meshes.body.add(mesh);
    return mesh;
  };
  const vines = Array.from({ length: 6 }, () => leaf('vines')),
    web = leaf('cobweb');
  const effects = new ChestBreakageEffects(
    world,
    root,
    profile,
    createChestAppearance(),
    copyChestBreakage({ seed: 5, moment: 'opening', parts: [] }, profile),
    '#35905f',
    0,
  );
  effects.start(false);
  const latchRest = meshes.latch.quaternion.clone();
  effects.landed(1);
  const fallen = vines.filter((vine) => vine.parent === world);
  assert.ok(fallen.length >= 3, `most vines fall off on landing (${fallen.length}/6)`);
  assert.equal(web.parent, meshes.body, 'cobweb sticks to the chest');
  const startY = fallen.map((vine) => vine.matrix.elements[13]);
  let minLatchTilt = Infinity;
  for (let step = 0; step < 90; step++) {
    effects.update(1 / 60);
    // Bottom of the latch: + is outwards (-Z, the front); it must never go into the chest.
    const down = new Vector3(0, -1, 0).applyQuaternion(
      meshes.latch.quaternion.clone().multiply(latchRest.clone().invert()),
    );
    minLatchTilt = Math.min(minLatchTilt, -down.z);
  }
  assert.ok(
    fallen.every((vine, index) => vine.matrix.elements[13] < startY[index]),
    'torn vines drift down',
  );
  assert.ok(minLatchTilt >= -1e-6, 'the latch never swings into the chest');
  assert.deepEqual(root.scale.toArray(), [1, 1, 1], 'the landing never squashes the chest');
  effects.reset();
  assert.ok(
    vines.every((vine) => vine.parent === meshes.body),
    'reset puts the vines back',
  );
  effects.dispose();
  for (const mesh of [...vines, web]) mesh.geometry.dispose();
  dispose();
});
