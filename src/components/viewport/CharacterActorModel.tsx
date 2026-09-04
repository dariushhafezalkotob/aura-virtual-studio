import React, { useRef, useMemo, useEffect } from 'react';
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

// 3D Spline Path Visualizer for Character Motion Trajectory
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
      {/* Glowing Spline Line on Floor */}
      <primitive object={new THREE.Line(lineGeometry, new THREE.LineBasicMaterial({ color: color || '#00ffcc', linewidth: 3 }))} />

      {/* Start Waypoint Marker */}
      <mesh position={[startPt[0], startPt[1] + 0.03, startPt[2]]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.2, 0.26, 24]} />
        <meshBasicMaterial color={color || '#00ffcc'} side={THREE.DoubleSide} />
      </mesh>

      {/* End Destination Marker */}
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

  // Joint references for procedural kinematics
  const spineRef = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Group>(null);
  const leftArmRef = useRef<THREE.Group>(null);
  const rightArmRef = useRef<THREE.Group>(null);
  const leftForeArmRef = useRef<THREE.Group>(null);
  const rightForeArmRef = useRef<THREE.Group>(null);
  const leftLegRef = useRef<THREE.Group>(null);
  const rightLegRef = useRef<THREE.Group>(null);
  const leftKneeRef = useRef<THREE.Group>(null);
  const rightKneeRef = useRef<THREE.Group>(null);

  const { position, rotation, scale = [1, 1, 1], trajectory = [], duration = 4.0, color = '#00ffcc' } = actor;

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

  // Real-time Kinematic Animation Engine in Three.js Render Loop
  useFrame(() => {
    const tTotal = Math.max(0.1, duration);
    const progress = (currentTimelineTime % tTotal) / tTotal;
    const animName = (actor.currentAnimation || actor.motionPrompt || '').toLowerCase();

    // 1. Root Position along Trajectory Path
    if (bodyGroupRef.current && trajectoryCurve && trajectory.length >= 2) {
      const posOnCurve = trajectoryCurve.getPointAt(progress);
      const tangent = trajectoryCurve.getTangentAt(progress).normalize();

      // Relative to actor root position
      bodyGroupRef.current.position.set(
        posOnCurve.x - position[0],
        posOnCurve.y - position[1],
        posOnCurve.z - position[2]
      );

      // Rotate body to face travel direction
      if (tangent.lengthSq() > 0.001) {
        const targetAngle = Math.atan2(-tangent.x, -tangent.z);
        bodyGroupRef.current.rotation.y = targetAngle - rotation[1];
      }
    } else if (bodyGroupRef.current) {
      bodyGroupRef.current.position.set(0, 0, 0);
      bodyGroupRef.current.rotation.set(0, 0, 0);
    }

    // 2. Kinematic Limb Movement based on Prompt/Animation State
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

    // A. Locomotion Cycle (Walking / Running)
    if (isWalking) {
      const legSwing = Math.sin(stridePhase) * 0.65;
      const armSwing = Math.sin(stridePhase) * 0.55;
      const hipBob = Math.abs(Math.sin(stridePhase * 2)) * 0.04;

      if (leftLegRef.current) leftLegRef.current.rotation.x = legSwing;
      if (rightLegRef.current) rightLegRef.current.rotation.x = -legSwing;

      if (leftKneeRef.current) leftKneeRef.current.rotation.x = Math.max(0, -legSwing * 0.9);
      if (rightKneeRef.current) rightKneeRef.current.rotation.x = Math.max(0, legSwing * 0.9);

      if (leftArmRef.current) leftArmRef.current.rotation.x = -armSwing;
      if (rightArmRef.current && !isWaving) rightArmRef.current.rotation.x = armSwing;

      if (spineRef.current) {
        spineRef.current.position.y = hipBob;
        spineRef.current.rotation.y = Math.sin(stridePhase) * 0.08;
      }
    } else if (isDancing) {
      // B. Dance Movement
      const beat = currentTimelineTime * 5.0;
      if (spineRef.current) {
        spineRef.current.rotation.z = Math.sin(beat) * 0.15;
        spineRef.current.rotation.y = Math.cos(beat * 0.5) * 0.2;
        spineRef.current.position.y = Math.abs(Math.sin(beat)) * 0.05;
      }
      if (leftArmRef.current) leftArmRef.current.rotation.z = 0.5 + Math.sin(beat) * 0.4;
      if (rightArmRef.current) rightArmRef.current.rotation.z = -0.5 - Math.cos(beat) * 0.4;
      if (leftLegRef.current) leftLegRef.current.rotation.x = Math.sin(beat) * 0.2;
      if (rightLegRef.current) rightLegRef.current.rotation.x = -Math.sin(beat) * 0.2;
    } else if (isMartial) {
      // C. Martial Arts Combat Strike
      const phase = (currentTimelineTime % 3.0) / 3.0;
      if (phase < 0.4) {
        const k = phase / 0.4;
        if (rightLegRef.current) rightLegRef.current.rotation.x = -Math.PI * 0.55 * Math.sin(k * Math.PI);
        if (rightKneeRef.current) rightKneeRef.current.rotation.x = 0.2;
        if (leftArmRef.current) leftArmRef.current.rotation.x = -0.8;
        if (rightArmRef.current) rightArmRef.current.rotation.x = -0.5;
        if (spineRef.current) spineRef.current.rotation.y = -0.3 * Math.sin(k * Math.PI);
      } else {
        if (rightLegRef.current) rightLegRef.current.rotation.x = 0;
        if (leftArmRef.current) leftArmRef.current.rotation.x = -0.4;
        if (rightArmRef.current) rightArmRef.current.rotation.x = -0.4;
      }
    } else {
      // D. Idle Natural Breathing & Micro Shifts
      const breath = Math.sin(currentTimelineTime * 2.2) * 0.02;
      if (spineRef.current) {
        spineRef.current.position.y = breath;
        spineRef.current.rotation.x = breath * 0.5;
        spineRef.current.rotation.y = 0;
      }
      if (leftLegRef.current) leftLegRef.current.rotation.x = 0;
      if (rightLegRef.current) rightLegRef.current.rotation.x = 0;
      if (leftKneeRef.current) leftKneeRef.current.rotation.x = 0;
      if (rightKneeRef.current) rightKneeRef.current.rotation.x = 0;
      if (leftArmRef.current) leftArmRef.current.rotation.x = 0;
      if (rightArmRef.current && !isWaving) rightArmRef.current.rotation.x = 0;
    }

    // Hand Gestures: Wave
    if (isWaving && rightArmRef.current && rightForeArmRef.current) {
      rightArmRef.current.rotation.x = -2.2;
      rightArmRef.current.rotation.z = -0.3;
      rightForeArmRef.current.rotation.z = -0.6 + Math.sin(currentTimelineTime * 8.0) * 0.45;
    } else if (isTalking && leftArmRef.current && rightArmRef.current) {
      leftArmRef.current.rotation.x = -0.8 + Math.sin(currentTimelineTime * 3.5) * 0.2;
      rightArmRef.current.rotation.x = -0.8 + Math.cos(currentTimelineTime * 3.5) * 0.2;
    }

    // Head Gaze & Look Around
    if (headRef.current) {
      if (isLooking) {
        headRef.current.rotation.y = Math.sin(currentTimelineTime * 1.6) * 0.55;
        headRef.current.rotation.x = Math.sin(currentTimelineTime * 0.8) * 0.1;
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
  const suitColor = isRobot ? '#f2f2f7' : '#1e2124';
  const accentColor = color || (isRobot ? '#ff9500' : '#00ffcc');

  return (
    <>
      {/* 3D Motion Trajectory Spline Visualization */}
      {showTrajectory && trajectory.length >= 2 && (
        <TrajectoryPath trajectory={trajectory} color={accentColor} />
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
        {/* Animated Body Hierarchy */}
        <group ref={bodyGroupRef}>
          {/* Hips / Pelvis */}
          <group position={[0, 0.95, 0]}>
            <mesh castShadow receiveShadow>
              <boxGeometry args={[0.28, 0.18, 0.2]} />
              <meshStandardMaterial color={suitColor} roughness={0.3} metalness={0.6} />
            </mesh>

            {/* Spine & Torso */}
            <group ref={spineRef} position={[0, 0.12, 0]}>
              {/* Lower Spine Joint */}
              <mesh position={[0, 0.08, 0]} castShadow>
                <cylinderGeometry args={[0.07, 0.08, 0.12, 16]} />
                <meshStandardMaterial color="#3a3d40" roughness={0.4} metalness={0.8} />
              </mesh>

              {/* Chest Armor / Torso */}
              <mesh position={[0, 0.24, 0]} castShadow receiveShadow>
                <boxGeometry args={[0.34, 0.28, 0.22]} />
                <meshStandardMaterial color={suitColor} roughness={0.25} metalness={0.7} />
              </mesh>

              {/* Chest Reactor / Accent Line */}
              <mesh position={[0, 0.25, 0.115]}>
                <boxGeometry args={[0.1, 0.04, 0.01]} />
                <meshBasicMaterial color={accentColor} />
              </mesh>

              {/* Neck */}
              <mesh position={[0, 0.42, 0]} castShadow>
                <cylinderGeometry args={[0.05, 0.05, 0.08, 16]} />
                <meshStandardMaterial color="#2a2d30" roughness={0.5} metalness={0.8} />
              </mesh>

              {/* Head & Visor */}
              <group ref={headRef} position={[0, 0.52, 0]}>
                <mesh castShadow receiveShadow>
                  <sphereGeometry args={[0.13, 24, 24]} />
                  <meshStandardMaterial color={suitColor} roughness={0.2} metalness={0.7} />
                </mesh>
                {/* Glowing Kimodo / SOMA Visor */}
                <mesh position={[0, 0.02, 0.11]}>
                  <boxGeometry args={[0.18, 0.06, 0.04]} />
                  <meshStandardMaterial
                    color={accentColor}
                    emissive={accentColor}
                    emissiveIntensity={1.8}
                    roughness={0.1}
                  />
                </mesh>
              </group>

              {/* Left Arm Chain */}
              <group ref={leftArmRef} position={[-0.22, 0.32, 0]}>
                <mesh castShadow>
                  <sphereGeometry args={[0.06, 16, 16]} />
                  <meshStandardMaterial color="#3a3d40" roughness={0.3} metalness={0.8} />
                </mesh>
                <mesh position={[0, -0.14, 0]} castShadow>
                  <cylinderGeometry args={[0.045, 0.04, 0.22, 16]} />
                  <meshStandardMaterial color={suitColor} roughness={0.3} metalness={0.5} />
                </mesh>
                {/* Left Forearm */}
                <group ref={leftForeArmRef} position={[0, -0.26, 0]}>
                  <mesh castShadow>
                    <sphereGeometry args={[0.045, 16, 16]} />
                    <meshStandardMaterial color="#3a3d40" roughness={0.3} metalness={0.8} />
                  </mesh>
                  <mesh position={[0, -0.12, 0]} castShadow>
                    <cylinderGeometry args={[0.04, 0.035, 0.2, 16]} />
                    <meshStandardMaterial color={suitColor} roughness={0.3} metalness={0.5} />
                  </mesh>
                  {/* Left Hand */}
                  <mesh position={[0, -0.24, 0]} castShadow>
                    <boxGeometry args={[0.04, 0.06, 0.03]} />
                    <meshStandardMaterial color="#2a2d30" roughness={0.4} metalness={0.8} />
                  </mesh>
                </group>
              </group>

              {/* Right Arm Chain */}
              <group ref={rightArmRef} position={[0.22, 0.32, 0]}>
                <mesh castShadow>
                  <sphereGeometry args={[0.06, 16, 16]} />
                  <meshStandardMaterial color="#3a3d40" roughness={0.3} metalness={0.8} />
                </mesh>
                <mesh position={[0, -0.14, 0]} castShadow>
                  <cylinderGeometry args={[0.045, 0.04, 0.22, 16]} />
                  <meshStandardMaterial color={suitColor} roughness={0.3} metalness={0.5} />
                </mesh>
                {/* Right Forearm */}
                <group ref={rightForeArmRef} position={[0, -0.26, 0]}>
                  <mesh castShadow>
                    <sphereGeometry args={[0.045, 16, 16]} />
                    <meshStandardMaterial color="#3a3d40" roughness={0.3} metalness={0.8} />
                  </mesh>
                  <mesh position={[0, -0.12, 0]} castShadow>
                    <cylinderGeometry args={[0.04, 0.035, 0.2, 16]} />
                    <meshStandardMaterial color={suitColor} roughness={0.3} metalness={0.5} />
                  </mesh>
                  {/* Right Hand */}
                  <mesh position={[0, -0.24, 0]} castShadow>
                    <boxGeometry args={[0.04, 0.06, 0.03]} />
                    <meshStandardMaterial color="#2a2d30" roughness={0.4} metalness={0.8} />
                  </mesh>
                </group>
              </group>
            </group>

            {/* Left Leg Chain */}
            <group ref={leftLegRef} position={[-0.1, -0.1, 0]}>
              <mesh castShadow>
                <sphereGeometry args={[0.065, 16, 16]} />
                <meshStandardMaterial color="#3a3d40" roughness={0.3} metalness={0.8} />
              </mesh>
              <mesh position={[0, -0.2, 0]} castShadow>
                <cylinderGeometry args={[0.055, 0.045, 0.36, 16]} />
                <meshStandardMaterial color={suitColor} roughness={0.3} metalness={0.5} />
              </mesh>
              {/* Left Knee & Shin */}
              <group ref={leftKneeRef} position={[0, -0.4, 0]}>
                <mesh castShadow>
                  <sphereGeometry args={[0.05, 16, 16]} />
                  <meshStandardMaterial color="#3a3d40" roughness={0.3} metalness={0.8} />
                </mesh>
                <mesh position={[0, -0.2, 0]} castShadow>
                  <cylinderGeometry args={[0.045, 0.04, 0.36, 16]} />
                  <meshStandardMaterial color={suitColor} roughness={0.3} metalness={0.5} />
                </mesh>
                {/* Left Foot */}
                <mesh position={[0, -0.41, 0.06]} castShadow receiveShadow>
                  <boxGeometry args={[0.09, 0.06, 0.2]} />
                  <meshStandardMaterial color="#1a1d20" roughness={0.5} metalness={0.8} />
                </mesh>
              </group>
            </group>

            {/* Right Leg Chain */}
            <group ref={rightLegRef} position={[0.1, -0.1, 0]}>
              <mesh castShadow>
                <sphereGeometry args={[0.065, 16, 16]} />
                <meshStandardMaterial color="#3a3d40" roughness={0.3} metalness={0.8} />
              </mesh>
              <mesh position={[0, -0.2, 0]} castShadow>
                <cylinderGeometry args={[0.055, 0.045, 0.36, 16]} />
                <meshStandardMaterial color={suitColor} roughness={0.3} metalness={0.5} />
              </mesh>
              {/* Right Knee & Shin */}
              <group ref={rightKneeRef} position={[0, -0.4, 0]}>
                <mesh castShadow>
                  <sphereGeometry args={[0.05, 16, 16]} />
                  <meshStandardMaterial color="#3a3d40" roughness={0.3} metalness={0.8} />
                </mesh>
                <mesh position={[0, -0.2, 0]} castShadow>
                  <cylinderGeometry args={[0.045, 0.04, 0.36, 16]} />
                  <meshStandardMaterial color={suitColor} roughness={0.3} metalness={0.5} />
                </mesh>
                {/* Right Foot */}
                <mesh position={[0, -0.41, 0.06]} castShadow receiveShadow>
                  <boxGeometry args={[0.09, 0.06, 0.2]} />
                  <meshStandardMaterial color="#1a1d20" roughness={0.5} metalness={0.8} />
                </mesh>
              </group>
            </group>
          </group>
        </group>

        {/* Selection Ring & Name Tag */}
        {isSelected && (
          <group position={[0, 0.02, 0]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.6, 0.68, 32]} />
              <meshBasicMaterial color={accentColor} side={THREE.DoubleSide} />
            </mesh>
            <Html position={[0, 2.0, 0]} center distanceFactor={8}>
              <div className="bg-surface-container/95 border border-primary/50 text-primary px-sm py-[2px] rounded font-label-caps text-[10px] tracking-wider whitespace-nowrap shadow-xl">
                {actor.name}
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
