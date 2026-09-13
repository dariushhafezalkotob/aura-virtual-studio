import * as THREE from 'three';

export interface TwoBoneIKChain {
  rootBone: THREE.Bone;   // Upper arm / thigh
  midBone: THREE.Bone;    // Forearm / shin
  endBone: THREE.Bone;    // Hand / foot
  poleTarget?: THREE.Vector3; // Direction hint for bend (elbow back, knee forward)
}

const _bonePos = new THREE.Vector3();
const _childPos = new THREE.Vector3();
const _curDir = new THREE.Vector3();
const _desDir = new THREE.Vector3();
const _delta = new THREE.Quaternion();
const _boneWorldQuat = new THREE.Quaternion();
const _parentWorldQuat = new THREE.Quaternion();

/**
 * Rotates `bone` so that `childBone` (a descendant whose world position moves
 * with `bone`) is aimed at `targetWorld`.
 *
 * This measures the bone's *actual* current aim direction rather than assuming
 * the bone points down local +Y. Assuming a fixed local axis throws away the
 * rest orientation baked into the skeleton and is what makes limbs snap to
 * arbitrary angles and rotate along the wrong axis.
 */
function aimBoneAt(bone: THREE.Bone, childBone: THREE.Object3D, targetWorld: THREE.Vector3): void {
  bone.updateWorldMatrix(true, true);

  bone.getWorldPosition(_bonePos);
  childBone.getWorldPosition(_childPos);

  _curDir.subVectors(_childPos, _bonePos);
  _desDir.subVectors(targetWorld, _bonePos);
  if (_curDir.lengthSq() < 1e-10 || _desDir.lengthSq() < 1e-10) return;
  _curDir.normalize();
  _desDir.normalize();

  // World-space delta rotation, applied on the left of the bone's world
  // orientation so the bone's existing twist is preserved.
  _delta.setFromUnitVectors(_curDir, _desDir);
  bone.getWorldQuaternion(_boneWorldQuat);
  _boneWorldQuat.premultiply(_delta);

  if (bone.parent) {
    bone.parent.getWorldQuaternion(_parentWorldQuat);
    bone.quaternion.copy(_parentWorldQuat.invert().multiply(_boneWorldQuat));
  } else {
    bone.quaternion.copy(_boneWorldQuat);
  }

  bone.updateWorldMatrix(false, true);
}

const _rootPos = new THREE.Vector3();
const _midPos = new THREE.Vector3();
const _endPos = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _poleVec = new THREE.Vector3();
const _bendDir = new THREE.Vector3();
const _currentBend = new THREE.Vector3();
const _midDir = new THREE.Vector3();
const _solvedMid = new THREE.Vector3();

/**
 * Analytical two-bone IK (law of cosines).
 *
 * Solves `rootBone` and `midBone` so `endBone` reaches `targetPosWorld`, with
 * the joint between them bending toward `poleTargetWorld`.
 */
export function solveTwoBoneIK(
  rootBone: THREE.Bone,
  midBone: THREE.Bone,
  endBone: THREE.Bone,
  targetPosWorld: THREE.Vector3,
  poleTargetWorld?: THREE.Vector3
): boolean {
  if (!rootBone || !midBone || !endBone) return false;

  // World matrices must reflect whatever the animation pass just wrote,
  // otherwise every measurement below is one frame stale.
  rootBone.updateWorldMatrix(true, true);

  rootBone.getWorldPosition(_rootPos);
  midBone.getWorldPosition(_midPos);
  endBone.getWorldPosition(_endPos);

  const l1 = _rootPos.distanceTo(_midPos);
  const l2 = _midPos.distanceTo(_endPos);
  if (l1 <= 1e-4 || l2 <= 1e-4) return false;

  _toTarget.subVectors(targetPosWorld, _rootPos);
  let dist = _toTarget.length();
  const maxReach = (l1 + l2) * 0.999;
  const minReach = Math.max(1e-3, Math.abs(l1 - l2) * 1.02);

  if (dist < 1e-5) {
    // Target sits on the root; nothing meaningful to aim at.
    return false;
  }
  if (dist > maxReach) {
    dist = maxReach;
    _toTarget.setLength(maxReach);
  } else if (dist < minReach) {
    dist = minReach;
    _toTarget.setLength(minReach);
  }

  const toTargetDir = _toTarget.clone().normalize();

  // Interior angle at the root between root->target and root->mid.
  const cosAlpha = THREE.MathUtils.clamp(
    (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist),
    -1,
    1
  );
  const alpha = Math.acos(cosAlpha);

  // Bend direction: the component of the pole vector perpendicular to the
  // root->target axis. Building the mid direction from an explicit orthonormal
  // basis (instead of rotating about a cross product) keeps the hinge on the
  // pole side regardless of how the limb is oriented.
  let haveBend = false;
  if (poleTargetWorld) {
    _poleVec.subVectors(poleTargetWorld, _rootPos);
    _bendDir.copy(_poleVec).addScaledVector(toTargetDir, -_poleVec.dot(toTargetDir));
    if (_bendDir.lengthSq() > 1e-8) {
      _bendDir.normalize();
      haveBend = true;
    }
  }

  if (!haveBend) {
    // Fall back to the limb's existing bend so the solve stays continuous
    // rather than popping to an arbitrary plane.
    _currentBend.subVectors(_midPos, _rootPos);
    _bendDir.copy(_currentBend).addScaledVector(toTargetDir, -_currentBend.dot(toTargetDir));
    if (_bendDir.lengthSq() > 1e-8) {
      _bendDir.normalize();
      haveBend = true;
    }
  }

  if (!haveBend) {
    // Perfectly straight limb with no hint: pick any stable perpendicular.
    _bendDir.set(0, 0, 1).addScaledVector(toTargetDir, -toTargetDir.z);
    if (_bendDir.lengthSq() < 1e-8) _bendDir.set(0, 1, 0).addScaledVector(toTargetDir, -toTargetDir.y);
    _bendDir.normalize();
  }

  _midDir
    .copy(toTargetDir)
    .multiplyScalar(Math.cos(alpha))
    .addScaledVector(_bendDir, Math.sin(alpha))
    .normalize();

  _solvedMid.copy(_rootPos).addScaledVector(_midDir, l1);

  // Aim the upper bone at the solved hinge position, then the middle bone at
  // the goal. aimBoneAt refreshes world matrices between the two steps, so the
  // second solve sees the hinge where the first solve actually put it.
  aimBoneAt(rootBone, midBone, _solvedMid);
  aimBoneAt(midBone, endBone, targetPosWorld);

  return true;
}

