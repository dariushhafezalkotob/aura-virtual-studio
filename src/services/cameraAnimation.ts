import * as THREE from 'three';
import { CameraEase, CameraKeyframe, CameraKeyHandle, CameraTake } from '../types';

/**
 * Playing back a hand-keyed camera move.
 *
 * A recorded take carries hundreds of keys a few milliseconds apart, so walking straight between
 * them looks like whatever the operator did. A keyed take carries a handful, seconds apart, and
 * the same treatment gives a dolly that travels in a dead straight line at a constant speed and
 * stops dead - every corner a visible kink, every start and stop a jolt.
 *
 * So two things are separated here, because they are separate decisions in real camera work:
 *
 *   SHAPE   - the path through space, a Catmull-Rom spline through the keyed positions, with
 *             per-key tangent handles when the user has dragged them.
 *   TIMING  - how fast the move travels that path, an easing curve per key. A wide arc taken at
 *             a constant crawl and a straight line that eases out of a stop are both normal, and
 *             conflating the two is what makes hand-keyed cameras feel mechanical.
 *
 * Nothing here touches recorded takes: `sampleCameraTake` returns null for them and the existing
 * playback path handles them exactly as before.
 */

export interface SampledCamera {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number | null;
  roll: number | null;
  focusDistance: number | null;
  aperture: number | null;
}

/** Reused across frames: this runs inside useFrame and must not allocate. */
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _pPrev = new THREE.Vector3();
const _pNext = new THREE.Vector3();
const _m0 = new THREE.Vector3();
const _m1 = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();

export const DEFAULT_TENSION = 0.5;

// ---------------------------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------------------------

/** A cubic bezier y(x) solved by bisection - exact enough for a timing curve, and allocation free. */
function cubicBezierEase(x: number, x1: number, y1: number, x2: number, y2: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const curveX = (t: number) => {
    const u = 1 - t;
    return 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t;
  };
  const curveY = (t: number) => {
    const u = 1 - t;
    return 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t;
  };

  let lo = 0;
  let hi = 1;
  let t = x;
  // ~20 halvings puts t within a millionth, far below what a frame can show.
  for (let i = 0; i < 20; i++) {
    t = (lo + hi) / 2;
    if (curveX(t) < x) lo = t;
    else hi = t;
  }
  return curveY(t);
}

/** Maps linear progress through a segment to eased progress. */
export function applyEase(alpha: number, ease: CameraEase | undefined, handles?: [number, number, number, number]): number {
  const a = Math.max(0, Math.min(1, alpha));
  switch (ease) {
    case 'hold':
      // The move waits at this key and jumps at the next: for a cut, or a locked-off beat.
      return 0;
    case 'ease-in':
      return a * a;
    case 'ease-out':
      return 1 - (1 - a) * (1 - a);
    case 'ease-in-out':
      return a < 0.5 ? 2 * a * a : 1 - 2 * (1 - a) * (1 - a);
    case 'bezier': {
      const h = handles || [0.42, 0, 0.58, 1];
      return cubicBezierEase(a, h[0], h[1], h[2], h[3]);
    }
    case 'linear':
    default:
      return a;
  }
}

// ---------------------------------------------------------------------------------------------
// Per-key timing handles
// ---------------------------------------------------------------------------------------------
//
// The graph editor plots progress through the move against time, with every key at its own time
// fraction of the move, so a constant pace is a straight diagonal. In one segment's local 0..1
// box the average pace is therefore a slope of 1 for EVERY segment, which is what lets a handle be
// stored on its key alone (slope relative to that pace, influence as a fraction of the segment)
// and still mean the same thing whichever neighbour it reaches toward.
//
// Segment i -> i+1 is the cubic bezier (0,0), P1, P2, (1,1) with
//   P1 = (out.influence, out.influence * out.slope)          from key i's handleOut
//   P2 = (1 - in.influence, 1 - in.influence * in.slope)     from key i+1's handleIn

export const LINEAR_HANDLE: CameraKeyHandle = { slope: 1, influence: 1 / 3 };
export const EASY_EASE_HANDLE: CameraKeyHandle = { slope: 0, influence: 1 / 3 };

const MIN_INFLUENCE = 0.02;
export const MAX_HANDLE_SLOPE = 12;

/** Scratch for the segment being sampled: the playback path runs every frame and must not allocate. */
const _seg = { outSlope: 1, outInfluence: 1 / 3, inSlope: 1, inInfluence: 1 / 3 };

/**
 * The handles an older take's segment ease amounts to. Linear, ease-in and ease-out are exact
 * cubics; the old two-piece ease-in-out is not a single cubic, so it becomes the nearest one.
 */
