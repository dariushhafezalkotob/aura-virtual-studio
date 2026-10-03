import * as THREE from 'three';
import type { CameraKeyframe, CameraTake, ObjectAnimation, ObjectKeyframe, SceneAsset } from '../types';
import { EASY_EASE_HANDLE, LINEAR_HANDLE, createSampledCamera, sampleCameraTake, segmentProgress } from './cameraAnimation';

/**
 * Keyed movement for set objects - a car that drives through the shot.
 *
 * An object's move is the same problem as a hand-keyed camera move: a few poses seconds apart,
 * a curved path through them, a turn that flows through each key, and timing per key. So the keys
 * are handed to the camera's sampler rather than a second copy of that maths being kept in step
 * with it. Only scale is the object's own.
 */

export interface SampledObject {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

export const createSampledObject = (): SampledObject => ({
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  scale: new THREE.Vector3(1, 1, 1),
});

const KEY_EPSILON = 1e-3;

/** The keys as a keyed camera move, built once per animation object (edits always make a new one). */
const asTake = new WeakMap<ObjectAnimation, CameraTake>();
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();

function takeFor(animation: ObjectAnimation): CameraTake {
  let take = asTake.get(animation);
  if (take) return take;
  const keyframes: CameraKeyframe[] = animation.keys.map((k) => {
    _quat.setFromEuler(_euler.set(k.rotation[0], k.rotation[1], k.rotation[2]));
    const handle = k.ease === 'ease' ? EASY_EASE_HANDLE : LINEAR_HANDLE;
    return {
      time: k.time,
      position: k.position,
      quaternion: [_quat.x, _quat.y, _quat.z, _quat.w],
      ease: k.ease === 'hold' ? 'hold' : 'linear',
      handleIn: handle,
      handleOut: handle,
      handleMode: 'smooth',
    };
  });
  // The camera's path leaves its first key and reaches its last at half speed (its end tangents
  // are half a segment), which is right for a camera move and wrong for a car crossing the frame:
  // two 'pass' keys on a straight road must be one constant speed. So the ends get the full chord.
  const n = keyframes.length;
  if (n >= 2) {
    const chord = (a: CameraKeyframe, b: CameraKeyframe): [number, number, number] => [
      b.position[0] - a.position[0],
      b.position[1] - a.position[1],
      b.position[2] - a.position[2],
    ];
    keyframes[0].tangentOut = chord(keyframes[0], keyframes[1]);
    keyframes[n - 1].tangentIn = chord(keyframes[n - 2], keyframes[n - 1]);
  }
  take = {
    id: 'object',
    name: 'object',
    createdAt: '',
    duration: keyframes.length ? keyframes[keyframes.length - 1].time : 0,
    keyframes,
    mode: 'keyed',
  };
  asTake.set(animation, take);
  return take;
}

const _cam = createSampledCamera();
const _ahead = createSampledCamera();
const _yaw = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

/** Compass heading of the path at `time` (radians about +Y), or null where the object is not moving. */
function headingAt(take: CameraTake, time: number): number | null {
  const first = take.keyframes[0].time;
  const last = take.keyframes[take.keyframes.length - 1].time;
  // Look a little ahead; at the very end, a little behind.
  const STEP = 0.05;
  let t0 = Math.min(Math.max(time, first), last);
  let t1 = t0 + STEP;
  if (t1 > last) {
    t1 = last;
    t0 = Math.max(first, last - STEP);
  }
  if (t1 - t0 < 1e-4) return null;
  if (!sampleCameraTake(take, t0, _cam) || !sampleCameraTake(take, t1, _ahead)) return null;
  const dx = _ahead.position.x - _cam.position.x;
  const dz = _ahead.position.z - _cam.position.z;
  if (dx * dx + dz * dz < 1e-8) return null;
  return Math.atan2(dx, dz);
}

/** The heading nearest to `time` where the object actually moves, so a parked car keeps its last direction. */
function settledHeading(take: CameraTake, time: number): number | null {
  const direct = headingAt(take, time);
  if (direct !== null) return direct;
  const first = take.keyframes[0].time;
  const last = take.keyframes[take.keyframes.length - 1].time;
  for (let step = 0.1; step <= last - first + 0.1; step += 0.1) {
    const before = time - step >= first ? headingAt(take, time - step) : null;
    if (before !== null) return before;
    const after = time + step <= last ? headingAt(take, time + step) : null;
    if (after !== null) return after;
  }
  return null;
}

/**
 * Where the object is at `time`. Returns false when it has no keys, so the caller leaves it where
 * the set designer put it. `out` is written in place; pass the same object every frame.
 */
export function sampleObjectAnimation(animation: ObjectAnimation | undefined, time: number, out: SampledObject): boolean {
  if (!animation || animation.keys.length === 0) return false;
  const keys = animation.keys;
  const take = takeFor(animation);
  if (!sampleCameraTake(take, time, _cam)) return false;
  out.position.copy(_cam.position);
  out.quaternion.copy(_cam.quaternion);

  // Scale rides the same timing as the move.
  const last = keys.length - 1;
  if (keys.length === 1 || time <= keys[0].time) out.scale.fromArray(keys[0].scale);
  else if (time >= keys[last].time) out.scale.fromArray(keys[last].scale);
  else {
    let i = 0;
    while (i < last - 1 && keys[i + 1].time <= time) i++;
    const span = keys[i + 1].time - keys[i].time;
    const t = segmentProgress(take.keyframes[i], take.keyframes[i + 1], span > 1e-6 ? (time - keys[i].time) / span : 0);
    out.scale.fromArray(keys[i].scale).lerp(_tmpScale.fromArray(keys[i + 1].scale), t);
  }

  // Auto-face: the object keeps the way it was set against the path at its first key, and turns by
  // however much the path has turned since. A generated model's "front" can point anywhere, so
  // this never has to know which way that is.
  if (animation.autoFace && keys.length >= 2) {
    const start = settledHeading(take, keys[0].time);
    const now = settledHeading(take, time);
    if (start !== null && now !== null) {
      _quat.setFromEuler(_euler.set(keys[0].rotation[0], keys[0].rotation[1], keys[0].rotation[2]));
      out.quaternion.copy(_yaw.setFromAxisAngle(_up, now - start)).multiply(_quat);
    }
  }
  return true;
}

const _tmpScale = new THREE.Vector3();

/** The route as points for drawing it on the floor, evenly spaced in time (bunched where it is slow). */
export function sampleObjectPath(animation: ObjectAnimation, samples = 120): THREE.Vector3[] {
  if (animation.keys.length < 2) return [];
  const take = takeFor(animation);
  const start = animation.keys[0].time;
  const end = animation.keys[animation.keys.length - 1].time;
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= samples; i++) {
    if (sampleCameraTake(take, start + ((end - start) * i) / samples, _cam)) points.push(_cam.position.clone());
  }
  return points;
}

