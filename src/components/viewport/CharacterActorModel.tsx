import React, { useRef, useMemo, useEffect, useState, Component, ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { TransformControls, Html } from '@react-three/drei';
import * as THREE from 'three';
import {
  CharacterActor,
  ActorConstraint,
  UpperBodyPosePreset,
  IkEffectorType,
} from '../../types';
import {
  TransformMode,
  markTransformDragStart,
  markTransformDragEnd,
  isSelectionSuppressed,
} from './ThreeStage';
import { solveTwoBoneIK, solveLookAtIK } from '../../services/ikSolver';
import {
  SOMA,
  IK_CHAINS,
  IkChainId,
  SOMARigCache,
  loadOfficialSOMARig,
} from '../../services/somaSkeleton';

interface CharacterActorModelProps {
  actor: CharacterActor;
  allActors?: CharacterActor[];
  isSelected: boolean;
  transformMode: TransformMode;
  currentTimelineTime: number;
  isPlaying?: boolean;
  showTrajectory?: boolean;
  onSelect: () => void;
  onDraggingChange: (isDragging: boolean) => void;
  onTransformChange?: (
    id: string,
    position: [number, number, number],
    rotation: [number, number, number],
    scale: [number, number, number]
  ) => void;
  onUpdateActor?: (updatedActor: CharacterActor) => void;
  onSelectJoint?: (jointIndex: number | null) => void;
  onSelectIkEffector?: (effector: IkEffectorType | null) => void;
}

// Scratch objects reused by the per-frame rig pass to avoid per-frame garbage.
const _tmpQuat = new THREE.Quaternion();
const _tmpVec = new THREE.Vector3();

// 3D Motion Trajectory Floor Spline
const TrajectoryPath: React.FC<{
  trajectory: [number, number, number][];
  color: string;
  groundY?: number;
}> = ({ trajectory, color, groundY = 0 }) => {
  const linePoints = useMemo(() => {
    if (trajectory.length < 2) return [];
    const pts = trajectory.map((p) => new THREE.Vector3(p[0], groundY + 0.02, p[2]));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.2);
    return curve.getPoints(Math.max(30, trajectory.length * 8));
  }, [trajectory, groundY]);

  const lineGeometry = useMemo(() => {
    if (linePoints.length < 2) return null;
    return new THREE.BufferGeometry().setFromPoints(linePoints);
  }, [linePoints]);

  if (!lineGeometry || linePoints.length < 2) return null;

  const startPt = linePoints[0];
  const endPt = linePoints[linePoints.length - 1];

  return (
    <group>
      <primitive
        object={
          new THREE.Line(
            lineGeometry,
            new THREE.LineBasicMaterial({ color: color || '#00ffcc', linewidth: 3 })
          )
        }
      />
      <mesh position={[startPt.x, groundY + 0.03, startPt.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.2, 0.26, 24]} />
        <meshBasicMaterial color={color || '#00ffcc'} side={THREE.DoubleSide} />
      </mesh>
      <group position={[endPt.x, groundY + 0.03, endPt.z]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.22, 24]} />
          <meshBasicMaterial color="#ff3b30" side={THREE.DoubleSide} />
        </mesh>
      </group>
    </group>
  );
};

export const ProxyMannequin: React.FC<{ color: string }> = ({ color }) => {
  return (
    <group position={[0, 0, 0]}>
      <mesh position={[0, 1.62, 0]} castShadow>
        <sphereGeometry args={[0.13, 16, 16]} />
        <meshStandardMaterial color={color} roughness={0.85} metalness={0.05} />
      </mesh>
      <mesh position={[0, 1.46, 0]} castShadow>
        <cylinderGeometry args={[0.045, 0.05, 0.1, 12]} />
        <meshStandardMaterial color={color} roughness={0.85} metalness={0.05} />
      </mesh>
      <mesh position={[0, 1.22, 0]} castShadow>
        <cylinderGeometry args={[0.16, 0.12, 0.42, 16]} />
        <meshStandardMaterial color={color} roughness={0.85} metalness={0.05} />
      </mesh>
      <mesh position={[0, 0.95, 0]} castShadow>
        <cylinderGeometry args={[0.13, 0.14, 0.18, 16]} />
        <meshStandardMaterial color={color} roughness={0.85} metalness={0.05} />
      </mesh>
      <mesh position={[-0.1, 0.5, 0]} castShadow>
        <cylinderGeometry args={[0.06, 0.045, 0.85, 12]} />
        <meshStandardMaterial color={color} roughness={0.85} metalness={0.05} />
      </mesh>
      <mesh position={[0.1, 0.5, 0]} castShadow>
        <cylinderGeometry args={[0.06, 0.045, 0.85, 12]} />
        <meshStandardMaterial color={color} roughness={0.85} metalness={0.05} />
      </mesh>
      <mesh position={[-0.24, 1.15, 0]} rotation={[0, 0, -0.15]} castShadow>
        <cylinderGeometry args={[0.045, 0.035, 0.65, 12]} />
        <meshStandardMaterial color={color} roughness={0.85} metalness={0.05} />
      </mesh>
      <mesh position={[0.24, 1.15, 0]} rotation={[0, 0, 0.15]} castShadow>
        <cylinderGeometry args={[0.045, 0.035, 0.65, 12]} />
        <meshStandardMaterial color={color} roughness={0.85} metalness={0.05} />
      </mesh>
    </group>
  );
};