function legacySegmentInto(target: typeof _seg, k0: CameraKeyframe) {
  const set = (oS: number, oI: number, iS: number, iI: number) => {
    target.outSlope = oS; target.outInfluence = oI; target.inSlope = iS; target.inInfluence = iI;
  };
  switch (k0.ease) {
    case 'ease-in': return set(0, 1 / 3, 2, 1 / 3);
    case 'ease-out': return set(2, 1 / 3, 0, 1 / 3);
    case 'ease-in-out': return set(0, 0.5, 0, 0.5);
    case 'bezier': {
      const h = k0.easeHandles || [0.42, 0, 0.58, 1];
      const oI = Math.max(MIN_INFLUENCE, h[0]);
      const iI = Math.max(MIN_INFLUENCE, 1 - h[2]);
      return set(h[1] / oI, oI, (1 - h[3]) / iI, iI);
    }
    default: return set(1, 1 / 3, 1, 1 / 3);
  }
}

/** True once either key of a segment carries per-key handles; older segments keep their own ease. */
function usesKeyHandles(k0: CameraKeyframe, k1: CameraKeyframe): boolean {
  return !!(k0.handleOut || k1.handleIn);
}

/**
 * Eased progress (0 at k0, 1 at k1; past either end when a handle overshoots) through the
 * segment k0 -> k1 at linear time fraction `alpha`. Playback and the graph editor both call
 * this, so the curve on screen is exactly the move the camera makes.
 */
export function segmentProgress(k0: CameraKeyframe, k1: CameraKeyframe, alpha: number): number {
  if (k0.ease === 'hold') return 0;
  if (!usesKeyHandles(k0, k1)) return applyEase(alpha, k0.ease, k0.easeHandles);
  // A key without its own handle on this side falls back to what the old segment ease meant.
  legacySegmentInto(_seg, k0);
  const out = k0.handleOut;
  const into = k1.handleIn;
  const oI = Math.max(MIN_INFLUENCE, Math.min(1, out ? out.influence : _seg.outInfluence));
  const oS = out ? out.slope : _seg.outSlope;
  const iI = Math.max(MIN_INFLUENCE, Math.min(1, into ? into.influence : _seg.inInfluence));
  const iS = into ? into.slope : _seg.inSlope;
  return cubicBezierEase(alpha, oI, oI * oS, 1 - iI, 1 - iI * iS);
}

/** The handles key `index` effectively has right now, whether stored on it or implied by an older ease. */
export function effectiveKeyHandles(keys: CameraKeyframe[], index: number): { handleIn: CameraKeyHandle; handleOut: CameraKeyHandle } {
  const k = keys[index];
  const scratch = { ..._seg };
  let handleIn = k.handleIn;
  if (!handleIn) {
    if (index > 0) { legacySegmentInto(scratch, keys[index - 1]); handleIn = { slope: scratch.inSlope, influence: scratch.inInfluence }; }
    else handleIn = { ...LINEAR_HANDLE };
  }
  let handleOut = k.handleOut;
  if (!handleOut) {
    legacySegmentInto(scratch, k);
    handleOut = { slope: scratch.outSlope, influence: scratch.outInfluence };
  }
  return { handleIn, handleOut };
}

/**
 * Converts a take to per-key handles without changing how it plays (bar the old ease-in-out,
 * which becomes its nearest cubic). Done once, on the first handle edit, so the curve does not
 * jump the moment the user grabs it. 'hold' survives; the old segment handles are dropped.
 */
export function withKeyHandles(keys: CameraKeyframe[]): CameraKeyframe[] {
  if (keys.every((k) => k.handleIn && k.handleOut)) return keys;
  return keys.map((k, i) => {
    const { handleIn, handleOut } = effectiveKeyHandles(keys, i);
    return { ...k, handleIn, handleOut, handleMode: k.handleMode, ease: k.ease === 'hold' ? 'hold' : undefined, easeHandles: undefined };
  });
}

// ---------------------------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------------------------

/**
 * One segment of a Catmull-Rom spline, in Hermite form so a user-dragged tangent can replace the
 * one the curve would have chosen. `tension` 0 collapses it to a straight line, which is how
 * "no curve please" is expressed.
 */
function hermite(
  out: THREE.Vector3,
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  m0: THREE.Vector3,
  m1: THREE.Vector3,
  t: number
) {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;

  out.copy(p0).multiplyScalar(h00);
  out.addScaledVector(m0, h10);
  out.addScaledVector(p1, h01);
  out.addScaledVector(m1, h11);
}

function keyPosition(target: THREE.Vector3, k: CameraKeyframe): THREE.Vector3 {
  return target.set(k.position[0], k.position[1], k.position[2]);
}

// ---------------------------------------------------------------------------------------------

/** Index of the last key at or before `time`. */
function bracketIndex(keys: CameraKeyframe[], time: number): number {
  let low = 0;
  let high = keys.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (keys[mid].time <= time) low = mid + 1;
    else high = mid - 1;
  }
  return Math.max(0, high);
}

