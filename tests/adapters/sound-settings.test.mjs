import assert from 'node:assert/strict';
import test from 'node:test';
import { SoundSettings } from '../../src/adapters/outbound/browser/sound-settings.ts';
import { ClickSound } from '../../src/adapters/outbound/browser/click-sound.ts';

test('sound preference survives a reload and unlocks only on explicit enable', () => {
  const memory = new Map(),
    applied = [];
  let unlocks = 0;
  const storage = {
    getItem: (key) => memory.get(key),
    setItem: (key, value) => memory.set(key, value),
  };
  const preference = new SoundSettings(
    () => storage,
    (muted) => applied.push(muted),
    () => unlocks++,
  );
  assert.equal(preference.isMuted(), false);
  assert.equal(unlocks, 0);
  preference.setMuted(true);
  const restored = new SoundSettings(
    () => storage,
    (muted) => applied.push(muted),
    () => unlocks++,
  );
  assert.equal(restored.isMuted(), true);
  restored.setMuted(false);
  assert.equal(unlocks, 1);
  assert.deepEqual(applied, [false, true, true, false]);
});

test('unavailable storage does not block changing sound', () => {
  const preference = new SoundSettings(
    () => {
      throw new Error('Denied');
    },
    () => {},
  );
  preference.setMuted(true);
  assert.equal(preference.isMuted(), true);
  preference.setMuted(false);
  assert.equal(preference.isMuted(), false);
});

test('muting roulette stops active voices and prevents further ticks', () => {
  const voices = [];
  let plays = 0;
  const sound = new ClickSound('tick.wav', () => {
    const voice = {
      muted: false,
      paused: true,
      ended: false,
      currentTime: 0,
      play() {
        plays++;
        this.paused = false;
        return Promise.resolve();
      },
      pause() {
        this.paused = true;
      },
      removeAttribute() {},
      load() {},
    };
    voices.push(voice);
    return voice;
  });
  sound.tick();
  assert.equal(plays, 1);
  sound.setMuted(true);
  assert.ok(voices.every((voice) => voice.paused));
  sound.tick();
  assert.equal(plays, 1);
  sound.setMuted(false);
  sound.tick();
  assert.equal(plays, 2);
  sound.dispose();
});