/** The key at `time`, within a frame's tolerance. */
export function keyAt(animation: ObjectAnimation | undefined, time: number, tolerance = 0.05): ObjectKeyframe | null {
  return animation?.keys.find((k) => Math.abs(k.time - time) <= tolerance) ?? null;
}

/** Adds a key, or replaces the one already at that time, keeping time order. */
export function withObjectKey(animation: ObjectAnimation | undefined, key: ObjectKeyframe, tolerance = 0.05): ObjectAnimation {
  const existing = keyAt(animation, key.time, tolerance);
  const merged: ObjectKeyframe = existing ? { ...key, time: existing.time, ease: key.ease ?? existing.ease } : key;
  const others = (animation?.keys || []).filter((k) => k !== existing);
  return { ...animation, keys: [...others, merged].sort((a, b) => a.time - b.time) };
}

/** Removes a key; with none left the object simply stops being animated. */
export function withoutObjectKey(animation: ObjectAnimation | undefined, time: number): ObjectAnimation | undefined {
  if (!animation) return undefined;
  const keys = animation.keys.filter((k) => Math.abs(k.time - time) > KEY_EPSILON);
  return keys.length ? { ...animation, keys } : undefined;
}

/** Moves a key in time. Landing on another key is refused rather than merging two poses. */
export function withObjectKeyMoved(animation: ObjectAnimation, time: number, newTime: number): ObjectAnimation {
  const target = Math.max(0, Number(newTime.toFixed(3)));
  if (animation.keys.some((k) => Math.abs(k.time - time) > KEY_EPSILON && Math.abs(k.time - target) <= KEY_EPSILON)) return animation;
  return {
    ...animation,
    keys: animation.keys.map((k) => (Math.abs(k.time - time) <= KEY_EPSILON ? { ...k, time: target } : k)).sort((a, b) => a.time - b.time),
  };
}

/** When the last object in the scene stops moving - the timeline has to reach at least this far. */
export function objectAnimationEnd(assets: SceneAsset[] | undefined): number {
  let end = 0;
  for (const a of assets || []) {
    const keys = a.animation?.keys;
    if (keys && keys.length) end = Math.max(end, keys[keys.length - 1].time);
    // A rigged prop's own animation that plays once has to be seen to its end.
    const clip = a.rigClip && a.animationClips?.[a.rigClip.index];
    if (clip && a.rigClip && !a.rigClip.loop) end = Math.max(end, a.rigClip.start + clip.duration / Math.max(0.1, a.rigClip.speed));
  }
  return end;
}
