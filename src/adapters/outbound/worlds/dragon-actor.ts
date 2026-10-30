import {
  AdditiveBlending,
  BoxGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  Vector3,
} from 'three';
import { crackedSkin, pixelSkin } from './skin.ts';
import type { Living } from '../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../application/ports/chest-handles.ts';

export interface DragonModel {
  group: Group;
  wings: Group[];
}

/**
 * A box of one flat colour reads as a cutout: give it a sky above, violet crystal light from below
 * and a rim at grazing angles, all from the face normal, so no scene light is needed.
 */
function shaded(material: MeshBasicMaterial): MeshBasicMaterial {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 dN;\nvarying vec3 dP;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\ndN = normalize(mat3(modelMatrix) * normal);\ndP = (modelMatrix * vec4(position, 1.)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 dN;\nvarying vec3 dP;')
      .replace(
        '#include <opaque_fragment>',
        `float dUp = dN.y * .5 + .5;
outgoingLight *= mix(.6, 1.3, dUp);
outgoingLight += vec3(.5, .2, .8) * max(-dN.y, 0.) * .3;
outgoingLight += vec3(.55, .35, .9) * pow(1. - abs(dot(normalize(dN), normalize(cameraPosition - dP))), 3.) * .5;
#include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => 'dragon-shaded';
  return material;
}

/** The dragon from boxes: body, neck, head with violet eyes, tail, two wings hinged at the body. */
export function dragonModel(root: Group): DragonModel {
  // Unlit materials with a faked light (see `shaded`): dark, yet lighter than the night sky behind.
  const body = shaded(new MeshBasicMaterial({ map: pixelSkin('#34283f', '#7a5a9a', 3) })),
    wingSkin = shaded(new MeshBasicMaterial({ map: pixelSkin('#4a3a5e', '#9a7ac0', 5) })),
    eye = new MeshBasicMaterial({ color: '#d65cff' });
  const group = new Group();
  const box = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    material = body,
    parent: Group = group,
  ) => {
    const mesh = new Mesh(new BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  // Facing +z.
  box(3, 2.4, 8, 0, 0, 0);
  box(1.4, 1.4, 4, 0, 0.8, 5.5);
  box(2, 1.6, 3, 0, 1, 8.8);
  for (const x of [-0.55, 0.55]) box(0.35, 0.25, 0.1, x, 1.4, 10.32, eye);
  for (let i = 0; i < 6; i++)
    box(1.4 - i * 0.18, 1.2 - i * 0.14, 2.4, 0, -0.1 - i * 0.1, -5.2 - i * 2.3);
  const wings = [-1, 1].map((side) => {
    const hinge = new Group();
    hinge.position.set(side * 1.5, 0.9, 1);
    group.add(hinge);
    box(10, 0.25, 5, side * 5, 0, -1, wingSkin, hinge);
    box(10, 0.5, 0.5, side * 5, 0.2, 1.4, body, hinge);
    return hinge;
  });
  group.scale.setScalar(0.65);
  root.add(group);
  return { group, wings };
}

/**
 * The dragon circles; now and then it sweeps low over the chest and the chest feels it. The loop is an
 * ellipse in front of the camera (a circle round the chest would pass behind it); a sweep brings it
 * above the chest, near enough to loom, far enough to stay whole in the frame.
 */
export function dragonFlight(
  { group, wings }: DragonModel,
  {
    floor,
    first = 20,
    every = [35, 25],
    swoop = [0.5, 4.5, 0.5],
  }: {
    readonly floor: number;
    readonly first?: number;
    /** [least, extra] seconds between sweeps. */
    readonly every?: readonly [number, number];
    /** Where a sweep reaches, from the floor (x, height above it, z). */
    readonly swoop?: readonly [number, number, number];
  },
): Living<ChestHandles> {
  const ORBIT = { x: 36, z: 28, centre: -34, height: floor + 10 },
    SWOOP = [swoop[0], floor + swoop[1], swoop[2]] as const;
  // A tiny steering AI, as in Minecraft: pick a goal point, turn toward it at a limited rate, fly
  // forward. Two goals: the next point on the holding loop, or (now and then) the strike over the chest.
  let angle = 0,
    next = first,
    striking = 0, // seconds left to reach the strike point; 0 while looping
    yaw = Math.PI / 2,
    pitch = 0,
    roll = 0,
    spin = 0,
    pace = 6,
    dir = 1; // which way round the loop; set when it leaves a strike, so the turn never reverses
  // The loop's shape drifts at every waypoint, so no two laps (nor two dives) take the same route.
  const shape = { x: ORBIT.x, z: ORBIT.z, centre: ORBIT.centre };
  const loopPoint = (a: number, y: number) =>
    new Vector3(Math.sin(a) * shape.x, y, shape.centre - Math.cos(a) * shape.z);
  const strike = new Vector3(SWOOP[0], SWOOP[1], SWOOP[2]),
    staging = new Vector3(SWOOP[0], ORBIT.height + 2, SWOOP[2] - 34);
  let diving = false; // on the final run at the chest, after lining up at `staging`
  // Fireballs: spat from the head during the dive, they fly at the chest and shake it where they land.
  const target = new Vector3(SWOOP[0], floor + 1.5, SWOOP[2]),
    scene = group.parent ?? group,
    fireGeometry = new IcosahedronGeometry(1, 1),
    // Two layers: a dense dark violet shell cracked over a glowing liquid core, under a lighter veil.
    coreMaterial = new MeshBasicMaterial({ map: crackedSkin('#26103f', '#ff9cff', 7) }),
    glowMaterial = new MeshBasicMaterial({
      color: '#cfa0ff',
      transparent: true,
      opacity: 0.28,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
    shots = Array.from({ length: 4 }, () => {
      const mesh = new Group(),
        core = new Mesh(fireGeometry, coreMaterial);
      core.scale.setScalar(0.62);
      mesh.add(core, new Mesh(fireGeometry, glowMaterial));
      mesh.visible = false;
      scene.add(mesh);
      return { mesh, velocity: new Vector3(), life: 0 };
    });
  // Where a fireball lands: a bright sphere that swells and fades, so the hit reads even in the dark.
  const burstGeometry = fireGeometry,
    bursts = Array.from({ length: 4 }, () => {
      const material = new MeshBasicMaterial({
        color: '#d890ff',
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new Mesh(burstGeometry, material);
      mesh.visible = false;
      scene.add(mesh);
      return { mesh, material, life: 0 };
    });
  const BURST = 0.7;
  let reload = 0;
  const goal = loopPoint(angle, ORBIT.height);
  group.position.set(0, ORBIT.height, ORBIT.centre - ORBIT.z);
  return {
    update(context, dt) {
      const at = group.position;
      if (!striking && (next -= dt) <= 0) {
        striking = 22; // gives up if the turn never lines up
        diving = false;
        // First line up behind the chest, from a different bearing each time, then dive at it.
        staging.set(
          SWOOP[0] + (context.rand() - 0.5) * 44,
          ORBIT.height + 2,
          SWOOP[2] - 26 - context.rand() * 14,
        );
        goal.copy(staging);
        next = every[0] + context.rand() * every[1];
      }
      const dx = goal.x - at.x,
        dz = goal.z - at.z,
        run = Math.hypot(dx, dz);
      if (striking && !diving && run < 8) {
        diving = true;
        goal.copy(strike);
      } else if (run < (diving ? 4 : 8)) {
        if (striking) {
          striking = 0;
          diving = false;
          const side = at.x < 0 ? -1 : 1;
          context.gust(0.9, side);
          // Away again: to the end of the loop on the side it is heading for, then on round the
          // back (away from the camera) whichever way that is.
          angle = Math.sin(yaw) >= 0 ? Math.PI / 2 : -Math.PI / 2;
          dir = Math.sin(angle) >= 0 ? -1 : 1;
        } else angle += dir * (0.7 + context.rand() * 0.6);
        shape.x = ORBIT.x * (0.7 + context.rand() * 0.6);
        shape.z = ORBIT.z * (0.7 + context.rand() * 0.6);
        shape.centre = ORBIT.centre + (context.rand() - 0.5) * 16;
        goal.copy(loopPoint(angle, ORBIT.height + (context.rand() - 0.5) * 6));
      }
      // Turn and climb toward the goal at a limited rate; bank into the turn.
      const rate = striking ? 1.4 : 0.8,
        bearing = Math.atan2(dx, dz),
        turn = Math.atan2(Math.sin(bearing - yaw), Math.cos(bearing - yaw)),
        ease = 1 - Math.exp(-dt * 2);
      // The turn rate and the speed are eased, not switched: no snap as it lines up or starts a strike.
      spin += (Math.max(-rate, Math.min(rate, turn * 1.5)) - spin) * ease;
      yaw += spin * dt;
      const wantPitch = Math.max(-0.5, Math.min(0.5, Math.atan2(at.y - goal.y, run)));
      pitch += (wantPitch - pitch) * ease;
      roll += (-Math.max(-0.4, Math.min(0.4, spin * 0.5)) - roll) * ease;
      group.rotation.set(pitch, yaw, roll, 'YXZ');
      pace += ((striking ? 11 : 6) - pace) * (1 - Math.exp(-dt * 0.8));
      const speed = pace;
      at.x += Math.sin(yaw) * Math.cos(pitch) * speed * dt;
      at.z += Math.cos(yaw) * Math.cos(pitch) * speed * dt;
      at.y += -Math.sin(pitch) * speed * dt;
      reload -= dt;
      const free = shots.find((s) => s.life <= 0);
      if (diving && reload <= 0 && free && at.distanceTo(target) < 34) {
        reload = 0.5;
        free.life = 3;
        free.mesh.visible = true;
        group.localToWorld(free.mesh.position.set(0, 1, 10)); // the mouth
        free.velocity.copy(target).sub(free.mesh.position).setLength(22);
      }
      for (const shot of shots) {
        if (shot.life <= 0) continue;
        shot.mesh.position.addScaledVector(shot.velocity, dt);
        shot.mesh.rotation.x += dt * 6;
        shot.mesh.children[0]!.rotation.y += dt * 3; // the shell turns under the veil
        shot.mesh.children[1]!.scale.setScalar(1.05 + Math.sin(context.time * 22) * 0.1);
        if ((shot.life -= dt) <= 0 || shot.mesh.position.distanceTo(target) < 1.2) {
          if (shot.life > 0) {
            context.host?.tremor(0.45, 0.6);
            context.host?.light('#c06cff', 1, 0.8);
            context.flash('#8a4cff', 0.55);
            const burst = bursts.find((b) => b.life <= 0) ?? bursts[0]!;
            burst.life = BURST;
            burst.mesh.visible = true;
            burst.mesh.position.copy(shot.mesh.position);
          }
          shot.life = 0;
          shot.mesh.visible = false;
        }
      }
      for (const burst of bursts) {
        if (burst.life <= 0) continue;
        burst.life -= dt;
        const age = 1 - Math.max(burst.life, 0) / BURST;
        burst.mesh.scale.setScalar(0.8 + age * 4.5);
        burst.material.opacity = (1 - age) * 0.85;
        if (burst.life <= 0) burst.mesh.visible = false;
      }
      const flap = Math.sin(context.time * (striking ? 6 : 3)) * 0.55;
      wings[0]!.rotation.z = flap;
      wings[1]!.rotation.z = -flap;
      if (striking && (striking -= dt) <= 0) {
        striking = 0;
        diving = false;
        goal.copy(loopPoint(angle, ORBIT.height));
      }
    },
  };
}
