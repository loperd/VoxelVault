import {
  Box3,
  BufferGeometry,
  Float32BufferAttribute,
  Plane,
  Vector2,
  Vector3,
  type Matrix4,
} from 'three';

/**
 * Procedural fracture of a real mesh into solid convex chunks.
 *
 * 1. `fractureCells` cuts the part's box with seeded planes (a BSP). Normals stay close to the
 *    box axes, so pieces break off like stone or planks (blocky chunks, no glassy wedges), and
 *    slivers are rejected.
 * 2. `buildFragment` clips the mesh's own triangles to a cell (keeping their UVs, so the outside
 *    still shows the chest texture) and closes every cut with a cap polygon: the broken face,
 *    which gets its own material. The result is a closed convex polyhedron centred on its centroid,
 *    ready for a rigid body with a convex-hull collider.
 *
 * Same seed, same fragments; another seed, another break.
 */
export interface FractureCell {
  readonly planes: readonly Plane[];
  /** Sample points inside the cell (mesh space). */
  readonly points: readonly Vector3[];
  readonly centre: Vector3;
}

/** Inward-facing planes of a box, pushed out by `margin` so they never coincide with the mesh's faces. */
export function boxPlanes(box: Box3, margin = 0): Plane[] {
  return [0, 1, 2].flatMap((axis) => [
    new Plane(new Vector3().setComponent(axis, 1), -box.min.getComponent(axis) + margin),
    new Plane(new Vector3().setComponent(axis, -1), box.max.getComponent(axis) + margin),
  ]);
}

/**
 * Up to `count` convex cells. `jitter` 0..1 tilts cut normals away from the box axes
 * (0 = clean axis cuts, 1 = any direction). `vertical` 0..1 favours vertical cuts (slabs).
 *
 * `weak` points (rust, cracks, wear on the surface) attract the cuts: when a cell contains weak
 * points, its cut passes through one of them, so the part breaks where it is already failing.
 */
export function fractureCells(
  box: Box3,
  count: number,
  next: () => number,
  jitter = 0.25,
  vertical = 0.5,
  weak: readonly Vector3[] = [],
): FractureCell[] {
  const size = box.getSize(new Vector3());
  const samples = Array.from(
    { length: 480 },
    () =>
      new Vector3(
        box.min.x + size.x * next(),
        box.min.y + size.y * next(),
        box.min.z + size.z * next(),
      ),
  );
  let cells: { planes: Plane[]; points: Vector3[] }[] = [{ planes: [], points: samples }];
  for (let guard = 0; cells.length < count && guard < count * 10; guard++) {
    cells.sort((a, b) => b.points.length - a.points.length); // split the largest piece
    const cell = cells[0]!;
    if (cell.points.length < 24) break;
    // Cut across the cell's longest extent, the way a beam or slab snaps.
    const extent = new Box3().setFromPoints(cell.points).getSize(new Vector3());
    let axis = extent.x >= extent.y && extent.x >= extent.z ? 0 : extent.y >= extent.z ? 1 : 2;
    if (axis === 1 && next() < vertical) axis = next() < 0.5 ? 0 : 2;
    const normal = new Vector3()
      .setComponent(axis, 1)
      .add(new Vector3(next() - 0.5, next() - 0.5, next() - 0.5).multiplyScalar(jitter * 2))
      .normalize();
    const centre = cell.points
      .reduce((sum, point) => sum.add(point), new Vector3())
      .divideScalar(cell.points.length);
    // Through a weak spot if the cell has one, otherwise the middle region: pieces of comparable size.
    const inside = weak.filter((point) =>
      cell.planes.every((plane) => plane.distanceToPoint(point) >= 0),
    );
    const through = inside.length
      ? inside[Math.floor(next() * inside.length)]!.clone()
      : centre.clone().addScaledVector(normal, (next() - 0.5) * normal.dot(extent) * 0.4);
    const plane = new Plane().setFromNormalAndCoplanarPoint(normal, through);
    const front = cell.points.filter((point) => plane.distanceToPoint(point) >= 0);
    const back = cell.points.filter((point) => plane.distanceToPoint(point) < 0);
    if (front.length < cell.points.length * 0.25 || back.length < cell.points.length * 0.25)
      continue;
    cells = [
      ...cells.slice(1),
      { planes: [...cell.planes, plane], points: front },
      { planes: [...cell.planes, plane.clone().negate()], points: back },
    ];
  }
  return cells.map((cell) => ({
    planes: cell.planes,
    points: cell.points,
    centre: cell.points
      .reduce((sum, point) => sum.add(point), new Vector3())
      .divideScalar(cell.points.length),
  }));
}

