import * as THREE from 'three';
import { CameraEase, CameraHeadPass, CameraKeyframe, CameraKeyHandle, CameraTake } from '../types';

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

// ---------------------------------------------------------------------------------------------
// Smoothness through keys
// ---------------------------------------------------------------------------------------------
//
// Every channel's speed AT a key is worked out from its neighbours and the TIME between them, then
// each segment is a cubic that leaves and arrives at those speeds. Done in seconds rather than per
// segment, a key between a short stretch and a long one no longer makes the speed jump (measured
// before: 2.0 m/s in, 0.67 m/s out across a smooth key with keys 1 s then 3 s apart).
//
// The timing curve multiplies in on top: at a key, real speed = channel speed x the handle's slope,
// so a 'smooth' key (equal slopes) is smooth in metres, degrees and millimetres, not just on the graph.

const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _qd = new THREE.Quaternion();
const _qe = new THREE.Quaternion();
const _w0 = new THREE.Vector3();
const _w1 = new THREE.Vector3();
const _wa = new THREE.Vector3();
const _wb = new THREE.Vector3();

function keyQuat(target: THREE.Quaternion, k: CameraKeyframe): THREE.Quaternion {
  return target.set(k.quaternion[0], k.quaternion[1], k.quaternion[2], k.quaternion[3]);
}

/** Rotation vector (axis x angle, radians) of a unit quaternion, taking the short way round. */
function quatLog(out: THREE.Vector3, q: THREE.Quaternion): THREE.Vector3 {
  const sign = q.w < 0 ? -1 : 1;
  const x = q.x * sign, y = q.y * sign, z = q.z * sign, w = q.w * sign;
  const sinHalf = Math.sqrt(x * x + y * y + z * z);
  if (sinHalf < 1e-9) return out.set(0, 0, 0);
  const angle = 2 * Math.atan2(sinHalf, w);
  return out.set(x, y, z).multiplyScalar(angle / sinHalf);
}

function quatExp(out: THREE.Quaternion, v: THREE.Vector3): THREE.Quaternion {
  const angle = v.length();
  if (angle < 1e-9) return out.set(0, 0, 0, 1);
  const s = Math.sin(angle / 2) / angle;
  return out.set(v.x * s, v.y * s, v.z * s, Math.cos(angle / 2));
}

/** Body-frame rotation from key a to key b, per second. */
function segmentSpin(out: THREE.Vector3, ka: CameraKeyframe, kb: CameraKeyframe): THREE.Vector3 {
  keyQuat(_qa, ka).invert().multiply(keyQuat(_qb, kb));
  return quatLog(out, _qa).multiplyScalar(1 / Math.max(1e-6, kb.time - ka.time));
}

/**
 * Turning rate at key i (radians per second, in the camera's own frame): the time-weighted blend
 * of the stretch before and the stretch after, as a non-uniform Catmull-Rom does for position.
 * The rotation from key i to either neighbour has the same axis in both cameras' frames, which is
 * why the two can be averaged as they are.
 */
function keySpin(out: THREE.Vector3, keys: CameraKeyframe[], i: number): THREE.Vector3 {
  const last = keys.length - 1;
  if (last < 1) return out.set(0, 0, 0);
  // Ends match the path's default: half the speed of their one stretch.
  if (i === 0) return segmentSpin(out, keys[0], keys[1]).multiplyScalar(0.5);
  if (i === last) return segmentSpin(out, keys[last - 1], keys[last]).multiplyScalar(0.5);
  const dtIn = keys[i].time - keys[i - 1].time;
  const dtOut = keys[i + 1].time - keys[i].time;
  segmentSpin(_wa, keys[i - 1], keys[i]).multiplyScalar(dtIn);
  segmentSpin(_wb, keys[i], keys[i + 1]).multiplyScalar(dtOut);
  return out.copy(_wa).add(_wb).multiplyScalar(1 / Math.max(1e-6, dtIn + dtOut));
}

