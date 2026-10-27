import type { Block, BlockRegistry, BlockSide } from './blocks.ts';
import type { BlockWorld } from './world.ts';
import type { RigLight } from './light.ts';

/**
 * Turns a lit BlockWorld into mesh data the way the game draws it (vanilla look):
 * - a cube shows only faces not covered by an opaque neighbour;
 * - directional face shade: top 1.0, north/south 0.8, east/west 0.6, bottom 0.5;
 * - smooth lighting: each vertex averages the light of the four cells on the open side of its face,
 *   brightness from the game's curve `f / (4 − 3f)` with the default gamma;
 * - ambient occlusion from the two side cells and the corner cell of each vertex (as
 *   prismarine-viewer's mesher), with the quad's diagonal flipped to follow it;
 * - crosses (flowers, grass) are two diagonal planes, torches a thin stick, liquids a surface at
 *   14/16 of the cell drawn in a separate transparent pass; `boxes` models (slabs, stairs, lanterns)
 *   their boxes, each face its part of the tile (or its own tile and UV), lit by their cell with the
 *   face shade, no AO;
 * - every side of a cube shows its own tile (`BlockTextures`).
 * - block light in two colours (first and second), each with its own tint;
 * - optionally the light of local sources (`rig`), each in its own colour, smoothed the same way.
 * Output is plain typed arrays (no three.js), so meshing can be tested, cached or moved to a worker.
 */
export interface MeshArrays {
  readonly positions: Float32Array;
  readonly uvs: Float32Array;
  readonly colors: Float32Array;
  readonly indices: Uint32Array;
  /** Per vertex: how free it is to move in the wind (plant tops, leaves) or wave (water tops), 0..1. */
  readonly sway: Float32Array;
  /** Per vertex: the share of its light that comes from glowing blocks (torches flicker it), 0..1. */
  readonly glow: Float32Array;
}

export interface WorldMesh {
  /** Cubes, including cut-out ones (leaves): drawn opaque with alpha test. */
  readonly opaque: MeshArrays;
  /** Crosses and torches: drawn from both sides with alpha test. */
  readonly plants: MeshArrays;
  /** Liquid surfaces: blended. */
  readonly liquid: MeshArrays;
}

export interface MeshOptions {
  /** [u0, v0, u1, v1] of an atlas tile. */
  readonly uv: (tile: string) => readonly [number, number, number, number];
  /** Tint of full sky light (dusk, the End's violet); default white. As [r, g, b] 0..1. */
  readonly sky?: readonly [number, number, number];
  /** Tint of block light (torches, lava); default warm. */
  readonly glow?: readonly [number, number, number];
  /** Tint of the second block light (`secondLight` blocks: soul fire); default cold cyan. */
  readonly glow2?: readonly [number, number, number];
  /** The darkest a lightless face gets, 0..1 (caves are dark, not black). */
  readonly minimum?: number;
  /** Strength of ambient occlusion, 0 none .. 1 full (vanilla-like ≈ .6). */
  readonly occlusion?: number;
  /** The colour of the darkest light, multiplying `minimum` per channel (a cold night, a warm cave); default white. */
  readonly shadow?: readonly [number, number, number];
  /** Light of local sources per cell (computeRigLight), added to the vanilla light. */
  readonly rig?: RigLight;
  /**
   * How much block light flickers (amplitude). Given, the glow attribute holds amplitudes (block light
   * at this, rig sources at their own) for a flicker uniform of 1; left out, it holds the share of
   * block light, as it always has, scaled by the stage's `flicker`.
   */
  readonly flicker?: number;
  /** How bright glowing blocks look themselves (1: their texture as painted). */
  readonly emissive?: number;
  /**
   * The sun, the way shader packs light the world — but baked, since the sun never moves: faces
   * turned to it warm up, and every vertex casts a ray towards it through the grid; if a block or a
   * leaf is in the way it lies in shadow. Only where sky light reaches (no sun in caves).
   */
  readonly sun?: {
    /** Direction TOWARDS the sun. */
    readonly direction: readonly [number, number, number];
    readonly color: readonly [number, number, number];
    /** How much of the light is sun (vs. sky): 0 vanilla .. ~.45 strong dusk shadows. */
    readonly strength: number;
    /** How far a shadow reaches, in blocks. */
    readonly reach?: number;
  };
}

/** The game's light curve for a level 0..15, with the default (moody → bright midpoint) gamma. */
export function brightness(level: number): number {
  const f = Math.max(0, Math.min(15, level)) / 15,
    curve = f / (4 - 3 * f);
  const lifted = 1 - Math.pow(1 - curve, 4);
  return curve + (lifted - curve) * 0.5;
}

