import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
} from 'three';
import {
  BlockRegistry,
  BlockWorld,
  blockAtlas,
  computeLight,
  meshWorld,
  worldMeshes,
  type BlockDefinition,
  type Stage,
  type StageBuilder,
} from '../../../../../packages/blockworld/src/index.ts';
import type { ChestHandles } from '../../../../application/ports/chest-handles.ts';
import { mapState, parseState, type Verdict } from './schematic-blocks.ts';

/**
 * Import experiment: a Minecraft build from a schematic, converted offline (research/prismarine/
 * convert.mjs) into research/schematics/*.json — third-party, local only, never shipped; without the
 * files there are no such scenes. Every block state goes through schematic-blocks.ts; nothing is
 * replaced silently: `diagnose` outlines the cells drawn with a stand-in tile (amber), a simpler shape
 * (magenta) or not at all (red).
 */
export interface Converted {
  readonly source: string;
  readonly version: string;
  readonly size: readonly [number, number, number];
  readonly palette: readonly string[];
  readonly blocks: readonly number[];
}
const FILES = import.meta.glob<Converted>('../../../../../research/schematics/*.json', {
  eager: true,
  import: 'default',
});
export const SCHEMATICS: Readonly<Record<string, Converted>> = Object.fromEntries(
  Object.entries(FILES).map(([path, data]) => [path.replace(/^.*\/|\.json$/g, ''), data]),
);

export interface ImportView {
  /** Overview: open to the sky, near-isometric, roof (y ≥ `roof`) and the shell (`shell` blocks on the bounds) taken off. */
  readonly cutaway?: { readonly roof: number; readonly shell: string };
  readonly diagnose?: boolean;
  /** Art shot: the chest on top of this cell, the camera at `eye` (cells), looking at the chest. */
  readonly chest?: {
    readonly cell: readonly [number, number, number];
    readonly eye: readonly [number, number, number];
    readonly lamp: readonly [number, number, number];
    readonly fov: number;
  };
}

const OUTLINE: Readonly<Record<Exclude<Verdict, 'exact'>, number>> = {
  texture: 0xffb020,
  shape: 0xff30d0,
  missing: 0xff2020,
};

