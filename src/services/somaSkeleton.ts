import * as THREE from 'three';
import { POSE_EDIT_TIME_TOLERANCE } from '../types';

/**
 * Canonical bone indices for the official SOMA 77-bone skeleton
 * (public/models/soma_official_rigged.json).
 *
 * These MUST match joint_names in that file. Verified order:
 *   0 Hips .. 10 RightEye, 11-38 Left arm + fingers, 39-66 Right arm + fingers,
 *   67-71 Left leg, 72-76 Right leg.
 *
 * Note the rig's world axes: +X is the character's LEFT, +Z is FORWARD (toes
 * point toward +Z), +Y is up.
 */
export const SOMA = {
  hips: 0,
  spine1: 1,
  spine2: 2,
  chest: 3,
  neck1: 4,
  neck2: 5,
  head: 6,
  headEnd: 7,

  leftShoulder: 11,
  leftArm: 12,
  leftForeArm: 13,
  leftHand: 14,

  rightShoulder: 39,
  rightArm: 40,
  rightForeArm: 41,
  rightHand: 42,

  leftLeg: 67,
  leftShin: 68,
  leftFoot: 69,
  leftToeBase: 70,
  leftToeEnd: 71,

  rightLeg: 72,
  rightShin: 73,
  rightFoot: 74,
  rightToeBase: 75,
  rightToeEnd: 76,
} as const;

export const SOMA_BONE_COUNT = 77;

export type IkChainId = 'leftHand' | 'rightHand' | 'leftFoot' | 'rightFoot';

export interface IkChainDef {
  /** Upper bone (upper arm / thigh) — the chain root that gets aimed first. */
  root: number;
  /** Middle bone (forearm / shin) — the hinge. */
  mid: number;
  /** End bone (hand / foot) — what reaches the target. */
  end: number;
  /**
   * Where the hinge should point, expressed in the character's body space
   * (+X left, +Y up, +Z forward). Elbows point back, knees point forward.
   */
  poleDir: [number, number, number];
}

/**
 * Two-bone chains. The arm chain is upperArm -> foreArm -> hand (NOT
 * shoulder -> upperArm -> hand, which skips the elbow and makes the forearm
 * rigid), and the leg chain is thigh -> shin -> foot.
 */
export const IK_CHAINS: Record<IkChainId, IkChainDef> = {
  leftHand: { root: SOMA.leftArm, mid: SOMA.leftForeArm, end: SOMA.leftHand, poleDir: [0.4, -0.2, -1] },
  rightHand: { root: SOMA.rightArm, mid: SOMA.rightForeArm, end: SOMA.rightHand, poleDir: [-0.4, -0.2, -1] },
  leftFoot: { root: SOMA.leftLeg, mid: SOMA.leftShin, end: SOMA.leftFoot, poleDir: [0.15, 0, 1] },
  rightFoot: { root: SOMA.rightLeg, mid: SOMA.rightShin, end: SOMA.rightFoot, poleDir: [-0.15, 0, 1] },
};

export interface SOMARigCache {
  geometry: THREE.BufferGeometry;
  jointNames: string[];
  jointConnections: [number, number][];
  /** Bone-local rest transform, i.e. relative to the parent bone. */
  localTransforms: { pos: THREE.Vector3; quat: THREE.Quaternion; scl: THREE.Vector3 }[];
  /** Rest pose position of each joint in skeleton (character) space. */
  restWorldPositions: THREE.Vector3[];
  /** Rest pose orientation of each joint in skeleton (character) space. */
  restWorldQuats: THREE.Quaternion[];
  /**
   * Head-local axis that points along the character's gaze at rest. Needed so
   * look-at IK can rotate from the actual rest orientation instead of
   * assuming the head bone is axis-aligned.
   */
  headGazeAxisLocal: THREE.Vector3;
}

let cachedSOMARigData: SOMARigCache | null = null;
let rigLoadPromise: Promise<SOMARigCache> | null = null;

/** Synchronous accessor — returns null until loadOfficialSOMARig() has resolved. */
export function getCachedSomaRig(): SOMARigCache | null {
  return cachedSOMARigData;
}

