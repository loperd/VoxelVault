import {
  AdditiveBlending,
  Color,
  Box3,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  ShaderMaterial,
  DoubleSide,
  type Object3D,
} from 'three';

/** Owned by the chest scene; animation time is the only effects clock. */
export class ChestOpeningEffects {
  private readonly root = new Group();
  private readonly light = new PointLight(0x41ffcf, 0, 4, 2);
  private readonly glow = new Mesh(
    new PlaneGeometry(1, 1),
    new MeshBasicMaterial({
      color: 0x62ffdf,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: AdditiveBlending,
      side: 2,
    }),
  );
  private readonly beams = new Group();
  private readonly beamGeometry = new PlaneGeometry(0.3, 2.8);
  private readonly beamMaterial = new ShaderMaterial({
    uniforms: { energy: { value: 0 }, tint: { value: new Color() } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; vec3 p = position;
      p.x *= 0.5 + uv.y * 3.5; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
    fragmentShader: `varying vec2 vUv; uniform float energy; uniform vec3 tint; void main() {
      float edge = pow(max(0.0, 1.0 - abs(vUv.x - 0.5) * 2.0), 2.0);
      float height = smoothstep(0.0, 0.08, vUv.y) * pow(1.0 - vUv.y, 1.8);
      gl_FragColor = vec4(tint, edge * height * energy);
    }`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    toneMapped: false,
  });
  private readonly positions = new Float32Array(80 * 3);
  private readonly geometry = new BufferGeometry();
  private readonly material = new PointsMaterial({
    color: 0x7effdb,
    size: 0.055,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  private readonly particles: Points;
  private context?: AudioContext;
  private readonly voices = new Set<OscillatorNode>();
  private cue = 0;
  private active = false;
  private muted = false;

  constructor(chest: Object3D, color = 0x86ead0) {
    this.light.color.setHex(color);
    this.glow.material.color.setHex(color);
    this.material.color.setHex(color);
    this.beamMaterial.uniforms.tint!.value.setHex(color);
    const bounds = new Box3().setFromObject(chest);
    const width = bounds.max.x - bounds.min.x;
    const depth = bounds.max.z - bounds.min.z;
    this.root.position.set(
      (bounds.min.x + bounds.max.x) / 2,
      bounds.min.y + (bounds.max.y - bounds.min.y) * 0.64,
      (bounds.min.z + bounds.max.z) / 2,
    );
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.scale.set(width * 0.82, depth * 0.8, 1);
    this.geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    this.particles = new Points(this.geometry, this.material);
    this.particles.frustumCulled = false;
    for (let i = 0; i < 5; i++) {
      const beam = new Mesh(this.beamGeometry, this.beamMaterial);
      beam.position.y = 1.4;
      beam.rotation.y = (i * Math.PI) / 5;
      this.beams.add(beam);
    }
    this.root.add(this.light, this.glow, this.particles, this.beams);
    this.root.visible = false;
    chest.add(this.root);
  }

  /** Must be invoked in the Open button's synchronous user gesture. */
  unlock(): void {
    try {
      this.context ??= new AudioContext();
      void this.context.resume().catch(() => {});
    } catch {
      /* Sound is optional. */
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      for (const voice of this.voices) {
        try {
          voice.stop();
        } catch {
          /* Already stopped. */
        }
      }
    }
  }

  charge(): void {
    this.tone(75, 290, 1.25, 0.025, 'sine');
    this.tone(120, 430, 1.25, 0.008, 'triangle');
  }

  impact(): void {
    this.tone(105, 32, 0.22, 0.08, 'sine');
    this.tone(180, 55, 0.09, 0.018, 'triangle');
  }

  start(): void {
    this.stop();
    this.active = true;
    this.root.visible = true;
  }

  update(progress: number, reducedMotion: boolean): void {
    if (!this.active) return;
    const p = Math.max(0, Math.min(progress, 1));
    if (this.cue === 0) {
      this.tone(170, 65, 0.09, 0.035, 'triangle');
      this.cue = 1;
    }
    if (p >= 0.18 && this.cue === 1) {
      this.tone(100, 230, 0.35, 0.018, 'sawtooth');
      this.cue = 2;
    }
    if (p >= 0.65 && this.cue === 2) {
      this.tone(520, 1040, 0.42, 0.025, 'sine');
      this.tone(780, 1560, 0.5, 0.022, 'sine');
      this.tone(210, 55, 0.3, 0.045, 'triangle');
      this.cue = 3;
    }
    const reveal = Math.max(0, (p - 0.08) / 0.92);
    const burst = Math.max(0, (p - 0.42) / 0.58);
    this.light.intensity = reducedMotion ? 2 : 5 + reveal * 22 + Math.sin(burst * Math.PI) * 12;
    this.light.position.y = 0.25 + burst * 0.35;
    this.glow.material.opacity = reducedMotion ? 0.15 : 0.2 + reveal * 0.55;
    this.beams.visible = !reducedMotion;
    this.beamMaterial.uniforms.energy!.value = reveal * 0.95;
    this.beams.scale.setScalar(0.35 + reveal * 0.65);
    this.beams.rotation.y = p * 0.4;
    this.material.opacity = reducedMotion ? 0 : Math.min(1, reveal * 2.5);
    this.particles.visible = !reducedMotion;
    for (let i = 0; i < 80; i++) {
      const age = Math.max(0, burst - (i % 8) * 0.035);
      const angle = i * 2.399963;
      const radius = 0.12 + age * (0.7 + (i % 5) * 0.18);
      this.positions[i * 3] = Math.cos(angle) * radius;
      this.positions[i * 3 + 1] = age * (1.8 + (i % 7) * 0.3) - age * age * 0.7;
      this.positions[i * 3 + 2] = Math.sin(angle) * radius;
    }
    (this.geometry.getAttribute('position') as Float32BufferAttribute).array.set(this.positions);
    this.geometry.getAttribute('position').needsUpdate = true;
  }

  stop(): void {
    this.active = false;
    this.cue = 0;
    this.root.visible = false;
    for (const voice of this.voices) {
      try {
        voice.stop();
      } catch {
        /* Already ended. */
      }
      voice.disconnect();
    }
    this.voices.clear();
  }

  dispose(): void {
    this.stop();
    this.root.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.beamGeometry.dispose();
    this.beamMaterial.dispose();

    this.glow.geometry.dispose();
    this.glow.material.dispose();
    this.light.dispose();
    if (this.context) void this.context.close().catch(() => {});
  }

  private tone(
    from: number,
    to: number,
    duration: number,
    volume: number,
    type: OscillatorType,
  ): void {
    const context = this.context;
    if (this.muted || !context || context.state !== 'running') return;
    const oscillator = context.createOscillator(),
      gain = context.createGain();
    const now = context.currentTime;
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, now);
    oscillator.frequency.exponentialRampToValueAtTime(to, now + duration);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    this.voices.add(oscillator);
    oscillator.onended = () => {
      this.voices.delete(oscillator);
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(now);
    oscillator.stop(now + duration);
  }
}
