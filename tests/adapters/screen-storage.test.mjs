import assert from 'node:assert/strict';
import test from 'node:test';
import { ScreenStorage } from '../../src/adapters/outbound/browser/screen-storage.ts';

test('damaged, future-version and denied browser snapshots fall back safely', () => {
  let raw = '{bad';
  const storage = new ScreenStorage(() => ({ getItem: () => raw, setItem() {}, removeItem() {} }));
  assert.equal(
    storage.read('x', (value) => value),
    undefined,
  );
  raw = JSON.stringify({ version: 99, value: 'future' });
  assert.equal(
    storage.read('x', (value) => value),
    undefined,
  );
  const denied = new ScreenStorage(() => {
    throw new Error('Denied');
  });
  assert.equal(
    denied.read('x', (value) => value),
    undefined,
  );
  assert.doesNotThrow(() => {
    denied.write('x', 'state');
    denied.remove('x');
  });
});
