import assert from 'node:assert/strict';
import test from 'node:test';
import { blockAtlas, TILE } from '../../packages/blockworld/src/atlas.ts';

test('a speckled tile is patches of its own shades, darkest to lightest, not per-pixel noise', () => {
  const original = globalThis.document,
    pixels = new Map();
  const canvas = {
    getContext: () => ({
      fillStyle: '',
      fillRect(x, y) {
        pixels.set(`${x},${y}`, this.fillStyle);
      },
      clearRect(x, y) {
        pixels.delete(`${x},${y}`);
      },
    }),
  };
  globalThis.document = { createElement: () => canvas };
  try {
    const [u0, , , v1] = blockAtlas().uv('amethyst');
    const x0 = Math.round((u0 * canvas.width) / TILE) * TILE,
      y0 = Math.round(((1 - v1) * canvas.height) / TILE) * TILE;
    const at = (x, y) => pixels.get(`${x0 + x},${y0 + y}`);
    const shades = ['#8a5cc8', '#a678e0', '#7346b0', '#c29af2'],
      seen = new Set();
    let same = 0;
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        seen.add(at(x, y));
        if (x > 0 && at(x, y) === at(x - 1, y)) same++;
      }
    assert.deepEqual([...seen].sort(), [...shades].sort(), 'every shade shows, nothing else');
    // Picked pixel by pixel, a quarter of neighbours would match; patches make it well over a third.
    assert.ok(same / (TILE * (TILE - 1)) > 0.38, `neighbours alike: ${same}`);
  } finally {
    globalThis.document = original;
  }
});