interface Polygon {
  readonly points: Vector3[];
  readonly uvs: Vector2[];
  readonly broken: boolean;
}

const EPSILON = 1e-6;

/** Sutherland–Hodgman against one plane (keeps distance >= 0); collects points lying on the cut. */
function clipPolygon(polygon: Polygon, plane: Plane, onCut: Vector3[]): Polygon | undefined {
  const points: Vector3[] = [],
    uvs: Vector2[] = [];
  const count = polygon.points.length;
  for (let index = 0; index < count; index++) {
    const a = polygon.points[index]!,
      b = polygon.points[(index + 1) % count]!;
    const ua = polygon.uvs[index]!,
      ub = polygon.uvs[(index + 1) % count]!;
    const da = plane.distanceToPoint(a),
      db = plane.distanceToPoint(b);
    if (da >= -EPSILON) {
      points.push(a);
      uvs.push(ua);
      if (Math.abs(da) <= EPSILON) onCut.push(a);
    }
    if (da >= -EPSILON !== db >= -EPSILON && Math.abs(da - db) > EPSILON) {
      const t = da / (da - db);
      const point = a.clone().lerp(b, t);
      points.push(point);
      uvs.push(ua.clone().lerp(ub, t));
      onCut.push(point);
    }
  }
  return points.length >= 3 ? { points, uvs, broken: polygon.broken } : undefined;
}

/** Convex cap polygon closing a cut, ordered so its normal faces out of the kept side. */
function capPolygon(points: Vector3[], plane: Plane): Polygon | undefined {
  const unique: Vector3[] = [];
  for (const point of points)
    if (!unique.some((other) => other.distanceToSquared(point) < 1e-10)) unique.push(point);
  if (unique.length < 3) return undefined;
  const centre = unique
    .reduce((sum, point) => sum.add(point), new Vector3())
    .divideScalar(unique.length);
  const outward = plane.normal.clone().negate();
  const u = new Vector3().subVectors(unique[0]!, centre).normalize(),
    v = new Vector3().crossVectors(outward, u);
  unique.sort((a, b) => {
    const pa = a.clone().sub(centre),
      pb = b.clone().sub(centre);
    return Math.atan2(pa.dot(v), pa.dot(u)) - Math.atan2(pb.dot(v), pb.dot(u));
  });
  return { points: unique, uvs: unique.map(() => new Vector2()), broken: true };
}

export interface Fragment {
  /** Group 0: outer surface (chest material); group 1: broken surface. Centred on `centre`. */
  readonly geometry: BufferGeometry;
  /** Fragment centre in the space the source was transformed to (usually world). */
  readonly centre: Vector3;
  /** Hull vertices relative to `centre`, for a convex collider. */
  readonly hull: Float32Array;
  readonly volume: number;
}

/**
 * Builds the solid fragment of `source` inside `cell`. `toSpace` maps mesh coordinates to the output
 * space (the mesh's world matrix); `texel` is one model texel in output units, for the broken-face UVs.
 */