/**
 * Orientation along segment i0 -> i0+1 at eased progress u: a cubic bezier on the sphere
 * (de Casteljau with slerps) whose inner controls are set by each key's turning rate, so the
 * camera turns through a key instead of snapping to a new direction there.
 */
function rotationAt(out: THREE.Quaternion, keys: CameraKeyframe[], i0: number, u: number) {
  const k0 = keys[i0];
  const k1 = keys[i0 + 1];
  const dt = Math.max(1e-6, k1.time - k0.time);
  keySpin(_w0, keys, i0).multiplyScalar(dt / 3);
  keySpin(_w1, keys, i0 + 1).multiplyScalar(-dt / 3);
  keyQuat(_q0, k0);
  keyQuat(_q1, k1);
  if (_q0.dot(_q1) < 0) _q1.set(-_q1.x, -_q1.y, -_q1.z, -_q1.w);
  _q2.copy(_q0).multiply(quatExp(_qe, _w0));
  _q3.copy(_q1).multiply(quatExp(_qe, _w1));
  _qa.copy(_q0).slerp(_q2, u);
  _qb.copy(_q2).slerp(_q3, u);
  _qc.copy(_q3).slerp(_q1, u);
  _qd.copy(_qa).slerp(_qb, u);
  _qa.copy(_qb).slerp(_qc, u);
  out.copy(_qd).slerp(_qa, u);
}

/** Path velocity at key i in world units per second, from its neighbours and the time between them. */
function keyVelocity(out: THREE.Vector3, keys: CameraKeyframe[], i: number, tension: number): THREE.Vector3 {
  const last = keys.length - 1;
  if (i === 0 || i === last) {
    // An end has one neighbour: tension x that stretch's average speed (as before).
    const a = i === 0 ? keys[0] : keys[last - 1];
    const b = i === 0 ? keys[1] : keys[last];
    keyPosition(out, b).sub(keyPosition(_tmp, a));
    return out.multiplyScalar(tension / Math.max(1e-6, b.time - a.time));
  }
  keyPosition(out, keys[i + 1]).sub(keyPosition(_tmp, keys[i - 1]));
  return out.multiplyScalar((2 * tension) / Math.max(1e-6, keys[i + 1].time - keys[i - 1].time));
}

type ScalarChannel = 'fov' | 'roll' | 'focusDistance' | 'aperture';

/** A channel's value at key i, treating focus/iris 0 as "this key does not set it". */
function channelValue(k: CameraKeyframe, ch: ScalarChannel): number | undefined {
  const v = k[ch];
  if (v === undefined) return undefined;
  if ((ch === 'focusDistance' || ch === 'aperture') && v <= 0) return undefined;
  return v;
}

/**
 * Rate of change of a channel at key i, per second: the non-uniform Catmull-Rom slope, flattened
 * at a turning point and capped (Fritsch-Carlson) so a lens or focus pull never swings past the
 * value it is heading for.
 */
function channelSlope(keys: CameraKeyframe[], i: number, ch: ScalarChannel): number {
  const v = channelValue(keys[i], ch);
  if (v === undefined) return 0;
  const prev = i > 0 ? channelValue(keys[i - 1], ch) : undefined;
  const next = i < keys.length - 1 ? channelValue(keys[i + 1], ch) : undefined;
  const dIn = prev === undefined ? undefined : (v - prev) / Math.max(1e-6, keys[i].time - keys[i - 1].time);
  const dOut = next === undefined ? undefined : (next - v) / Math.max(1e-6, keys[i + 1].time - keys[i].time);
  if (dIn === undefined && dOut === undefined) return 0;
  if (dIn === undefined) return dOut!;
  if (dOut === undefined) return dIn;
  if (dIn * dOut <= 0) return 0;
  const m = (next! - prev!) / Math.max(1e-6, keys[i + 1].time - keys[i - 1].time);
  const cap = 3 * Math.min(Math.abs(dIn), Math.abs(dOut));
  return Math.sign(m) * Math.min(Math.abs(m), cap);
}

