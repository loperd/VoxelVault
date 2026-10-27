import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshBasicMaterial, MeshLambertMaterial, ShaderChunk, ShaderLib } from 'three';
import { moving } from '../../packages/blockworld/src/view.ts';

// No WebGL in node: GLSL rejects a second declaration of a name in one scope, so count them in main().
const expand = (source) =>
  source.replace(/#include <(\w+)>/g, (_, name) => expand(ShaderChunk[name]));
const main = (source) => source.slice(source.indexOf('void main()'));
const declarations = (source) => {
  const counts = new Map();
  for (const [, name] of source.matchAll(/\b(?:float|int|bool|vec[234]|mat[34])\s+(\w+)\s*[=;]/g))
    counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
};

test('the sway and wave chunks declare no name the stock basic or Lambert (Shadow PoC) shader already has', () => {
  for (const [Material, lib] of [
    [MeshBasicMaterial, ShaderLib.basic],
    [MeshLambertMaterial, ShaderLib.lambert],
  ])
    for (const kind of ['sway', 'wave']) {
      const shader = {
        uniforms: {},
        vertexShader: lib.vertexShader,
        fragmentShader: lib.fragmentShader,
      };
      moving(new Material(), kind).onBeforeCompile(shader);
      for (const stage of ['vertexShader', 'fragmentShader']) {
        const stock = declarations(main(expand(lib[stage]))),
          patched = declarations(main(expand(shader[stage])));
        const clashes = [...patched]
          .filter(([name, count]) => stock.has(name) && count > stock.get(name))
          .map(([name]) => name);
        assert.deepEqual(clashes, [], `${Material.name} ${kind} ${stage} redeclares ${clashes}`);
      }
    }
});