interface Face {
  readonly n: readonly [number, number, number];
  readonly shade: number;
  readonly corners: readonly (readonly [number, number, number])[];
  readonly kind: 'top' | 'bottom' | 'side';
  readonly side: BlockSide;
}

// Corners counter-clockwise seen from outside: bottom-left, bottom-right, top-right, top-left of
// the texture as it appears on that face.
export const FACES: readonly Face[] = [
  {
    n: [1, 0, 0],
    shade: 0.6,
    kind: 'side',
    side: 'east',
    corners: [
      [1, 0, 1],
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
    ],
  },
  {
    n: [-1, 0, 0],
    shade: 0.6,
    kind: 'side',
    side: 'west',
    corners: [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
    ],
  },
  {
    n: [0, 0, 1],
    shade: 0.8,
    kind: 'side',
    side: 'south',
    corners: [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
  },
  {
    n: [0, 0, -1],
    shade: 0.8,
    kind: 'side',
    side: 'north',
    corners: [
      [1, 0, 0],
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ],
  },
  {
    n: [0, 1, 0],
    shade: 1,
    kind: 'top',
    side: 'up',
    corners: [
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
      [0, 1, 0],
    ],
  },
  {
    n: [0, -1, 0],
    shade: 0.5,
    kind: 'bottom',
    side: 'down',
    corners: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
  },
];

const AO_LEVELS = [0.5, 0.65, 0.82, 1];
/** A torch's own vertices: the stick stays, the flame end flickers. */
const FLAME = [0, 0, 1, 1];

class Builder {
  positions: number[] = [];
  uvs: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  sway: number[] = [];
  glow: number[] = [];
  quad(
    points: readonly (readonly [number, number, number])[],
    uv: readonly [number, number, number, number],
    colors: readonly (readonly [number, number, number])[],
    flip = false,
    sub?: readonly [number, number, number, number],
    sway: readonly number[] = [0, 0, 0, 0],
    glow: readonly number[] = [0, 0, 0, 0],
  ): void {
    const start = this.positions.length / 3;
    const [u0, v0, u1, v1] = uv,
      du = u1 - u0,
      dv = v1 - v0;
    // Optional sub-rectangle of the tile (fractions), for small models like the torch.
    const [a0, b0, a1, b1] = sub ?? [0, 0, 1, 1];
    const corners: [number, number][] = [
      [a0, b0],
      [a1, b0],
      [a1, b1],
      [a0, b1],
    ];
    points.forEach((p, i) => {
      this.positions.push(p[0], p[1], p[2]);
      this.uvs.push(u0 + du * corners[i]![0], v0 + dv * corners[i]![1]);
      this.colors.push(colors[i]![0], colors[i]![1], colors[i]![2]);
      this.sway.push(sway[i]!);
      this.glow.push(glow[i]!);
    });
    if (flip) this.indices.push(start + 1, start + 2, start + 3, start + 1, start + 3, start);
    else this.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
  arrays(): MeshArrays {
    return {
      positions: new Float32Array(this.positions),
      uvs: new Float32Array(this.uvs),
      colors: new Float32Array(this.colors),
      indices: new Uint32Array(this.indices),
      sway: new Float32Array(this.sway),
      glow: new Float32Array(this.glow),
    };
  }
}

function normalise(v: readonly [number, number, number]): readonly [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function meshWorld(
  world: BlockWorld,
  registry: BlockRegistry,
  options: MeshOptions,
): WorldMesh {
  const opaque = new Builder(),
    plants = new Builder(),
    liquid = new Builder();
  const sky = options.sky ?? [1, 1, 1],
    glow = options.glow ?? [1, 0.87, 0.66],
    glow2 = options.glow2 ?? [0.42, 0.82, 1];
  const minimum = options.minimum ?? 0.045,
    occlusion = options.occlusion ?? 0.6,
    shadow = options.shadow ?? [1, 1, 1];
  const rig = options.rig,
    amplitude = options.flicker,
    e = options.emissive ?? 1,
    emitted = [e, e, e] as const,
    own = amplitude ?? 1;
  const [ox, oy, oz] = world.origin;
  const blockAt = (x: number, y: number, z: number): Block | undefined =>
    registry.get(world.get(x, y, z));
  const sun = options.sun,
    sunDir = sun ? normalise(sun.direction) : ([0, 1, 0] as const);
  /** Is a point (grid coordinates) lit by the sun: nothing solid or leafy between it and the sky? */
  const sunlit = (px: number, py: number, pz: number): boolean => {
    const reach = sun?.reach ?? 64;
    for (let d = 0.6; d < reach; d += 0.5) {
      const cx = Math.floor(px + sunDir[0] * d),
        cy = Math.floor(py + sunDir[1] * d),
        cz = Math.floor(pz + sunDir[2] * d);
      if (cy >= world.sy) return true;
      const hit = blockAt(cx, cy, cz);
      if (hit && (hit.opaque || hit.model === 'cube')) return false;
    }
    return true;
  };
  /** Sun on top of the vanilla light: shadowed where blocked, warm where facing it; scaled by sky. */
  const withSun = (
    color: [number, number, number],
    skyLevel: number,
    facing: number,
    px: number,
    py: number,
    pz: number,
  ): [number, number, number] => {
    if (!sun || skyLevel <= 0) return color;
    const sky = brightness(skyLevel),
      k = sun.strength * sky;
    const amount = facing > 0 && sunlit(px, py, pz) ? facing : 0;
    return [0, 1, 2].map((i) =>
      Math.min(1.25, color[i]! * (1 - k + sun.color[i]! * k * 2.6 * amount)),
    ) as [number, number, number];
  };
  const solid = (x: number, y: number, z: number) => (blockAt(x, y, z)?.opaque ? 1 : 0);
  /** Local sources' light of a cell, added into `into` (r, g, b, flicker). */
  const rigAt = (x: number, y: number, z: number, into: number[]): void => {
    const i = rig ? rig.index(x, y, z) : -1;
    if (!rig || i < 0) return;
    into[0] = into[0]! + rig.rgb[i * 3]!;
    into[1] = into[1]! + rig.rgb[i * 3 + 1]!;
    into[2] = into[2]! + rig.rgb[i * 3 + 2]!;
    into[3] = into[3]! + rig.flicker[i]!;
  };
  const light = (
    s: number,
    g: number,
    g2 = 0,
    local?: readonly number[],
  ): [number, number, number] => {
    const bs = brightness(s),
      bg = brightness(g),
      bg2 = brightness(g2);
    if (!local)
      return [0, 1, 2].map((i) =>
        Math.min(1, Math.max(minimum * shadow[i]!, sky[i]! * bs + glow[i]! * bg + glow2[i]! * bg2)),
      ) as [number, number, number];
    return [0, 1, 2].map((i) =>
      Math.min(
        1,
        Math.max(minimum * shadow[i]!, sky[i]! * bs + glow[i]! * bg + glow2[i]! * bg2 + local[i]!),
      ),
    ) as [number, number, number];
  };

  /** How much of a light mix flickers, so the shader can flicker just that part: block light's share, or amplitudes (see `flicker`). */
  const glowShare = (s: number, g: number, g2 = 0, local?: readonly number[]): number => {
    const bg = brightness(g) + brightness(g2),
      bs = (brightness(s) * (sky[0] + sky[1] + sky[2])) / 3;
    if (amplitude === undefined) return bg <= 0 ? 0 : bg / (bg + bs);
    const rl = local ? (local[0]! + local[1]! + local[2]!) / 3 : 0,
      total = bg + bs + rl;
    return total <= 0 ? 0 : (bg * amplitude + (local?.[3] ?? 0)) / total;
  };
  /** The rig's light of one cell (cross, boxes), or nothing without a rig. */
  const rigCell = (x: number, y: number, z: number): number[] | undefined => {
    if (!rig) return undefined;
    const into = [0, 0, 0, 0];
    rigAt(x, y, z, into);
    return into;
  };

  for (let z = 0; z < world.sz; z++)
    for (let y = 0; y < world.sy; y++)
      for (let x = 0; x < world.sx; x++) {
        const block = blockAt(x, y, z);
        if (!block) continue;
        const at = (px: number, py: number, pz: number): [number, number, number] => [
          x + px + ox,
          y + py + oy,
          z + pz + oz,
        ];

        if (block.model === 'cross') {
          const local = rigCell(x, y, z);
          const c = withSun(
              light(world.skyAt(x, y, z), world.glowAt(x, y, z), world.glow2At(x, y, z), local),
              world.skyAt(x, y, z),
              Math.max(0.55, sunDir[1]),
              x + 0.5,
              y + 0.6,
              z + 0.5,
            ),
            cs = [c, c, c, c];
          const uv = options.uv(block.textures.side);
          // Rooted at the bottom, free at the top.
          const free = [0, 0, 1, 1],
            g = glowShare(
              world.skyAt(x, y, z),
              world.glowAt(x, y, z),
              world.glow2At(x, y, z),
              local,
            ),
            gs = [g, g, g, g];
          plants.quad(
            [at(0.15, 0, 0.15), at(0.85, 0, 0.85), at(0.85, 1, 0.85), at(0.15, 1, 0.15)],
            uv,
            cs,
            false,
            undefined,
            free,
            gs,
          );
          plants.quad(
            [at(0.15, 0, 0.85), at(0.85, 0, 0.15), at(0.85, 1, 0.15), at(0.15, 1, 0.85)],
            uv,
            cs,
            false,
            undefined,
            free,
            gs,
          );
          continue;
        }
        if (block.model === 'torch') {
          const lit = emitted,
            ls = [lit, lit, lit, lit],
            uv = options.uv(block.textures.side),
            flame = amplitude === undefined ? FLAME : FLAME.map((f) => f * amplitude);
          const a = 7 / 16,
            b = 9 / 16,
            h = 12 / 16;
          // Sides show the stick and its flame (tile columns 7–8, rows 4–15); the top shows the flame.
          const side: [number, number, number, number] = [7 / 16, 0, 9 / 16, h];
          plants.quad(
            [at(b, 0, b), at(b, 0, a), at(b, h, a), at(b, h, b)],
            uv,
            ls,
            false,
            side,
            undefined,
            flame,
          );
          plants.quad(
            [at(a, 0, a), at(a, 0, b), at(a, h, b), at(a, h, a)],
            uv,
            ls,
            false,
            side,
            undefined,
            flame,
          );
          plants.quad(
            [at(a, 0, b), at(b, 0, b), at(b, h, b), at(a, h, b)],
            uv,
            ls,
            false,
            side,
            undefined,
            flame,
          );
          plants.quad(
            [at(b, 0, a), at(a, 0, a), at(a, h, a), at(b, h, a)],
            uv,
            ls,
            false,
            side,
            undefined,
            flame,
          );
          plants.quad(
            [at(a, h, b), at(b, h, b), at(b, h, a), at(a, h, a)],
            uv,
            ls,
            false,
            [7 / 16, 10 / 16, 9 / 16, 12 / 16],
            undefined,
            [own, own, own, own],
          );
          continue;
        }

        if (block.model === 'boxes') {
          const s = world.skyAt(x, y, z),
            g = world.glowAt(x, y, z),
            g2 = world.glow2At(x, y, z),
            local = rigCell(x, y, z);
          const lit = block.light > 0 ? emitted : light(s, g, g2, local),
            share = block.light > 0 ? own : glowShare(s, g, g2, local);
          for (const part of block.boxes) {
            const lo = part.from.map((p) => p / 16),
              hi = part.to.map((p) => p / 16);
            for (const face of FACES) {
              const [nx, ny, nz] = face.n,
                axis = nx ? 0 : ny ? 1 : 2,
                outward = (nx || ny || nz) > 0;
              // A face on the cell's side against an opaque neighbour is never seen.
              if (
                (outward ? hi[axis] === 1 : lo[axis] === 0) &&
                blockAt(x + nx, y + ny, z + nz)?.opaque
              )
                continue;
              const own = part.faces?.[face.side],
                tile = own?.texture ?? block.textures[face.side];
              const c0 = face.corners[0]!,
                c1 = face.corners[1]!,
                c2 = face.corners[2]!;
              // The tile's u runs from corner 0 to corner 1, v from corner 1 to corner 2: the part of it the box covers.
              const u = [0, 1, 2].find((i) => c0[i] !== c1[i])!,
                v = [0, 1, 2].find((i) => c1[i] !== c2[i])!;
              const along = (corner: readonly number[], i: number, p: number) =>
                corner[i] === 0 ? p : 1 - p;
              const pos = (corner: readonly number[], i: number) => (corner[i] ? hi[i]! : lo[i]!);
              // A face's own UV is in pixels from the tile's top-left; the quad's v runs up from the bottom.
              const sub: [number, number, number, number] = own?.uv
                ? [own.uv[0] / 16, 1 - own.uv[3] / 16, own.uv[2] / 16, 1 - own.uv[1] / 16]
                : [
                    along(c0, u, pos(c0, u)),
                    along(c1, v, pos(c1, v)),
                    along(c0, u, pos(c1, u)),
                    along(c1, v, pos(c2, v)),
                  ];
              const shade = block.light > 0 ? 1 : face.shade,
                facing = nx * sunDir[0] + ny * sunDir[1] + nz * sunDir[2];
              const color = withSun(
                [lit[0] * shade, lit[1] * shade, lit[2] * shade],
                s,
                facing,
                x + 0.5,
                y + 0.5,
                z + 0.5,
              );
              opaque.quad(
                face.corners.map((corner) => at(pos(corner, 0), pos(corner, 1), pos(corner, 2))),
                options.uv(tile),
                [color, color, color, color],
                false,
                sub,
                undefined,
                [share, share, share, share],
              );
            }
          }
          continue;
        }

        for (const face of FACES) {
          const [nx, ny, nz] = face.n,
            neighbour = blockAt(x + nx, y + ny, z + nz);
          if (block.model === 'liquid') {
            if (neighbour?.id === block.id || neighbour?.opaque) continue;
          } else {
            if (neighbour?.opaque) continue;
            if (neighbour && neighbour.id === block.id && block.transparent) continue;
          }
          const uv = options.uv(block.textures[face.side]);
          // The open side of the face, and the two axes along it.
          const ax = x + nx,
            ay = y + ny,
            az = z + nz;
          const tangents = (
            [
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1],
            ] as const
          ).filter((t) => t[0] * nx + t[1] * ny + t[2] * nz === 0);
          const colors: [number, number, number][] = [],
            aos: number[] = [],
            sway: number[] = [],
            glows: number[] = [];
          const points = face.corners.map(([cx, cy, cz]) => {
            const corner = [cx, cy, cz] as const;
            const steps = tangents.map((t) => (corner[t.indexOf(1)]! === 0 ? -1 : 1));
            const [t1, t2] = tangents as unknown as [
              readonly [number, number, number],
              readonly [number, number, number],
            ];
            const s1 = [
              ax + t1[0] * steps[0]!,
              ay + t1[1] * steps[0]!,
              az + t1[2] * steps[0]!,
            ] as const;
            const s2 = [
              ax + t2[0] * steps[1]!,
              ay + t2[1] * steps[1]!,
              az + t2[2] * steps[1]!,
            ] as const;
            const cc = [
              s1[0] + t2[0] * steps[1]!,
              s1[1] + t2[1] * steps[1]!,
              s1[2] + t2[2] * steps[1]!,
            ] as const;
            const o1 = solid(...s1),
              o2 = solid(...s2),
              o3 = o1 && o2 ? 1 : solid(...cc);
            const ao = o1 && o2 ? 0 : 3 - (o1 + o2 + o3);
            aos.push(ao);
            // Smooth light: average the open cells around the vertex (blocked ones don't count).
            let skySum = world.skyAt(ax, ay, az),
              glowSum = world.glowAt(ax, ay, az),
              glow2Sum = world.glow2At(ax, ay, az),
              count = 1;
            const local = rig ? [0, 0, 0, 0] : undefined;
            if (local) rigAt(ax, ay, az, local);
            for (const [cell, blocked] of [
              [s1, o1],
              [s2, o2],
              [cc, o3],
            ] as const) {
              if (blocked) continue;
              skySum += world.skyAt(...cell);
              glowSum += world.glowAt(...cell);
              glow2Sum += world.glow2At(...cell);
              count++;
              if (local) rigAt(...cell, local);
            }
            if (local) for (let i = 0; i < 4; i++) local[i] = local[i]! / count;
            const lit =
              block.light > 0
                ? emitted
                : light(skySum / count, glowSum / count, glow2Sum / count, local);
            const occluded = 1 - (1 - AO_LEVELS[ao]!) * occlusion;
            const shade = block.light > 0 ? 1 : face.shade * occluded;
            let vertex: [number, number, number] = [lit[0] * shade, lit[1] * shade, lit[2] * shade];
            if (block.light === 0) {
              const facing = nx * sunDir[0] + ny * sunDir[1] + nz * sunDir[2];
              vertex = withSun(
                vertex,
                skySum / count,
                facing,
                x + cx + nx * 0.02,
                y + cy + ny * 0.02,
                z + cz + nz * 0.02,
              );
            }
            colors.push(vertex);
            glows.push(
              block.light > 0
                ? own
                : glowShare(skySum / count, glowSum / count, glow2Sum / count, local),
            );
            const surface =
              block.model === 'liquid' && cy === 1 && blockAt(x, y + 1, z)?.id !== block.id;
            const top = surface ? 14 / 16 : cy;
            // Leaves rustle a little as a whole; a liquid's surface waves.
            sway.push(block.cutout && block.model === 'cube' ? 0.3 : surface ? 1 : 0);
            return at(cx, top, cz);
          });
          const target = block.model === 'liquid' ? liquid : opaque;
          // Split the quad along the brighter diagonal, so occlusion does not streak.
          target.quad(
            points,
            uv,
            colors,
            aos[0]! + aos[2]! < aos[1]! + aos[3]!,
            undefined,
            sway,
            glows,
          );
        }
      }
  return { opaque: opaque.arrays(), plants: plants.arrays(), liquid: liquid.arrays() };
}
