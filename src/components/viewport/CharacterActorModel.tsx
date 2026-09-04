import React, { useRef, useMemo, useEffect, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { TransformControls, Html } from '@react-three/drei';
import * as THREE from 'three';
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
          color: actor.characterType === 'g1' ? '#e5e5ea' : '#32363d',
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

  // Update material on renderMode / characterType change
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

  // Real-time Kinematic Animation Engine driving the SOMA 77-Bone Skeleton
  useFrame(() => {
    const tTotal = Math.max(0.1, duration);
    const progress = (currentTimelineTime % tTotal) / tTotal;
    const animName = (actor.currentAnimation || actor.motionPrompt || '').toLowerCase();
    const bones = bonesRef.current;
    const restQuats = restQuatsRef.current;

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

    if (bones.length < 77 || restQuats.length < 77) return;

    // SOMA Key Bone Indices:
    // 0: Hips, 1: Spine1, 2: Spine2, 3: Chest, 4: Neck1, 6: Head
    // 11: LeftShoulder, 12: LeftArm, 13: LeftForeArm, 14: LeftHand
    // 39: RightShoulder, 40: RightArm, 41: RightForeArm, 42: RightHand
    // 67: LeftLeg (Thigh), 68: LeftShin (Knee), 69: LeftFoot (Ankle), 70: LeftToeBase
    // 72: RightLeg (Thigh), 73: RightShin (Knee), 74: RightFoot (Ankle), 75: RightToeBase

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

    // Reset bones to rest pose
    for (let i = 0; i < bones.length; i++) {
      bones[i].quaternion.copy(restQuats[i]);
    }

    const qDelta = new THREE.Quaternion();

    // A. Locomotion / Walking Stride
    if (isWalking) {
      const legSwing = Math.sin(stridePhase) * 0.65;
      const hipBob = Math.abs(Math.sin(stridePhase * 2)) * 0.04;

      // LeftLeg / RightLeg Thighs
      qDelta.setFromAxisAngle(new THREE.Vector3(1, 0, 0), legSwing);
      bones[67].quaternion.multiply(qDelta);

      qDelta.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -legSwing);
      bones[72].quaternion.multiply(qDelta);

      // LeftShin / RightShin Knees
      qDelta.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.max(0, -legSwing * 1.0));
      bones[68].quaternion.multiply(qDelta);

      qDelta.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.max(0, legSwing * 1.0));
      bones[73].quaternion.multiply(qDelta);

      // LeftFoot / RightFoot Ankles
      qDelta.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -legSwing * 0.35);
      bones[69].quaternion.multiply(qDelta);

      qDelta.setFromAxisAngle(new THREE.Vector3(1, 0, 0), legSwing * 0.35);
      bones[74].quaternion.multiply(qDelta);

      // Arm Counter-Swings
      qDelta.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -legSwing * 0.7);
      bones[12].quaternion.multiply(qDelta);

      if (!isWaving) {
        qDelta.setFromAxisAngle(new THREE.Vector3(1, 0, 0), legSwing * 0.7);
        bones[40].quaternion.multiply(qDelta);
      }

      // Hips vertical bob and subtle spine twist
      bones[0].position.y = (cachedSOMARigData?.localTransforms[0].pos.y || 1.0) + hipBob;
      qDelta.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(stridePhase) * 0.08);
      bones[0].quaternion.multiply(qDelta);

      qDelta.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.sin(stridePhase) * 0.05);
      bones[3].quaternion.multiply(qDelta); // Chest
    } else if (isDancing) {
      const beat = currentTimelineTime * 5.0;
      qDelta.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.sin(beat) * 0.15);
      bones[0].quaternion.multiply(qDelta); // Hips sway

      qDelta.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.cos(beat * 0.5) * 0.2);
      bones[2].quaternion.multiply(qDelta); // Spine twist

      qDelta.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.5 + Math.sin(beat) * 0.35);
      bones[12].quaternion.multiply(qDelta); // LeftArm

      qDelta.setFromAxisAngle(new THREE.Vector3(0, 0, -1), 0.5 + Math.cos(beat) * 0.35);
      bones[40].quaternion.multiply(qDelta); // RightArm

      qDelta.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.sin(beat) * 0.25);
      bones[67].quaternion.multiply(qDelta);
      qDelta.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.sin(beat) * 0.25);
      bones[72].quaternion.multiply(qDelta);
    } else if (isMartial) {
      const phase = (currentTimelineTime % 3.0) / 3.0;
      if (phase < 0.4) {
        const k = phase / 0.4;
        qDelta.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI * 0.55 * Math.sin(k * Math.PI));
        bones[72].quaternion.multiply(qDelta); // Right Leg Kick

        qDelta.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.25);
        bones[73].quaternion.multiply(qDelta); // Knee bend

        qDelta.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.7);
        bones[12].quaternion.multiply(qDelta);
        bones[40].quaternion.multiply(qDelta);
      }
    } else {
      // Natural Idle Breathing
      const breath = Math.sin(currentTimelineTime * 2.2) * 0.02;
      qDelta.setFromAxisAngle(new THREE.Vector3(1, 0, 0), breath * 0.5);
      bones[3].quaternion.multiply(qDelta); // Chest breath
    }

    // Gestures: Waving with Right Arm
    if (isWaving) {
      qDelta.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -2.2);
      bones[40].quaternion.multiply(qDelta); // RightArm high

      qDelta.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.5 + Math.sin(currentTimelineTime * 8.5) * 0.4);
      bones[41].quaternion.multiply(qDelta); // RightForeArm wave
    } else if (isTalking) {
      qDelta.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.7 + Math.sin(currentTimelineTime * 3.5) * 0.2);
      bones[12].quaternion.multiply(qDelta);
      qDelta.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.7 + Math.cos(currentTimelineTime * 3.5) * 0.2);
      bones[40].quaternion.multiply(qDelta);
    }

    // Head Gaze & Look Around
    if (isLooking) {
      qDelta.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(currentTimelineTime * 1.6) * 0.55);
      bones[6].quaternion.multiply(qDelta);
      qDelta.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.sin(currentTimelineTime * 0.8) * 0.1);
      bones[6].quaternion.multiply(qDelta);
    } else {
      qDelta.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(currentTimelineTime * 0.8) * 0.08);
      bones[6].quaternion.multiply(qDelta);
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
          {/* Official SOMA Skinned Mesh Primitive */}
          {isRigReady && skinnedMeshRef.current && (
            <primitive object={skinnedMeshRef.current} />
          )}

          {/* SOMA Glowing Optical Visor Attached to Head */}
          <group position={[0, 1.62, 0.06]}>
            <mesh position={[0, 0, 0.04]}>
              <boxGeometry args={[0.15, 0.04, 0.03]} />
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
