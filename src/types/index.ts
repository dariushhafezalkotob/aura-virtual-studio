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

export interface MotionData {
  fps: number;
  duration: number;
  num_frames: number;
  root: [number, number, number][];
  rotations: [number, number, number, number][][]; // [frame][77_bones][qx, qy, qz, qw]
  trajectory: [number, number, number][];
  bvh?: string;
  prompt?: string;
}

export type ConstraintType =
  | 'look_at'
  | 'upper_body_lock'
  | 'destination'
  | 'facing_direction'
  | 'foot_grounding'
  | 'stance_height';

export type LookAtTargetType = 'camera' | 'actor' | 'point';
export type UpperBodyPosePreset = 'crossed_arms' | 'hands_on_hips' | 'holding_prop' | 'hands_in_pockets' | 'defensive';
export type FacingTargetType = 'camera' | 'actor' | 'angle';
export type FootGroundingMode = 'both' | 'left' | 'right';

export interface ActorConstraint {
  id: string;
  name: string;
  type: ConstraintType;
  enabled: boolean;
  startTime: number;
  endTime: number;
  weight: number; // 0.0 to 1.0
  lookAt?: {
    targetType: LookAtTargetType;
    targetActorId?: string;
    targetPoint?: [number, number, number];
  };
  upperBody?: {
    preset: UpperBodyPosePreset;
    blendFactor?: number;
  };
  destination?: {
    position: [number, number, number];
    arrivalRadius?: number;
    prompt?: string;
  };
  facing?: {
    targetType: FacingTargetType;
    targetActorId?: string;
    angleDegrees?: number;
  };
  footGrounding?: {
    mode: FootGroundingMode;
    plantThreshold?: number;
  };
  stance?: {
    heightOffset: number; // e.g. -0.3 for crouch, +0.1 for tall
  };
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
  motionData?: MotionData;
  bvhUrl?: string;
  color?: string;
  renderMode?: 'mesh' | 'skeleton' | 'hybrid';
  visible?: boolean;
  constraints?: ActorConstraint[];
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
