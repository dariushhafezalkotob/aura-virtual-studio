import React, { useRef, useMemo, useEffect, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { TransformControls, Html } from '@react-three/drei';
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { CharacterActor } from '../../types';
import { TransformMode } from './ThreeStage';

interface CharacterActorModelProps {
  actor: CharacterActor;
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

// ---------------------------------------------------------------------------
// SOMA / SMPL Humanoid Skeleton Definition (24 Anatomical Biomechanical Joints)
// ---------------------------------------------------------------------------
interface SOMAJointDef {
  name: string;
  pos: THREE.Vector3;
  radius: number;
  parent: number;
  isEndEffector?: boolean;
}

// SOMA Joint T-Pose Coordinates in Mesh Space (centered at pelvis root)
const SOMA_JOINTS_DEF: SOMAJointDef[] = [
  { name: 'Pelvis', pos: new THREE.Vector3(0, 0, 0), radius: 0.18, parent: -1 },
  { name: 'Spine1', pos: new THREE.Vector3(0, 0.13, -0.01), radius: 0.16, parent: 0 },
  { name: 'Spine2', pos: new THREE.Vector3(0, 0.27, 0), radius: 0.18, parent: 1 },
  { name: 'Spine3', pos: new THREE.Vector3(0, 0.41, 0.02), radius: 0.20, parent: 2 },
  { name: 'Neck', pos: new THREE.Vector3(0, 0.53, 0.01), radius: 0.10, parent: 3 },
  { name: 'Head', pos: new THREE.Vector3(0, 0.65, 0.04), radius: 0.15, parent: 4, isEndEffector: true },
  
  { name: 'L_Collar', pos: new THREE.Vector3(-0.08, 0.43, 0.01), radius: 0.12, parent: 3 },
  { name: 'L_Shoulder', pos: new THREE.Vector3(-0.20, 0.41, 0), radius: 0.14, parent: 6 },
  { name: 'L_Elbow', pos: new THREE.Vector3(-0.46, 0.41, 0), radius: 0.12, parent: 7 },
  { name: 'L_Wrist', pos: new THREE.Vector3(-0.70, 0.41, 0), radius: 0.09, parent: 8 },
  { name: 'L_Hand', pos: new THREE.Vector3(-0.80, 0.41, 0), radius: 0.08, parent: 9, isEndEffector: true },

  { name: 'R_Collar', pos: new THREE.Vector3(0.08, 0.43, 0.01), radius: 0.12, parent: 3 },
  { name: 'R_Shoulder', pos: new THREE.Vector3(0.20, 0.41, 0), radius: 0.14, parent: 11 },
  { name: 'R_Elbow', pos: new THREE.Vector3(0.46, 0.41, 0), radius: 0.12, parent: 12 },
  { name: 'R_Wrist', pos: new THREE.Vector3(0.70, 0.41, 0), radius: 0.09, parent: 13 },
  { name: 'R_Hand', pos: new THREE.Vector3(0.80, 0.41, 0), radius: 0.08, parent: 14, isEndEffector: true },

  { name: 'L_Hip', pos: new THREE.Vector3(-0.10, -0.07, 0), radius: 0.16, parent: 0 },
  { name: 'L_Knee', pos: new THREE.Vector3(-0.10, -0.49, 0.01), radius: 0.14, parent: 16 },
  { name: 'L_Ankle', pos: new THREE.Vector3(-0.10, -0.87, -0.02), radius: 0.10, parent: 17 },
  { name: 'L_Toe', pos: new THREE.Vector3(-0.10, -0.95, 0.08), radius: 0.10, parent: 18, isEndEffector: true },

  { name: 'R_Hip', pos: new THREE.Vector3(0.10, -0.07, 0), radius: 0.16, parent: 0 },
  { name: 'R_Knee', pos: new THREE.Vector3(0.10, -0.49, 0.01), radius: 0.14, parent: 20 },
  { name: 'R_Ankle', pos: new THREE.Vector3(0.10, -0.87, -0.02), radius: 0.10, parent: 21 },
  { name: 'R_Toe', pos: new THREE.Vector3(0.10, -0.95, 0.08), radius: 0.10, parent: 22, isEndEffector: true },
];

// Helper to calculate Linear Blend Skinning (LBS) weights on SOMA mesh geometry
function applySOMALBSSkinning(geometry: THREE.BufferGeometry) {
  const posAttr = geometry.attributes.position;
  const count = posAttr.count;
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  const v = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(posAttr, i);

    const dists: { index: number; weight: number }[] = [];
    for (let j = 0; j < SOMA_JOINTS_DEF.length; j++) {
      const joint = SOMA_JOINTS_DEF[j];
      const d = v.distanceTo(joint.pos);
      const sigma = joint.radius * 1.5;
      const weight = Math.exp(-(d * d) / (2 * sigma * sigma));
      dists.push({ index: j, weight });
    }

    dists.sort((a, b) => b.weight - a.weight);
    let totalW = dists[0].weight + dists[1].weight + dists[2].weight + dists[3].weight;
    if (totalW < 1e-6) totalW = 1.0;

    skinIndices.push(dists[0].index, dists[1].index, dists[2].index, dists[3].index);
    skinWeights.push(
      dists[0].weight / totalW,
      dists[1].weight / totalW,
      dists[2].weight / totalW,
      dists[3].weight / totalW
    );
  }

  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geometry.computeVertexNormals();
}

// 3D Motion Trajectory Floor Spline
const TrajectoryPath: React.FC<{
  trajectory: [number, number, number][];
  color: string;
}> = ({ trajectory, color }) => {
  const linePoints = useMemo(() => {
    if (trajectory.length < 2) return [];
    const pts = trajectory.map((p) => new THREE.Vector3(p[0], p[1] + 0.02, p[2]));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.2);
    return curve.getPoints(Math.max(30, trajectory.length * 8));
  }, [trajectory]);

  const lineGeometry = useMemo(() => {
    if (linePoints.length < 2) return null;
    return new THREE.BufferGeometry().setFromPoints(linePoints);
  }, [linePoints]);

  if (!lineGeometry || trajectory.length < 2) return null;

  const startPt = trajectory[0];
  const endPt = trajectory[trajectory.length - 1];

  return (
    <group>
      <primitive object={new THREE.Line(lineGeometry, new THREE.LineBasicMaterial({ color: color || '#00ffcc', linewidth: 3 }))} />
      <mesh position={[startPt[0], startPt[1] + 0.03, startPt[2]]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.2, 0.26, 24]} />
        <meshBasicMaterial color={color || '#00ffcc'} side={THREE.DoubleSide} />
      </mesh>
      <group position={[endPt[0], endPt[1] + 0.03, endPt[2]]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.22, 24]} />
          <meshBasicMaterial color="#ff3b30" side={THREE.DoubleSide} />
        </mesh>
      </group>
    </group>
  );
};

