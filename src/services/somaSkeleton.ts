import * as THREE from 'three';

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
