/**
 * @voxel-vault/blockworld — Minecraft-style block worlds on three.js.
 *
 *   const blocks = new BlockRegistry([{ name: 'grass', textures: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' } }, ...]);
 *   const world = new BlockWorld(64, 32, 64, [-32, 0, -48]);
 *   world.set(x, y, z, blocks.id('grass'));
 *   computeLight(world, blocks);
 *   const { texture, uv } = blockAtlas();
 *   const meshes = worldMeshes(meshWorld(world, blocks, { uv }), texture);
 *   new BlockView(element, { id: 'meadow', build: () => ({ root, living, sky, fog, camera }) });
 */
export {
  BlockRegistry,
  BLOCK_SIDES,
  type Block,
  type BlockBox,
  type BlockDefinition,
  type BlockModel,
  type BlockPart,
  type BlockSide,
  type BlockTextures,
  type PartFace,
} from './blocks.ts';
export { BlockWorld } from './world.ts';
export { computeLight } from './light.ts';
export {
  meshWorld,
  brightness,
  FACES,
  type MeshArrays,
  type MeshOptions,
  type WorldMesh,
} from './mesher.ts';
export { blockAtlas, TILE, type TileName } from './atlas.ts';
export {
  BlockView,
  guestKey,
  preloadStage,
  worldMeshes,
  geometry,
  type BlockRenderMetrics,
  type GraphicsMode,
  type Guest,
  type GuestLight,
  type GuestWorld,
  type Living,
  type Stage,
  type StageBuilder,
  type StageContext,
} from './view.ts';
export { raw } from './color.ts';
export {
  WorldPhysics,
  physicsReady,
  type Body,
  type BodyBox,
  type BodyPose,
  type BodySpec,
  type PhysicsGround,
  type Vec,
} from './physics.ts';
export { packAtlas, type TilePixels } from './atlas.ts';
export {
  readWorldPack,
  packFilesAt,
  packHash,
  pathProblem,
  PackError,
  PACK_FORMAT,
  PACK_LIMITS,
  GLTF_EXTENSIONS,
  type PackFiles,
  type PackLimits,
  type PackProblem,
  type WorldPack,
  type PackCredits,
  type PackObject,
  type PackMarker,
  type PackCamera,
  type PackEnvironment,
  type PackLighting,
} from './pack/read.ts';
export { loadPackAssets, packDiagnostics, type PackAssets } from './pack/assets.ts';
export { packStage } from './pack/stage.ts';
export { computeRigLight, type RigLight, type RigSource } from './light.ts';
export {
  LIGHTING_PRESETS,
  LOCAL_BUDGET,
  LOCAL_TYPES,
  SOURCE_KINDS,
  SOURCE_TYPES,
  LightingError,
  readLightingPreset,
  resolveLighting,
  flickerBeat,
  merge as mergeLighting,
  type LightingPreset,
  type LightSource,
  type LocalType,
  type SourceKind,
  type Place,
  type SourceStyle,
  type LightingScene,
  type StageLighting,
  type Emitter,
} from './lighting.ts';
export { presetOf } from './pack/stage.ts';