export async function loadOfficialSOMARig(): Promise<SOMARigCache> {
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

      const worldMats: THREE.Matrix4[] = data.joint_transforms.map((t: number[][]) => {
        const m = new THREE.Matrix4();
        m.set(
          t[0][0], t[0][1], t[0][2], t[0][3],
          t[1][0], t[1][1], t[1][2], t[1][3],
          t[2][0], t[2][1], t[2][2], t[2][3],
          t[3][0], t[3][1], t[3][2], t[3][3]
        );
        return m;
      });

      const localTransforms: SOMARigCache['localTransforms'] = [];
      const restWorldPositions: THREE.Vector3[] = [];
      const restWorldQuats: THREE.Quaternion[] = [];

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

        const wPos = new THREE.Vector3();
        const wQuat = new THREE.Quaternion();
        const wScl = new THREE.Vector3();
        worldMats[i].decompose(wPos, wQuat, wScl);
        restWorldPositions.push(wPos);
        restWorldQuats.push(wQuat);
      }

      // The character faces +Z at rest, so the head's gaze axis in head-local
      // space is whatever maps to world +Z under the head's rest orientation.
      const headGazeAxisLocal = new THREE.Vector3(0, 0, 1)
        .applyQuaternion(restWorldQuats[SOMA.head].clone().invert())
        .normalize();

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
        restWorldPositions,
        restWorldQuats,
        headGazeAxisLocal,
      };
      return cachedSOMARigData;
    } catch (err) {
      rigLoadPromise = null;
      throw err;
    }
  })();

  return rigLoadPromise;
}

/**
 * Composes a rest-relative offset onto a bone's rest orientation, producing the
 * absolute local quaternion stored in `customBoneRotations`. Pose presets are
 * authored as offsets so identity means "rest pose" rather than "snap this bone
 * to axis-aligned", which would mangle the A-pose the rig ships in.
 */
export function composeRestOffset(
  boneIndex: number,
  offset: [number, number, number, number]
): [number, number, number, number] {
  const rig = getCachedSomaRig();
  const off = new THREE.Quaternion(offset[0], offset[1], offset[2], offset[3]).normalize();
  const rest = rig?.localTransforms[boneIndex]?.quat;
  const q = rest ? rest.clone().multiply(off) : off;
  return [q.x, q.y, q.z, q.w];
}

/**
 * Converts a quaternion [x, y, z, w] to an axis-angle (rotation vector), the
 * form Kimodo's constraint files use for `local_joints_rot`.
 *
 * atan2 rather than acos for numerical stability near identity, and the
 * hemisphere is normalised so the result is always the shortest rotation.
 */
export function quatToAxisAngle(q: [number, number, number, number]): [number, number, number] {
  let [x, y, z, w] = q;
  const n = Math.hypot(x, y, z, w);
  if (n < 1e-12) return [0, 0, 0];
  x /= n; y /= n; z /= n; w /= n;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }

  const s = Math.hypot(x, y, z);
  if (s < 1e-8) return [0, 0, 0];
  const k = (2 * Math.atan2(s, w)) / s;
  return [x * k, y * k, z * k];
}

/**
 * Expands a sparse `customBoneRotations`-style map into the dense per-joint
 * axis-angle array Kimodo expects, filling untouched joints with their rest
 * orientation.
 *
 * All 77 joints are emitted: kimodo's `_convert_constraint_local_rots_to_skeleton`
 * converts 77 -> 30 itself, so there is no need to remap here.
 */
export function buildFullBodyAxisAngle(
  boneRotations: Record<number, [number, number, number, number]> | undefined
): [number, number, number][] | null {
  const rig = getCachedSomaRig();
  if (!rig) return null;

  const out: [number, number, number][] = [];
  for (let i = 0; i < SOMA_BONE_COUNT; i++) {
    const posed = boneRotations?.[i];
    if (posed) {
      out.push(quatToAxisAngle(posed));
    } else {
      const r = rig.localTransforms[i].quat;
      out.push(quatToAxisAngle([r.x, r.y, r.z, r.w]));
    }
  }
  return out;
}

/** Rest-pose height of the hips, used as the default root Y for constraints. */
export function getRestHipHeight(): number {
  return getCachedSomaRig()?.restWorldPositions[SOMA.hips]?.y ?? 0.999;
}

