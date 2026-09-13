import * as THREE from 'three';

export interface TwoBoneIKChain {
  rootBone: THREE.Bone;   // e.g. Shoulder / Hip
  midBone: THREE.Bone;    // e.g. Elbow / Knee
  endBone: THREE.Bone;    // e.g. Hand / Foot
  poleTarget?: THREE.Vector3; // Direction hint for bend (e.g. knee forward, elbow back)
}

/**
 * Analytical Two-Bone IK Solver (Law of Cosines)
 * Solves root and mid bone rotations so that endBone reaches targetPosition.
 */
export function solveTwoBoneIK(
  rootBone: THREE.Bone,
  midBone: THREE.Bone,
  endBone: THREE.Bone,
  targetPosWorld: THREE.Vector3,
  poleTargetWorld?: THREE.Vector3
): boolean {
  if (!rootBone || !midBone || !endBone) return false;

  // Global world positions
  const rootPos = new THREE.Vector3();
  const midPos = new THREE.Vector3();
  const endPos = new THREE.Vector3();

  rootBone.getWorldPosition(rootPos);
  midBone.getWorldPosition(midPos);
  endBone.getWorldPosition(endPos);

  const l1 = rootPos.distanceTo(midPos);
  const l2 = midPos.distanceTo(endPos);
  if (l1 <= 0.0001 || l2 <= 0.0001) return false;

  // Vector from root to target
  const rootToTarget = new THREE.Vector3().subVectors(targetPosWorld, rootPos);
  let dist = rootToTarget.length();
  const maxReach = (l1 + l2) * 0.999;
  const minReach = Math.max(0.01, Math.abs(l1 - l2) * 1.05);

  if (dist > maxReach) {
    dist = maxReach;
    rootToTarget.setLength(maxReach);
  } else if (dist < minReach) {
    dist = minReach;
    rootToTarget.setLength(minReach);
  }

  // Law of Cosines for interior angles
  const cosAlpha = THREE.MathUtils.clamp(
    (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist),
    -1.0,
    1.0
  );
  const alpha = Math.acos(cosAlpha);


  // Compute bend plane normal using pole target
  const pole = poleTargetWorld
    ? poleTargetWorld.clone()
    : new THREE.Vector3(rootPos.x, rootPos.y - 1, rootPos.z + 1);
  const rootToPole = new THREE.Vector3().subVectors(pole, rootPos);

  let planeNormal = new THREE.Vector3().crossVectors(rootToTarget, rootToPole).normalize();
  if (planeNormal.lengthSq() < 0.0001) {
    planeNormal.set(0, 0, 1);
  }

  // Direction from root to mid bone in world space
  const rootToTargetDir = rootToTarget.clone().normalize();
  const midDir = rootToTargetDir.clone().applyAxisAngle(planeNormal, alpha).normalize();
  const solvedMidPos = rootPos.clone().addScaledVector(midDir, l1);

  // Orient root bone towards solvedMidPos
  orientBoneWorld(rootBone, solvedMidPos);

  // Orient mid bone towards targetPosWorld
  orientBoneWorld(midBone, targetPosWorld);

  return true;
}

/**
 * Rotates a bone so its local bone axis points toward targetWorld in world coordinates
 */
function orientBoneWorld(bone: THREE.Bone, targetWorld: THREE.Vector3) {
  const currentWorldPos = new THREE.Vector3();
  bone.getWorldPosition(currentWorldPos);

  const desiredWorldDir = new THREE.Vector3().subVectors(targetWorld, currentWorldPos).normalize();
  if (desiredWorldDir.lengthSq() < 0.0001) return;

  const parent = bone.parent;
  if (parent) {
    const parentWorldQuat = new THREE.Quaternion();
    parent.getWorldQuaternion(parentWorldQuat);
    const invParentQuat = parentWorldQuat.clone().invert();

    // Local target direction
    const desiredLocalDir = desiredWorldDir.clone().applyQuaternion(invParentQuat).normalize();

    // Default bone rest direction (along positive local Y)
    const defaultDir = new THREE.Vector3(0, 1, 0);
    const rot = new THREE.Quaternion().setFromUnitVectors(defaultDir, desiredLocalDir);
    bone.quaternion.slerp(rot, 0.85);
  }
}

/**
 * Analytical Look-At IK Solver for Head / Neck
 */
export function solveLookAtIK(
  headBone: THREE.Bone,
  neckBone: THREE.Bone | null,
  targetPosWorld: THREE.Vector3,
  weight: number = 1.0,
  maxPitchDeg: number = 60,
  maxYawDeg: number = 80
) {
  if (!headBone || weight <= 0) return;

  const headWorldPos = new THREE.Vector3();
  headBone.getWorldPosition(headWorldPos);

  const lookDirWorld = new THREE.Vector3().subVectors(targetPosWorld, headWorldPos).normalize();
  if (lookDirWorld.lengthSq() < 0.0001) return;

  const parent = headBone.parent;
  if (!parent) return;

  const parentWorldQuat = new THREE.Quaternion();
  parent.getWorldQuaternion(parentWorldQuat);
  const invParent = parentWorldQuat.clone().invert();

  const lookDirLocal = lookDirWorld.clone().applyQuaternion(invParent).normalize();

  // Clamp yaw and pitch
  const yaw = THREE.MathUtils.clamp(
    Math.atan2(lookDirLocal.x, lookDirLocal.z),
    -THREE.MathUtils.degToRad(maxYawDeg),
    THREE.MathUtils.degToRad(maxYawDeg)
  );
  const pitch = THREE.MathUtils.clamp(
    Math.asin(THREE.MathUtils.clamp(-lookDirLocal.y, -1, 1)),
    -THREE.MathUtils.degToRad(maxPitchDeg),
    THREE.MathUtils.degToRad(maxPitchDeg)
  );

  const targetEuler = new THREE.Euler(pitch, yaw, 0, 'YXZ');
  const targetQuat = new THREE.Quaternion().setFromEuler(targetEuler);

  // Split look-at weight between neck and head if neck exists
  if (neckBone) {
    const halfQuat = new THREE.Quaternion().slerp(targetQuat, 0.45 * weight);
    neckBone.quaternion.slerp(halfQuat, 0.3);
    headBone.quaternion.slerp(halfQuat, 0.55 * weight);
  } else {
    headBone.quaternion.slerp(targetQuat, weight);
  }
}
