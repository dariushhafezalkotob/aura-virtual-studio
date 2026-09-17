export type WorkflowStage = 'projects' | 'workflow' | 'stage1_scene' | 'stage2_acting' | 'stage3_camera';

export type AI3DEngine = 'trellis' | 'hunyuan3d' | 'hunyuan_world';

export type AssetCategory = 'environment' | 'prop';

export interface CameraKeyframe {
  time: number; // in seconds relative to timeline start
  position: [number, number, number];
  quaternion: [number, number, number, number];
  fov?: number;
}

export interface CameraTake {
  id: string;
  name: string; // e.g., "Take 1"
  createdAt: string;
  duration: number; // in seconds
  keyframes: CameraKeyframe[];
  focalLength?: string;
  fps?: number;
  thumbnail?: string; // Captured first frame / poster frame data URL
  /** Handheld shake smoothing, 0-100, applied on playback/export. `keyframes` stay as recorded. */
  stabilizer?: number;
}

export interface StagePointLight {
  id: string;
  name: string;
  color: string;
  intensity: number;
  distance: number; // falloff radius in meters (default ~15)
  decay: number; // physical attenuation falloff exponent (default 2.0)
  position: [number, number, number];
  enabled?: boolean;
}

export interface DepthOfFieldConfig {
  enabled: boolean;
  aperture: number; // f-number (e.g. 1.4, 2.8, 5.6)
  focusDistance: number; // focus plane in meters (e.g. 3.5m)
  focalLengthMm: number; // lens focal length in mm (e.g. 35, 50, 85)
  autoFocus?: boolean; // dynamic center raycast autofocus
  focusPeaking?: boolean; // high-contrast edge assist for in-focus subjects
  bokehScale?: number; // max bokeh blur radius multiplier
}

export type LightingEnvironmentPreset = 'studio' | 'city' | 'sunset' | 'dawn' | 'park';

export interface Project {
  id: string;
  name: string;
  thumbnail: string;
  modified: string;
  description?: string;
  scenes?: SceneAsset[];
  characters?: CharacterActor[];
  cameraTakes?: CameraTake[];
  pointLights?: StagePointLight[];
  panoramaUrl?: string;
  panoramaRotation?: number;
  panoramaBlur?: number;
  showPanorama?: boolean;
  splatUrl?: string;
  stageSpecularity?: number;
  lightIntensity?: number;
  environmentPreset?: LightingEnvironmentPreset;
  dialogue?: DialogueScene;
}

/** A line of dialogue placed on the scene timeline. `text` keeps its inline [emotion] tags. */
export interface DialogueLine {
  id: string;
  speaker: string;
  text: string;
  start: number; // seconds on the scene timeline
  end: number;
  /** Per-line voice clip, when generated line by line. */
  audioUrl?: string;
}

export interface DialogueCastMember {
  speaker: string; // name as written in the script, e.g. "DAVID"
  actorId?: string;
  voice: string; // Gemini prebuilt voice name
}

/**
 * Dialogue previs: a script whose lines drive a voice track, per-actor talk/listen motion and
 * timing. Whatever the audio source, it ends as one scene track plus per-line start/end times.
 */
export interface DialogueScene {
  script: string;
  audioMode: 'per_line' | 'whole_scene' | 'import';
  cast: DialogueCastMember[];
  lines: DialogueLine[];
  /** Pause inserted between lines when assembling per-line clips. */
  gapSec: number;
  audioUrl?: string;
  duration?: number;
  ttsModel?: string;
}

