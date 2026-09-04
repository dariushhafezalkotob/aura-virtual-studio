export type WorkflowStage = 'projects' | 'workflow' | 'stage1_scene' | 'stage2_acting' | 'stage3_camera';

export type AI3DEngine = 'trellis' | 'hunyuan3d' | 'hunyuan_world';

export type AssetCategory = 'environment' | 'prop';

export interface Project {
  id: string;
  name: string;
  thumbnail: string;
  modified: string;
  description?: string;
  scenes?: SceneAsset[];
  characters?: CharacterActor[];
  panoramaUrl?: string;
  panoramaRotation?: number;
  panoramaBlur?: number;
  splatUrl?: string;
}

export interface SceneAsset {
  id: string;
  name: string;
  glbUrl: string;
  splatUrl?: string;
  previewUrl?: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  prompt?: string;
  engine?: AI3DEngine;
  category?: AssetCategory;
  createdAt: string;
}

export interface CharacterActor {
  id: string;
  name: string;
  modelUrl?: string;
  characterType?: 'soma' | 'g1' | 'mannequin' | 'custom';
  avatar?: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale?: [number, number, number];
  currentAnimation?: string;
  motionPrompt?: string;
  duration?: number;
  trajectory?: [number, number, number][];
  color?: string;
  visible?: boolean;
}

export interface TrellisGenerateParams {
  engine?: AI3DEngine;
  category?: AssetCategory;
  imageFile?: File | Blob;
  imageUrl?: string;
  prompt?: string;
  seed?: number;
  steps?: number;
  ssGuidance?: number;
  ssSteps?: number;
  slatGuidance?: number;
  slatSteps?: number;
  simplify?: number;
  textureSize?: number;
}
