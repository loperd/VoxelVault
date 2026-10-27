/** Bounded pool: skipped frames produce one tick, never a catch-up burst. */
export class ClickSound {
  private readonly voices: HTMLAudioElement[];
  private disposed = false;
  private unlocked = false;
  private muted = false;
  constructor(url: string, create: (url: string) => HTMLAudioElement = (url) => new Audio(url)) {
    this.voices = Array.from({ length: 4 }, () => {
      const voice = create(url);
      voice.volume = 0.05;
      voice.preload = 'auto';
      return voice;
    });
  }

  /** Called synchronously by the user's Open click. Autoplay refusal is nonfatal. */
  unlock(): void {
    if (this.disposed || this.unlocked) return;
    this.unlocked = true;
    for (const voice of this.voices) {
      try {
        voice.muted = true;
        const playing = voice.play();
        Promise.resolve(playing).then(
          () => {
            if (this.disposed) return;
            voice.pause();
            voice.currentTime = 0;
            voice.muted = false;
          },
          () => {
            if (!this.disposed) voice.muted = false;
          },
        );
      } catch {
        voice.muted = false;
      }
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.stop();
  }

  /** `rate` pitches the tick with the strip's speed: faster cards click higher. */
  tick(rate = 1): void {
    if (this.disposed || this.muted) return;
    const voice = this.voices.find((voice) => !voice.muted && (voice.paused || voice.ended));
    if (!voice) return;
    try {
      voice.playbackRate = rate;
      voice.currentTime = 0;
      void Promise.resolve(voice.play()).catch(() => {});
    } catch {
      /* optional sound */
    }
  }

  stop(): void {
    for (const voice of this.voices) {
      voice.pause();
      voice.currentTime = 0;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    for (const voice of this.voices) {
      voice.removeAttribute('src');
      voice.load();
    }
  }
}