export class ActorErrorBoundary extends Component<
  { actor: CharacterActor; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: any) {
    console.warn('ActorErrorBoundary caught error for:', this.props.actor.name, error);
  }
  render() {
    if (this.state.hasError) {
      const { position, rotation, scale, color } = this.props.actor;
      return (
        <group position={position} rotation={rotation} scale={scale}>
          <ProxyMannequin color={color || '#00ffcc'} />
        </group>
      );
    }
    return this.props.children;
  }
}

const UPPER_BODY_POSE_PRESETS: Record<
  UpperBodyPosePreset,
  { index: number; euler: [number, number, number] }[]
> = {
  crossed_arms: [
    { index: 11, euler: [0.1, 0.2, -0.2] },
    { index: 12, euler: [0.6, 0.4, -0.6] },
    { index: 13, euler: [0.2, 1.4, -0.4] },
    { index: 14, euler: [0.0, 0.3, 0.0] },
    { index: 39, euler: [0.1, -0.2, 0.2] },
    { index: 40, euler: [0.7, -0.4, 0.6] },
    { index: 41, euler: [-0.2, -1.4, 0.4] },
    { index: 42, euler: [0.0, -0.3, 0.0] },
    { index: 3, euler: [0.05, 0.0, 0.0] },
  ],
  hands_on_hips: [
    { index: 11, euler: [0.0, -0.1, -0.2] },
    { index: 12, euler: [-0.3, -0.2, -0.8] },
    { index: 13, euler: [0.1, 1.3, -0.5] },
    { index: 14, euler: [0.2, 0.4, -0.2] },
    { index: 39, euler: [0.0, 0.1, 0.2] },
    { index: 40, euler: [-0.3, 0.2, 0.8] },
    { index: 41, euler: [-0.1, -1.3, 0.5] },
    { index: 42, euler: [-0.2, -0.4, 0.2] },
    { index: 3, euler: [0.03, 0.0, 0.0] },
  ],
  holding_prop: [
    { index: 11, euler: [0.1, 0.1, -0.1] },
    { index: 12, euler: [0.8, 0.2, -0.3] },
    { index: 13, euler: [0.0, 1.0, 0.0] },
    { index: 14, euler: [0.2, 0.0, 0.0] },
    { index: 39, euler: [0.1, -0.1, 0.1] },
    { index: 40, euler: [0.8, -0.2, 0.3] },
    { index: 41, euler: [0.0, -1.0, 0.0] },
    { index: 42, euler: [-0.2, 0.0, 0.0] },
    { index: 3, euler: [0.04, 0.0, 0.0] },
  ],
  hands_in_pockets: [
    { index: 12, euler: [-0.1, 0.0, -0.2] },
    { index: 13, euler: [0.2, 0.4, -0.2] },
    { index: 14, euler: [0.2, 0.3, 0.0] },
    { index: 40, euler: [-0.1, 0.0, 0.2] },
    { index: 41, euler: [-0.2, -0.4, 0.2] },
    { index: 42, euler: [-0.2, -0.3, 0.0] },
    { index: 3, euler: [0.02, 0.0, 0.0] },
  ],
  defensive: [
    { index: 11, euler: [0.2, 0.2, -0.1] },
    { index: 12, euler: [1.1, 0.3, -0.5] },
    { index: 13, euler: [0.3, 1.8, -0.2] },
    { index: 14, euler: [0.4, 0.0, 0.0] },
    { index: 39, euler: [0.2, -0.2, 0.1] },
    { index: 40, euler: [1.1, -0.3, 0.5] },
    { index: 41, euler: [-0.3, -1.8, 0.2] },
    { index: 42, euler: [-0.4, 0.0, 0.0] },
    { index: 3, euler: [0.06, 0.0, 0.0] },
  ],
};

function getConstraintWeight(c: ActorConstraint, t: number): number {
  if (!c.enabled || t < c.startTime || t > c.endTime) return 0;
  const fadeInDur = 0.25;
  const fadeOutDur = 0.25;
  const tSinceStart = t - c.startTime;
  const tUntilEnd = c.endTime - t;
  let envelope = 1.0;
  if (tSinceStart < fadeInDur) {
    envelope = 0.5 * (1 - Math.cos((tSinceStart / fadeInDur) * Math.PI));
  } else if (tUntilEnd < fadeOutDur) {
    envelope = 0.5 * (1 - Math.cos((tUntilEnd / fadeOutDur) * Math.PI));
  }
  return (c.weight ?? 1.0) * envelope;
}