export interface SavedStageTemplate {
  id: string;
  name: string;
  createdAt: string;
  scenes: SceneAsset[];
  pointLights?: StagePointLight[];
  panoramaUrl?: string;
  panoramaRotation?: number;
  splatUrl?: string;
  environmentPreset?: string;
  lightIntensity?: number;
  stageSpecularity?: number;
  thumbnail?: string;
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
  specularity?: number;
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

export type RigMode = 'fk' | 'ik' | 'off';
export type IkEffectorType = 'hips' | 'leftHand' | 'rightHand' | 'leftFoot' | 'rightFoot' | 'lookAt';

export interface IkTargets {
  /**
   * Pelvis / centre-of-gravity goal. Moving it translates the whole skeleton
   * while the hand and foot goals stay where they are, which is what produces
   * crouches, weight shifts and hip drops.
   */
  hips?: [number, number, number];
  leftHand?: [number, number, number];
  rightHand?: [number, number, number];
  leftFoot?: [number, number, number];
  rightFoot?: [number, number, number];
  lookAt?: [number, number, number];
}

/**
 * Which Kimodo constraint a pose key emits. 'fullbody' pins every joint;
 * the end-effector kinds pin only that limb (plus hips) and leave the rest of
 * the body free for the model to solve.
 */
export type KeyframeConstraintKind =
  | 'fullbody'
  | 'left-hand'
  | 'right-hand'
  | 'left-foot'
  | 'right-foot';

/** How close the playhead must be for a live pose edit to count as "here". */
export const POSE_EDIT_TIME_TOLERANCE = 0.15;

export const KEYFRAME_CONSTRAINT_KINDS: {
  id: KeyframeConstraintKind;
  label: string;
  icon: string;
}[] = [
  { id: 'fullbody', label: 'Full Body', icon: 'accessibility_new' },
  { id: 'left-hand', label: 'L Hand', icon: 'pan_tool' },
  { id: 'right-hand', label: 'R Hand', icon: 'pan_tool' },
  { id: 'left-foot', label: 'L Foot', icon: 'snowshoeing' },
  { id: 'right-foot', label: 'R Foot', icon: 'snowshoeing' },
];

export interface ActorKeyframePose {
  id: string;
  time: number; // timestamp in seconds on timeline
  boneRotations?: Record<number, [number, number, number, number]>; // boneIndex -> quaternion [x, y, z, w]
  ikTargets?: IkTargets;
  rootPosition?: [number, number, number];
  /**
   * Hip position in Kimodo's canonical motion space at this key: XZ relative to
   * the take's first frame (Kimodo canonicalises the root to (0,0) at frame 0),
   * Y as the real hip height.
   *
   * Distinct from `rootPosition`, which is the actor's static placement in the
   * scene and does NOT move during a generated take -- the take's translation
   * lives in motionData.root. Sending the static position as a constraint tells
   * Kimodo the character is back at the origin on that frame, which cancels the
   * locomotion it just generated.
   */
  rootMotion?: [number, number, number];
  poseName?: string;
  /**
   * Kimodo constraint types this key emits. Defaults to ['fullbody'] when
   * absent, which is how every key authored before this existed behaves.
   */
  constraintKinds?: KeyframeConstraintKind[];
}

/** One span of a multi-text prompt sequence. */
export interface MotionSegment {
  id: string;
  prompt: string;
  duration: number;
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
  keyframePoses?: ActorKeyframePose[];
  activeRigMode?: RigMode;
  selectedJointIndex?: number | null;
  selectedIkEffector?: IkEffectorType | null;
  ikTargets?: IkTargets;
  customBoneRotations?: Record<number, [number, number, number, number]>;
  /**
   * Timeline position the live pose edit in `customBoneRotations` belongs to.
   *
   * Without this the edit is applied at every time, so it masks the keyframe
   * blend and every key renders as whichever pose was authored last. When
   * keyframes exist the override only applies near this time.
   */
  customPoseTime?: number;
  /**
   * Multi-text sequence. Kimodo generates these as ONE continuous motion with
   * a per-segment frame budget, blending across the boundaries, rather than
   * separate takes. Empty or absent means a single prompt.
   */
  motionSegments?: MotionSegment[];
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

export interface DeviceOrientationData {
  alpha: number; // yaw [0, 360)
  beta: number;  // pitch [-180, 180)
  gamma: number; // roll [-90, 90)
  screenOrientation?: number; // 90, -90, 0
  quaternion?: [number, number, number, number];
}

export interface RemoteMoveData {
  moveX: number; // -1 to 1 (Truck Left / Right)
  moveZ: number; // -1 to 1 (Dolly Forward / Back)
  moveY: number; // -1 to 1 (Pedestal Down / Up)
}

export interface CameraRemoteState {
  isRecording: boolean;
  isPlaying: boolean;
  timelineSec: number;
  effectiveDuration: number;
  focalLength: string;
  activeTakeName?: string;
  /** Host playback rate, so the phone's local clock runs at the same speed between syncs. */
  playbackSpeed?: number;
}

export interface CameraPoseData {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  fov?: number;
}

export type CameraRemoteMessage =
  | { type: 'peer_joined'; role: string; peerCount: number; timestamp: number }
  | { type: 'peer_left'; role: string; peerCount: number; timestamp: number }
  | { type: 'init_scene'; project: Project }
  | { type: 'camera_pose'; pose: CameraPoseData; timestamp: number }
  | { type: 'gyro'; orientation: DeviceOrientationData; timestamp: number }
  | { type: 'move'; move: RemoteMoveData; timestamp: number }
  | { type: 'look'; deltaPitch: number; deltaYaw: number; timestamp: number }
  | { type: 'toggle_record' }
  | { type: 'set_focal_length'; focalLength: string }
  | { type: 'calibrate' }
  | { type: 'rewind' }
  | { type: 'toggle_play' }
  | { type: 'host_state'; state: CameraRemoteState };

