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
  radius: number;
  isEndEffector?: boolean;
}

const SOMA_JOINTS: Record<string, SOMAJointDef> = {
  pelvis: { name: 'Pelvis / Root', radius: 0.048, isEndEffector: false },
  spine1: { name: 'Spine (Lumbar)', radius: 0.038 },
  spine2: { name: 'Spine (Thoracic)', radius: 0.038 },
  spine3: { name: 'Spine (Chest)', radius: 0.042 },
  neck: { name: 'Neck', radius: 0.032 },
  head: { name: 'Head (Cranial)', radius: 0.055, isEndEffector: true },
  
  leftCollar: { name: 'L Clavicle', radius: 0.028 },
  leftShoulder: { name: 'L Shoulder', radius: 0.038 },
  leftElbow: { name: 'L Elbow', radius: 0.032 },
  leftWrist: { name: 'L Wrist', radius: 0.026 },
  leftHand: { name: 'L Hand', radius: 0.024, isEndEffector: true },
  
  rightCollar: { name: 'R Clavicle', radius: 0.028 },
  rightShoulder: { name: 'R Shoulder', radius: 0.038 },
  rightElbow: { name: 'R Elbow', radius: 0.032 },
  rightWrist: { name: 'R Wrist', radius: 0.026 },
  rightHand: { name: 'R Hand', radius: 0.024, isEndEffector: true },
  
  leftHip: { name: 'L Hip Joint', radius: 0.042 },
  leftKnee: { name: 'L Knee', radius: 0.036 },
  leftAnkle: { name: 'L Ankle', radius: 0.03 },
  leftToe: { name: 'L Foot / Toe', radius: 0.026, isEndEffector: true },
  
  rightHip: { name: 'R Hip Joint', radius: 0.042 },
  rightKnee: { name: 'R Knee', radius: 0.036 },
  rightAnkle: { name: 'R Ankle', radius: 0.03 },
  rightToe: { name: 'R Foot / Toe', radius: 0.026, isEndEffector: true },
};

// Anatomical Tapered Bone Link Segment Component
const SOMABoneLink: React.FC<{
  start: THREE.Vector3;
  end: THREE.Vector3;
  rTop?: number;
  rBottom?: number;
  color?: string;
}> = ({ start, end, rTop = 0.022, rBottom = 0.016, color = '#383c42' }) => {
  const meshRef = useRef<THREE.Mesh>(null);

  const { position, quaternion, length } = useMemo(() => {
    const dir = new THREE.Vector3().subVectors(end, start);
    const len = dir.length();
    const pos = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    const quat = new THREE.Quaternion();
    
    if (len > 0.0001) {
      const normDir = dir.clone().normalize();
      const up = new THREE.Vector3(0, 1, 0);
      quat.setFromUnitVectors(up, normDir);
    }
    return { position: pos, quaternion: quat, length: len };
  }, [start.x, start.y, start.z, end.x, end.y, end.z]);

  if (length < 0.001) return null;

  return (
    <mesh ref={meshRef} position={position} quaternion={quaternion} castShadow>
      <cylinderGeometry args={[rTop, rBottom, length, 12]} />
      <meshStandardMaterial
        color={color}
        roughness={0.35}
        metalness={0.7}
        envMapIntensity={0.8}
      />
    </mesh>
  );
};

