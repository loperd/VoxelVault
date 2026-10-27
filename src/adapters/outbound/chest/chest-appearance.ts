import { Color, Mesh, MeshStandardMaterial, type Material, type Object3D } from 'three';
import { copyChestAppearance, type ChestAppearance } from '../../../domain/chest-appearance.ts';
import type { ChestModificationProfile, ColorZone } from '../../../domain/chest-modifications.ts';

/** Meshes at or below the named nodes; overlay meshes added by effects are excluded. */
export function meshesOf(root: Object3D, nodes: readonly string[]): Mesh[] {
  const result = new Set<Mesh>();
  for (const name of nodes) {
    root.getObjectByName(name)?.traverse((object) => {
      if (object instanceof Mesh && !object.userData.chestOverlay) result.add(object);
    });
  }
  return [...result];
}

const white = new Color(0xffffff);
function zoneColor(zone: ColorZone, hex: string): Color {
  const color = new Color(hex);
  if (zone.mode === 'replace') return color;
  // Palette colours are dark base tones; tinting a coloured texture needs a light version of the hue.
  const hsl = color.getHSL({ h: 0, s: 0, l: 0 });
  return white.clone().lerp(color.setHSL(hsl.h, hsl.s, Math.max(hsl.l, 0.72)), zone.strength);
}

/**
 * Applies instance colours to the zones the model profile declares. Node-targeted zones get their
 * own material copy, because one glTF material is often shared by every part.
 */
export function applyChestPalette(
  root: Object3D,
  appearance: ChestAppearance,
  profile: ChestModificationProfile,
): void {
  const { palette } = copyChestAppearance(appearance);
  const own = new WeakSet<Material>();
  for (const zone of profile.colorZones) {
    const color = zoneColor(zone, palette[zone.role]);
    const paint = (material: Material) => {
      if (!(material instanceof MeshStandardMaterial)) return;
      material.color.copy(color);
      if (zone.role === 'accent') material.emissive.set(palette.accent);
    };
    if (zone.materials.length) {
      root.traverse((object) => {
        if (!(object instanceof Mesh) || object.userData.chestOverlay) return;
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material]) {
          if (zone.materials.includes(material.name)) paint(material);
        }
      });
    }
    for (const mesh of meshesOf(root, zone.nodes)) {
      const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(
        (material) => {
          if (own.has(material)) return material;
          const copy = material.clone();
          own.add(copy);
          return copy;
        },
      );
      mesh.material = Array.isArray(mesh.material) ? materials : materials[0]!;
      materials.forEach(paint);
    }
  }
}

/** Preserve the instance accent hue while keeping emitted light bright enough. */
export function chestEffectColor(appearance: ChestAppearance): number {
  const color = new Color(copyChestAppearance(appearance).palette.accent);
  const hsl = color.getHSL({ h: 0, s: 0, l: 0 });
  return color.setHSL(hsl.h, hsl.s, Math.max(hsl.l, 0.62)).getHex();
}
