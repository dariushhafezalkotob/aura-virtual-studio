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

  // Real-time Kinematic Animation Engine driving the SOMA 77-Bone Skeleton
  useFrame(() => {
    const bones = bonesRef.current;
    const restQuats = restQuatsRef.current;
    if (bones.length < 77 || restQuats.length < 77) return;

    // =========================================================================
    // 1. TRUE NVIDIA KIMODO NEURAL DIFFUSION MOTION PLAYBACK
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

      // A. Drive Root 3D Translation
      if (mData.root && mData.root.length > 0 && bodyGroupRef.current) {
        const r0 = mData.root[frame0] || [0, 0, 0];
        const r1 = mData.root[frame1] || r0;

        const rx = THREE.MathUtils.lerp(r0[0], r1[0], alpha);
        const ry = THREE.MathUtils.lerp(r0[1], r1[1], alpha);
        const rz = THREE.MathUtils.lerp(r0[2], r1[2], alpha);

        bodyGroupRef.current.position.set(rx, ry, rz);
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
      return;
    }

    // =========================================================================
    // 2. DEFAULT NEUTRAL REST POSE WITH SUBTLE IDLE BREATHING (PRE-GENERATION)
    // =========================================================================
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
