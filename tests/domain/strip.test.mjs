import assert from 'node:assert/strict';
import test from 'node:test';
import { copyCatalog, copyItem } from '../../src/domain/item.ts';
import { buildStrip, ensureTarget } from '../../src/domain/strip.ts';
import { constantRandom, item, legacyCatalog, seededRandom } from '../helpers.mjs';

test('the legacy percentages create 39 slots; selecting King inserts the 40th', () => {
  const catalog = legacyCatalog();
  const strip = buildStrip(catalog, 40, constantRandom());
  assert.equal(strip.length, 39);
  assert.equal(
    strip.some((slot) => slot.item.id === '14'),
    false,
  );
  const selected = ensureTarget(strip, catalog[13], constantRandom());
  assert.equal(selected.slots.length, 40);
  assert.equal(selected.slots[selected.targetIndex].item.title, 'King');
  assert.equal(strip.length, 39);
  assert.equal(new Set(selected.slots.map((slot) => slot.id)).size, 40);
});

test('shuffle changes item order while preserving rounded counts and input order', () => {
  const catalog = legacyCatalog();
  const original = structuredClone(catalog);
  const first = buildStrip(catalog, 40, constantRandom(0));
  const last = buildStrip(catalog, 40, constantRandom(1 - Number.EPSILON));
  assert.notDeepEqual(
    first.map((slot) => slot.item.id),
    last.map((slot) => slot.item.id),
  );
  assert.deepEqual(catalog, original);
  for (const entry of catalog) {
    assert.equal(
      first.filter((slot) => slot.item.id === entry.id).length,
      Math.round(0.4 * entry.displayWeight),
    );
  }
});

test('capacity caps overallocated percentages without normalizing them', () => {
  const strip = buildStrip([item('a', 100), item('b', 100)], 40, constantRandom(0));
  assert.equal(strip.length, 40);
  assert.equal(new Set(strip.map((slot) => slot.item.id)).size, 1);
});

test('multiple matches include both legal endpoints and never select past the array', () => {
  const strip = buildStrip([item('a', 100)], 40, constantRandom());
  assert.equal(ensureTarget(strip, item('a'), constantRandom(0)).targetIndex, 0);
  assert.equal(ensureTarget(strip, item('a'), constantRandom(1 - Number.EPSILON)).targetIndex, 39);
});

test('missing prizes can be inserted at either end of the actual strip', () => {
  const strip = buildStrip([item('a', 10)], 40, constantRandom());
  assert.equal(strip.length, 4);
  const first = ensureTarget(strip, item('b'), constantRandom(0));
  const last = ensureTarget(strip, item('b'), constantRandom(1 - Number.EPSILON));
  assert.equal(first.targetIndex, 0);
  assert.equal(last.targetIndex, 4);
  assert.deepEqual(
    last.slots.slice(0, 4).map((slot) => slot.id),
    strip.map((slot) => slot.id),
  );
});

test('an all-zero catalog produces only the authoritative result on opening', () => {
  const strip = buildStrip([item('a')], 40, constantRandom());
  assert.equal(strip.length, 0);
  const selection = ensureTarget(strip, item('winner'), constantRandom());
  assert.equal(selection.targetIndex, 0);
  assert.equal(selection.slots.length, 1);
});

test('target metadata comes from the result even when the catalog has stale metadata', () => {
  const strip = buildStrip([item('a', 100)], 2, constantRandom());
  const prize = item('a', 0, { title: 'Updated', image: '/new.png', rarity: 'legendary' });
  const selection = ensureTarget(strip, prize, constantRandom(0));
  assert.deepEqual(selection.slots[selection.targetIndex].item, prize);
  assert.equal(strip[0].item.title, 'Item a');
  assert.notEqual(selection.prize, prize);
});

test('persistent inserts retain unique slot ids and are not reinserted', () => {
  let strip = buildStrip([item('a', 100)], 4, constantRandom());
  for (let i = 0; i < 20; i += 1) {
    const prize = item(`extra-${i}`);
    strip = ensureTarget(strip, prize, constantRandom()).slots;
    const selectedAgain = ensureTarget(strip, prize, constantRandom());
    assert.equal(selectedAgain.slots.length, strip.length);
  }
  assert.equal(strip.length, 24);
  assert.equal(new Set(strip.map((slot) => slot.id)).size, strip.length);
});

test('domain outputs cannot be mutated through caller references', () => {
  const catalog = [item('a', 100)];
  const strip = buildStrip(catalog, 2, constantRandom());
  catalog[0].title = 'Mutated';
  assert.equal(strip[0].item.title, 'Item a');
  assert.throws(() => strip.push(strip[0]), TypeError);
  assert.throws(() => {
    strip[0].item.title = 'Mutated';
  }, TypeError);
});

test('invalid catalog data is rejected before constructing a strip', () => {
  assert.throws(() => copyCatalog([]), { code: 'EMPTY_CATALOG' });
  assert.throws(() => copyCatalog([item('a'), item('a')]), { code: 'DUPLICATE_ITEM' });
  for (const patch of [
    { id: '' },
    { title: ' ' },
    { image: '' },
    { displayWeight: '25' },
    { displayWeight: -1 },
    { displayWeight: NaN },
    { displayWeight: Infinity },
    { rarity: 'primary' },
    { rarity: { toString: () => 'legendary' } },
  ]) {
    assert.throws(() => copyItem(item('a', 0, patch)), { code: 'INVALID_ITEM' });
  }
  assert.throws(() => copyCatalog(Array(1)), { code: 'INVALID_ITEM' });
});

test('invalid capacity, slot ids, and random values are rejected', () => {
  for (const capacity of [0, -1, 1.5, Infinity]) {
    assert.throws(() => buildStrip([item('a')], capacity, constantRandom()), {
      code: 'INVALID_CAPACITY',
    });
  }
  for (const value of [-1, 1, NaN, Infinity]) {
    assert.throws(() => ensureTarget([], item('a'), constantRandom(value)), {
      code: 'INVALID_RANDOM',
    });
  }
  const slot = { id: 'duplicate', item: item('a') };
  assert.throws(() => ensureTarget([slot, slot], item('a'), constantRandom()), {
    code: 'INVALID_STRIP',
  });
  assert.throws(() => ensureTarget(Array(1), item('a'), constantRandom()), {
    code: 'INVALID_STRIP',
  });
});

test('100 seeded catalogs and selections keep target indices and ids valid', () => {
  for (let seed = 0; seed < 100; seed += 1) {
    const random = seededRandom(seed);
    let strip = buildStrip(legacyCatalog(), 40, random);
    for (const prize of [...legacyCatalog(), item('external')]) {
      const selection = ensureTarget(strip, prize, random);
      assert.ok(selection.targetIndex >= 0 && selection.targetIndex < selection.slots.length);
      assert.equal(selection.slots[selection.targetIndex].item.id, prize.id);
      assert.equal(new Set(selection.slots.map((slot) => slot.id)).size, selection.slots.length);
      strip = selection.slots;
    }
  }
});