function readKey(k: CameraKeyframe, out: SampledCamera) {
  keyPosition(out.position, k);
  out.quaternion.set(k.quaternion[0], k.quaternion[1], k.quaternion[2], k.quaternion[3]);
  out.fov = k.fov ?? null;
  out.roll = k.roll ?? null;
  out.focusDistance = k.focusDistance ?? null;
  out.aperture = k.aperture ?? null;
}

function lerpChannel(a: number | undefined, b: number | undefined, t: number): number | null {
  if (a === undefined && b === undefined) return null;
  if (a === undefined) return b!;
  if (b === undefined) return a;
  return a + (b - a) * t;
}

/**
 * Where the camera is at `time` on a hand-keyed take.
 *
 * Returns null for anything that is not a keyed take, so the caller can fall through to the
 * original recorded-take playback rather than this changing how existing footage plays.
 *
 * `out` is written in place and returned; pass the same object every frame.
 */
export function sampleCameraTake(
  take: CameraTake | null | undefined,
  time: number,
  out: SampledCamera
): SampledCamera | null {
  if (!take || take.mode !== 'keyed') return null;
  const keys = take.keyframes;
  if (!keys || keys.length === 0) return null;

  if (keys.length === 1 || time <= keys[0].time) {
    readKey(keys[0], out);
    return out;
  }
  const last = keys.length - 1;
  if (time >= keys[last].time) {
    readKey(keys[last], out);
    return out;
  }

  const i0 = bracketIndex(keys, time);
  const i1 = Math.min(last, i0 + 1);
  const k0 = keys[i0];
  const k1 = keys[i1];

  const span = k1.time - k0.time;
  const linear = span > 1e-6 ? (time - k0.time) / span : 0;
  const t = segmentProgress(k0, k1, linear);

  keyPosition(_p0, k0);
  keyPosition(_p1, k1);

  const tension = take.tension ?? DEFAULT_TENSION;

  if (tension <= 1e-6 && !k0.tangentOut && !k1.tangentIn) {
    // Straight line, which is a legitimate choice and worth not paying for a spline.
    out.position.copy(_p0).lerp(_p1, t);
  } else {
    // Catmull-Rom tangents from the neighbouring keys, so the path flows through this key rather
    // than cornering at it. The ends have no neighbour, so they borrow the segment itself.
    if (k0.tangentOut) {
      _m0.set(k0.tangentOut[0], k0.tangentOut[1], k0.tangentOut[2]);
    } else {
      keyPosition(_pPrev, keys[Math.max(0, i0 - 1)]);
      _m0.copy(_p1).sub(_pPrev).multiplyScalar(tension);
    }

    if (k1.tangentIn) {
      _m1.set(k1.tangentIn[0], k1.tangentIn[1], k1.tangentIn[2]);
    } else {
      keyPosition(_pNext, keys[Math.min(last, i1 + 1)]);
      _m1.copy(_pNext).sub(_p0).multiplyScalar(tension);
    }

    hermite(_tmp, _p0, _p1, _m0, _m1, t);
    out.position.copy(_tmp);
  }

  _q0.set(k0.quaternion[0], k0.quaternion[1], k0.quaternion[2], k0.quaternion[3]);
  _q1.set(k1.quaternion[0], k1.quaternion[1], k1.quaternion[2], k1.quaternion[3]);
  out.quaternion.copy(_q0).slerp(_q1, t);

  out.fov = lerpChannel(k0.fov, k1.fov, t);
  out.roll = lerpChannel(k0.roll, k1.roll, t);
  out.focusDistance = lerpChannel(k0.focusDistance, k1.focusDistance, t);
  out.aperture = lerpChannel(k0.aperture, k1.aperture, t);

  return out;
}

export function createSampledCamera(): SampledCamera {
  return {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    fov: null,
    roll: null,
    focusDistance: null,
    aperture: null,
  };
}

/**
 * The path as a list of points, for drawing it in the viewport and for the graph editor's
 * background. Sampled evenly in TIME, so the spacing shows the speed: points bunch up where the
 * move slows down and spread out where it races.
 */
export function samplePath(take: CameraTake, samples = 200): THREE.Vector3[] {
  const keys = take.keyframes;
  if (!keys || keys.length < 2) return [];
  const start = keys[0].time;
  const end = keys[keys.length - 1].time;
  const out = createSampledCamera();
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = start + ((end - start) * i) / samples;
    if (sampleCameraTake(take, t, out)) points.push(out.position.clone());
  }
  return points;
}

/** Keeps keys in time order and stops two keys landing on the same frame. */
export function insertKeyframe(keys: CameraKeyframe[], key: CameraKeyframe, epsilon = 1e-3): CameraKeyframe[] {
  const without = keys.filter((k) => Math.abs(k.time - key.time) > epsilon);
  return [...without, key].sort((a, b) => a.time - b.time);
}
