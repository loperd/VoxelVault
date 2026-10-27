import {
  DirectionalLight,
  Mesh,
  Texture,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';

export function disposeObject(root: Object3D): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  const images = new Set<{ close(): void }>();
  root.traverse((object) => {
    if (object instanceof DirectionalLight) object.shadow.dispose();
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value);
      }
    }
  });
  for (const texture of textures) {
    const image: unknown = texture.source.data;
    if (
      image &&
      typeof image === 'object' &&
      'close' in image &&
      typeof image.close === 'function'
    ) {
      images.add(image as { close(): void });
    }
    texture.dispose();
  }
  for (const image of images) image.close();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}
