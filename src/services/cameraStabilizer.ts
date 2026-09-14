import { CameraKeyframe } from '../types';

/** Gaussian window width (sigma, seconds) at full stabilizer strength. */
const MAX_SIGMA_SEC = 0.6;

/**
 * Smooths a recorded handheld camera path.
 *
 * Runs after recording, looking both backward and forward in time, so unlike a live filter it
 * adds no lag: the camera still arrives on time at every move, just without the hand shake.
 * `strength` is 0-100; 0 returns the original keyframes. The original take is never modified.
 */
export function stabilizeKeyframes(keyframes: CameraKeyframe[], strength: number): CameraKeyframe[] {
  if (!keyframes || keyframes.length < 3 || !(strength > 0)) return keyframes;

  // Square the curve so the low end of the slider gives fine control over subtle shake.
  const s = Math.min(1, strength / 100);
  const sigma = MAX_SIGMA_SEC * s * s + 0.01;
  const reach = sigma * 3;
  const inv2Sigma2 = 1 / (2 * sigma * sigma);
  const n = keyframes.length;
  const out: CameraKeyframe[] = new Array(n);

  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const center = keyframes[i];
    const t = center.time;
    while (keyframes[lo].time < t - reach) lo++;
    while (hi + 1 < n && keyframes[hi + 1].time <= t + reach) hi++;

    const cq = center.quaternion;
    let px = 0, py = 0, pz = 0;
    let qx = 0, qy = 0, qz = 0, qw = 0;
    let fov = 0, fovW = 0;
    let wSum = 0;

    for (let j = lo; j <= hi; j++) {
      const k = keyframes[j];
      const dt = k.time - t;
      const w = Math.exp(-dt * dt * inv2Sigma2);
      px += k.position[0] * w;
      py += k.position[1] * w;
      pz += k.position[2] * w;

      // q and -q are the same rotation; flip onto the center's side before averaging,
      // otherwise opposite-signed neighbours cancel out into a wild spin.
      const q = k.quaternion;
      const sign = q[0] * cq[0] + q[1] * cq[1] + q[2] * cq[2] + q[3] * cq[3] < 0 ? -w : w;
      qx += q[0] * sign;
      qy += q[1] * sign;
      qz += q[2] * sign;
      qw += q[3] * sign;

      if (k.fov !== undefined) {
        fov += k.fov * w;
        fovW += w;
      }
      wSum += w;
    }

    const qLen = Math.hypot(qx, qy, qz, qw) || 1;
    out[i] = {
      time: t,
      position: [px / wSum, py / wSum, pz / wSum],
      quaternion: [qx / qLen, qy / qLen, qz / qLen, qw / qLen],
      ...(center.fov !== undefined ? { fov: fovW > 0 ? fov / fovW : center.fov } : {}),
    };
  }
  return out;
}