export function imported(name: string, view: ImportView): StageBuilder<ChestHandles> {
  return {
    id: `import-${name}`,
    build(): Stage<ChestHandles> {
      const data = SCHEMATICS[name];
      if (!data) throw new Error(`No converted schematic "${name}" in research/schematics/`);
      const [X, Y, Z] = data.size,
        mapped = data.palette.map(mapState);
      const definitions: BlockDefinition[] = mapped.flatMap((m) =>
        m.definition ? [m.definition] : [],
      );
      const registry = new BlockRegistry(definitions);
      const ids = mapped.map((m) => (m.definition ? registry.id(m.definition.name) : 0));
      const w = new BlockWorld(X, Y + 2, Z, [-Math.floor(X / 2), 0, -Math.floor(Z / 2)]);
      const cutaway = view.cutaway,
        shell = cutaway && data.palette.findIndex((s) => parseState(s).name === cutaway.shell);
      for (let y = 0; y < Y; y++)
        for (let z = 0; z < Z; z++)
          for (let x = 0; x < X; x++) {
            const i = data.blocks[(y * Z + z) * X + x]!;
            if (
              cutaway &&
              (y >= cutaway.roof ||
                (i === shell && (x === 0 || z === 0 || x === X - 1 || z === Z - 1)))
            )
              continue;
            if (ids[i]) w.set(x, y, z, ids[i]!);
          }
      computeLight(w, registry);
      const { texture, uv } = blockAtlas(),
        root = new Group();
      const lit = cutaway
        ? { sky: [1, 1, 1] as const, minimum: 0.25 }
        : { sky: [0, 0, 0] as const, minimum: 0.03 };
      root.add(
        ...worldMeshes(
          meshWorld(w, registry, { uv, ...lit, glow: [1, 0.78, 0.5], occlusion: 0.7 }),
          texture,
        ),
      );
      if (view.diagnose)
        root.add(
          ...outlines(
            w,
            data,
            mapped.map((m) => m.verdict),
          ),
        );

      const sky = cutaway
        ? { top: '#9fb3c4', horizon: '#c9d3db', bottom: '#c9d3db' }
        : { top: '#000000', horizon: '#000000', bottom: '#000000' };
      const [ox, , oz] = w.origin,
        centre = [0, Y / 3, 0] as const;
      if (!view.chest) {
        const look = [-1, 0.82, 1] as const,
          k = 120 / Math.hypot(...look);
        return {
          root,
          living: [],
          calm: 0,
          flicker: 0,
          sky,
          fog: { color: sky.horizon, near: 400, far: 800 },
          camera: {
            position: [centre[0] + look[0] * k, centre[1] + look[1] * k, centre[2] + look[2] * k],
            target: centre,
            fov: 26,
            drift: 0,
          },
        };
      }
      const { cell, eye, lamp, fov } = view.chest,
        anchor = [cell[0] + ox + 0.5, cell[1] + 1, cell[2] + oz + 0.5] as const;
      const at = [lamp[0] + ox + 0.5, lamp[1] + 0.5, lamp[2] + oz + 0.5];
      return {
        root,
        living: [],
        calm: 0,
        flicker: 0.08,
        sky,
        fog: { color: '#000000', near: 18, far: 60 },
        camera: {
          position: [eye[0] + ox + 0.5, eye[1] + 0.5, eye[2] + oz + 0.5],
          target: [anchor[0], anchor[1] + 0.6, anchor[2]],
          fov,
          drift: 0,
          focus: [0.5, 0.44],
        },
        anchor,
        ground: { floor: anchor[1] },
        light: {
          sky: '#3a3026',
          ground: '#0d0a08',
          key: '#ffc890',
          from: [at[0]! - anchor[0], at[1]! - anchor[1], at[2]! - anchor[2]],
          keyStrength: 5,
          fillStrength: 0.8,
        },
      };
    },
  };
}

/** Box edges around every visible cell whose block is not drawn as the game draws it. */
function outlines(w: BlockWorld, data: Converted, verdicts: readonly Verdict[]): LineSegments[] {
  const [X, Y, Z] = data.size,
    [ox, oy, oz] = w.origin,
    points = new Map<Verdict, number[]>();
  const edges = [
    [0, 0, 0, 1, 0, 0],
    [0, 1, 0, 1, 1, 0],
    [0, 0, 1, 1, 0, 1],
    [0, 1, 1, 1, 1, 1],
    [0, 0, 0, 0, 1, 0],
    [1, 0, 0, 1, 1, 0],
    [0, 0, 1, 0, 1, 1],
    [1, 0, 1, 1, 1, 1],
    [0, 0, 0, 0, 0, 1],
    [1, 0, 0, 1, 0, 1],
    [0, 1, 0, 0, 1, 1],
    [1, 1, 0, 1, 1, 1],
  ];
  for (let y = 0; y < Y; y++)
    for (let z = 0; z < Z; z++)
      for (let x = 0; x < X; x++) {
        const v = verdicts[data.blocks[(y * Z + z) * X + x]!]!;
        // Cells the cutaway took off are not in the world.
        if (v === 'exact' || !w.get(x, y, z)) continue;
        // Only cells that show: one open side.
        if (
          ![
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
            [0, 0, 1],
            [0, 0, -1],
          ].some(([dx, dy, dz]) => !w.get(x + dx!, y + dy!, z + dz!))
        )
          continue;
        const list = points.get(v) ?? [];
        points.set(v, list);
        for (const e of edges)
          list.push(
            x + ox + e[0]!,
            y + oy + e[1]!,
            z + oz + e[2]!,
            x + ox + e[3]!,
            y + oy + e[4]!,
            z + oz + e[5]!,
          );
      }
  return [...points].map(([v, list]) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(list, 3));
    return new LineSegments(
      g,
      new LineBasicMaterial({ color: OUTLINE[v as Exclude<Verdict, 'exact'>], depthTest: true }),
    );
  });
}
