import { DataTexture, NearestFilter, RGBAFormat, RepeatWrapping, SRGBColorSpace } from 'three';

/**
 * A small original pixel skin for box models: a base colour with per-pixel grain, darker seams and
 * sparse bright specks (our own art, in the spirit of the atlas's procedural tiles; no game assets).
 * Every face of a BoxGeometry maps the whole texture, so one skin serves all the boxes of a model.
 */
export function pixelSkin(base: string, speck: string, seed: number, size = 16): DataTexture {
  const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [b, s] = [hex(base), hex(speck)] as [number[], number[]];
  const hash = (x: number, y: number) => {
    const v = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
    return v - Math.floor(v);
  };
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const n = hash(x, y);
      // Grain, a darker seam along the edge, and a rare speck.
      const light = 0.8 + n * 0.4 - (x === 0 || y === 0 ? 0.18 : 0);
      const lit = n > 0.94;
      for (let k = 0; k < 3; k++)
        data[(y * size + x) * 4 + k] = Math.min(255, (lit ? s[k]! : b[k]! * light) | 0);
      data[(y * size + x) * 4 + 3] = 255;
    }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = texture.minFilter = NearestFilter;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * A dense dark shell split by cracks that glow like a liquid core: Voronoi cells, bright along their
 * edges (the gap between the nearest and the second-nearest site is small there).
 */
export function crackedSkin(dark: string, glow: string, seed: number, size = 32): DataTexture {
  const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [d, g] = [hex(dark), hex(glow)] as [number[], number[]];
  const rand = (i: number) => {
    const v = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  const sites = Array.from({ length: 9 }, (_, i) => [rand(i * 2) * size, rand(i * 2 + 1) * size]);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let near = 1e9,
        second = 1e9;
      for (const [sx, sy] of sites) {
        // Wrapped, so the texture tiles round the sphere without a seam.
        const dx = Math.min(Math.abs(x - sx!), size - Math.abs(x - sx!)),
          dy = Math.min(Math.abs(y - sy!), size - Math.abs(y - sy!)),
          dist = Math.hypot(dx, dy);
        if (dist < near) [near, second] = [dist, near];
        else if (dist < second) second = dist;
      }
      const crack = Math.max(0, 1 - (second - near) / 2.2);
      for (let k = 0; k < 3; k++)
        data[(y * size + x) * 4 + k] = Math.min(255, d[k]! + (g[k]! - d[k]!) * crack * crack);
      data[(y * size + x) * 4 + 3] = 255;
    }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = texture.minFilter = NearestFilter;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}