export const CharacterActorModel: React.FC<CharacterActorModelProps> = ({
  actor,
  isSelected,
  transformMode,
  currentTimelineTime,
  isPlaying: _isPlaying = false,
  showTrajectory = true,
  onSelect,
  onDraggingChange,
  onTransformChange,
}) => {
  const rootGroupRef = useRef<THREE.Group>(null);
  const bodyGroupRef = useRef<THREE.Group>(null);
  const skinnedMeshRef = useRef<THREE.SkinnedMesh | null>(null);

  // Store Bone Tree array
  const bonesRef = useRef<THREE.Bone[]>([]);
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

  // Build SOMA Bone Hierarchy & Rigged SkinnedMesh on Mount
  useEffect(() => {
    let isMounted = true;

    // 1. Build SOMA Bone Nodes
    const bones = SOMA_JOINTS_DEF.map((j) => {
      const b = new THREE.Bone();
      b.name = j.name;
      b.position.copy(j.pos);
      return b;
    });

    // Structure parent-child relative hierarchy
    for (let i = 0; i < SOMA_JOINTS_DEF.length; i++) {
      const pIdx = SOMA_JOINTS_DEF[i].parent;
      if (pIdx >= 0) {
        const parentPos = SOMA_JOINTS_DEF[pIdx].pos;
        bones[i].position.sub(parentPos);
        bones[pIdx].add(bones[i]);
      }
    }

    bonesRef.current = bones;

    // 2. Load Official SOMA SMPL Human Body Mesh OBJ & Apply Linear Blend Skinning
    const loader = new OBJLoader();
    loader.load(
      '/models/soma_smpl_body.obj',
      (obj) => {
        if (!isMounted) return;

        let geom: THREE.BufferGeometry | null = null;
        obj.traverse((child) => {
          if ((child as THREE.Mesh).isMesh && !geom) {
            geom = (child as THREE.Mesh).geometry.clone();
          }
        });

        if (geom) {
          applySOMALBSSkinning(geom);

          const skeleton = new THREE.Skeleton(bones);
          const material = new THREE.MeshStandardMaterial({
            color: actor.characterType === 'g1' ? '#e5e5ea' : '#32363d',
            roughness: 0.35,
            metalness: 0.45,
            side: THREE.DoubleSide,
          });

          const sm = new THREE.SkinnedMesh(geom, material);
          sm.castShadow = true;
          sm.receiveShadow = true;
          sm.add(bones[0]); // Add root bone (Pelvis)
          sm.bind(skeleton);
          sm.position.set(0, 0.95, 0); // Ground alignment

          skinnedMeshRef.current = sm;
          setIsRigReady(true);
        }
      },
      undefined,
      (err) => console.warn('SOMA Mesh load note:', err)
    );

    return () => {
      isMounted = false;
    };
  }, [actor.characterType]);

  // Update material appearance when renderMode or selection changes
  useEffect(() => {
    if (skinnedMeshRef.current) {
      const isHybrid = renderMode === 'hybrid';
      const isMesh = renderMode === 'mesh';
      skinnedMeshRef.current.visible = isMesh || isHybrid;

      const mat = skinnedMeshRef.current.material as THREE.MeshStandardMaterial;
      if (mat) {
        mat.transparent = isHybrid;
        mat.opacity = isHybrid ? 0.45 : 1.0;
        mat.color.set(actor.characterType === 'g1' ? '#e5e5ea' : '#32363d');
        mat.needsUpdate = true;
      }
    }
  }, [renderMode, actor.characterType]);

  // Sync initial root transform
  useEffect(() => {
    if (rootGroupRef.current) {
      rootGroupRef.current.position.set(position[0], position[1], position[2]);
      rootGroupRef.current.rotation.set(rotation[0], rotation[1], rotation[2]);
      rootGroupRef.current.scale.set(scale[0], scale[1], scale[2]);
      rootGroupRef.current.updateMatrixWorld(true);
    }
  }, [position[0], position[1], position[2], rotation[0], rotation[1], rotation[2], scale[0], scale[1], scale[2]]);

  // Trajectory Spline Curve
  const trajectoryCurve = useMemo(() => {
    if (trajectory.length < 2) return null;
    const pts = trajectory.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.2);
  }, [trajectory]);

  // Real-time SOMA Kinematic Animation Engine driving the Skinned Skeleton
  useFrame(() => {
    const tTotal = Math.max(0.1, duration);
    const progress = (currentTimelineTime % tTotal) / tTotal;
    const animName = (actor.currentAnimation || actor.motionPrompt || '').toLowerCase();
    const bones = bonesRef.current;

    // 1. Root Trajectory Translation & Heading
    if (bodyGroupRef.current && trajectoryCurve && trajectory.length >= 2) {
      const posOnCurve = trajectoryCurve.getPointAt(progress);
      const tangent = trajectoryCurve.getTangentAt(progress).normalize();

      bodyGroupRef.current.position.set(
        posOnCurve.x - position[0],
        posOnCurve.y - position[1],
        posOnCurve.z - position[2]
      );

      if (tangent.lengthSq() > 0.001) {
        const targetAngle = Math.atan2(-tangent.x, -tangent.z);
        bodyGroupRef.current.rotation.y = targetAngle - rotation[1];
      }
    } else if (bodyGroupRef.current) {
      bodyGroupRef.current.position.set(0, 0, 0);
      bodyGroupRef.current.rotation.set(0, 0, 0);
    }

    if (bones.length < 24) return;

    // Bone index references:
    // 0: Pelvis, 1: Spine1, 2: Spine2, 3: Spine3, 4: Neck, 5: Head
    // 6: L_Collar, 7: L_Shoulder, 8: L_Elbow, 9: L_Wrist, 10: L_Hand
    // 11: R_Collar, 12: R_Shoulder, 13: R_Elbow, 14: R_Wrist, 15: R_Hand
    // 16: L_Hip, 17: L_Knee, 18: L_Ankle, 19: L_Toe
    // 20: R_Hip, 21: R_Knee, 22: R_Ankle, 23: R_Toe

    const isWalking =
      animName.includes('walk') ||
      animName.includes('jog') ||
      animName.includes('run') ||
      animName.includes('patrol') ||
      animName.includes('step');
    const isWaving = animName.includes('wave') || animName.includes('greet');
    const isLooking = animName.includes('look') || animName.includes('scan') || animName.includes('around');
    const isMartial = animName.includes('martial') || animName.includes('kick') || animName.includes('punch');
    const isDancing = animName.includes('dance') || animName.includes('groove');
    const isTalking = animName.includes('talk') || animName.includes('explain') || animName.includes('gesture');

    const strideRate = animName.includes('run') || animName.includes('jog') ? 8.5 : 5.0;
    const stridePhase = currentTimelineTime * strideRate;

    // Reset default rest pose
    for (let i = 0; i < bones.length; i++) {
      bones[i].rotation.set(0, 0, 0);
    }

    // A. Locomotion / Leg Kinematics (LBS mesh deform)
    if (isWalking) {
      const legSwing = Math.sin(stridePhase) * 0.7;
      const hipBob = Math.abs(Math.sin(stridePhase * 2)) * 0.045;

      bones[16].rotation.x = legSwing; // L_Hip
      bones[20].rotation.x = -legSwing; // R_Hip

      bones[17].rotation.x = Math.max(0, -legSwing * 1.1); // L_Knee
      bones[21].rotation.x = Math.max(0, legSwing * 1.1); // R_Knee

      bones[18].rotation.x = -legSwing * 0.4; // L_Ankle
      bones[22].rotation.x = legSwing * 0.4; // R_Ankle

      bones[7].rotation.x = -legSwing * 0.8; // L_Shoulder
      if (!isWaving) bones[12].rotation.x = legSwing * 0.8; // R_Shoulder

      bones[8].rotation.x = Math.max(0.1, -legSwing * 0.4); // L_Elbow
      if (!isWaving) bones[13].rotation.x = Math.max(0.1, legSwing * 0.4); // R_Elbow

      bones[0].position.y = hipBob; // Pelvis
      bones[0].rotation.y = Math.sin(stridePhase) * 0.08;
      bones[1].rotation.y = -Math.sin(stridePhase) * 0.05; // Spine1
      bones[3].rotation.y = -Math.sin(stridePhase) * 0.05; // Spine3
    } else if (isDancing) {
      const beat = currentTimelineTime * 5.0;
      bones[0].position.y = Math.abs(Math.sin(beat)) * 0.05;
      bones[0].rotation.z = Math.sin(beat) * 0.18;
      bones[2].rotation.y = Math.cos(beat * 0.5) * 0.25; // Spine2

      bones[7].rotation.z = 0.6 + Math.sin(beat) * 0.4; // L_Shoulder
      bones[7].rotation.x = Math.cos(beat) * 0.3;
      bones[12].rotation.z = -0.6 - Math.cos(beat) * 0.4; // R_Shoulder
      bones[12].rotation.x = -Math.sin(beat) * 0.3;

      bones[16].rotation.x = Math.sin(beat) * 0.3; // L_Hip
      bones[20].rotation.x = -Math.sin(beat) * 0.3; // R_Hip
    } else if (isMartial) {
      const phase = (currentTimelineTime % 3.0) / 3.0;
      if (phase < 0.4) {
        const k = phase / 0.4;
        bones[20].rotation.x = -Math.PI * 0.6 * Math.sin(k * Math.PI); // R_Hip kick
        bones[21].rotation.x = 0.3; // R_Knee
        bones[7].rotation.x = -0.9; // L_Shoulder
        bones[12].rotation.x = -0.6; // R_Shoulder
        bones[2].rotation.y = -0.4 * Math.sin(k * Math.PI);
      } else {
        bones[20].rotation.x = 0;
        bones[7].rotation.x = -0.4;
        bones[12].rotation.x = -0.4;
      }
    } else {
      // Idle Breathing
      const breath = Math.sin(currentTimelineTime * 2.2) * 0.02;
      bones[0].position.y = breath * 0.4;
      bones[2].rotation.x = breath * 0.6;
    }

    // Gestures: Waving
    if (isWaving) {
      bones[12].rotation.x = -2.3; // R_Shoulder
      bones[12].rotation.z = -0.35;
      bones[13].rotation.z = -0.7 + Math.sin(currentTimelineTime * 8.5) * 0.5; // R_Elbow
    } else if (isTalking) {
      bones[7].rotation.x = -0.8 + Math.sin(currentTimelineTime * 3.5) * 0.25;
      bones[12].rotation.x = -0.8 + Math.cos(currentTimelineTime * 3.5) * 0.25;
    }

    // Head Scanning & Gaze
    if (isLooking) {
      bones[5].rotation.y = Math.sin(currentTimelineTime * 1.6) * 0.6; // Head
      bones[5].rotation.x = Math.sin(currentTimelineTime * 0.8) * 0.12;
    } else {
      bones[5].rotation.y = Math.sin(currentTimelineTime * 0.8) * 0.08;
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
        <TrajectoryPath trajectory={trajectory} color={jointColor} />
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
          {/* Rigged Skinned Mesh Primitive */}
          {isRigReady && skinnedMeshRef.current && (
            <primitive object={skinnedMeshRef.current} />
          )}

          {/* SOMA Glowing Optical Visor Attached to Head */}
          <group position={[0, 1.60, 0.08]}>
            <mesh position={[0, 0, 0.04]}>
              <boxGeometry args={[0.16, 0.04, 0.03]} />
              <meshStandardMaterial
                color={jointColor}
                emissive={jointColor}
                emissiveIntensity={1.8}
                roughness={0.1}
              />
            </mesh>
          </group>
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
                {actor.name} (SOMA Rigged)
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