/**
 * Resolves the full 77-joint pose an actor is showing at `timeSec`, composing
 * whatever the viewport is composing: generated motion, else keyframe blend,
 * else rest -- with any live pose edit laid on top.
 *
 * Keyframes must capture ALL joints, not just the ones the user touched.
 * buildFullBodyAxisAngle fills anything missing with the REST pose, so a key
 * holding only the two bones you rotated becomes a 'fullbody' constraint
 * meaning "these two here, everything else at rest", which tears the body out
 * of the generated motion. Snapshotting the composed pose is what lets you key
 * on top of a walk the way the reference demo does.
 */
export function sampleActorPose(
  actor: {
    motionData?: { rotations?: number[][][]; num_frames?: number; duration?: number } | null;
    keyframePoses?: { time: number; boneRotations?: Record<number, [number, number, number, number]> }[];
    customBoneRotations?: Record<number, [number, number, number, number]>;
    customPoseTime?: number;
    duration?: number;
  },
  timeSec: number
): Record<number, [number, number, number, number]> | null {
  const rig = getCachedSomaRig();
  if (!rig) return null;

  const out: Record<number, [number, number, number, number]> = {};
  const q = new THREE.Quaternion();
  const qb = new THREE.Quaternion();

  const md = actor.motionData;
  if (md && md.rotations && md.rotations.length > 0) {
    // Mirrors the viewport's playback sampling exactly.
    const tTotal = Math.max(0.1, md.duration || actor.duration || 4.0);
    const numFrames = md.num_frames || md.rotations.length;
    const progress = (timeSec % tTotal) / tTotal;
    const exactFrame = progress * (numFrames - 1);
    const f0 = Math.floor(exactFrame);
    const f1 = Math.min(numFrames - 1, f0 + 1);
    const alpha = exactFrame - f0;
    const r0 = md.rotations[f0];
    const r1 = md.rotations[f1] || r0;

    for (let b = 0; b < SOMA_BONE_COUNT; b++) {
      const a = r0?.[b];
      const c = r1?.[b] ?? a;
      if (a && c) {
        q.set(a[0], a[1], a[2], a[3]);
        qb.set(c[0], c[1], c[2], c[3]);
        q.slerp(qb, alpha);
      } else {
        q.copy(rig.localTransforms[b].quat);
      }
      out[b] = [q.x, q.y, q.z, q.w];
    }
  } else if (actor.keyframePoses && actor.keyframePoses.length > 0) {
    const kfs = [...actor.keyframePoses].sort((a, b) => a.time - b.time);
    let prev = kfs[0];
    let next = kfs[kfs.length - 1];
    for (const k of kfs) {
      if (k.time <= timeSec) prev = k;
      if (k.time >= timeSec) { next = k; break; }
    }
    const span = next.time - prev.time;
    const t = span > 0.001 ? Math.min(1, Math.max(0, (timeSec - prev.time) / span)) : 0;
    const ease = t * t * (3 - 2 * t);

    for (let b = 0; b < SOMA_BONE_COUNT; b++) {
      const a = prev.boneRotations?.[b];
      const c = next.boneRotations?.[b];
      if (a || c) {
        if (a) q.set(a[0], a[1], a[2], a[3]);
        else q.copy(rig.localTransforms[b].quat);
        if (c) qb.set(c[0], c[1], c[2], c[3]);
        else qb.copy(q);
        q.slerp(qb, ease);
      } else {
        q.copy(rig.localTransforms[b].quat);
      }
      out[b] = [q.x, q.y, q.z, q.w];
    }
  } else {
    for (let b = 0; b < SOMA_BONE_COUNT; b++) {
      const r = rig.localTransforms[b].quat;
      out[b] = [r.x, r.y, r.z, r.w];
    }
  }

  // Live pose edit wins where it applies.
  const editTime = actor.customPoseTime;
  const hasPoseTrack =
    !!(md && md.rotations && md.rotations.length > 0) ||
    !!(actor.keyframePoses && actor.keyframePoses.length > 0);
  const editApplies =
    !hasPoseTrack ||
    editTime === undefined ||
    Math.abs(timeSec - editTime) <= POSE_EDIT_TIME_TOLERANCE;

  if (actor.customBoneRotations && editApplies) {
    for (const [k, v] of Object.entries(actor.customBoneRotations)) {
      if (v) out[Number(k)] = v;
    }
  }

  return out;
}