const _headPos = new THREE.Vector3();
const _curGaze = new THREE.Vector3();
const _desGaze = new THREE.Vector3();
const _lookDelta = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _headWorldQuat = new THREE.Quaternion();
const _neckParentQuat = new THREE.Quaternion();

const _WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Shortest rotation from `from` to `to`, except when they are nearly opposite:
 * THREE picks an arbitrary perpendicular axis there, which made a head asked to
 * look straight backwards tip over vertically instead of turning sideways.
 */
function gazeDelta(out: THREE.Quaternion, from: THREE.Vector3, to: THREE.Vector3): THREE.Quaternion {
  if (from.dot(to) > -0.9995) return out.setFromUnitVectors(from, to);

  _axis.copy(_WORLD_UP).addScaledVector(from, -_WORLD_UP.dot(from));
  if (_axis.lengthSq() < 1e-6) {
    // Gaze is already vertical; any perpendicular will do.
    _axis.set(1, 0, 0).addScaledVector(from, -from.x);
  }
  return out.setFromAxisAngle(_axis.normalize(), Math.PI);
}

/** Clamps a rotation to at most `maxRad` about its own axis. */
function clampRotation(q: THREE.Quaternion, maxRad: number): THREE.Quaternion {
  const w = THREE.MathUtils.clamp(Math.abs(q.w), -1, 1);
  const angle = 2 * Math.acos(w);
  if (angle <= maxRad || angle < 1e-6) return q;

  const s = Math.sqrt(Math.max(1e-12, 1 - w * w));
  const sign = q.w < 0 ? -1 : 1;
  _axis.set((q.x * sign) / s, (q.y * sign) / s, (q.z * sign) / s).normalize();
  return q.setFromAxisAngle(_axis, maxRad);
}

/**
 * Look-at IK for the head, optionally sharing the rotation with the neck.
 *
 * `gazeAxisLocal` is the head-local axis that points along the character's gaze
 * in the rest pose (see SOMARigCache.headGazeAxisLocal). Deriving the current
 * gaze from the bone's live world orientation means the head turns relative to
 * wherever the spine currently is, instead of snapping to a world-axis euler.
 */
export function solveLookAtIK(
  headBone: THREE.Bone,
  neckBone: THREE.Bone | null,
  targetPosWorld: THREE.Vector3,
  gazeAxisLocal: THREE.Vector3,
  weight: number = 1.0,
  maxAngleDeg: number = 70
): void {
  if (!headBone || weight <= 0) return;

  headBone.updateWorldMatrix(true, true);
  headBone.getWorldPosition(_headPos);

  _desGaze.subVectors(targetPosWorld, _headPos);
  if (_desGaze.lengthSq() < 1e-8) return;
  _desGaze.normalize();

  const maxRad = THREE.MathUtils.degToRad(maxAngleDeg);
  const neckShare = neckBone ? 0.4 : 0;

  if (neckBone) {
    headBone.getWorldQuaternion(_headWorldQuat);
    _curGaze.copy(gazeAxisLocal).applyQuaternion(_headWorldQuat).normalize();

    gazeDelta(_lookDelta, _curGaze, _desGaze);
    clampRotation(_lookDelta, maxRad * neckShare);
    _lookDelta.slerp(new THREE.Quaternion(), 1 - weight * neckShare);

    neckBone.getWorldQuaternion(_headWorldQuat);
    _headWorldQuat.premultiply(_lookDelta);
    if (neckBone.parent) {
      neckBone.parent.getWorldQuaternion(_neckParentQuat);
      neckBone.quaternion.copy(_neckParentQuat.invert().multiply(_headWorldQuat));
    } else {
      neckBone.quaternion.copy(_headWorldQuat);
    }
    neckBone.updateWorldMatrix(false, true);
  }

  // Remaining correction goes to the head itself.
  headBone.getWorldQuaternion(_headWorldQuat);
  _curGaze.copy(gazeAxisLocal).applyQuaternion(_headWorldQuat).normalize();

  gazeDelta(_lookDelta, _curGaze, _desGaze);
  clampRotation(_lookDelta, maxRad);
  if (weight < 1) _lookDelta.slerp(new THREE.Quaternion(), 1 - weight);

  _headWorldQuat.premultiply(_lookDelta);
  if (headBone.parent) {
    headBone.parent.getWorldQuaternion(_neckParentQuat);
    headBone.quaternion.copy(_neckParentQuat.invert().multiply(_headWorldQuat));
  } else {
    headBone.quaternion.copy(_headWorldQuat);
  }
  headBone.updateWorldMatrix(false, true);
}