function channelAt(keys: CameraKeyframe[], i0: number, u: number, ch: ScalarChannel): number | null {
  const k0 = keys[i0];
  const k1 = keys[i0 + 1];
  const a = k0[ch];
  const b = k1[ch];
  // A key that does not set the channel keeps the old behaviour: hold whichever side has it.
  if (channelValue(k0, ch) === undefined || channelValue(k1, ch) === undefined) return lerpChannel(a, b, u);
  const dt = k1.time - k0.time;
  const m0 = channelSlope(keys, i0, ch) * dt;
  const m1 = channelSlope(keys, i0 + 1, ch) * dt;
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * a! + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * b! + (u3 - u2) * m1;
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
    applyHeadPass(take, time, out);
    return out;
  }
  const last = keys.length - 1;
  if (time >= keys[last].time) {
    readKey(keys[last], out);
    applyHeadPass(take, time, out);
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
    // Tangents from each key's velocity in metres per second, scaled to this segment's length in
    // time, so the speed carries through a key however unevenly the keys are spaced. With evenly
    // spaced keys this is exactly the uniform Catmull-Rom it replaces. Tangents the user dragged
    // in the viewport are used as they are.
    if (k0.tangentOut) _m0.set(k0.tangentOut[0], k0.tangentOut[1], k0.tangentOut[2]);
    else keyVelocity(_m0, keys, i0, tension).multiplyScalar(span);
    if (k1.tangentIn) _m1.set(k1.tangentIn[0], k1.tangentIn[1], k1.tangentIn[2]);
    else keyVelocity(_m1, keys, i1, tension).multiplyScalar(span);

    hermite(_tmp, _p0, _p1, _m0, _m1, t);
    out.position.copy(_tmp);
  }

  rotationAt(out.quaternion, keys, i0, t);

  out.fov = channelAt(keys, i0, t, 'fov');
  out.roll = channelAt(keys, i0, t, 'roll');
  applyHeadPass(take, time, out);
  out.focusDistance = channelAt(keys, i0, t, 'focusDistance');
  out.aperture = channelAt(keys, i0, t, 'aperture');

  return out;
}

/** The take's chosen head pass, if it has one with anything in it. */
export function activeHeadPass(take: CameraTake): CameraHeadPass | null {
  if (!take.activeHeadPassId || !take.headPasses) return null;
  const pass = take.headPasses.find((p) => p.id === take.activeHeadPassId);
  return pass && pass.samples.length > 0 ? pass : null;
}

/**
 * A crane take: the keys keep position, lens and focus, and the operated pass supplies the
 * orientation. The pass already carries the operator's roll, so the keyed roll is dropped.
 */
function applyHeadPass(take: CameraTake, time: number, out: SampledCamera) {
  const pass = activeHeadPass(take);
  if (!pass) return;
  const s = pass.samples;
  if (time <= s[0].time) {
    const q = s[0].quaternion;
    out.quaternion.set(q[0], q[1], q[2], q[3]);
  } else if (time >= s[s.length - 1].time) {
    const q = s[s.length - 1].quaternion;
    out.quaternion.set(q[0], q[1], q[2], q[3]);
  } else {
    let low = 0;
    let high = s.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (s[mid].time <= time) low = mid + 1;
      else high = mid - 1;
    }
    const a = s[Math.max(0, high)];
    const b = s[Math.min(s.length - 1, high + 1)];
    const span = b.time - a.time;
    const f = span > 1e-6 ? (time - a.time) / span : 0;
    _qa.set(a.quaternion[0], a.quaternion[1], a.quaternion[2], a.quaternion[3]);
    _qb.set(b.quaternion[0], b.quaternion[1], b.quaternion[2], b.quaternion[3]);
    out.quaternion.copy(_qa).slerp(_qb, f);
  }
  out.roll = null;
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