export function buildFragment(
  source: BufferGeometry,
  cell: FractureCell,
  toSpace: Matrix4,
  texel: number,
): Fragment | undefined {
  const geometry = source.index ? source.toNonIndexed() : source;
  const position = geometry.getAttribute('position'),
    uv = geometry.getAttribute('uv');
  let polygons: Polygon[] = [];
  for (let index = 0; index + 2 < position.count; index += 3) {
    polygons.push({
      broken: false,
      points: [0, 1, 2].map(
        (offset) =>
          new Vector3(
            position.getX(index + offset),
            position.getY(index + offset),
            position.getZ(index + offset),
          ),
      ),
      uvs: [0, 1, 2].map((offset) =>
        uv ? new Vector2(uv.getX(index + offset), uv.getY(index + offset)) : new Vector2(),
      ),
    });
  }
  if (geometry !== source) geometry.dispose();
  for (const plane of cell.planes) {
    const onCut: Vector3[] = [];
    polygons = polygons.flatMap((polygon) => clipPolygon(polygon, plane, onCut) ?? []);
    const cap = capPolygon(onCut, plane);
    if (cap) polygons.push(cap);
  }
  if (polygons.length < 4) return undefined;
  // Keep mesh-space copies: surface overlays (rust, moss, cracks) project from them.
  const sources = polygons.map((polygon) => polygon.points.map((point) => point.clone()));
  const sourceNormals = polygons.map((polygon) =>
    new Vector3()
      .subVectors(polygon.points[1]!, polygon.points[0]!)
      .cross(new Vector3().subVectors(polygon.points[2]!, polygon.points[0]!))
      .normalize(),
  );
  // Cut points are shared by a face and its cap: copy before transforming, or they move twice.
  polygons = polygons.map((polygon) => ({
    ...polygon,
    points: polygon.points.map((point) => point.clone().applyMatrix4(toSpace)),
  }));
  // A mirroring transform flips the winding; restore it so normals keep pointing outwards.
  if (toSpace.determinant() < 0)
    polygons.forEach((polygon, index) => {
      polygon.points.reverse();
      polygon.uvs.reverse();
      sources[index]!.reverse();
    });
  const all = polygons.flatMap((polygon) => polygon.points);
  const centre = all.reduce((sum, point) => sum.add(point), new Vector3()).divideScalar(all.length);
  const outer: number[] = [],
    outerUv: number[] = [],
    inner: number[] = [],
    innerUv: number[] = [];
  const outerSource: number[] = [],
    innerSource: number[] = [],
    outerSourceNormal: number[] = [],
    innerSourceNormal: number[] = [];
  let volume = 0;
  for (const [polygonIndex, polygon] of polygons.entries()) {
    const target = polygon.broken ? inner : outer,
      targetUv = polygon.broken ? innerUv : outerUv;
    const targetSource = polygon.broken ? innerSource : outerSource,
      targetSourceNormal = polygon.broken ? innerSourceNormal : outerSourceNormal;
    const source = sources[polygonIndex]!,
      sourceNormal = sourceNormals[polygonIndex]!;
    const normal = new Vector3()
      .subVectors(polygon.points[1]!, polygon.points[0]!)
      .cross(new Vector3().subVectors(polygon.points[2]!, polygon.points[0]!))
      .normalize();
    const axis =
      Math.abs(normal.x) > Math.abs(normal.y) && Math.abs(normal.x) > Math.abs(normal.z)
        ? 0
        : Math.abs(normal.y) > Math.abs(normal.z)
          ? 1
          : 2;
    const [ua, va] = axis === 0 ? [2, 1] : axis === 1 ? [0, 2] : [0, 1];
    for (let index = 1; index + 1 < polygon.points.length; index++) {
      for (const vertex of [0, index, index + 1]) {
        const point = polygon.points[vertex]!.clone().sub(centre);
        target.push(point.x, point.y, point.z);
        targetSource.push(source[vertex]!.x, source[vertex]!.y, source[vertex]!.z);
        targetSourceNormal.push(sourceNormal.x, sourceNormal.y, sourceNormal.z);
        // Broken faces: planar texel-grid UVs, so the break texture has the chest's pixel size.
        if (polygon.broken)
          innerUv.push(
            point.getComponent(ua!) / (texel * 16),
            point.getComponent(va!) / (texel * 16),
          );
        else targetUv.push(polygon.uvs[vertex]!.x, polygon.uvs[vertex]!.y);
      }
      const a = polygon.points[0]!.clone().sub(centre),
        b = polygon.points[index]!.clone().sub(centre),
        c = polygon.points[index + 1]!.clone().sub(centre);
      volume += a.dot(b.cross(c)) / 6;
    }
  }
  const result = new BufferGeometry();
  result.setAttribute('position', new Float32BufferAttribute([...outer, ...inner], 3));
  result.setAttribute('uv', new Float32BufferAttribute([...outerUv, ...innerUv], 2));
  // Mesh-space position and normal of the source surface, for overlays that project from it.
  result.setAttribute(
    'sourcePosition',
    new Float32BufferAttribute([...outerSource, ...innerSource], 3),
  );
  result.setAttribute(
    'sourceNormal',
    new Float32BufferAttribute([...outerSourceNormal, ...innerSourceNormal], 3),
  );
  result.addGroup(0, outer.length / 3, 0);
  result.addGroup(outer.length / 3, inner.length / 3, 1);
  result.computeVertexNormals(); // non-indexed: flat per face
  const hull = new Float32Array(
    all.flatMap((point) => [point.x - centre.x, point.y - centre.y, point.z - centre.z]),
  );
  return { geometry: result, centre, hull, volume: Math.abs(volume) };
}
