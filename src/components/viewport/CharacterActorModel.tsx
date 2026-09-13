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

interface SOMARigCache {
  geometry: THREE.BufferGeometry;
  jointNames: string[];
  jointConnections: [number, number][];
  localTransforms: { pos: THREE.Vector3; quat: THREE.Quaternion; scl: THREE.Vector3 }[];
}

let cachedSOMARigData: SOMARigCache | null = null;
let rigLoadPromise: Promise<SOMARigCache> | null = null;

async function loadOfficialSOMARig(): Promise<SOMARigCache> {
  if (cachedSOMARigData) return cachedSOMARigData;
  if (rigLoadPromise) return rigLoadPromise;

  rigLoadPromise = (async () => {
    try {
      const res = await fetch('/models/soma_official_rigged.json');
      if (!res.ok) throw new Error('Failed to load /models/soma_official_rigged.json');
      const data = await res.json();

      const parentMap: Record<number, number> = {};
      data.joint_connections.forEach(([p, c]: [number, number]) => {
        parentMap[c] = p;
      });

      const worldMats = data.joint_transforms.map((t: number[][]) => {
        const m = new THREE.Matrix4();
        m.set(
          t[0][0], t[0][1], t[0][2], t[0][3],
          t[1][0], t[1][1], t[1][2], t[1][3],
          t[2][0], t[2][1], t[2][2], t[2][3],
          t[3][0], t[3][1], t[3][2], t[3][3]
        );
        return m;
      });

      const localTransforms: { pos: THREE.Vector3; quat: THREE.Quaternion; scl: THREE.Vector3 }[] = [];
      for (let i = 0; i < data.joint_names.length; i++) {
        const pIdx = parentMap[i];
        let localM: THREE.Matrix4;
        if (pIdx === undefined) {
          localM = worldMats[i].clone();
        } else {
          const invParent = worldMats[pIdx].clone().invert();
          localM = invParent.multiply(worldMats[i]);
        }
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        const scl = new THREE.Vector3();
        localM.decompose(pos, quat, scl);
        localTransforms.push({ pos, quat, scl });
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.vertices, 3));
      geometry.setIndex(data.faces);
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(data.skin_indices, 4));
      geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(data.skin_weights, 4));
      geometry.computeVertexNormals();

      cachedSOMARigData = {
        geometry,
        jointNames: data.joint_names,
        jointConnections: data.joint_connections,
        localTransforms,
      };
      return cachedSOMARigData;
    } catch (err) {
      rigLoadPromise = null;
      throw err;
    }
  })();

  return rigLoadPromise;
}

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
  const [isRigReady, setIsRigReady] = useState<boolean>(false);

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
    leftHand: THREE.Group | null;
    rightHand: THREE.Group | null;
    leftFoot: THREE.Group | null;
    rightFoot: THREE.Group | null;
    lookAt: THREE.Group | null;
  }>({
    leftHand: null,
    rightHand: null,
    leftFoot: null,
    rightFoot: null,
    lookAt: null,
  });

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
    if (actor.keyframePoses && actor.keyframePoses.length > 0) {
      // A. Timeline Keyframe Pose Blending
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
    } else if (actor.motionData && actor.motionData.rotations && actor.motionData.rotations.length > 0) {
      // B. Neural Motion Data Playback
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

    // =========================================================================
    // 3. ACTIVE USER IK SOLVER PASS (Two-Bone Analytical IK)
    // =========================================================================
    if (activeRigMode === 'ik' || actor.ikTargets) {
      const ikTargets = actor.ikTargets || {};

      // Right Arm IK (bones 39: shoulder, 40: arm, 41: forearm, 42: hand)
      if (ikTargets.rightHand && ikTargetHandlesRef.current.rightHand) {
        const targetWorld = new THREE.Vector3();
        ikTargetHandlesRef.current.rightHand.getWorldPosition(targetWorld);
        solveTwoBoneIK(bones[39], bones[40], bones[42], targetWorld);
      }

      // Left Arm IK (bones 11: shoulder, 12: arm, 13: forearm, 14: hand)
      if (ikTargets.leftHand && ikTargetHandlesRef.current.leftHand) {
        const targetWorld = new THREE.Vector3();
        ikTargetHandlesRef.current.leftHand.getWorldPosition(targetWorld);
        solveTwoBoneIK(bones[11], bones[12], bones[14], targetWorld);
      }

      // Right Leg IK (bones 71: hip, 72: knee, 73: ankle)
      if (ikTargets.rightFoot && ikTargetHandlesRef.current.rightFoot) {
        const targetWorld = new THREE.Vector3();
        ikTargetHandlesRef.current.rightFoot.getWorldPosition(targetWorld);
        solveTwoBoneIK(bones[71], bones[72], bones[73], targetWorld);
      }

      // Left Leg IK (bones 66: hip, 67: knee, 68: ankle)
      if (ikTargets.leftFoot && ikTargetHandlesRef.current.leftFoot) {
        const targetWorld = new THREE.Vector3();
        ikTargetHandlesRef.current.leftFoot.getWorldPosition(targetWorld);
        solveTwoBoneIK(bones[66], bones[67], bones[68], targetWorld);
      }

      // Look-At Head IK (bones 6: head, 4: neck)
      if (ikTargets.lookAt && ikTargetHandlesRef.current.lookAt) {
        const targetWorld = new THREE.Vector3();
        ikTargetHandlesRef.current.lookAt.getWorldPosition(targetWorld);
        solveLookAtIK(bones[6], bones[4], targetWorld, 1.0);
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

    const handle = ikTargetHandlesRef.current[eff];
    if (handle && onUpdateActor) {
      const pos: [number, number, number] = [handle.position.x, handle.position.y, handle.position.z];
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
                ref={(el) => (ikTargetHandlesRef.current.rightHand = el)}
                position={actor.ikTargets?.rightHand || [0.35, 1.0, 0.2]}
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
                ref={(el) => (ikTargetHandlesRef.current.leftHand = el)}
                position={actor.ikTargets?.leftHand || [-0.35, 1.0, 0.2]}
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
                ref={(el) => (ikTargetHandlesRef.current.rightFoot = el)}
                position={actor.ikTargets?.rightFoot || [0.12, 0.08, 0.0]}
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
                ref={(el) => (ikTargetHandlesRef.current.leftFoot = el)}
                position={actor.ikTargets?.leftFoot || [-0.12, 0.08, 0.0]}
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

              {/* Look-At Head IK Target */}
              <group
                ref={(el) => (ikTargetHandlesRef.current.lookAt = el)}
                position={actor.ikTargets?.lookAt || [0, 1.6, 1.5]}
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
          size={0.6}
          onMouseDown={() => {
            markTransformDragStart();
            onDraggingChange(true);
          }}
          onMouseUp={() => {
            markTransformDragEnd();
            setTimeout(() => onDraggingChange(false), 200);
            if (selectedBone && onUpdateActor && selectedJointIndex !== null) {
              const q = selectedBone.quaternion;
              onUpdateActor({
                ...actor,
                customBoneRotations: {
                  ...(actor.customBoneRotations || {}),
                  [selectedJointIndex]: [q.x, q.y, q.z, q.w],
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
          }}
          onMouseUp={() => handleIkEffectorTransformEnd(selectedIkEffector)}
        />
      )}
    </>
  );
};
