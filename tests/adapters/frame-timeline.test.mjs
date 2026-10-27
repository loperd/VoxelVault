import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameTimeline } from '../../src/adapters/outbound/browser/frame-timeline.ts';
import { ClickSound } from '../../src/adapters/outbound/browser/click-sound.ts';
import { frameEnvironment as environment } from '../frame-environment.mjs';

test('timelines finish at the exact duration at 30/60/120 Hz and release RAF', async () => {
  for (const hz of [30, 60, 120]) {
    const env = environment(),
      timeline = new FrameTimeline(env),
      values = [];
    const done = timeline.run(0.6, (value) => values.push(value), new AbortController().signal);
    for (let frame = 0; frame <= hz; frame++) env.tick((frame * 1000) / hz);
    await done;
    assert.equal(values.at(-1), 0.6);
    assert.equal(env.frames.size, 0);
    timeline.dispose();
    assert.equal(env.listeners.size, 0);
  }
});

test('hidden time does not finish a transition; cancellation and rendering errors reject it', async () => {
  const env = environment(),
    timeline = new FrameTimeline(env),
    values = [];
  const abort = new AbortController();
  const done = timeline.run(1.2, (value) => values.push(value), abort.signal);
  const rejected = assert.rejects(done, /cancelled/);
  env.tick(0);
  env.tick(50);
  env.visibility(true);
  env.tick(60_000);
  env.visibility(false);
  env.tick(60_050);
  assert.equal(values.at(-1), 0.05);
  abort.abort(new Error('cancelled'));
  await rejected;
  assert.equal(env.frames.size, 0);
  let count = 0;
  const failed = timeline.run(
    1,
    () => {
      if (++count > 1) throw new Error('paint failed');
    },
    new AbortController().signal,
  );
  env.tick(70_000);
  await assert.rejects(failed, /paint failed/);
  assert.equal(env.frames.size, 0);
  timeline.dispose();
});

test('slow visible frames preserve transition duration instead of accumulating lost time', async () => {
  for (const gap of [250, 500, 1000, 16_000]) {
    const env = environment(),
      timeline = new FrameTimeline(env),
      values = [];
    const done = timeline.run(2.5, (value) => values.push(value), new AbortController().signal);
    env.tick(0);
    for (let now = gap; now <= Math.ceil(2500 / gap) * gap; now += gap) env.tick(now);
    assert.equal(
      values.at(-1),
      2.5,
      `ends on the first frame after 2.5 visible seconds (gap ${gap}ms)`,
    );
    assert.equal(env.frames.size, 0);
    await done;
    timeline.dispose();
  }
});

test('replacing an animation settles the old promise and disposal settles the active promise', async () => {
  const env = environment(),
    timeline = new FrameTimeline(env),
    signal = new AbortController().signal;
  const first = timeline.run(1, () => {}, signal);
  const rejected = assert.rejects(first, /replaced/);
  const second = timeline.run(1, () => {}, signal);
  await rejected;
  const disposed = assert.rejects(second, /cancelled/);
  timeline.dispose();
  timeline.dispose();
  await disposed;
  assert.equal(env.frames.size, 0);
  assert.equal(env.listeners.size, 0);
});

test('audio autoplay failures do not break the game and the pool is bounded and disposed', async () => {
  const voices = [];
  const sound = new ClickSound('/audio/click.wav', () => {
    const voice = {
      volume: 1,
      muted: false,
      paused: true,
      ended: false,
      currentTime: 0,
      plays: 0,
      pauses: 0,
      unloaded: 0,
      play() {
        this.plays++;
        return Promise.reject(new Error('Autoplay blocked'));
      },
      pause() {
        this.pauses++;
      },
      removeAttribute() {
        this.unloaded++;
      },
      load() {},
    };
    voices.push(voice);
    return voice;
  });
  sound.unlock();
  await Promise.resolve();
  sound.tick();
  await Promise.resolve();
  assert.equal(voices.length, 4);
  assert.ok(voices.every((voice) => voice.volume === 0.05));
  const plays = voices.reduce((sum, voice) => sum + voice.plays, 0);
  sound.dispose();
  sound.dispose();
  sound.tick();
  assert.equal(
    voices.reduce((sum, voice) => sum + voice.plays, 0),
    plays,
  );
  assert.ok(voices.every((voice) => voice.unloaded === 1));
});