// ---------------------------------------------------------------------------
// Official NVIDIA SOMA SMPL-X Single-Piece Continuous Human Body Mesh Loader
// ---------------------------------------------------------------------------
const SOMAExactSMPLHumanMesh: React.FC<{
  color: string;
  isHybrid: boolean;
}> = ({ color, isHybrid }) => {
  const [meshObj, setMeshObj] = useState<THREE.Group | null>(null);

  useEffect(() => {
    let isMounted = true;
    const loader = new OBJLoader();

    loader.load(
      '/models/soma_smplx_body.obj',
      (obj) => {
        if (!isMounted) return;
        obj.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const m = child as THREE.Mesh;
            m.geometry.computeVertexNormals();
            m.castShadow = true;
            m.receiveShadow = true;
            m.material = new THREE.MeshStandardMaterial({
              color: color || '#2c3036',
              roughness: 0.35,
              metalness: 0.45,
              transparent: isHybrid,
              opacity: isHybrid ? 0.45 : 1.0,
              side: THREE.DoubleSide,
            });
          }
        });

        // Center mesh and place feet accurately on the floor
        obj.position.set(0, 1.30, 0);
        setMeshObj(obj);
      },
      undefined,
      (err) => {
        console.warn('Failed to load official SOMA SMPL-X mesh:', err);
      }
    );

    return () => {
      isMounted = false;
    };
  }, [color, isHybrid]);

  if (!meshObj) return null;

  return (
    <primitive object={meshObj.clone()} />
  );
};

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

  // SOMA Hierarchical Joint Rig Node Refs
  const pelvisRef = useRef<THREE.Group>(null);
  const spine1Ref = useRef<THREE.Group>(null);
  const spine2Ref = useRef<THREE.Group>(null);
  const spine3Ref = useRef<THREE.Group>(null);
  const neckRef = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Group>(null);

  const leftShoulderRef = useRef<THREE.Group>(null);
  const leftElbowRef = useRef<THREE.Group>(null);
  const leftWristRef = useRef<THREE.Group>(null);
  const leftHandRef = useRef<THREE.Group>(null);

  const rightShoulderRef = useRef<THREE.Group>(null);
  const rightElbowRef = useRef<THREE.Group>(null);
  const rightWristRef = useRef<THREE.Group>(null);
  const rightHandRef = useRef<THREE.Group>(null);

  const leftHipRef = useRef<THREE.Group>(null);
  const leftKneeRef = useRef<THREE.Group>(null);
  const leftAnkleRef = useRef<THREE.Group>(null);
  const leftToeRef = useRef<THREE.Group>(null);

  const rightHipRef = useRef<THREE.Group>(null);
  const rightKneeRef = useRef<THREE.Group>(null);
  const rightAnkleRef = useRef<THREE.Group>(null);
  const rightToeRef = useRef<THREE.Group>(null);

  const {
    position,
    rotation,
    scale = [1, 1, 1],
    trajectory = [],
    duration = 4.0,
    color = '#00ffcc',
    renderMode = 'mesh', // 'mesh' | 'skeleton' | 'hybrid'
  } = actor;

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

  // Real-time SOMA Kinematic Animation Engine
  useFrame(() => {
    const tTotal = Math.max(0.1, duration);
    const progress = (currentTimelineTime % tTotal) / tTotal;
    const animName = (actor.currentAnimation || actor.motionPrompt || '').toLowerCase();

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

    // 2. Kinematic Joint Calculations for SOMA Skeleton
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

    // A. Locomotion / Leg Kinematics
    if (isWalking) {
      const legSwing = Math.sin(stridePhase) * 0.7;
      const hipBob = Math.abs(Math.sin(stridePhase * 2)) * 0.045;

      if (leftHipRef.current) leftHipRef.current.rotation.x = legSwing;
      if (rightHipRef.current) rightHipRef.current.rotation.x = -legSwing;

      if (leftKneeRef.current) leftKneeRef.current.rotation.x = Math.max(0, -legSwing * 1.1);
      if (rightKneeRef.current) rightKneeRef.current.rotation.x = Math.max(0, legSwing * 1.1);

      if (leftAnkleRef.current) leftAnkleRef.current.rotation.x = -legSwing * 0.4;
      if (rightAnkleRef.current) rightAnkleRef.current.rotation.x = legSwing * 0.4;

      if (leftShoulderRef.current) leftShoulderRef.current.rotation.x = -legSwing * 0.8;
      if (rightShoulderRef.current && !isWaving) rightShoulderRef.current.rotation.x = legSwing * 0.8;

      if (leftElbowRef.current) leftElbowRef.current.rotation.x = Math.max(0.1, -legSwing * 0.4);
      if (rightElbowRef.current && !isWaving) rightElbowRef.current.rotation.x = Math.max(0.1, legSwing * 0.4);

      if (pelvisRef.current) {
        pelvisRef.current.position.y = hipBob;
        pelvisRef.current.rotation.y = Math.sin(stridePhase) * 0.08;
      }
      if (spine1Ref.current) spine1Ref.current.rotation.y = -Math.sin(stridePhase) * 0.05;
      if (spine3Ref.current) spine3Ref.current.rotation.y = -Math.sin(stridePhase) * 0.05;
    } else if (isDancing) {
      const beat = currentTimelineTime * 5.0;
      if (pelvisRef.current) {
        pelvisRef.current.position.y = Math.abs(Math.sin(beat)) * 0.05;
        pelvisRef.current.rotation.z = Math.sin(beat) * 0.18;
      }
      if (spine2Ref.current) spine2Ref.current.rotation.y = Math.cos(beat * 0.5) * 0.25;
      if (leftShoulderRef.current) {
        leftShoulderRef.current.rotation.z = 0.6 + Math.sin(beat) * 0.4;
        leftShoulderRef.current.rotation.x = Math.cos(beat) * 0.3;
      }
      if (rightShoulderRef.current) {
        rightShoulderRef.current.rotation.z = -0.6 - Math.cos(beat) * 0.4;
        rightShoulderRef.current.rotation.x = -Math.sin(beat) * 0.3;
      }
      if (leftHipRef.current) leftHipRef.current.rotation.x = Math.sin(beat) * 0.3;
      if (rightHipRef.current) rightHipRef.current.rotation.x = -Math.sin(beat) * 0.3;
    } else if (isMartial) {
      const phase = (currentTimelineTime % 3.0) / 3.0;
      if (phase < 0.4) {
        const k = phase / 0.4;
        if (rightHipRef.current) rightHipRef.current.rotation.x = -Math.PI * 0.6 * Math.sin(k * Math.PI);
        if (rightKneeRef.current) rightKneeRef.current.rotation.x = 0.3;
        if (leftShoulderRef.current) leftShoulderRef.current.rotation.x = -0.9;
        if (rightShoulderRef.current) rightShoulderRef.current.rotation.x = -0.6;
        if (spine2Ref.current) spine2Ref.current.rotation.y = -0.4 * Math.sin(k * Math.PI);
      } else {
        if (rightHipRef.current) rightHipRef.current.rotation.x = 0;
        if (leftShoulderRef.current) leftShoulderRef.current.rotation.x = -0.4;
        if (rightShoulderRef.current) rightShoulderRef.current.rotation.x = -0.4;
      }
    } else {
      const breath = Math.sin(currentTimelineTime * 2.2) * 0.02;
      if (pelvisRef.current) pelvisRef.current.position.y = breath * 0.4;
      if (spine2Ref.current) {
        spine2Ref.current.rotation.x = breath * 0.6;
        spine2Ref.current.position.z = breath * 0.02;
      }
      if (leftHipRef.current) leftHipRef.current.rotation.x = 0;
      if (rightHipRef.current) rightHipRef.current.rotation.x = 0;
      if (leftKneeRef.current) leftKneeRef.current.rotation.x = 0;
      if (rightKneeRef.current) rightKneeRef.current.rotation.x = 0;
      if (leftShoulderRef.current) leftShoulderRef.current.rotation.x = 0;
      if (rightShoulderRef.current && !isWaving) rightShoulderRef.current.rotation.x = 0;
    }

    // Hand & Arm Gestures
    if (isWaving && rightShoulderRef.current && rightElbowRef.current) {
      rightShoulderRef.current.rotation.x = -2.3;
      rightShoulderRef.current.rotation.z = -0.35;
      rightElbowRef.current.rotation.z = -0.7 + Math.sin(currentTimelineTime * 8.5) * 0.5;
    } else if (isTalking && leftShoulderRef.current && rightShoulderRef.current) {
      leftShoulderRef.current.rotation.x = -0.8 + Math.sin(currentTimelineTime * 3.5) * 0.25;
      rightShoulderRef.current.rotation.x = -0.8 + Math.cos(currentTimelineTime * 3.5) * 0.25;
    }

    // Head Gaze & Scanning
    if (headRef.current) {
      if (isLooking) {
        headRef.current.rotation.y = Math.sin(currentTimelineTime * 1.6) * 0.6;
        headRef.current.rotation.x = Math.sin(currentTimelineTime * 0.8) * 0.12;
      } else {
        headRef.current.rotation.y = Math.sin(currentTimelineTime * 0.8) * 0.08;
        headRef.current.rotation.x = 0;
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
  const boneColor = isRobot ? '#8e9297' : '#22252a';
  const skinColor = isRobot ? '#e5e5ea' : '#32363d';
  const endEffectorColor = '#ff3b30';

  const showMesh = renderMode === 'mesh' || renderMode === 'hybrid';
  const showSkeleton = renderMode === 'skeleton' || renderMode === 'hybrid';
  const isHybrid = renderMode === 'hybrid';

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
        {/* Animated SOMA Multi-Body Kinematic Skeleton & Single-Piece Mesh */}
        <group ref={bodyGroupRef}>
          {/* ========================================================= */}
          {/* OFFICIAL SOMA SMPL-X SINGLE CONTINUOUS HUMAN BODY MESH    */}
          {/* ========================================================= */}
          {showMesh && (
            <SOMAExactSMPLHumanMesh color={skinColor} isHybrid={isHybrid} />
          )}

          {/* ========================================================= */}
          {/* SOMA 24-JOINT BIOMECHANICAL SKELETON RIG & END-EFFECTORS  */}
          {/* ========================================================= */}
          {showSkeleton && (
            <group position={[0, 0.95, 0]} ref={pelvisRef}>
              {/* Pelvis Joint Node */}
              <mesh castShadow>
                <sphereGeometry args={[SOMA_JOINTS.pelvis.radius, 16, 16]} />
                <meshStandardMaterial color={jointColor} roughness={0.2} metalness={0.8} />
              </mesh>

              {/* Sacrum Bone */}
              <mesh position={[0, -0.02, 0]}>
                <boxGeometry args={[0.22, 0.08, 0.12]} />
                <meshStandardMaterial color={boneColor} roughness={0.3} metalness={0.7} />
              </mesh>

              {/* Spine 1 (Lumbar) */}
              <group ref={spine1Ref} position={[0, 0.12, -0.01]}>
                <mesh castShadow>
                  <sphereGeometry args={[SOMA_JOINTS.spine1.radius, 14, 14]} />
                  <meshStandardMaterial color={jointColor} roughness={0.2} metalness={0.8} />
                </mesh>
                <SOMABoneLink start={new THREE.Vector3(0, -0.12, 0.01)} end={new THREE.Vector3(0, 0, 0)} rTop={0.026} rBottom={0.03} color={boneColor} />

                {/* Spine 2 (Thoracic) */}
                <group ref={spine2Ref} position={[0, 0.14, 0.01]}>
                  <mesh castShadow>
                    <sphereGeometry args={[SOMA_JOINTS.spine2.radius, 14, 14]} />
                    <meshStandardMaterial color={jointColor} roughness={0.2} metalness={0.8} />
                  </mesh>
                  <SOMABoneLink start={new THREE.Vector3(0, -0.14, -0.01)} end={new THREE.Vector3(0, 0, 0)} rTop={0.028} rBottom={0.026} color={boneColor} />

                  {/* Spine 3 (Chest / Upper Thorax) */}
                  <group ref={spine3Ref} position={[0, 0.14, 0.02]}>
                    <mesh castShadow>
                      <sphereGeometry args={[SOMA_JOINTS.spine3.radius, 16, 16]} />
                      <meshStandardMaterial color={jointColor} roughness={0.2} metalness={0.8} />
                    </mesh>
                    <SOMABoneLink start={new THREE.Vector3(0, -0.14, -0.01)} end={new THREE.Vector3(0, 0, 0)} rTop={0.034} rBottom={0.028} color={boneColor} />

                    {/* Neck Joint */}
                    <group ref={neckRef} position={[0, 0.12, -0.01]}>
                      <mesh castShadow>
                        <sphereGeometry args={[SOMA_JOINTS.neck.radius, 14, 14]} />
                        <meshStandardMaterial color={jointColor} roughness={0.2} metalness={0.8} />
                      </mesh>
                      <SOMABoneLink start={new THREE.Vector3(0, -0.12, 0.01)} end={new THREE.Vector3(0, 0, 0)} rTop={0.02} rBottom={0.025} color={boneColor} />

                      {/* Head / Cranial Joint (End-Effector) */}
                      <group ref={headRef} position={[0, 0.14, 0.03]}>
                        <mesh castShadow>
                          <sphereGeometry args={[SOMA_JOINTS.head.radius, 20, 20]} />
                          <meshStandardMaterial color={boneColor} roughness={0.25} metalness={0.7} />
                        </mesh>
                        <SOMABoneLink start={new THREE.Vector3(0, -0.14, -0.03)} end={new THREE.Vector3(0, 0, 0)} rTop={0.024} rBottom={0.02} color={boneColor} />

                        {/* Head Gaze Visor */}
                        <mesh position={[0, 0.01, 0.06]}>
                          <boxGeometry args={[0.09, 0.03, 0.03]} />
                          <meshStandardMaterial color={jointColor} emissive={jointColor} emissiveIntensity={1.5} />
                        </mesh>
                      </group>
                    </group>

                    {/* Left Clavicle & Shoulder Chain */}
                    <group position={[-0.08, 0.02, -0.01]}>
                      <mesh castShadow>
                        <sphereGeometry args={[SOMA_JOINTS.leftCollar.radius, 12, 12]} />
                        <meshStandardMaterial color={jointColor} roughness={0.2} metalness={0.8} />
                      </mesh>
                      <SOMABoneLink start={new THREE.Vector3(0.08, -0.02, 0.01)} end={new THREE.Vector3(0, 0, 0)} rTop={0.018} rBottom={0.024} color={boneColor} />

                      <group ref={leftShoulderRef} position={[-0.12, -0.02, 0]}>
                        <mesh castShadow>
                          <sphereGeometry args={[SOMA_JOINTS.leftShoulder.radius, 14, 14]} />
                          <meshStandardMaterial color={jointColor} roughness={0.2} metalness={0.8} />
                        </mesh>
                        <SOMABoneLink start={new THREE.Vector3(0.12, 0.02, 0)} end={new THREE.Vector3(0, 0, 0)} rTop={0.022} rBottom={0.018} color={boneColor} />
                        <SOMABoneLink start={new THREE.Vector3(0, 0, 0)} end={new THREE.Vector3(0, -0.26, 0)} rTop={0.024} rBottom={0.018} color={boneColor} />

                        {/* Left Elbow */}
                        <group ref={leftElbowRef} position={[0, -0.26, 0]}>
                          <mesh castShadow>
                            <sphereGeometry args={[SOMA_JOINTS.leftElbow.radius, 12, 12]} />
                            <meshStandardMaterial color={jointColor} roughness={0.2} metalness={0.8} />
                          </mesh>
                          <SOMABoneLink start={new THREE.Vector3(0, 0, 0)} end={new THREE.Vector3(0, -0.24, 0)} rTop={0.02} rBottom={0.016} color={boneColor} />

                          {/* Left Wrist */}
                          <group ref={leftWristRef} position={[0, -0.24, 0]}>
                            <mesh castShadow>
                              <sphereGeometry args={[SOMA_JOINTS.leftWrist.radius, 10, 10]} />
                              <meshStandardMaterial color={jointColor} roughness={0.2} metalness={0.8} />
                            </mesh>

                            {/* Left Hand End-Effector */}
                            <group ref={leftHandRef} position={[0, -0.08, 0]}>
                              <mesh castShadow>
                                <sphereGeometry args={[SOMA_JOINTS.leftHand.radius, 10, 10]} />
                                <meshStandardMaterial color={endEffectorColor} emissive={endEffectorColor} emissiveIntensity={0.6} />
                              </mesh>
                            </group>
                          </group>
                        </group>
                      </group>
                    </group>

                    {/* Right Clavicle & Shoulder Chain */}
                    <group position={[0.08, 0.02, -0.01]}>
                      <mesh castShadow>
                        <sphereGeometry args={[SOMA_JOINTS.rightCollar.radius, 12, 12]} />
                        <meshStandardMaterial color={jointColor} roughness={0.2} metalness={0.8} />
                      </mesh>
                      <SOMABoneLink start={new THREE.Vector3(-0.08, -0.02, 0.01)} end={new THREE.Vector3(0, 0, 0)} rTop={0.018} rBottom={0.024} color={boneColor} />

                      <group ref={rightShoulderRef} position={[0.12, -0.02, 0]}>
                        <mesh castShadow>
                          <sphereGeometry args={[SOMA_JOINTS.rightShoulder.radius, 14, 14]} />
                          <meshStandardMaterial color={jointColor} roughness={0.2} metalness={0.8} />
                        </mesh>
                        <SOMABoneLink start={new THREE.Vector3(-0.12, 0.02, 0)} end={new THREE.Vector3(0, 0, 0)} rTop={0.022} rBottom={0.018} color={boneColor} />
                        <SOMABoneLink start={new THREE.Vector3(0, 0, 0)} end={new THREE.Vector3(0, -0.26, 0)} rTop={0.024} rBottom={0.018} color={boneColor} />

                        {/* Right Elbow */}
                        <group ref={rightElbowRef} position={[0, -0.26, 0]}>
                          <mesh castShadow>
                            <sphereGeometry args={[SOMA_JOINTS.rightElbow.radius, 12, 12]} />
                            <meshStandardMaterial color={jointColor} roughness={0.2} metalness={0.8} />
                          </mesh>
                          <SOMABoneLink start={new THREE.Vector3(0, 0, 0)} end={new THREE.Vector3(0, -0.24, 0)} rTop={0.02} rBottom={0.016} color={boneColor} />

                          {/* Right Wrist */}
                          <group ref={rightWristRef} position={[0, -0.24, 0]}>
                            <mesh castShadow>
                              <sphereGeometry args={[SOMA_JOINTS.rightWrist.radius, 10, 10]} />
                              <meshStandardMaterial color={jointColor} roughness={0.2} metalness={0.8} />
                            </mesh>

                            {/* Right Hand End-Effector */}
                            <group ref={rightHandRef} position={[0, -0.08, 0]}>
                              <mesh castShadow>
                                <sphereGeometry args={[SOMA_JOINTS.rightHand.radius, 10, 10]} />
                                <meshStandardMaterial color={endEffectorColor} emissive={endEffectorColor} emissiveIntensity={0.6} />
                              </mesh>
                            </group>
                          </group>
                        </group>
                      </group>
                    </group>
                  </group>
                </group>
              </group>

              {/* Left Hip & Leg Chain */}
              <group position={[-0.1, -0.05, 0]}>
                <group ref={leftHipRef}>
                  <mesh castShadow>
                    <sphereGeometry args={[SOMA_JOINTS.leftHip.radius, 16, 16]} />
                    <meshStandardMaterial color={jointColor} roughness={0.2} metalness={0.8} />
                  </mesh>
                  <SOMABoneLink start={new THREE.Vector3(0.1, 0.05, 0)} end={new THREE.Vector3(0, 0, 0)} rTop={0.028} rBottom={0.032} color={boneColor} />
                  <SOMABoneLink start={new THREE.Vector3(0, 0, 0)} end={new THREE.Vector3(0, -0.42, 0)} rTop={0.034} rBottom={0.026} color={boneColor} />

                  {/* Left Knee */}
                  <group ref={leftKneeRef} position={[0, -0.42, 0]}>
                    <mesh castShadow>
                      <sphereGeometry args={[SOMA_JOINTS.leftKnee.radius, 14, 14]} />
                      <meshStandardMaterial color={jointColor} roughness={0.2} metalness={0.8} />
                    </mesh>
                    <SOMABoneLink start={new THREE.Vector3(0, 0, 0)} end={new THREE.Vector3(0, -0.38, 0)} rTop={0.028} rBottom={0.022} color={boneColor} />

                    {/* Left Ankle */}
                    <group ref={leftAnkleRef} position={[0, -0.38, 0]}>
                      <mesh castShadow>
                        <sphereGeometry args={[SOMA_JOINTS.leftAnkle.radius, 12, 12]} />
                        <meshStandardMaterial color={jointColor} roughness={0.2} metalness={0.8} />
                      </mesh>

                      {/* Left Toe End-Effector */}
                      <group ref={leftToeRef} position={[0, -0.06, 0.1]}>
                        <mesh castShadow>
                          <sphereGeometry args={[SOMA_JOINTS.leftToe.radius, 10, 10]} />
                          <meshStandardMaterial color={endEffectorColor} emissive={endEffectorColor} emissiveIntensity={0.6} />
                        </mesh>
                        <mesh position={[0, 0.01, -0.04]} castShadow receiveShadow>
                          <boxGeometry args={[0.08, 0.035, 0.16]} />
                          <meshStandardMaterial color={boneColor} roughness={0.4} metalness={0.7} />
                        </mesh>
                        <SOMABoneLink start={new THREE.Vector3(0, 0.06, -0.1)} end={new THREE.Vector3(0, 0, 0)} rTop={0.02} rBottom={0.016} color={boneColor} />
                      </group>
                    </group>
                  </group>
                </group>
              </group>

              {/* Right Hip & Leg Chain */}
              <group position={[0.1, -0.05, 0]}>
                <group ref={rightHipRef}>
                  <mesh castShadow>
                    <sphereGeometry args={[SOMA_JOINTS.rightHip.radius, 16, 16]} />
                    <meshStandardMaterial color={jointColor} roughness={0.2} metalness={0.8} />
                  </mesh>
                  <SOMABoneLink start={new THREE.Vector3(-0.1, 0.05, 0)} end={new THREE.Vector3(0, 0, 0)} rTop={0.028} rBottom={0.032} color={boneColor} />
                  <SOMABoneLink start={new THREE.Vector3(0, 0, 0)} end={new THREE.Vector3(0, -0.42, 0)} rTop={0.034} rBottom={0.026} color={boneColor} />

                  {/* Right Knee */}
                  <group ref={rightKneeRef} position={[0, -0.42, 0]}>
                    <mesh castShadow>
                      <sphereGeometry args={[SOMA_JOINTS.rightKnee.radius, 14, 14]} />
                      <meshStandardMaterial color={jointColor} roughness={0.2} metalness={0.8} />
                    </mesh>
                    <SOMABoneLink start={new THREE.Vector3(0, 0, 0)} end={new THREE.Vector3(0, -0.38, 0)} rTop={0.028} rBottom={0.022} color={boneColor} />

                    {/* Right Ankle */}
                    <group ref={rightAnkleRef} position={[0, -0.38, 0]}>
                      <mesh castShadow>
                        <sphereGeometry args={[SOMA_JOINTS.rightAnkle.radius, 12, 12]} />
                        <meshStandardMaterial color={jointColor} roughness={0.2} metalness={0.8} />
                      </mesh>

                      {/* Right Toe End-Effector */}
                      <group ref={rightToeRef} position={[0, -0.06, 0.1]}>
                        <mesh castShadow>
                          <sphereGeometry args={[SOMA_JOINTS.rightToe.radius, 10, 10]} />
                          <meshStandardMaterial color={endEffectorColor} emissive={endEffectorColor} emissiveIntensity={0.6} />
                        </mesh>
                        <mesh position={[0, 0.01, -0.04]} castShadow receiveShadow>
                          <boxGeometry args={[0.08, 0.035, 0.16]} />
                          <meshStandardMaterial color={boneColor} roughness={0.4} metalness={0.7} />
                        </mesh>
                        <SOMABoneLink start={new THREE.Vector3(0, 0.06, -0.1)} end={new THREE.Vector3(0, 0, 0)} rTop={0.02} rBottom={0.016} color={boneColor} />
                      </group>
                    </group>
                  </group>
                </group>
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
            <Html position={[0, 1.95, 0]} center distanceFactor={8}>
              <div className="bg-surface-container/95 border border-primary/50 text-primary px-sm py-[2px] rounded font-label-caps text-[10px] tracking-wider whitespace-nowrap shadow-xl">
                {actor.name} ({renderMode.toUpperCase()})
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
