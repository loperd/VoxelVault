/**
 * Procedural game sounds (Web Audio, no files): one shared context for every action that needs a
 * sound — interface clicks and navigation, the chest breaking (energy crackle, burst, crumble),
 * debris landing, and the outcome stings. Muted together with the rest through SoundSettings.
 * Everything is optional: no context, a suspended context or an error simply means silence.
 */
export type { Rarity as RewardRarity } from '../../../domain/item.ts';
import type { Rarity as RewardRarity } from '../../../domain/item.ts';

class GameAudio {
  private context?: AudioContext;
  private noise?: AudioBuffer;
  private muted = false;
  private lastThud = 0;
  private active = 0;

  /** Call inside a user gesture (any click); browsers only start audio from one. */
  unlock(): void {
    try {
      this.context ??= new AudioContext();
      void this.context.resume().catch(() => {});
    } catch {
      /* sound is optional */
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /** Button press: a short dry tick. */
  click(): void {
    this.tone(1900, 1500, 0.035, 0.025, 'square');
  }

  /** Moving between screens: a soft airy swipe. */
  navigate(): void {
    this.noiseBurst(0.16, 0.02, 900, 3200, 'bandpass');
  }

  /** The chest straining against the energy inside: crackle that grows with `charge` 0..1. */
  strain(charge: number): void {
    if (Math.random() > 0.25 + charge * 0.6) return;
    this.noiseBurst(
      0.025 + Math.random() * 0.03,
      0.01 + charge * 0.03,
      1800 + Math.random() * 2400,
      1400,
      'highpass',
    );
  }

  /** The energy released: a deep boom, a rushing blast and splitting crackle. */
  burst(strength: number): void {
    const level = Math.min(1, 0.5 + strength * 0.4);
    this.tone(70, 28, 0.9, 0.22 * level, 'sine');
    this.tone(140, 45, 0.35, 0.06 * level, 'triangle');
    this.noiseBurst(0.7, 0.12 * level, 2600, 220, 'lowpass');
    for (let index = 0; index < 6; index++)
      this.later(index * 0.04 + Math.random() * 0.05, () => this.crack(0.6 * level));
  }

  /** A mechanical break on landing: cracking and a short collapse, no energy boom. */
  breakOnImpact(strength: number): void {
    this.tone(95, 40, 0.3, 0.1 * strength, 'sine');
    for (let index = 0; index < 4; index++)
      this.later(index * 0.05 + Math.random() * 0.04, () => this.crack(0.5 * strength));
    this.crumble(0.8 * strength);
  }

  /** Stone splitting. */
  crack(level = 0.6): void {
    this.noiseBurst(
      0.05 + Math.random() * 0.05,
      0.05 * level,
      2200 + Math.random() * 1800,
      900,
      'bandpass',
    );
  }

  /** Rubble pouring down. */
  crumble(level = 0.6): void {
    for (let index = 0; index < 10; index++) {
      this.later(index * 0.06 + Math.random() * 0.05, () =>
        this.noiseBurst(
          0.04,
          0.02 * level * (1 - index / 12),
          700 + Math.random() * 600,
          500,
          'lowpass',
        ),
      );
    }
  }

  /** A chunk hitting the floor or another chunk: heavier and faster is louder and lower. */
  thud(mass: number, speed: number): void {
    const context = this.context;
    if (!context) return;
    const now = context.currentTime;
    if (now - this.lastThud < 0.03 || this.active > 14) return; // a hail of hits, not a wall of noise
    this.lastThud = now;
    const level = Math.min(1, speed / 4) * Math.min(1, 0.25 + Math.sqrt(mass) * 1.4);
    if (level < 0.04) return;
    const pitch = 160 - Math.min(90, Math.sqrt(mass) * 220);
    this.tone(pitch, pitch * 0.45, 0.12, 0.09 * level, 'sine');
    this.noiseBurst(0.03, 0.04 * level, 1400, 500, 'lowpass');
  }

  /** The roulette draws back before it runs: a low swell rising into the spin. */
  spinStart(): void {
    this.tone(90, 180, 0.45, 0.04, 'triangle');
    this.noiseBurst(0.5, 0.015, 400, 2400, 'bandpass');
  }

  /** The prize card locks under the pointer: a short, solid latch. */
  spinLock(): void {
    this.tone(320, 180, 0.09, 0.07, 'square');
    this.tone(640, 640, 0.25, 0.025, 'triangle');
    this.noiseBurst(0.05, 0.03, 1600, 700, 'lowpass');
  }

  /** Outcome: a rising arpeggio, brighter for rarer rewards. */
  reward(rarity: RewardRarity): void {
    const notes = {
      common: [523, 659, 784],
      uncommon: [523, 659, 784, 1047],
      rare: [587, 740, 880, 1175],
      epic: [622, 784, 932, 1245, 1568],
      legendary: [659, 831, 988, 1319, 1661],
    }[rarity];
    notes.forEach((note, index) =>
      this.later(index * 0.09, () => {
        this.tone(note, note, 0.45, 0.05, 'triangle');
        this.tone(note * 2, note * 2, 0.3, 0.012, 'sine');
      }),
    );
  }

  /** Outcome: the reward is lost — a low, falling, dissonant sting. */
  destroyed(): void {
    this.tone(220, 110, 1.1, 0.06, 'sawtooth');
    this.tone(233, 116, 1.1, 0.045, 'sawtooth');
    this.later(0.18, () => this.tone(147, 70, 1.2, 0.07, 'triangle'));
    this.noiseBurst(0.9, 0.03, 600, 120, 'lowpass');
  }

  private later(seconds: number, play: () => void) {
    setTimeout(play, seconds * 1000);
  }

  private ready(): AudioContext | undefined {
    const context = this.context;
    return !this.muted && context && context.state === 'running' ? context : undefined;
  }

  private tone(from: number, to: number, duration: number, volume: number, type: OscillatorType) {
    const context = this.ready();
    if (!context) return;
    try {
      const oscillator = context.createOscillator(),
        gain = context.createGain(),
        now = context.currentTime;
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(Math.max(20, from), now);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, to), now + duration);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(volume, now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      this.track(oscillator, gain);
      oscillator.start(now);
      oscillator.stop(now + duration + 0.02);
    } catch {
      /* optional */
    }
  }

  private noiseBurst(
    duration: number,
    volume: number,
    from: number,
    to: number,
    type: BiquadFilterType,
  ) {
    const context = this.ready();
    if (!context) return;
    try {
      if (!this.noise) {
        this.noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
        const data = this.noise.getChannelData(0);
        for (let index = 0; index < data.length; index++) data[index] = Math.random() * 2 - 1;
      }
      const source = context.createBufferSource(),
        filter = context.createBiquadFilter(),
        gain = context.createGain();
      const now = context.currentTime;
      source.buffer = this.noise;
      source.playbackRate.value = 0.8 + Math.random() * 0.4;
      filter.type = type;
      filter.Q.value = type === 'bandpass' ? 1.4 : 0.7;
      filter.frequency.setValueAtTime(from, now);
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, to), now + duration);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(volume, now + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);
      this.track(source, gain);
      source.start(now, Math.random() * 0.5);
      source.stop(now + duration + 0.02);
    } catch {
      /* optional */
    }
  }

  private track(node: AudioScheduledSourceNode, gain: GainNode) {
    this.active++;
    node.onended = () => {
      this.active--;
      node.disconnect();
      gain.disconnect();
    };
  }
}

/** The project's one audio voice for actions (the roulette tick and chest opening keep their own). */
export const gameAudio = new GameAudio();