export const CharacterActorModel: React.FC<CharacterActorModelProps> = ({
  actor,
  allActors: _allActors = [],
  isSelected,
  transformMode,
  currentTimelineTime,
  isPlaying: _isPlaying = false,
  showTrajectory = true,
  onSelect,
  onDraggingChange,
  onTransformChange,
  onUpdateActor,
  onSelectJoint: _onSelectJoint,
  onSelectIkEffector,
}) => {
  const rootGroupRef = useRef<THREE.Group>(null);
  const bodyGroupRef = useRef<THREE.Group>(null);
  const skinnedMeshRef = useRef<THREE.SkinnedMesh | null>(null);

  // SOMA 77 Bones array and rest orientations
  const bonesRef = useRef<THREE.Bone[]>([]);
  const restQuatsRef = useRef<THREE.Quaternion[]>([]);
  const rigDataRef = useRef<SOMARigCache | null>(null);
  const [isRigReady, setIsRigReady] = useState<boolean>(false);

  // Bumped whenever an IK handle mounts, so the gizmo below can pick up a ref
  // that was assigned during the same commit.
  const [handleEpoch, setHandleEpoch] = useState<number>(0);

  // While an FK gizmo is being dragged the animation pass must not stomp the
  // bone the user is holding — it writes every bone every frame.
  const fkDragRef = useRef<{ index: number; quat: THREE.Quaternion } | null>(null);

  // Same problem for IK: the handle's `position` prop is re-applied on every
  // React commit (e.g. the timeline ticking), which yanked the handle back to
  // its stored value mid-drag.
  const ikDragRef = useRef<{ eff: IkEffectorType; pos: THREE.Vector3 } | null>(null);

  const {
    position,
    rotation,
    scale = [1, 1, 1],
    trajectory = [],
    duration = 4.0,
    color = '#00ffcc',
    renderMode = 'mesh',
    activeRigMode = 'off',
    selectedJointIndex = 6,
    selectedIkEffector = 'rightHand',
  } = actor;

  // IK Targets state in local coordinate space
  const ikTargetHandlesRef = useRef<{
    hips: THREE.Group | null;
    leftHand: THREE.Group | null;
    rightHand: THREE.Group | null;
    leftFoot: THREE.Group | null;
    rightFoot: THREE.Group | null;
    lookAt: THREE.Group | null;
  }>({
    hips: null,
    leftHand: null,
    rightHand: null,
    leftFoot: null,
    rightFoot: null,
    lookAt: null,
  });

  // These must keep a stable identity across renders: React detaches and
  // reattaches a ref whose callback identity changed, and a setState inside a
  // freshly-created callback turns that into an infinite render loop.
  const ikHandleRefSetters = useMemo(() => {
    const make = (eff: IkEffectorType) => (el: THREE.Group | null) => {
      const prev = ikTargetHandlesRef.current[eff];
      ikTargetHandlesRef.current[eff] = el;
      if (!!prev !== !!el) setHandleEpoch((v) => v + 1);
    };
    return {
      hips: make('hips'),
      leftHand: make('leftHand'),
      rightHand: make('rightHand'),
      leftFoot: make('leftFoot'),
      rightFoot: make('rightFoot'),
      lookAt: make('lookAt'),
    };
  }, []);

  /**
   * Default resting place for each IK handle, taken from the actual rest pose
   * of the bone it drives. Hardcoded guesses put the "right hand" handle on the
   * character's left side (this rig's +X is the character's LEFT) and both foot
   * handles near the origin, so the handles never lined up with the limbs.
   */
  const ikHandleDefaults = useMemo(() => {
    const rig = rigDataRef.current;
    const p = (i: number, fallback: [number, number, number]): [number, number, number] => {
      const v = rig?.restWorldPositions[i];
      return v ? [v.x, v.y, v.z] : fallback;
    };
    const head = p(SOMA.head, [0, 1.595, -0.016]);
    return {
      hips: p(SOMA.hips, [0, 0.999, -0.051]),
      leftHand: p(SOMA.leftHand, [0.53, 1.02, 0.063]),
      rightHand: p(SOMA.rightHand, [-0.53, 1.02, 0.063]),
      leftFoot: p(SOMA.leftFoot, [0.157, 0.073, -0.1]),
      rightFoot: p(SOMA.rightFoot, [-0.158, 0.073, -0.101]),
      // Straight ahead of the eyes, so look-at is a no-op until it is dragged.
      lookAt: [head[0], head[1], head[2] + 2.0] as [number, number, number],
    };
  }, [isRigReady]);

  // Build SOMA 77-Bone Skeleton & SkinnedMesh on mount
  useEffect(() => {
    let isMounted = true;

    loadOfficialSOMARig()
      .then((rigData) => {
        if (!isMounted) return;

        // 1. Create 77 SOMA Bones
        const bones: THREE.Bone[] = [];
        const restQuats: THREE.Quaternion[] = [];

        for (let i = 0; i < rigData.jointNames.length; i++) {
          const b = new THREE.Bone();
          b.name = rigData.jointNames[i];
          const tr = rigData.localTransforms[i];
          b.position.copy(tr.pos);
          b.quaternion.copy(tr.quat);
          b.scale.copy(tr.scl);
          bones.push(b);
          restQuats.push(tr.quat.clone());
        }

        // Build bone hierarchy tree
        for (const [p, c] of rigData.jointConnections) {
          bones[p].add(bones[c]);
        }

        const rootBone = bones[0];
        rootBone.updateMatrixWorld(true);

        bonesRef.current = bones;
        restQuatsRef.current = restQuats;
        rigDataRef.current = rigData;

        // 2. Instantiate SkinnedMesh with Official SOMA Geometry
        const geom = rigData.geometry.clone();
        const skeleton = new THREE.Skeleton(bones);

        const material = new THREE.MeshStandardMaterial({
          color: actor.color || (actor.characterType === 'g1' ? '#e5e5ea' : '#32363d'),
          roughness: 0.85,
          metalness: 0.05,
          side: THREE.DoubleSide,
        });

        const sm = new THREE.SkinnedMesh(geom, material);
        sm.castShadow = true;
        sm.receiveShadow = true;
        sm.add(rootBone);
        sm.bind(skeleton);

        skinnedMeshRef.current = sm;
        setIsRigReady(true);
      })
      .catch((err) => {
        console.warn('Official SOMA Rig load error:', err);
      });

    return () => {
      isMounted = false;
    };
  }, [actor.characterType]);

  // Update material on renderMode / characterType / color change
  useEffect(() => {
    if (skinnedMeshRef.current) {
      const isHybrid = renderMode === 'hybrid' || activeRigMode !== 'off';
      const isMesh = renderMode === 'mesh' && activeRigMode === 'off';
      skinnedMeshRef.current.visible = isMesh || isHybrid;

      const mat = skinnedMeshRef.current.material as THREE.MeshStandardMaterial;
      if (mat) {
        mat.transparent = isHybrid;
        mat.opacity = isHybrid ? 0.45 : 1.0;
        mat.color.set(actor.color || (actor.characterType === 'g1' ? '#e5e5ea' : '#32363d'));
        mat.needsUpdate = true;
      }
    }
  }, [renderMode, activeRigMode, actor.characterType, actor.color]);

  // Sync initial root transform
  useEffect(() => {
    if (rootGroupRef.current) {
      rootGroupRef.current.position.set(position[0], position[1], position[2]);
      rootGroupRef.current.rotation.set(rotation[0], rotation[1], rotation[2]);
      rootGroupRef.current.scale.set(scale[0], scale[1], scale[2]);
      rootGroupRef.current.updateMatrixWorld(true);
    }
  }, [position[0], position[1], position[2], rotation[0], rotation[1], rotation[2], scale[0], scale[1], scale[2]]);

  // Real-time Kinematic Animation Engine driving the SOMA 77-Bone Skeleton
  useFrame(() => {
    const bones = bonesRef.current;
    const restQuats = restQuatsRef.current;
    if (bones.length < 77 || restQuats.length < 77) return;

    // =========================================================================
    // 1. BASE POSE: TIMELINE KEYFRAME BLENDING, KIMODO DIFFUSION, OR REST BREATHING
    // =========================================================================
    // Generated motion wins over keyframe poses. It was the other way round,
    // so as soon as an actor had a single pose keyframe the Kimodo animation
    // never played -- the character just sat in the blended keyframe pose and
    // it looked like generation had done nothing. Editing a keyframe clears
    // motionData (see ActorRigPosingPanel), which drops back to authoring.
    if (actor.motionData && actor.motionData.rotations && actor.motionData.rotations.length > 0) {
      // A. Generated Kimodo Motion Playback
      const mData = actor.motionData;
      const tTotal = Math.max(0.1, mData.duration || duration || 4.0);
      const progress = (currentTimelineTime % tTotal) / tTotal;
      const numFrames = mData.num_frames || mData.rotations.length;

      const exactFrame = progress * (numFrames - 1);
      const frame0 = Math.floor(exactFrame);
      const frame1 = Math.min(numFrames - 1, frame0 + 1);
      const alpha = exactFrame - frame0;

      if (mData.root && mData.root.length > 0 && bodyGroupRef.current) {
        const initRoot = mData.root[0] || [0, 0, 0];
        const r0 = mData.root[frame0] || initRoot;
        const r1 = mData.root[frame1] || r0;

        const rx = THREE.MathUtils.lerp(r0[0], r1[0], alpha);
        const ry = THREE.MathUtils.lerp(r0[1], r1[1], alpha);
        const rz = THREE.MathUtils.lerp(r0[2], r1[2], alpha);

        const dx = rx - initRoot[0];
        const dy = ry - initRoot[1];
        const dz = rz - initRoot[2];

        bodyGroupRef.current.position.set(dx, dy, dz);
        bodyGroupRef.current.rotation.set(0, 0, 0);
      }

      const rots0 = mData.rotations[frame0];
      const rots1 = mData.rotations[frame1];
      const q0 = new THREE.Quaternion();
      const q1 = new THREE.Quaternion();

      if (rots0) {
        for (let b = 0; b < Math.min(bones.length, rots0.length); b++) {
          const raw0 = rots0[b];
          const raw1 = rots1 ? rots1[b] : raw0;
          if (raw0 && raw1) {
            q0.set(raw0[0], raw0[1], raw0[2], raw0[3]);
            q1.set(raw1[0], raw1[1], raw1[2], raw1[3]);
            bones[b].quaternion.copy(q0).slerp(q1, alpha);
          }
        }
      }
    } else if (actor.keyframePoses && actor.keyframePoses.length > 0) {
      // B. Timeline Keyframe Pose Blending (authoring preview)
      const kfs = [...actor.keyframePoses].sort((a, b) => a.time - b.time);
      let prevKf = kfs[0];
      let nextKf = kfs[kfs.length - 1];

      for (let i = 0; i < kfs.length; i++) {
        if (kfs[i].time <= currentTimelineTime) {
          prevKf = kfs[i];
        }
        if (kfs[i].time >= currentTimelineTime) {
          nextKf = kfs[i];
          break;
        }
      }

      const span = nextKf.time - prevKf.time;
      const alpha = span > 0.001 ? THREE.MathUtils.clamp((currentTimelineTime - prevKf.time) / span, 0, 1) : 0;
      const easeAlpha = alpha * alpha * (3 - 2 * alpha);

      // Slerp bone rotations
      for (let b = 0; b < bones.length; b++) {
        const q0Raw = prevKf.boneRotations?.[b];
        const q1Raw = nextKf.boneRotations?.[b];

        if (q0Raw || q1Raw) {
          const q0 = q0Raw
            ? new THREE.Quaternion(q0Raw[0], q0Raw[1], q0Raw[2], q0Raw[3])
            : restQuats[b].clone();
          const q1 = q1Raw
            ? new THREE.Quaternion(q1Raw[0], q1Raw[1], q1Raw[2], q1Raw[3])
            : q0.clone();
          bones[b].quaternion.copy(q0).slerp(q1, easeAlpha);
        } else {
          bones[b].quaternion.copy(restQuats[b]);
        }
      }
    } else {
      // C. Default Neutral Rest Pose with Subtle Breathing
      if (bodyGroupRef.current) {
        bodyGroupRef.current.position.set(0, 0, 0);
        bodyGroupRef.current.rotation.set(0, 0, 0);
      }

      for (let i = 0; i < bones.length; i++) {
        bones[i].quaternion.copy(restQuats[i]);
      }

      const breath = Math.sin(currentTimelineTime * 2.0) * 0.015;
      const qDelta = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), breath);
      bones[3].quaternion.multiply(qDelta);

      const headShift = Math.sin(currentTimelineTime * 0.8) * 0.03;
      qDelta.setFromAxisAngle(new THREE.Vector3(0, 1, 0), headShift);
      bones[6].quaternion.multiply(qDelta);
    }

    // =========================================================================
    // 2. ACTIVE USER FK POSE OVERRIDES
    // =========================================================================
    if (actor.customBoneRotations) {
      for (const [idxStr, qRaw] of Object.entries(actor.customBoneRotations)) {
        const bIdx = Number(idxStr);
        if (bones[bIdx] && qRaw) {
          bones[bIdx].quaternion.set(qRaw[0], qRaw[1], qRaw[2], qRaw[3]);
        }
      }
    }

    // The base pose above rewrites every bone each frame. Restore whatever the
    // FK gizmo is currently holding, otherwise the drag is undone before it is
    // ever rendered and the handle appears to do nothing.
    const fkDrag = fkDragRef.current;
    if (fkDrag && bones[fkDrag.index]) {
      bones[fkDrag.index].quaternion.copy(fkDrag.quat);
    }

    const ikDrag = ikDragRef.current;
    if (ikDrag) {
      const handle = ikTargetHandlesRef.current[ikDrag.eff];
      if (handle) handle.position.copy(ikDrag.pos);
    }

    // =========================================================================
    // 2.5 HIP / ROOT TRANSLATION
    // =========================================================================
    // The pelvis is the skeleton root, so writing its position moves the whole
    // body. The hand and foot goals live on the body group rather than inside
    // the skeleton, so they stay put while the hips travel -- that is what
    // turns a hip drop into a crouch instead of sinking the character through
    // the floor.
    const hipsRest = rigDataRef.current?.localTransforms[SOMA.hips]?.pos;
    const hipsBone = bones[SOMA.hips];
    if (hipsRest && hipsBone) {
      const hipsHandle = ikTargetHandlesRef.current.hips;
      const storedHips = actor.ikTargets?.hips;

      if (activeRigMode === 'ik' && hipsHandle && hipsHandle.parent) {
        // Handle position is already in body-group space, same as the bone's.
        hipsBone.position.copy(hipsHandle.position);
      } else if (storedHips) {
        hipsBone.position.set(storedHips[0], storedHips[1], storedHips[2]);
      } else {
        hipsBone.position.copy(hipsRest);
      }
    }

    // =========================================================================
    // 3. ACTIVE USER IK SOLVER PASS (Two-Bone Analytical IK)
    // =========================================================================
    const bodyGroup = bodyGroupRef.current;
    const ikActive = activeRigMode === 'ik' || !!actor.ikTargets;

    if (ikActive && bodyGroup) {
      bodyGroup.updateWorldMatrix(true, false);

      // Character-space axes in world terms, so pole targets stay behind the
      // elbow / in front of the knee no matter how the actor is turned.
      const bodyQuat = bodyGroup.getWorldQuaternion(_tmpQuat);
      const poleWorld = new THREE.Vector3();
      const targetWorld = new THREE.Vector3();

      const resolveTarget = (eff: IkEffectorType, out: THREE.Vector3): boolean => {
        const handle = ikTargetHandlesRef.current[eff];
        if (handle && handle.parent) {
          // Live handle position — read every frame so dragging is continuous
          // instead of only applying once the pointer is released.
          handle.getWorldPosition(out);
          return true;
        }
        const stored = actor.ikTargets?.[eff];
        if (stored) {
          out.set(stored[0], stored[1], stored[2]);
          bodyGroup.localToWorld(out);
          return true;
        }
        return false;
      };

      const hasTarget = (eff: IkEffectorType) =>
        activeRigMode === 'ik' || !!actor.ikTargets?.[eff];

      (Object.keys(IK_CHAINS) as IkChainId[]).forEach((eff) => {
        if (!hasTarget(eff)) return;
        if (!resolveTarget(eff, targetWorld)) return;

        const chain = IK_CHAINS[eff];
        const root = bones[chain.root];
        const mid = bones[chain.mid];
        const end = bones[chain.end];
        if (!root || !mid || !end) return;

        // The pose pass above only wrote quaternions, so refresh before reading
        // the limb's world origin.
        root.updateWorldMatrix(true, false);
        root.getWorldPosition(poleWorld);
        _tmpVec
          .set(chain.poleDir[0], chain.poleDir[1], chain.poleDir[2])
          .applyQuaternion(bodyQuat)
          .normalize();
        poleWorld.addScaledVector(_tmpVec, 1.5);

        solveTwoBoneIK(root, mid, end, targetWorld, poleWorld);
      });

      if (hasTarget('lookAt') && resolveTarget('lookAt', targetWorld)) {
        const gazeAxis = rigDataRef.current?.headGazeAxisLocal;
        if (gazeAxis) {
          solveLookAtIK(bones[SOMA.head], bones[SOMA.neck1], targetWorld, gazeAxis, 1.0);
        }
      }
    }

    // =========================================================================
    // 4. KINEMATIC CONSTRAINTS PIPELINE (Upper Body Lock, Stance, Look-At)
    // =========================================================================
    if (actor.constraints && actor.constraints.length > 0) {
      const upperBodyConstraints = actor.constraints.filter((c) => c.type === 'upper_body_lock');
      for (const c of upperBodyConstraints) {
        const w = getConstraintWeight(c, currentTimelineTime);
        if (w > 0.001 && c.upperBody) {
          const presetCfg = UPPER_BODY_POSE_PRESETS[c.upperBody.preset];
          if (presetCfg) {
            for (const bCfg of presetCfg) {
              if (bones[bCfg.index] && restQuats[bCfg.index]) {
                const qOffset = new THREE.Quaternion().setFromEuler(
                  new THREE.Euler(bCfg.euler[0], bCfg.euler[1], bCfg.euler[2], 'YXZ')
                );
                const targetQ = restQuats[bCfg.index].clone().multiply(qOffset);
                bones[bCfg.index].quaternion.slerp(targetQ, w);
              }
            }
          }
        }
      }
    }
  });

  const pointerDownPosRef = useRef<{ x: number; y: number } | null>(null);

  const handleTransformEnd = () => {
    markTransformDragEnd();
    setTimeout(() => {
      onDraggingChange(false);
    }, 200);
    if (rootGroupRef.current && onTransformChange) {
      const pos: [number, number, number] = [
        rootGroupRef.current.position.x,
        rootGroupRef.current.position.y,
        rootGroupRef.current.position.z,
      ];
      const rot: [number, number, number] = [
        rootGroupRef.current.rotation.x,
        rootGroupRef.current.rotation.y,
        rootGroupRef.current.rotation.z,
      ];
      const scl: [number, number, number] = [
        rootGroupRef.current.scale.x,
        rootGroupRef.current.scale.y,
        rootGroupRef.current.scale.z,
      ];
      onTransformChange(actor.id, pos, rot, scl);
    }
  };

  const handleIkEffectorTransformEnd = (eff: IkEffectorType) => {
    markTransformDragEnd();
    setTimeout(() => {
      onDraggingChange(false);
    }, 200);

    const dragged = ikDragRef.current?.eff === eff ? ikDragRef.current.pos : null;
    const handle = ikTargetHandlesRef.current[eff];
    ikDragRef.current = null;
    if (handle && onUpdateActor) {
      const src = dragged ?? handle.position;
      const pos: [number, number, number] = [src.x, src.y, src.z];
      onUpdateActor({
        ...actor,
        ikTargets: {
          ...(actor.ikTargets || {}),
          [eff]: pos,
        },
      });
    }
  };

  const isRobot = actor.characterType === 'g1';
  const jointColor = color || (isRobot ? '#ff9500' : '#00ffcc');
  const showSkeletonRig = isSelected && (activeRigMode !== 'off' || renderMode === 'skeleton' || renderMode === 'hybrid');

  const selectedBone = isRigReady && selectedJointIndex !== null && bonesRef.current[selectedJointIndex]
    ? bonesRef.current[selectedJointIndex]
    : null;

  // handleEpoch forces this to be re-read after the handle groups mount; a ref
  // assigned during a commit is still null on the render that assigned it, so
  // without this the translate gizmo never appeared on first entry to IK mode.
  void handleEpoch;
  const activeIkHandle = activeRigMode === 'ik' && selectedIkEffector
    ? ikTargetHandlesRef.current[selectedIkEffector]
    : null;

  return (
    <>
      {/* 3D Motion Trajectory Spline */}
      {showTrajectory && trajectory.length >= 2 && (
        <TrajectoryPath trajectory={trajectory} color={jointColor} groundY={position[1]} />
      )}

      {/* Main Root Transform Group */}
      <group
        ref={rootGroupRef}
        position={position}
        rotation={rotation}
        scale={scale}
        onPointerDown={(e) => {
          pointerDownPosRef.current = { x: e.clientX, y: e.clientY };
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (isSelectionSuppressed()) return;
          if (pointerDownPosRef.current) {
            const dx = e.clientX - pointerDownPosRef.current.x;
            const dy = e.clientY - pointerDownPosRef.current.y;
            if (dx * dx + dy * dy > 25) return;
          }
          onSelect();
        }}
      >
        {/* Animated SOMA Multi-Body Skinned Mesh */}
        <group ref={bodyGroupRef}>
          {isRigReady && skinnedMeshRef.current ? (
            <primitive object={skinnedMeshRef.current} />
          ) : (
            <ProxyMannequin color={jointColor} />
          )}

          {/* 3D Interactive IK Effector Handles */}
          {showSkeletonRig && (
            <group>
              {/* Right Hand IK Effector */}
              <group
                ref={ikHandleRefSetters.rightHand}
                position={actor.ikTargets?.rightHand || ikHandleDefaults.rightHand}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectIkEffector?.('rightHand');
                }}
              >
                <mesh>
                  <sphereGeometry args={[0.045, 16, 16]} />
                  <meshStandardMaterial
                    color={selectedIkEffector === 'rightHand' && activeRigMode === 'ik' ? '#00ffcc' : '#ffffff'}
                    emissive={selectedIkEffector === 'rightHand' ? '#00ffcc' : '#000000'}
                    emissiveIntensity={0.6}
                  />
                </mesh>
              </group>

              {/* Left Hand IK Effector */}
              <group
                ref={ikHandleRefSetters.leftHand}
                position={actor.ikTargets?.leftHand || ikHandleDefaults.leftHand}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectIkEffector?.('leftHand');
                }}
              >
                <mesh>
                  <sphereGeometry args={[0.045, 16, 16]} />
                  <meshStandardMaterial
                    color={selectedIkEffector === 'leftHand' && activeRigMode === 'ik' ? '#00ffcc' : '#ffffff'}
                    emissive={selectedIkEffector === 'leftHand' ? '#00ffcc' : '#000000'}
                    emissiveIntensity={0.6}
                  />
                </mesh>
              </group>

              {/* Right Foot IK Effector */}
              <group
                ref={ikHandleRefSetters.rightFoot}
                position={actor.ikTargets?.rightFoot || ikHandleDefaults.rightFoot}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectIkEffector?.('rightFoot');
                }}
              >
                <mesh>
                  <boxGeometry args={[0.08, 0.04, 0.16]} />
                  <meshStandardMaterial
                    color={selectedIkEffector === 'rightFoot' && activeRigMode === 'ik' ? '#ff9500' : '#ffffff'}
                    emissive={selectedIkEffector === 'rightFoot' ? '#ff9500' : '#000000'}
                    emissiveIntensity={0.6}
                  />
                </mesh>
              </group>

              {/* Left Foot IK Effector */}
              <group
                ref={ikHandleRefSetters.leftFoot}
                position={actor.ikTargets?.leftFoot || ikHandleDefaults.leftFoot}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectIkEffector?.('leftFoot');
                }}
              >
                <mesh>
                  <boxGeometry args={[0.08, 0.04, 0.16]} />
                  <meshStandardMaterial
                    color={selectedIkEffector === 'leftFoot' && activeRigMode === 'ik' ? '#ff9500' : '#ffffff'}
                    emissive={selectedIkEffector === 'leftFoot' ? '#ff9500' : '#000000'}
                    emissiveIntensity={0.6}
                  />
                </mesh>
              </group>

              {/* Hip / Root COG Handle -- drag to move the whole body */}
              <group
                ref={ikHandleRefSetters.hips}
                position={actor.ikTargets?.hips || ikHandleDefaults.hips}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectIkEffector?.('hips');
                }}
              >
                <mesh rotation={[-Math.PI / 2, 0, 0]}>
                  <torusGeometry args={[0.13, 0.012, 8, 28]} />
                  <meshStandardMaterial
                    color={selectedIkEffector === 'hips' && activeRigMode === 'ik' ? '#ffd60a' : '#ffffff'}
                    emissive={selectedIkEffector === 'hips' ? '#ffd60a' : '#000000'}
                    emissiveIntensity={0.6}
                  />
                </mesh>
                {/* Small hub so the ring is still clickable edge-on */}
                <mesh>
                  <sphereGeometry args={[0.03, 12, 12]} />
                  <meshStandardMaterial
                    color={selectedIkEffector === 'hips' && activeRigMode === 'ik' ? '#ffd60a' : '#ffffff'}
                    emissive={selectedIkEffector === 'hips' ? '#ffd60a' : '#000000'}
                    emissiveIntensity={0.6}
                  />
                </mesh>
              </group>

              {/* Look-At Head IK Target */}
              <group
                ref={ikHandleRefSetters.lookAt}
                position={actor.ikTargets?.lookAt || ikHandleDefaults.lookAt}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectIkEffector?.('lookAt');
                }}
              >
                <mesh>
                  <octahedronGeometry args={[0.06]} />
                  <meshStandardMaterial
                    color={selectedIkEffector === 'lookAt' && activeRigMode === 'ik' ? '#af52de' : '#ffffff'}
                    emissive={selectedIkEffector === 'lookAt' ? '#af52de' : '#000000'}
                    emissiveIntensity={0.6}
                  />
                </mesh>
              </group>
            </group>
          )}
        </group>

        {/* Selection Ring & Name Tag */}
        {isSelected && (
          <group position={[0, 0.02, 0]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.55, 0.62, 32]} />
              <meshBasicMaterial color={jointColor} side={THREE.DoubleSide} />
            </mesh>
            <Html position={[0, 1.9, 0]} center>
              <div className="bg-surface-container/90 border border-primary/40 text-primary px-1.5 py-[1px] rounded font-label-caps text-[9px] tracking-wide whitespace-nowrap shadow-lg backdrop-blur-sm pointer-events-none select-none flex items-center gap-1">
                <span>{actor.name}</span>
                {activeRigMode !== 'off' && (
                  <span className="bg-primary text-background font-bold px-1 rounded text-[8px] uppercase">
                    {activeRigMode}
                  </span>
                )}
              </div>
            </Html>
          </group>
        )}
      </group>

      {/* 1. Root Actor Transform Gizmo (When activeRigMode is 'off') */}
      {isSelected && activeRigMode === 'off' && rootGroupRef.current && (
        <TransformControls
          object={rootGroupRef.current}
          mode={transformMode}
          size={0.75}
          onMouseDown={() => {
            markTransformDragStart();
            onDraggingChange(true);
          }}
          onMouseUp={handleTransformEnd}
        />
      )}

      {/* 2. FK Bone Joint Rotation Gizmo (When activeRigMode is 'fk') */}
      {isSelected && activeRigMode === 'fk' && selectedBone && (
        <TransformControls
          object={selectedBone}
          mode="rotate"
          space="local"
          size={0.6}
          onMouseDown={() => {
            markTransformDragStart();
            onDraggingChange(true);
            fkDragRef.current = {
              index: selectedJointIndex ?? SOMA.head,
              quat: selectedBone.quaternion.clone(),
            };
          }}
          onObjectChange={() => {
            // Capture every pointer move so the animation pass can replay it,
            // which is what makes the joint follow the gizmo in real time.
            if (fkDragRef.current) fkDragRef.current.quat.copy(selectedBone.quaternion);
          }}
          onMouseUp={() => {
            markTransformDragEnd();
            setTimeout(() => onDraggingChange(false), 200);
            const q = fkDragRef.current?.quat ?? selectedBone.quaternion;
            const committed: [number, number, number, number] = [q.x, q.y, q.z, q.w];
            fkDragRef.current = null;
            if (onUpdateActor && selectedJointIndex !== null) {
              onUpdateActor({
                ...actor,
                customBoneRotations: {
                  ...(actor.customBoneRotations || {}),
                  [selectedJointIndex]: committed,
                },
              });
            }
          }}
        />
      )}

      {/* 3. IK Effector Translation Gizmo (When activeRigMode is 'ik') */}
      {isSelected && activeRigMode === 'ik' && activeIkHandle && selectedIkEffector && (
        <TransformControls
          object={activeIkHandle}
          mode="translate"
          size={0.6}
          onMouseDown={() => {
            markTransformDragStart();
            onDraggingChange(true);
            ikDragRef.current = {
              eff: selectedIkEffector,
              pos: activeIkHandle.position.clone(),
            };
          }}
          onObjectChange={() => {
            if (ikDragRef.current) ikDragRef.current.pos.copy(activeIkHandle.position);
          }}
          onMouseUp={() => handleIkEffectorTransformEnd(selectedIkEffector)}
        />
      )}
    </>
  );
};
