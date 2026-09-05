import React, { useRef, useMemo, useEffect, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { TransformControls, Html } from '@react-three/drei';
import * as THREE from 'three';
import { CharacterActor, ActorConstraint, UpperBodyPosePreset } from '../../types';
import { TransformMode } from './ThreeStage';

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
    const res = await fetch('/models/soma_official_rigged.json');
    if (!res.ok) throw new Error('Failed to load /models/soma_official_rigged.json');
    const data = await res.json();

    const parentMap: Record<number, number> = {};
    data.joint_connections.forEach(([p, c]: [number, number]) => { parentMap[c] = p; });

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
  })();

  return rigLoadPromise;
}

// 3D Motion Trajectory Floor Spline (Strictly grounded on stage plane)
const TrajectoryPath: React.FC<{
  trajectory: [number, number, number][];
  color: string;
  groundY?: number;
}> = ({ trajectory, color, groundY = 0 }) => {
  const linePoints = useMemo(() => {
    if (trajectory.length < 2) return [];
    // Ensure all trajectory spline points strictly follow the floor plane
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
      <primitive object={new THREE.Line(lineGeometry, new THREE.LineBasicMaterial({ color: color || '#00ffcc', linewidth: 3 }))} />
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


const UPPER_BODY_POSE_PRESETS: Record<
  UpperBodyPosePreset,
  { index: number; euler: [number, number, number] }[]
> = {
  crossed_arms: [
    { index: 11, euler: [0.1, 0.2, -0.2] },  // LeftShoulder
    { index: 12, euler: [0.6, 0.4, -0.6] },  // LeftArm
    { index: 13, euler: [0.2, 1.4, -0.4] },  // LeftForeArm
    { index: 14, euler: [0.0, 0.3, 0.0] },   // LeftHand
    { index: 39, euler: [0.1, -0.2, 0.2] },  // RightShoulder
    { index: 40, euler: [0.7, -0.4, 0.6] },  // RightArm
    { index: 41, euler: [-0.2, -1.4, 0.4] }, // RightForeArm
    { index: 42, euler: [0.0, -0.3, 0.0] },  // RightHand
    { index: 3, euler: [0.05, 0.0, 0.0] },   // Chest
  ],
  hands_on_hips: [
    { index: 11, euler: [0.0, -0.1, -0.2] }, // LeftShoulder
    { index: 12, euler: [-0.3, -0.2, -0.8] },// LeftArm
    { index: 13, euler: [0.1, 1.3, -0.5] },  // LeftForeArm
    { index: 14, euler: [0.2, 0.4, -0.2] },  // LeftHand
    { index: 39, euler: [0.0, 0.1, 0.2] },   // RightShoulder
    { index: 40, euler: [-0.3, 0.2, 0.8] },  // RightArm
    { index: 41, euler: [-0.1, -1.3, 0.5] }, // RightForeArm
    { index: 42, euler: [-0.2, -0.4, 0.2] }, // RightHand
    { index: 3, euler: [0.03, 0.0, 0.0] },   // Chest
  ],
  holding_prop: [
    { index: 11, euler: [0.1, 0.1, -0.1] },  // LeftShoulder
    { index: 12, euler: [0.8, 0.2, -0.3] },  // LeftArm
    { index: 13, euler: [0.0, 1.0, 0.0] },   // LeftForeArm
    { index: 14, euler: [0.2, 0.0, 0.0] },   // LeftHand
    { index: 39, euler: [0.1, -0.1, 0.1] },  // RightShoulder
    { index: 40, euler: [0.8, -0.2, 0.3] },  // RightArm
    { index: 41, euler: [0.0, -1.0, 0.0] },  // RightForeArm
    { index: 42, euler: [-0.2, 0.0, 0.0] },  // RightHand
    { index: 3, euler: [0.04, 0.0, 0.0] },   // Chest
  ],
  hands_in_pockets: [
    { index: 12, euler: [-0.1, 0.0, -0.2] }, // LeftArm
    { index: 13, euler: [0.2, 0.4, -0.2] },  // LeftForeArm
    { index: 14, euler: [0.2, 0.3, 0.0] },   // LeftHand
    { index: 40, euler: [-0.1, 0.0, 0.2] },  // RightArm
    { index: 41, euler: [-0.2, -0.4, 0.2] }, // RightForeArm
    { index: 42, euler: [-0.2, -0.3, 0.0] }, // RightHand
    { index: 3, euler: [0.02, 0.0, 0.0] },   // Chest
  ],
  defensive: [
    { index: 11, euler: [0.2, 0.2, -0.1] },  // LeftShoulder
    { index: 12, euler: [1.1, 0.3, -0.5] },  // LeftArm
    { index: 13, euler: [0.3, 1.8, -0.2] },  // LeftForeArm
    { index: 14, euler: [0.4, 0.0, 0.0] },   // LeftHand
    { index: 39, euler: [0.2, -0.2, 0.1] },  // RightShoulder
    { index: 40, euler: [1.1, -0.3, 0.5] },  // RightArm
    { index: 41, euler: [-0.3, -1.8, 0.2] }, // RightForeArm
    { index: 42, euler: [-0.4, 0.0, 0.0] },  // RightHand
    { index: 3, euler: [0.06, 0.0, 0.0] },   // Chest
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
  allActors = [],
  isSelected,
  transformMode,
  currentTimelineTime,
  isPlaying: _isPlaying = false,
  showTrajectory = true,
  onSelect,
  onDraggingChange,
  onTransformChange,
}) => {
  const { camera } = useThree();
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
    renderMode = 'mesh', // 'mesh' | 'skeleton' | 'hybrid'
  } = actor;

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
          roughness: 0.35,
          metalness: 0.45,
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
      const isHybrid = renderMode === 'hybrid';
      const isMesh = renderMode === 'mesh';
      skinnedMeshRef.current.visible = isMesh || isHybrid;

      const mat = skinnedMeshRef.current.material as THREE.MeshStandardMaterial;
      if (mat) {
        mat.transparent = isHybrid;
        mat.opacity = isHybrid ? 0.45 : 1.0;
        mat.color.set(actor.color || (actor.characterType === 'g1' ? '#e5e5ea' : '#32363d'));
        mat.needsUpdate = true;
      }
    }
  }, [renderMode, actor.characterType, actor.color]);

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
    // 1. BASE POSE: TRUE NVIDIA KIMODO DIFFUSION MOTION OR IDLE BREATHING
    // =========================================================================
    if (actor.motionData && actor.motionData.rotations && actor.motionData.rotations.length > 0) {
      const mData = actor.motionData;
      const tTotal = Math.max(0.1, mData.duration || duration || 4.0);
      const progress = (currentTimelineTime % tTotal) / tTotal;
      const numFrames = mData.num_frames || mData.rotations.length;

      const exactFrame = progress * (numFrames - 1);
      const frame0 = Math.floor(exactFrame);
      const frame1 = Math.min(numFrames - 1, frame0 + 1);
      const alpha = exactFrame - frame0;

      // A. Drive Root 3D Translation (Relative to Frame 0 to preserve ground contact and placement)
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
      } else if (bodyGroupRef.current) {
        bodyGroupRef.current.position.set(0, 0, 0);
        bodyGroupRef.current.rotation.set(0, 0, 0);
      }

      // B. Drive 77 SOMA Bone Rotations with SLERP
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
      // Default Neutral Rest Pose with Subtle Idle Breathing
      if (bodyGroupRef.current) {
        bodyGroupRef.current.position.set(0, 0, 0);
        bodyGroupRef.current.rotation.set(0, 0, 0);
      }

      // Reset bones to rest pose
      for (let i = 0; i < bones.length; i++) {
        bones[i].quaternion.copy(restQuats[i]);
      }

      // Natural subtle chest breathing
      const breath = Math.sin(currentTimelineTime * 2.0) * 0.015;
      const qDelta = new THREE.Quaternion();
      qDelta.setFromAxisAngle(new THREE.Vector3(1, 0, 0), breath);
      bones[3].quaternion.multiply(qDelta); // Chest

      // Micro head shift
      const headShift = Math.sin(currentTimelineTime * 0.8) * 0.03;
      qDelta.setFromAxisAngle(new THREE.Vector3(0, 1, 0), headShift);
      bones[6].quaternion.multiply(qDelta); // Head
    }

    // =========================================================================
    // 2. REAL-TIME KINEMATIC CONSTRAINT BLENDING PIPELINE
    // =========================================================================
    if (actor.constraints && actor.constraints.length > 0) {
      // A. Destination Steering (only active during kinematic preview when neural motionData is not present)
      if (!actor.motionData) {
        const destConstraints = actor.constraints.filter((c) => c.type === 'destination');
        for (const c of destConstraints) {
          const w = getConstraintWeight(c, currentTimelineTime);
          if (w > 0.001 && c.destination && bodyGroupRef.current) {
            const totalDur = Math.max(0.1, c.endTime - c.startTime);
            const progress = THREE.MathUtils.clamp((currentTimelineTime - c.startTime) / totalDur, 0, 1);
            const easeProgress = progress * progress * (3 - 2 * progress);
            const targetX = c.destination.position[0] - position[0];
            const targetZ = c.destination.position[2] - position[2];
            bodyGroupRef.current.position.x = THREE.MathUtils.lerp(
              bodyGroupRef.current.position.x,
              targetX,
              easeProgress * w
            );
            bodyGroupRef.current.position.z = THREE.MathUtils.lerp(
              bodyGroupRef.current.position.z,
              targetZ,
              easeProgress * w
            );
          }
        }
      }

      // B. Facing Direction / Heading Lock
      const faceConstraints = actor.constraints.filter((c) => c.type === 'facing_direction');
      for (const c of faceConstraints) {
        const w = getConstraintWeight(c, currentTimelineTime);
        if (w > 0.001 && c.facing && bodyGroupRef.current) {
          let targetYaw = 0;
          if (c.facing.targetType === 'camera') {
            const rootWorld = new THREE.Vector3();
            rootGroupRef.current?.getWorldPosition(rootWorld);
            targetYaw = Math.atan2(camera.position.x - rootWorld.x, camera.position.z - rootWorld.z);
          } else if (c.facing.targetType === 'actor' && c.facing.targetActorId && allActors) {
            const targetAct = allActors.find((a) => a.id === c.facing?.targetActorId);
            if (targetAct && rootGroupRef.current) {
              const rootWorld = new THREE.Vector3();
              rootGroupRef.current.getWorldPosition(rootWorld);
              targetYaw = Math.atan2(targetAct.position[0] - rootWorld.x, targetAct.position[2] - rootWorld.z);
            }
          } else if (c.facing.targetType === 'angle') {
            targetYaw = (c.facing.angleDegrees || 0) * (Math.PI / 180);
          }
          const curY = bodyGroupRef.current.rotation.y;
          let diff = (targetYaw - curY) % (Math.PI * 2);
          if (diff > Math.PI) diff -= Math.PI * 2;
          if (diff < -Math.PI) diff += Math.PI * 2;
          bodyGroupRef.current.rotation.y = curY + diff * w;
        }
      }

      // C. Stance & Height Clamping
      const stanceConstraints = actor.constraints.filter((c) => c.type === 'stance_height');
      for (const c of stanceConstraints) {
        const w = getConstraintWeight(c, currentTimelineTime);
        if (w > 0.001 && c.stance && bodyGroupRef.current) {
          const heightOffset = c.stance.heightOffset * w;
          bodyGroupRef.current.position.y += heightOffset;

          if (c.stance.heightOffset < -0.15) {
            const crouchFactor = Math.min(1.0, Math.abs(c.stance.heightOffset) / 0.4) * w;
            const qKnee = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.5 * crouchFactor);
            bones[67]?.quaternion.multiply(qKnee);
            bones[72]?.quaternion.multiply(qKnee);
            const qShin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.9 * crouchFactor);
            bones[68]?.quaternion.multiply(qShin);
            bones[73]?.quaternion.multiply(qShin);
            const qSpine = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.2 * crouchFactor);
            bones[1]?.quaternion.multiply(qSpine);
            bones[2]?.quaternion.multiply(qSpine);
          }
        }
      }

      // D. Foot Grounding Lock
      const groundConstraints = actor.constraints.filter((c) => c.type === 'foot_grounding');
      for (const c of groundConstraints) {
        const w = getConstraintWeight(c, currentTimelineTime);
        if (w > 0.001 && c.footGrounding && bodyGroupRef.current) {
          if (bodyGroupRef.current.position.y < 0) {
            bodyGroupRef.current.position.y = THREE.MathUtils.lerp(bodyGroupRef.current.position.y, 0, w);
          }
          if ((c.footGrounding.mode === 'both' || c.footGrounding.mode === 'left') && bones[69]) {
            bones[69].quaternion.slerp(restQuats[69], 0.6 * w);
          }
          if ((c.footGrounding.mode === 'both' || c.footGrounding.mode === 'right') && bones[74]) {
            bones[74].quaternion.slerp(restQuats[74], 0.6 * w);
          }
        }
      }

      // E. Upper-Body Pose Lock / Isolation
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

      // F. Look-At Target (Camera / Actor / Point)
      const lookConstraints = actor.constraints.filter((c) => c.type === 'look_at');
      for (const c of lookConstraints) {
        const w = getConstraintWeight(c, currentTimelineTime);
        if (w > 0.001 && c.lookAt && rootGroupRef.current && bones[6]) {
          let targetWorld = new THREE.Vector3();
          if (c.lookAt.targetType === 'camera') {
            targetWorld.copy(camera.position);
          } else if (c.lookAt.targetType === 'actor' && c.lookAt.targetActorId && allActors) {
            const targetAct = allActors.find((a) => a.id === c.lookAt?.targetActorId);
            if (targetAct) {
              targetWorld.set(targetAct.position[0], targetAct.position[1] + 1.6, targetAct.position[2]);
            } else {
              targetWorld.copy(camera.position);
            }
          } else if (c.lookAt.targetType === 'point' && c.lookAt.targetPoint) {
            targetWorld.set(c.lookAt.targetPoint[0], c.lookAt.targetPoint[1], c.lookAt.targetPoint[2]);
          } else {
            targetWorld.copy(camera.position);
          }

          const headPos = new THREE.Vector3();
          bones[6].getWorldPosition(headPos);
          const dirWorld = new THREE.Vector3().subVectors(targetWorld, headPos);
          if (dirWorld.lengthSq() > 0.001) {
            dirWorld.normalize();
            const rootWorldQuat = new THREE.Quaternion();
            rootGroupRef.current.getWorldQuaternion(rootWorldQuat);
            const invRootQuat = rootWorldQuat.clone().invert();
            const dirLocal = dirWorld.clone().applyQuaternion(invRootQuat);

            let targetYaw = Math.atan2(dirLocal.x, dirLocal.z);
            const xzDist = Math.sqrt(dirLocal.x * dirLocal.x + dirLocal.z * dirLocal.z);
            let targetPitch = -Math.atan2(dirLocal.y, xzDist);

            targetYaw = THREE.MathUtils.clamp(targetYaw, -1.2, 1.2);
            targetPitch = THREE.MathUtils.clamp(targetPitch, -0.7, 0.7);

            const qNeckDelta = new THREE.Quaternion().setFromEuler(
              new THREE.Euler(targetPitch * 0.35, targetYaw * 0.35, 0, 'YXZ')
            );
            const qHeadDelta = new THREE.Quaternion().setFromEuler(
              new THREE.Euler(targetPitch * 0.65, targetYaw * 0.65, 0, 'YXZ')
            );

            const targetNeckQuat = restQuats[4].clone().multiply(qNeckDelta);
            const targetHeadQuat = restQuats[6].clone().multiply(qHeadDelta);

            bones[4]?.quaternion.slerp(targetNeckQuat, w);
            bones[6]?.quaternion.slerp(targetHeadQuat, w);
          }
        }
      }
    }
  });

  const handleTransformEnd = () => {
    onDraggingChange(false);
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

  const isRobot = actor.characterType === 'g1';
  const jointColor = color || (isRobot ? '#ff9500' : '#00ffcc');

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
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
      >
        {/* Animated Rigged SOMA Multi-Body Skinned Mesh */}
        <group ref={bodyGroupRef}>
          {/* Official SOMA Skinned Mesh Primitive */}
          {isRigReady && skinnedMeshRef.current && (
            <primitive object={skinnedMeshRef.current} />
          )}
        </group>

        {/* Selection Ring & Name Tag */}
        {isSelected && (
          <group position={[0, 0.02, 0]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.55, 0.62, 32]} />
              <meshBasicMaterial color={jointColor} side={THREE.DoubleSide} />
            </mesh>
            <Html position={[0, 1.95, 0]} center distanceFactor={8}>
              <div className="bg-surface-container/95 border border-primary/50 text-primary px-sm py-[2px] rounded font-label-caps text-[10px] tracking-wider whitespace-nowrap shadow-xl">
                {actor.name} (SOMA 77-Bone Rigged)
              </div>
            </Html>
          </group>
        )}
      </group>

      {/* Transform Gizmo when selected */}
      {isSelected && rootGroupRef.current && (
        <TransformControls
          object={rootGroupRef.current}
          mode={transformMode}
          size={0.75}
          onMouseDown={() => onDraggingChange(true)}
          onMouseUp={handleTransformEnd}
        />
      )}
    </>
  );
};
