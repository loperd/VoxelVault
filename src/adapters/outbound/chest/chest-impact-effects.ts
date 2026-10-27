import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Points,
  PointsMaterial,
  type Scene,
} from 'three';

/**
 * Model-independent impact: sparks rising under the falling chest and dust thrown out on landing.
 * No glow or ring on the ground: the chest stands in a world, and its real shadow does that job.
 */
export class ChestImpactEffects {
  private readonly root = new Group();
  private readonly geometry = new BufferGeometry();
  private readonly positions = new Float32Array(40 * 3);
  private readonly material: PointsMaterial;
  private readonly points: Points;
  private age = Infinity;
  private reduced = false;

  constructor(scene: Scene, color = 0x86ead0) {
    this.geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    this.material = new PointsMaterial({
      color,
      size: 0.045,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.root.add(this.points);
    this.root.visible = false;
    scene.add(this.root);
  }

  approach(x: number, y: number, z: number, reduced: boolean): void {
    if (reduced) return;
    this.root.position.set(x, 0.035, z);
    this.root.visible = true;
    this.points.visible = true;
    this.material.opacity = 0.28;
    for (let i = 0; i < 40; i++) {
      const angle = i * 2.399963,
        length = (i % 10) / 10;
      this.positions[i * 3] = Math.cos(angle) * (0.5 + length * 0.3);
      this.positions[i * 3 + 1] = y + 0.7 + length * 1.2;
      this.positions[i * 3 + 2] = Math.sin(angle) * (0.5 + length * 0.3);
    }
    this.geometry.getAttribute('position').array.set(this.positions);
    this.geometry.getAttribute('position').needsUpdate = true;
  }

  trigger(x: number, z: number, reduced: boolean): void {
    this.age = 0;
    this.reduced = reduced;
    this.root.position.set(x, 0.035, z);
    this.root.visible = true;
    this.points.visible = !reduced;
    this.update(0);
  }

  update(delta: number): void {
    if (!Number.isFinite(this.age)) return;
    this.age += delta;
    if (this.age >= 0.85 || this.reduced) {
      this.reset();
      return;
    }
    const p = this.age / 0.85;
    this.material.opacity = (1 - p) ** 2 * 0.7;
    for (let i = 0; i < 40; i++) {
      const angle = i * 2.399963,
        speed = 0.7 + (i % 7) * 0.19;
      const radius = 0.4 + this.age * speed;
      this.positions[i * 3] = Math.cos(angle) * radius;
      this.positions[i * 3 + 1] = Math.max(
        0.01,
        this.age * (0.6 + (i % 5) * 0.12) - this.age ** 2 * 1.5,
      );
      this.positions[i * 3 + 2] = Math.sin(angle) * radius;
    }
    this.geometry.getAttribute('position').array.set(this.positions);
    this.geometry.getAttribute('position').needsUpdate = true;
  }

  reset(): void {
    this.age = Infinity;
    this.root.visible = false;
  }
  dispose(): void {
    this.reset();
    this.root.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
